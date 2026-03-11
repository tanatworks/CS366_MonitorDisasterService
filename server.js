require("dotenv").config();
const express = require("express");
const crypto = require("crypto");

const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const {
    DynamoDBDocumentClient,
    GetCommand,
    PutCommand,
    ScanCommand,
    UpdateCommand,
} = require("@aws-sdk/lib-dynamodb");

const { SNSClient, PublishCommand } = require("@aws-sdk/client-sns");

const app = express();
app.use(express.json());

const REGION = process.env.AWS_REGION || "us-east-1";
const SNS_TOPIC_ARN =
    process.env.SNS_TOPIC_ARN ||
    "arn:aws:sns:us-east-1:462632273029:MonitoringDisaster-Topic";

const ddbClient = new DynamoDBClient({ region: REGION });
const docClient = DynamoDBDocumentClient.from(ddbClient);

const snsClient = new SNSClient({ region: "us-east-1" });

const TABLE_AREAS = "Disaster_Areas";
const TABLE_AUDIT_LOGS = "Disaster_AuditLogs";
const TABLE_INCIDENT_REPORTS = "Disaster_IncidentReports";

// Function: Calculate disaster status based on water level
const calculateDisasterStatus = (waterLevel) => {
    if (waterLevel >= 150) return "CRITICAL";
    if (waterLevel >= 100) return "WARNING";
    if (waterLevel >= 50) return "WATCH";
    return "NORMAL";
};
// Function: Text -> Impact Level (1-4)
const getImpactLevel = (status) => {
    const levels = { CRITICAL: 4, WARNING: 3, WATCH: 2, NORMAL: 1 };
    return levels[status] || 1;
};

// Event Publisher & Incident Logger (SQS + DynamoDB)
const publishEvent = async (
    areaId,
    prevStatus,
    currStatus,
    waterLevel,
    rainfall,
    trigger,
) => {
    if (prevStatus === currStatus) return;

    const eventId = crypto.randomUUID();
    const incidentId = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const impactLevel = getImpactLevel(currStatus);

    // 1. Save to Audit Logs
    await docClient.send(
        new PutCommand({
            TableName: TABLE_AUDIT_LOGS,
            Item: {
                logId: eventId,
                area_id: areaId,
                previous_status: prevStatus,
                new_status: currStatus,
                water_level_cm: waterLevel,
                rainfall_mm: rainfall,
                triggered_by: trigger,
                createdAt: createdAt,
            },
        }),
    );

    // 2. Save to Incident Reports (Outbox) - Status: PENDING
    const description = `Status changed to ${currStatus} due to water level reaching ${waterLevel} cm.`;

    await docClient.send(
        new PutCommand({
            TableName: TABLE_INCIDENT_REPORTS,
            Item: {
                incident_id: incidentId,
                area_id: areaId,
                incident_type: "flood",
                incident_description: description,
                impact_level: impactLevel,
                threshold_water_cm: waterLevel,
                threshold_rain_mm: rainfall,
                sync_status: "PENDING", // ยังไม่ได้ส่ง
                reported_at: createdAt,
            },
        }),
    );

    // 3. Prepare Payload for SQS
    const eventPayload = {
        incident_id: incidentId,
        incident_type: "flood",
        exact_location: areaId,
        impact_level: impactLevel,
        status: "Reported",
        reported_by:
            trigger === "SYSTEM_AUTO" ? "MonitorDisaster-Service" : trigger,
        created_at: createdAt,
        details: {
            water_level_cm: waterLevel,
            rainfall_mm: rainfall,
            previous_status: prevStatus,
        },
    };

    // 4. Send to AWS SQS
    try {
        await snsClient.send(
            new PublishCommand({
                TopicArn: SNS_TOPIC_ARN,
                Message: JSON.stringify(eventPayload),
            }),
        );
        console.log(`\n[ASYNC EVENT] Successfully published to SNS!`);

        // Update status to SUCCESS
        await docClient.send(
            new UpdateCommand({
                TableName: TABLE_INCIDENT_REPORTS,
                Key: { incident_id: incidentId },
                UpdateExpression: "SET sync_status = :status",
                ExpressionAttributeValues: { ":status": "SUCCESS" },
            }),
        );
    } catch (error) {
        console.error(
            `\n[ASYNC EVENT] Failed to send SNS for ${incidentId}:`,
            error.message,
        );
        // Status remains PENDING/FAILED, can be retried later
        try {
            await docClient.send(
                new UpdateCommand({
                    TableName: TABLE_INCIDENT_REPORTS,
                    Key: { incident_id: incidentId },
                    UpdateExpression: "SET sync_status = :status",
                    ExpressionAttributeValues: { ":status": "FAILED" },
                }),
            );
        } catch (dbErr) {
            console.error(
                `[CRITICAL] Also failed to update DB status to FAILED:`,
                dbErr.message,
            );
        }
    }
};

// Background Job: Check Outdated Data (runs every 1 minute)
setInterval(async () => {
    try {
        const now = new Date();
        const response = await docClient.send(
            new ScanCommand({ TableName: TABLE_AREAS }),
        );
        const areas = response.Items || [];

        for (const area of areas) {
            const lastUpdatedDate = new Date(area.last_updated);
            const diffMinutes = (now - lastUpdatedDate) / (1000 * 60);

            if (diffMinutes > 15 && !area.is_outdated) {
                await docClient.send(
                    new UpdateCommand({
                        TableName: TABLE_AREAS,
                        Key: { area_id: area.area_id },
                        UpdateExpression: "SET is_outdated = :trueVal",
                        ExpressionAttributeValues: { ":trueVal": true },
                    }),
                );
                console.log(
                    `[SYSTEM WARNING] Area ${area.area_id} data is outdated.`,
                );
            } else if (diffMinutes <= 15 && area.is_outdated) {
                await docClient.send(
                    new UpdateCommand({
                        TableName: TABLE_AREAS,
                        Key: { area_id: area.area_id },
                        UpdateExpression: "SET is_outdated = :falseVal",
                        ExpressionAttributeValues: { ":falseVal": false },
                    }),
                );
            }
        }
    } catch (err) {
        console.error("Background Job Error:", err.message);
    }
}, 60000);

// API #1 [POST]: Ingest Data
app.post("/api/monitor-disaster/ingest", async (req, res) => {
    try {
        const {
            area_id,
            area_name,
            source_api,
            water_level_cm,
            rainfall_mm,
            timestamp,
        } = req.body;

        if (
            !area_id ||
            !source_api ||
            !timestamp ||
            typeof water_level_cm !== "number" ||
            typeof rainfall_mm !== "number"
        ) {
            return res.status(400).json({
                error: {
                    code: "VALIDATION_ERROR",
                    message: "Invalid input",
                },
            });
        }

        // Get current area
        const getRes = await docClient.send(
            new GetCommand({ TableName: TABLE_AREAS, Key: { area_id } }),
        );
        let area = getRes.Item;

        if (!area) {
            area = {
                disaster_status: "NORMAL",
                is_manual_override: false,
                last_updated: "2000-01-01",
            };
        } else if (new Date(timestamp) <= new Date(area.last_updated)) {
            return res.status(200).json({
                message: "Old data ignored",
                updated_status: area.disaster_status,
            });
        }

        let new_status = calculateDisasterStatus(water_level_cm);
        if (area.is_manual_override) new_status = area.disaster_status;
        const prev_status = area.disaster_status;

        // Upsert Area
        await docClient.send(
            new PutCommand({
                TableName: TABLE_AREAS,
                Item: {
                    area_id,
                    area_name: area_name || area.area_name || `Area ${area_id}`,
                    water_level_cm,
                    rainfall_mm,
                    disaster_status: new_status,
                    is_manual_override: area.is_manual_override,
                    source_api,
                    is_outdated: false,
                    last_updated: timestamp,
                },
            }),
        );

        // Fire & Forget Event (No await needed here to keep API fast)
        publishEvent(
            area_id,
            prev_status,
            new_status,
            water_level_cm,
            rainfall_mm,
            "SYSTEM_AUTO",
        );

        res.status(200).json({
            message: "Data ingested successfully",
            updated_status: new_status,
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// API #2 [GET]: Get Area Status
app.get("/api/monitor-disaster/areas/:area_id", async (req, res) => {
    try {
        const getRes = await docClient.send(
            new GetCommand({
                TableName: TABLE_AREAS,
                Key: { area_id: req.params.area_id },
            }),
        );
        if (!getRes.Item)
            return res.status(404).json({
                error: { code: "NOT_FOUND", message: "Area not found" },
            });
        res.status(200).json(getRes.Item);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// API #4 [GET]: Get All Areas (Dashboard)
app.get("/api/monitor-disaster/areas", async (req, res) => {
    try {
        const response = await docClient.send(
            new ScanCommand({ TableName: TABLE_AREAS }),
        );
        res.status(200).json(response.Items || []);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// API #3 [PATCH]: Manually Override Status
app.patch("/api/monitor-disaster/areas/:area_id/status", async (req, res) => {
    try {
        const { disaster_status, status_description, overridden_by } = req.body;
        const { area_id } = req.params;
        const validStatuses = ["NORMAL", "WATCH", "WARNING", "CRITICAL"];

        if (
            !validStatuses.includes(disaster_status) ||
            !status_description ||
            !overridden_by
        ) {
            return res.status(400).json({
                error: {
                    code: "VALIDATION_ERROR",
                    message: "Invalid input",
                },
            });
        }

        const getRes = await docClient.send(
            new GetCommand({ TableName: TABLE_AREAS, Key: { area_id } }),
        );
        const area = getRes.Item;
        if (!area)
            return res.status(404).json({
                error: { code: "NOT_FOUND", message: "Area not found" },
            });

        await docClient.send(
            new UpdateCommand({
                TableName: TABLE_AREAS,
                Key: { area_id },
                UpdateExpression:
                    "SET disaster_status = :ds, status_description = :sd, is_manual_override = :mo, last_updated = :lu",
                ExpressionAttributeValues: {
                    ":ds": disaster_status,
                    ":sd": status_description,
                    ":mo": true,
                    ":lu": new Date().toISOString(),
                },
            }),
        );

        publishEvent(
            area_id,
            area.disaster_status,
            disaster_status,
            area.water_level_cm,
            area.rainfall_mm,
            overridden_by,
        );
        res.status(200).json({ message: "Status overridden successfully" });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// DEBUG API: Dump everything from memory
app.get("/api/monitor-disaster/debug/db", async (req, res) => {
    try {
        const areas = await docClient.send(
            new ScanCommand({ TableName: TABLE_AREAS }),
        );
        const logs = await docClient.send(
            new ScanCommand({ TableName: TABLE_AUDIT_LOGS }),
        );
        const incidents = await docClient.send(
            new ScanCommand({ TableName: TABLE_INCIDENT_REPORTS }),
        );
        res.status(200).json({
            areas: areas.Items,
            audit_logs: logs.Items,
            incident_reports: incidents.Items,
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

const PORT = 3000;
app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});
