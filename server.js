const express = require("express");
const crypto = require("crypto");
const Database = require("better-sqlite3");
const app = express();
app.use(express.json());

const db = new Database("disaster.db");

// Database Schema Initialization
// 1. Area Disaster Operational State
db.exec(`
    CREATE TABLE IF NOT EXISTS areas (
        area_id TEXT PRIMARY KEY,
        area_name TEXT NOT NULL,
        water_level_cm REAL NOT NULL,
        rainfall_mm REAL NOT NULL,
        disaster_status TEXT NOT NULL,
        status_description TEXT,
        is_outdated INTEGER NOT NULL DEFAULT 0,
        is_manual_override INTEGER NOT NULL DEFAULT 0,
        source_api TEXT NOT NULL,
        last_updated TEXT NOT NULL
    )`);

// 2. Area Disaster Audit Log
db.exec(`
    CREATE TABLE IF NOT EXISTS audit_logs (
        logId TEXT PRIMARY KEY,
        area_id TEXT NOT NULL,
        previous_status TEXT NOT NULL,
        new_status TEXT NOT NULL,
        water_level_cm REAL NOT NULL,
        rainfall_mm REAL NOT NULL,
        triggered_by TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        FOREIGN KEY (area_id) REFERENCES areas(area_id)
    )`);

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

    const eventId = crypto.randomUUID();
    const createdAt = new Date().toISOString();

    db.prepare(
        `
        INSERT INTO audit_logs (logId, area_id, previous_status, new_status, water_level_cm, rainfall_mm, triggered_by, createdAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
    ).run(
        eventId,
        areaId,
        prevStatus,
        currStatus,
        waterLevel,
        rainfall,
        trigger,
        createdAt,
    );

    const event = {
        eventId,
        messageType: "DisasterStatusChanged",
        publishedAt: createdAt,
        body: {
            area_id: areaId,
            previous_status: prevStatus,
            new_status: currStatus,
            water_level_cm: waterLevel,
            rainfall_mm: rainfall,
            triggered_by: trigger,
            triggered_at: createdAt,
        },
    };

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
    const areas = db.prepare("SELECT * FROM areas").all();

    areas.forEach((area) => {
        const lastUpdatedDate = new Date(area.last_updated);
        const diffMinutes = (now - lastUpdatedDate) / (1000 * 60);

        if (diffMinutes > 15 && area.is_outdated === 0) {
            db.prepare(
                "UPDATE areas SET is_outdated = 1 WHERE area_id = ?",
            ).run(area.area_id);
            console.log(
                `\n[SYSTEM WARNING] Area ${area.area_id} data is outdated (>15 mins). Flag set to true.`,
            );
        } else if (diffMinutes <= 15 && area.is_outdated === 1) {
            db.prepare(
                "UPDATE areas SET is_outdated = 0 WHERE area_id = ?",
            ).run(area.area_id);
        }
    });
}, 60000);

// API #1 [POST]: Ingest Data
app.post("/api/monitor-disaster/ingest", (req, res) => {
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
            error: { code: "VALIDATION_ERROR", message: "Invalid input" },
        });
    }

    const defaultAreaName = area_name || `Area ${area_id}`;

    let area = db.prepare("SELECT * FROM areas WHERE area_id = ?").get(area_id);

    if (!area) {
        area = {
            disaster_status: "NORMAL",
            is_manual_override: 0,
            last_updated: "2000-01-01",
        };
    } else if (new Date(timestamp) <= new Date(area.last_updated)) {
        return res.status(200).json({
            message: "Old data ignored",
            updated_status: area.disaster_status,
        });
    }

    let new_status = calculateDisasterStatus(water_level_cm);

    // Concurrency Control: Lock the status if manually overridden
    if (area.is_manual_override === 1) {
        new_status = area.disaster_status;
    }

    const prev_status = area.disaster_status;

    db.prepare(
        `
        INSERT INTO areas (area_id, area_name, water_level_cm, rainfall_mm, disaster_status, is_manual_override, source_api, is_outdated, last_updated)
        VALUES (@area_id, @area_name, @water_level_cm, @rainfall_mm, @disaster_status, @is_manual_override, @source_api, 0, @last_updated)
        ON CONFLICT(area_id) DO UPDATE SET
            area_name = excluded.area_name,
            water_level_cm = excluded.water_level_cm,
            rainfall_mm = excluded.rainfall_mm,
            disaster_status = excluded.disaster_status,
            source_api = excluded.source_api,
            is_outdated = 0,
            last_updated = excluded.last_updated
    `,
    ).run({
        area_id,
        area_name: defaultAreaName,
        water_level_cm,
        rainfall_mm,
        disaster_status: new_status,
        is_manual_override: area.is_manual_override,
        source_api,
        last_updated: timestamp,
    });

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
    const area = db
        .prepare("SELECT * FROM areas WHERE area_id = ?")
        .get(req.params.area_id);

    if (!area) {
        return res.status(404).json({
            error: { code: "NOT_FOUND", message: "Area ID not found" },
        });
    }

    // Now returns is_manual_override so you can verify it's locked
    res.status(200).json({
        ...area,
        is_outdated: area.is_outdated === 1,
        is_manual_override: area.is_manual_override === 1,
    });
});

// API #4 [GET]: Get All Areas (Dashboard)
app.get("/api/monitor-disaster/areas", (req, res) => {
    const areas = db.prepare("SELECT * FROM areas").all();

    const formattedAreas = areas.map((area) => ({
        ...area,
        is_outdated: area.is_outdated === 1,
        is_manual_override: area.is_manual_override === 1,
    }));

    res.status(200).json(formattedAreas);
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

    const area = db
        .prepare("SELECT * FROM areas WHERE area_id = ?")
        .get(area_id);

    if (!area) {
        return res.status(404).json({
            error: {
                code: "NOT_FOUND",
                message: "Cannot override. Area ID not found in system.",
            },
        });
    }

    db.prepare(
        `
        UPDATE areas 
        SET disaster_status = ?, status_description = ?, is_manual_override = 1, last_updated = ?
        WHERE area_id = ?
    `,
    ).run(
        disaster_status,
        status_description,
        new Date().toISOString(),
        area_id,
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
});

// DEBUG API: Dump everything from memory
app.get("/api/monitor-disaster/debug/db", (req, res) => {
    const allAreas = db.prepare("SELECT * FROM areas").all();
    const allLogs = db.prepare("SELECT * FROM audit_logs").all();
    res.status(200).json({
        total_areas: allAreas.length,
        areas: allAreas,
        total_logs: allLogs.length,
        audit_logs: allLogs,
    });
});

const PORT = 3000;
app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});
