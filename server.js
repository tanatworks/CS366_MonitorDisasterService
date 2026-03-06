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

// Helper Function: Publish Async Event
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

// API #1: Ingest Data (POST /api/monitor-disaster/ingest)
app.post("/api/monitor-disaster/ingest", (req, res) => {
    const { area_id, source_api, water_level_cm, rainfall_mm, timestamp } =
        req.body;

    // Validation
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

    // Retrieve existing data or set default
    const area = db[area_id] || {
        area_id,
        disaster_status: "NORMAL",
        is_manual_override: false,
        last_updated: "2000-01-01",
    };

    // Idempotency: Ignore older or duplicated data
    if (new Date(timestamp) <= new Date(area.last_updated)) {
        return res.status(200).json({
            message: "Old data ignored",
            updated_status: area.disaster_status,
        });
    }

    // Calculate new status
    let new_status = calculateDisasterStatus(water_level_cm);

    // Concurrency Control: Retain status if manually overridden by Dispatcher
    if (area.is_manual_override) {
        new_status = area.disaster_status;
    }

    const prev_status = area.disaster_status;

    // Save to Database
    db[area_id] = {
        ...area,
        water_level_cm,
        rainfall_mm,
        disaster_status: new_status,
        source_api,
        last_updated: timestamp,
    };

    // Publish Event
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

// API #2: Get Area Status (GET /api/monitor-disaster/areas/:area_id)
app.get("/api/monitor-disaster/areas/:area_id", (req, res) => {
    const area = db[req.params.area_id];

    if (!area) {
        return res.status(404).json({
            error: { code: "NOT_FOUND", message: "Area ID not found" },
        });
    }

    res.status(200).json({
        area_id: area.area_id,
        disaster_status: area.disaster_status,
        water_level_cm: area.water_level_cm,
        is_outdated: area.is_outdated || false,
        last_updated: area.last_updated,
    });
});

// API #3: Override Status (PATCH /api/monitor-disaster/areas/:area_id/status)
app.patch("/api/monitor-disaster/areas/:area_id/status", (req, res) => {
    const { disaster_status, status_description, overridden_by } = req.body;
    const { area_id } = req.params;

    const validStatuses = ["NORMAL", "WATCH", "WARNING", "CRITICAL"];

    // Validation
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

    // Update state and set manual override flag
    db[area_id] = {
        ...area,
        disaster_status,
        status_description,
        is_manual_override: true,
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

const PORT = 3000;
app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});
