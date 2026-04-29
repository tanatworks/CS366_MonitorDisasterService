require("dotenv").config();
const express = require("express");
const crypto = require("crypto");
const axios = require("axios");
const cron = require("node-cron");

const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const {
    DynamoDBDocumentClient,
    GetCommand,
    PutCommand,
    ScanCommand,
    UpdateCommand,
    DeleteCommand,
} = require("@aws-sdk/lib-dynamodb");

const { SNSClient, PublishCommand } = require("@aws-sdk/client-sns");
const {
    SQSClient,
    ReceiveMessageCommand,
    DeleteMessageCommand,
} = require("@aws-sdk/client-sqs");

const app = express();
app.use(express.json());

// --- 1. Configuration ---
const REPORT_SERVICE_URL =
    process.env.REPORT_SERVICE_URL ||
    "https://d8a7ds12a2.execute-api.us-east-1.amazonaws.com/dev/v1/reports";
const REPORT_API_KEY =
    process.env.REPORT_API_KEY || "Hk3gkvihdf5scu0ZPJKGn1EsvX74Ny2m5gKDTxDe";

const REGION = process.env.AWS_REGION || "us-east-1";
const SNS_TOPIC_ARN =
    process.env.SNS_TOPIC_ARN ||
    "arn:aws:sns:us-east-1:462632273029:MonitoringDisaster-Topic";

const SQS_EVENTS_QUEUE_URL =
    process.env.SQS_EVENTS_QUEUE_URL ||
    "https://sqs.us-east-1.amazonaws.com/462632273029/monitor-disaster-events-queue";
const SQS_STATUS_QUEUE_URL =
    process.env.SQS_STATUS_QUEUE_URL ||
    "https://sqs.us-east-1.amazonaws.com/462632273029/monitor-disaster-status-queue";

const MY_DISASTER_API_KEY =
    process.env.MY_DISASTER_API_KEY ||
    "disaster-monitoring-9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6";

const ddbClient = new DynamoDBClient({ region: REGION });
const docClient = DynamoDBDocumentClient.from(ddbClient);
const snsClient = new SNSClient({ region: REGION });
const sqsClient = new SQSClient({ region: REGION });

const TABLE_AREAS = "Disaster_Areas";
const TABLE_AUDIT_LOGS = "Disaster_AuditLogs";
const TABLE_INCIDENT_REPORTS = "Disaster_IncidentReports";

// --- 2. Middleware ---
app.use((req, res, next) => {
    req.traceId = crypto.randomUUID();
    res.setHeader("X-Trace-Id", req.traceId);
    next();
});

const apiKeyAuth = (req, res, next) => {
    const clientKey = req.header("X-Api-Key");
    if (!clientKey || clientKey !== MY_DISASTER_API_KEY) {
        return res
            .status(401)
            .json({ error: "UNAUTHORIZED", traceId: req.traceId });
    }
    next();
};

// --- 3. Helpers ---
const calculateDisasterStatus = (water, rain) => {
    if (water >= 150 || rain >= 100) return "CRITICAL";
    if (water >= 100 || rain >= 50) return "WARNING";
    if (water >= 50 || rain >= 20) return "WATCH";
    return "NORMAL";
};

const getImpactLevel = (status) => {
    const levels = { CRITICAL: 4, WARNING: 3, WATCH: 2, NORMAL: 1 };
    return levels[status] || 1;
};

const hasActiveIncident = async (areaId) => {
    try {
        const response = await docClient.send(
            new ScanCommand({
                TableName: TABLE_INCIDENT_REPORTS,
                FilterExpression:
                    "area_id = :aid AND sync_status <> :closedStatus",
                ExpressionAttributeValues: {
                    ":aid": areaId,
                    ":closedStatus": "CLOSED",
                },
            }),
        );
        return response.Items && response.Items.length > 0;
    } catch (err) {
        return false;
    }
};

const publishEvent = async (
    areaId,
    prevStatus,
    currStatus,
    waterLevel,
    rainfall,
    trigger,
    incidentId = null,
) => {
    if (prevStatus === currStatus) return;
    const eventId = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    try {
        await docClient.send(
            new PutCommand({
                TableName: TABLE_AUDIT_LOGS,
                Item: {
                    logId: eventId,
                    incident_id: incidentId,
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
        await snsClient.send(
            new PublishCommand({
                TopicArn: SNS_TOPIC_ARN,
                Message: JSON.stringify({
                    event_id: eventId,
                    timestamp: createdAt,
                    event_type: "DisasterStatusChanged",
                    data: {
                        area_id: areaId,
                        old_status: prevStatus,
                        new_status: currStatus,
                        incident_id: incidentId,
                        impact_level: getImpactLevel(currStatus),
                    },
                }),
            }),
        );
    } catch (err) {
        console.error("[EVENT PUBLISH ERROR]", err.message);
    }
};

// --- 4. API Routes ---

app.post("/api/v1/monitor-disaster/ingest", apiKeyAuth, async (req, res) => {
    try {
        const {
            area_id,
            area_name,
            water_level_cm,
            rainfall_mm,
            timestamp,
            geo_location,
            media_urls,
            source_api,
        } = req.body;
        const geo = geo_location || { lat: 0, lon: 0 };
        const media = media_urls || [];

        const getRes = await docClient.send(
            new GetCommand({ TableName: TABLE_AREAS, Key: { area_id } }),
        );
        const currentArea = getRes.Item;

        if (currentArea && currentArea.last_timestamp > timestamp) {
            return res.status(409).json({
                message: "Out-of-order data ignored",
                traceId: req.traceId,
            });
        }

        const prev_status = currentArea
            ? currentArea.disaster_status
            : "NORMAL";
        let new_status = calculateDisasterStatus(water_level_cm, rainfall_mm);
        if (currentArea && currentArea.is_manual_override) {
            new_status = currentArea.disaster_status;
        }

        await docClient.send(
            new PutCommand({
                TableName: TABLE_AREAS,
                Item: {
                    area_id,
                    water_level_cm,
                    rainfall_mm,
                    disaster_status: new_status,
                    area_name:
                        area_name || currentArea?.area_name || "Unknown Area",
                    incident_id: currentArea?.incident_id || null,
                    status_description: `Updated via ${source_api || "Sensor"}`,
                    is_outdated: false,
                    source_api: source_api || "IOT_SENSOR_V1",
                    is_manual_override:
                        currentArea?.is_manual_override || false,
                    geo_location: geo,
                    last_timestamp: timestamp,
                    last_updated: new Date().toISOString(),
                },
            }),
        );

        let sync_status = "NOT_REQUIRED";
        const reported_at = new Date().toISOString();

        if (new_status === "CRITICAL" && prev_status !== "CRITICAL") {
            const active = await hasActiveIncident(area_id);
            if (active) {
                sync_status = "BYPASSED_ACTIVE_INCIDENT";
            } else {
                const reportSource = "IOT_SENSOR";
                const reporterId = `sensor-${area_id.toLowerCase()}`;
                const rawContent = `[CRITICAL] พื้นที่ ${area_id}: ระดับน้ำ ${water_level_cm}cm ปริมาณฝน ${rainfall_mm}mm`;

                const tempReportId = `temp-${req.traceId}`;
                const incidentReportItem = {
                    report_id: tempReportId,
                    incident_id: null,
                    area_id,
                    report_source: reportSource,
                    reporter_id: reporterId,
                    incident_type: "flood",
                    incident_description: rawContent,
                    impact_level: getImpactLevel(new_status),
                    threshold_water_cm: water_level_cm,
                    threshold_rain_mm: rainfall_mm,
                    sync_status: "PENDING_RETRY",
                    reported_at: reported_at,
                    geo_location: geo,
                    media_urls: media,
                    idempotency_key: req.traceId,
                    retry_count: 0,
                    next_retry_time: Date.now(),
                };

                await docClient.send(
                    new PutCommand({
                        TableName: TABLE_INCIDENT_REPORTS,
                        Item: incidentReportItem,
                    }),
                );

                try {
                    const response = await axios.post(
                        REPORT_SERVICE_URL,
                        {
                            reporter_source: reportSource,
                            reporter_id: reporterId,
                            raw_content: rawContent,
                            geo_location: geo,
                        },
                        {
                            timeout: 30000,
                            headers: {
                                "x-api-key": REPORT_API_KEY,
                                "Content-Type": "application/json",
                                "X-IncidentTNX-Id": req.traceId,
                            },
                        },
                    );

                    const realReportId = response.data.report_id;

                    await docClient.send(
                        new PutCommand({
                            TableName: TABLE_INCIDENT_REPORTS,
                            Item: {
                                ...incidentReportItem,
                                report_id: realReportId,
                                remote_trace_id: response.data.traceId || null,
                                sync_status: "PENDING_INCIDENT",
                            },
                        }),
                    );

                    await docClient.send(
                        new DeleteCommand({
                            TableName: TABLE_INCIDENT_REPORTS,
                            Key: { report_id: tempReportId },
                        }),
                    );

                    sync_status = "PENDING_INCIDENT";
                } catch (err) {
                    console.error(
                        "[POST REPORT ERROR - DEFERRING TO CRON]",
                        err.message,
                    );
                    sync_status = "PENDING_RETRY";
                }
            }
        }

        publishEvent(
            area_id,
            prev_status,
            new_status,
            water_level_cm,
            rainfall_mm,
            "SYSTEM_AUTO",
            currentArea?.incident_id,
        );
        res.status(200).json({
            updated_status: new_status,
            sync_status,
            traceId: req.traceId,
        });
    } catch (err) {
        res.status(500).json({ error: err.message, traceId: req.traceId });
    }
});

app.patch(
    "/api/v1/monitor-disaster/areas/:area_id/status",
    apiKeyAuth,
    async (req, res) => {
        try {
            const { area_id } = req.params;
            const {
                disaster_status,
                status_description,
                overridden_by,
                geo_location,
                media_urls,
            } = req.body;

            const getRes = await docClient.send(
                new GetCommand({ TableName: TABLE_AREAS, Key: { area_id } }),
            );
            const area = getRes.Item;
            if (!area)
                return res
                    .status(404)
                    .json({ error: "Area not found", traceId: req.traceId });

            const geo = geo_location || area.geo_location || { lat: 0, lon: 0 };
            const media = media_urls || [];

            await docClient.send(
                new UpdateCommand({
                    TableName: TABLE_AREAS,
                    Key: { area_id },
                    UpdateExpression:
                        "SET disaster_status = :ds, is_manual_override = :mo, last_updated = :lu, status_description = :sd, source_api = :sa",
                    ExpressionAttributeValues: {
                        ":ds": disaster_status,
                        ":mo": true,
                        ":lu": new Date().toISOString(),
                        ":sd": status_description || "Manual Override",
                        ":sa": "OFFICIAL_APP",
                    },
                }),
            );

            let sync_status = "NOT_REQUIRED";
            if (
                disaster_status === "CRITICAL" &&
                area.disaster_status !== "CRITICAL"
            ) {
                const active = await hasActiveIncident(area_id);
                if (!active) {
                    const reported_at = new Date().toISOString();
                    const reportSource = "OFFICIAL_APP";
                    const reporterId = overridden_by || "Unknown-Dispatcher";
                    const rawContent = `[CRITICAL] พื้นที่ ${area_id}: ${status_description}`;

                    const tempReportId = `temp-${req.traceId}`;
                    const incidentReportItem = {
                        report_id: tempReportId,
                        incident_id: null,
                        area_id,
                        report_source: reportSource,
                        reporter_id: reporterId,
                        incident_type: "flood",
                        incident_description: rawContent,
                        impact_level: getImpactLevel(disaster_status),
                        threshold_water_cm: area.water_level_cm,
                        threshold_rain_mm: area.rainfall_mm,
                        sync_status: "PENDING_RETRY",
                        reported_at: reported_at,
                        geo_location: geo,
                        media_urls: media,
                        idempotency_key: req.traceId,
                        retry_count: 0,
                        next_retry_time: Date.now(),
                    };

                    await docClient.send(
                        new PutCommand({
                            TableName: TABLE_INCIDENT_REPORTS,
                            Item: incidentReportItem,
                        }),
                    );

                    try {
                        const response = await axios.post(
                            REPORT_SERVICE_URL,
                            {
                                reporter_source: reportSource,
                                reporter_id: reporterId,
                                raw_content: rawContent,
                                geo_location: geo,
                            },
                            {
                                timeout: 30000,
                                headers: {
                                    "x-api-key": REPORT_API_KEY,
                                    "Content-Type": "application/json",
                                    "X-IncidentTNX-Id": req.traceId,
                                },
                            },
                        );

                        const realReportId = response.data.report_id;

                        await docClient.send(
                            new PutCommand({
                                TableName: TABLE_INCIDENT_REPORTS,
                                Item: {
                                    ...incidentReportItem,
                                    report_id: realReportId,
                                    remote_trace_id:
                                        response.data.traceId || null,
                                    sync_status: "PENDING_INCIDENT",
                                },
                            }),
                        );

                        await docClient.send(
                            new DeleteCommand({
                                TableName: TABLE_INCIDENT_REPORTS,
                                Key: { report_id: tempReportId },
                            }),
                        );

                        sync_status = "PENDING_INCIDENT";
                    } catch (err) {
                        console.error("[POST REPORT ERROR]", err.message);
                        sync_status = "PENDING_RETRY";
                    }
                } else {
                    sync_status = "BYPASSED_ACTIVE_INCIDENT";
                }
            }

            publishEvent(
                area_id,
                area.disaster_status,
                disaster_status,
                area.water_level_cm,
                area.rainfall_mm,
                overridden_by,
                area.incident_id,
            );
            res.status(200).json({
                message: "Status overridden",
                sync_status,
                traceId: req.traceId,
            });
        } catch (err) {
            res.status(500).json({ error: err.message, traceId: req.traceId });
        }
    },
);

// Cron: Adaptive Exponential Backoff Retry Worker
cron.schedule("*/5 * * * *", async () => {
    try {
        const pending = await docClient.send(
            new ScanCommand({
                TableName: TABLE_INCIDENT_REPORTS,
                FilterExpression: "sync_status = :s",
                ExpressionAttributeValues: { ":s": "PENDING_RETRY" },
            }),
        );

        const currentTime = Date.now();

        for (const report of pending.Items || []) {
            if (report.next_retry_time && currentTime < report.next_retry_time)
                continue;

            try {
                const response = await axios.post(
                    REPORT_SERVICE_URL,
                    {
                        reporter_source: report.report_source || "IOT_SENSOR",
                        reporter_id:
                            report.reporter_id ||
                            `retry-worker-${report.area_id.toLowerCase()}`,
                        raw_content: report.incident_description,
                        geo_location: report.geo_location || { lat: 0, lon: 0 },
                    },
                    {
                        timeout: 30000,
                        headers: {
                            "x-api-key": REPORT_API_KEY,
                            "Content-Type": "application/json",
                            "X-IncidentTNX-Id": report.idempotency_key,
                        },
                    },
                );

                const new_id = response.data?.report_id;
                if (new_id) {
                    await docClient.send(
                        new PutCommand({
                            TableName: TABLE_INCIDENT_REPORTS,
                            Item: {
                                ...report,
                                report_id: new_id,
                                remote_trace_id: response.data.traceId || null,
                                sync_status: "PENDING_INCIDENT",
                            },
                        }),
                    );
                    await docClient.send(
                        new DeleteCommand({
                            TableName: TABLE_INCIDENT_REPORTS,
                            Key: { report_id: report.report_id },
                        }),
                    );
                }
            } catch (err) {
                const currentRetry = (report.retry_count || 0) + 1;
                console.error(`[CRON RETRY ${currentRetry} FAIL]`, err.message);

                if (currentRetry >= 10) {
                    await docClient.send(
                        new UpdateCommand({
                            TableName: TABLE_INCIDENT_REPORTS,
                            Key: { report_id: report.report_id },
                            UpdateExpression:
                                "SET sync_status = :failState, retry_count = :rc",
                            ExpressionAttributeValues: {
                                ":failState": "FAILED_PERMANENTLY",
                                ":rc": currentRetry,
                            },
                        }),
                    );
                } else {
                    const backoffMinutes = Math.pow(2, currentRetry) * 5;
                    const nextRetry = currentTime + backoffMinutes * 60 * 1000;

                    await docClient.send(
                        new UpdateCommand({
                            TableName: TABLE_INCIDENT_REPORTS,
                            Key: { report_id: report.report_id },
                            UpdateExpression:
                                "SET retry_count = :rc, next_retry_time = :nt",
                            ExpressionAttributeValues: {
                                ":rc": currentRetry,
                                ":nt": nextRetry,
                            },
                        }),
                    );
                }
            }
        }
    } catch (err) {
        console.error("Cron Error", err.message);
    }
});

// --- 5. Async SQS Pollers (แยก 2 Queue) ---

// Worker 1: ดึงคิวแจ้งเตือนผูกเหตุการณ์ใหม่ (INCIDENT_CREATED)
const pollEventsQueue = async () => {
    try {
        const data = await sqsClient.send(
            new ReceiveMessageCommand({
                QueueUrl: SQS_EVENTS_QUEUE_URL,
                MaxNumberOfMessages: 10,
                WaitTimeSeconds: 20,
            }),
        );

        // จะ Log ก็ต่อเมื่อมีข้อความส่งมาจริงๆ เท่านั้น จะไม่ขึ้นรบกวนถ้าระบบว่างเปล่า
        if (data.Messages && data.Messages.length > 0) {
            console.log(
                `\n[SQS-EVENTS] 📥 Received ${data.Messages.length} message(s) from Events Queue.`,
            );

            for (const message of data.Messages) {
                try {
                    // แปลงข้อความที่มาจาก API Gateway
                    const body = JSON.parse(message.Body);
                    const event = body.Message
                        ? JSON.parse(body.Message)
                        : body;
                    const { eventType, data: evData } = event;

                    console.log(
                        `[SQS-EVENTS] 🔍 Event Type: ${eventType} | Search Report ID: [${evData?.source_report_id}] | Central Incident ID: [${evData?.incident_id}]`,
                    );

                    // ทำงานเฉพาะ Event ประเภท INCIDENT_CREATED
                    if (eventType === "INCIDENT_CREATED") {
                        const rid = evData.source_report_id;
                        if (rid && evData.incident_id) {
                            console.log(
                                `[SQS-EVENTS] 🔄 Trying to Update Database for Report: ${rid}...`,
                            );

                            // 1. นำ incident_id ไปผูกกับ Report ID ดั้งเดิมของเราและปรับเป็น SUCCESS
                            const updReport = await docClient.send(
                                new UpdateCommand({
                                    TableName: TABLE_INCIDENT_REPORTS,
                                    Key: { report_id: rid },
                                    UpdateExpression:
                                        "SET incident_id = :iid, sync_status = :s",
                                    ConditionExpression:
                                        "attribute_exists(report_id)",
                                    ExpressionAttributeValues: {
                                        ":iid": evData.incident_id,
                                        ":s": "SUCCESS",
                                    },
                                    ReturnValues: "ALL_NEW",
                                }),
                            );

                            // 2. อัปเดตตารางพื้นที่ (Areas) เพื่อแปะรหัส incident เข้าไป
                            if (updReport.Attributes?.area_id) {
                                await docClient.send(
                                    new UpdateCommand({
                                        TableName: TABLE_AREAS,
                                        Key: {
                                            area_id:
                                                updReport.Attributes.area_id,
                                        },
                                        UpdateExpression:
                                            "SET incident_id = :iid",
                                        ExpressionAttributeValues: {
                                            ":iid": evData.incident_id,
                                        },
                                    }),
                                );
                            }
                            console.log(
                                `[SQS-EVENTS] ✅ Successfully linked Incident [${evData.incident_id}] to Area [${updReport.Attributes?.area_id}]`,
                            );
                        } else {
                            console.warn(
                                `[SQS-EVENTS] ⚠️ Missing required fields (source_report_id or incident_id) in Payload.`,
                            );
                        }
                    }

                    // ลบข้อความทิ้งเมื่อประมวลผลเสร็จ
                    await sqsClient.send(
                        new DeleteMessageCommand({
                            QueueUrl: SQS_EVENTS_QUEUE_URL,
                            ReceiptHandle: message.ReceiptHandle,
                        }),
                    );
                    console.log(`[SQS-EVENTS] 🗑️ Message deleted from Queue.`);
                } catch (e) {
                    console.error("[SQS-EVENTS PROC ERROR]", e.message);
                }
            }
        }
    } catch (err) {
        console.error("[SQS-EVENTS POLL ERROR]", err.message);
    }
    // วนลูปทำงานต่อไป (จะหน่วงไว้ 1 วิ หรือขึ้นกับ WaitTimeSeconds 20 วิ)
    setTimeout(pollEventsQueue, 1000);
};

// Worker 2: ดึงคิวแจ้งอัปเดต/ปิดสถานะเหตุการณ์ (STATUS_CHANGED)
const pollStatusQueue = async () => {
    try {
        const data = await sqsClient.send(
            new ReceiveMessageCommand({
                QueueUrl: SQS_STATUS_QUEUE_URL,
                MaxNumberOfMessages: 10,
                WaitTimeSeconds: 20,
            }),
        );

        if (data.Messages && data.Messages.length > 0) {
            console.log(
                `\n[SQS-STATUS] 📥 Received ${data.Messages.length} message(s) from Status Queue.`,
            );

            for (const message of data.Messages) {
                try {
                    const body = JSON.parse(message.Body);
                    const event = body.Message
                        ? JSON.parse(body.Message)
                        : body;
                    const { eventType, data: evData } = event;

                    console.log(
                        `[SQS-STATUS] 🔍 Event Type: ${eventType} | Target Incident ID: [${evData?.incident_id}] | New Status: [${evData?.new_status}]`,
                    );

                    // ทำงานเฉพาะ Event ประเภท STATUS_CHANGED
                    if (eventType === "STATUS_CHANGED") {
                        if (
                            evData.new_status === "CLOSED" ||
                            evData.new_status === "RESOLVED"
                        ) {
                            console.log(
                                `[SQS-STATUS] 🔄 Resolving Incident in Database...`,
                            );
                            // 1. ค้นหาว่าเหตุการณ์นี้ (incident_id) เกิดขึ้นในพื้นที่ใด
                            const scan = await docClient.send(
                                new ScanCommand({
                                    TableName: TABLE_INCIDENT_REPORTS,
                                    FilterExpression: "incident_id = :iid",
                                    ExpressionAttributeValues: {
                                        ":iid": evData.incident_id,
                                    },
                                }),
                            );

                            if (scan.Items?.length > 0) {
                                const areaId = scan.Items[0].area_id;

                                // 2. ปิดจ็อบที่ตาราง Report (ปรับสถานะเป็น CLOSED)
                                await docClient.send(
                                    new UpdateCommand({
                                        TableName: TABLE_INCIDENT_REPORTS,
                                        Key: {
                                            report_id: scan.Items[0].report_id,
                                        },
                                        UpdateExpression:
                                            "SET sync_status = :s, resolved_at = :t",
                                        ExpressionAttributeValues: {
                                            ":s": "CLOSED",
                                            ":t": new Date().toISOString(),
                                        },
                                    }),
                                );

                                // 3. เคลียร์ค่า incident_id ในพื้นที่เกิดเหตุกลับเป็น Null
                                await docClient.send(
                                    new UpdateCommand({
                                        TableName: TABLE_AREAS,
                                        Key: { area_id: areaId },
                                        UpdateExpression:
                                            "SET incident_id = :n",
                                        ExpressionAttributeValues: {
                                            ":n": null,
                                        },
                                    }),
                                );
                                console.log(
                                    `[SQS-STATUS] ✅ Successfully CLOSED Incident [${evData.incident_id}] and cleared Area [${areaId}]`,
                                );
                            } else {
                                console.warn(
                                    `[SQS-STATUS] ⚠️ Incident ID [${evData.incident_id}] not found in our database. Ignored.`,
                                );
                            }
                        } else {
                            console.log(
                                `[SQS-STATUS] ℹ️ Status is ${evData.new_status}, no action required on Area table.`,
                            );
                        }
                    }

                    // ลบข้อความทิ้งเมื่อประมวลผลเสร็จ
                    await sqsClient.send(
                        new DeleteMessageCommand({
                            QueueUrl: SQS_STATUS_QUEUE_URL,
                            ReceiptHandle: message.ReceiptHandle,
                        }),
                    );
                    console.log(`[SQS-STATUS] Message deleted from Queue.`);
                } catch (e) {
                    console.error("[SQS-STATUS PROC ERROR]", e.message);
                }
            }
        }
    } catch (err) {
        console.error("[SQS-STATUS POLL ERROR]", err.message);
    }
    // วนลูปทำงานต่อไป
    setTimeout(pollStatusQueue, 1000);
};

// --- 6. API Public & Server Start ---
app.get("/api/v1/monitor-disaster/areas/:area_id", async (req, res) => {
    try {
        const getRes = await docClient.send(
            new GetCommand({
                TableName: TABLE_AREAS,
                Key: { area_id: req.params.area_id },
            }),
        );
        if (!getRes.Item)
            return res
                .status(404)
                .json({ error: "Area not found", traceId: req.traceId });
        res.status(200).json({ ...getRes.Item, traceId: req.traceId });
    } catch (err) {
        res.status(500).json({ error: err.message, traceId: req.traceId });
    }
});

app.get("/api/v1/monitor-disaster/areas", async (req, res) => {
    try {
        const response = await docClient.send(
            new ScanCommand({ TableName: TABLE_AREAS }),
        );
        res.status(200).json({ areas: response.Items, traceId: req.traceId });
    } catch (err) {
        res.status(500).json({ error: err.message, traceId: req.traceId });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(
        `DisasterMonitoring (v1) Operational State Ready on port ${PORT}`,
    );

    pollEventsQueue();
    pollStatusQueue();
});
