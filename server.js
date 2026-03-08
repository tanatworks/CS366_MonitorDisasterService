const express = require("express");
const crypto = require("crypto");

const app = express();
app.use(express.json());

// In-memory database variables
const db = {};
const auditLog = [];

// Helper Function: Calculate disaster status based on water level
const calculateDisasterStatus = (waterLevel) => {
    if (waterLevel >= 150) return "CRITICAL";
    if (waterLevel >= 100) return "WARNING";
    if (waterLevel >= 50) return "WATCH";
    return "NORMAL";
};

// Asynchronous: Publish event to notification service (simulated with setTimeout)
const publishEvent = (
    areaId,
    prevStatus,
    currStatus,
    waterLevel,
    rainfall,
    trigger,
) => {
    if (prevStatus === currStatus) return;

    const event = {
        eventId: crypto.randomUUID(),
        messageType: "DisasterStatusChanged",
        publishedAt: new Date().toISOString(),
        body: {
            area_id: areaId,
            previous_status: prevStatus,
            new_status: currStatus,
            water_level_cm: waterLevel,
            rainfall_mm: rainfall,
            triggered_by: trigger,
            triggered_at: new Date().toISOString(),
        },
    };

    auditLog.push(event);

    setTimeout(() => {
        console.log(
            "\n[ASYNC EVENT] Notification Service Triggered:\n",
            JSON.stringify(event, null, 2),
        );
    }, 500);
};

// Background Job: Check Outdated Data (runs every 1 minute)
setInterval(() => {
    const now = new Date();
    Object.keys(db).forEach((area_id) => {
        const area = db[area_id];
        const lastUpdatedDate = new Date(area.last_updated);
        const diffMinutes = (now - lastUpdatedDate) / (1000 * 60);

        if (diffMinutes > 15 && !area.is_outdated) {
            db[area_id].is_outdated = true;
            console.log(
                `\n[SYSTEM WARNING] Area ${area_id} data is outdated (>15 mins). Flag set to true.`,
            );
        } else if (diffMinutes <= 15 && area.is_outdated) {
            db[area_id].is_outdated = false;
        }
    });
}, 60000);

// API #1 [POST]: Ingest Data
app.post("/api/monitor-disaster/ingest", (req, res) => {
    const { area_id, source_api, water_level_cm, rainfall_mm, timestamp } =
        req.body;

    if (
        !area_id ||
        !source_api ||
        !timestamp ||
        typeof water_level_cm !== "number" ||
        typeof rainfall_mm !== "number"
    ) {
        return res.status(400).json({
            error: { code: "VALIDATION_ERROR", message: "Invalid input" },
        });
    }

    const area = db[area_id] || {
        area_id,
        disaster_status: "NORMAL",
        is_manual_override: false,
        last_updated: "2000-01-01",
    };

    if (new Date(timestamp) <= new Date(area.last_updated)) {
        return res.status(200).json({
            message: "Old data ignored",
            updated_status: area.disaster_status,
        });
    }

    let new_status = calculateDisasterStatus(water_level_cm);

    // Concurrency Control: Lock the status if manually overridden
    if (area.is_manual_override) {
        new_status = area.disaster_status;
    }

    const prev_status = area.disaster_status;

    db[area_id] = {
        ...area,
        water_level_cm,
        rainfall_mm,
        disaster_status: new_status,
        source_api,
        is_outdated: false,
        last_updated: timestamp,
    };

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
});

// API #2 [GET]: Get Area Status
app.get("/api/monitor-disaster/areas/:area_id", (req, res) => {
    const area = db[req.params.area_id];

    if (!area) {
        return res.status(404).json({
            error: { code: "NOT_FOUND", message: "Area ID not found" },
        });
    }

    // Now returns is_manual_override so you can verify it's locked
    res.status(200).json({
        area_id: area.area_id,
        disaster_status: area.disaster_status,
        water_level_cm: area.water_level_cm,
        is_outdated: area.is_outdated || false,
        is_manual_override: area.is_manual_override || false,
        status_description: area.status_description || null,
        last_updated: area.last_updated,
    });
});

// API #4 [GET]: Get All Areas (Dashboard)
app.get("/api/monitor-disaster/areas", (req, res) => {
    const allAreas = Object.values(db).map((area) => ({
        area_id: area.area_id,
        disaster_status: area.disaster_status,
        water_level_cm: area.water_level_cm,
        is_outdated: area.is_outdated || false,
        is_manual_override: area.is_manual_override || false,
        status_description: area.status_description || null,
        last_updated: area.last_updated,
    }));

    res.status(200).json(allAreas);
});

// API #3 [PATCH]: Manually Override Status
app.patch("/api/monitor-disaster/areas/:area_id/status", (req, res) => {
    const { disaster_status, status_description, overridden_by } = req.body;
    const { area_id } = req.params;

    const validStatuses = ["NORMAL", "WATCH", "WARNING", "CRITICAL"];

    if (
        !validStatuses.includes(disaster_status) ||
        !status_description ||
        !overridden_by
    ) {
        return res.status(400).json({
            error: { code: "VALIDATION_ERROR", message: "Invalid input" },
        });
    }

    const area = db[area_id] || {
        area_id,
        water_level_cm: 0,
        rainfall_mm: 0,
        disaster_status: "NORMAL",
    };

    const prev_status = area.disaster_status;

    db[area_id] = {
        ...area,
        disaster_status,
        status_description,
        is_manual_override: true, // This flag is set to true
        last_updated: new Date().toISOString(),
    };

    publishEvent(
        area_id,
        prev_status,
        disaster_status,
        area.water_level_cm,
        area.rainfall_mm,
        overridden_by,
    );

    res.status(200).json({ message: "Status overridden successfully" });
});

// DEBUG API: Dump everything from memory
app.get("/api/monitor-disaster/debug/db", (req, res) => {
    res.status(200).json({
        total_areas: Object.keys(db).length,
        database: db,
        audit_log: auditLog,
    });
});

const PORT = 3000;
app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});
