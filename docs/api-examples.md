# API Examples

## 1. POST /api/monitor-disaster/ingest

**Request:**

```json
{
    "area_id": "TH-BKK-001",
    "area_name": "Bangkok - Don Mueang",
    "source_api": "RID-API",
    "water_level_cm": 120.5,
    "rainfall_mm": 80.0,
    "timestamp": "2026-03-08T15:05:00Z"
}
```

**Response (200 OK):**

```json
{
    "area_id": "TH-BKK-001",
    "area_name": "Bangkok - Don Mueang",
    "source_api": "RID-API",
    "water_level_cm": 120.5,
    "rainfall_mm": 80.0,
    "timestamp": "2026-03-08T15:05:00Z"
}
```

## 2. PATCH /api/monitor-disaster/areas/TH-BKK-001/status

**Request:**

```json
{
    "disaster_status": "CRITICAL",
    "status_description": "Evacuation needed immediately",
    "overridden_by": "dispatcher_tanat"
}
```

**Response (200 OK):**

```json
{
    "message": "Status overridden successfully"
}
```
