# API Contracts

Base URL: `http://monitor-disaster-alb-1866264118.us-east-1.elb.amazonaws.com`

## 1. Ingest Environmental Data

| Field  | Value                           |
| :----- | :------------------------------ |
| Name   | Ingest environmental data       |
| Method | POST                            |
| Path   | `/api/monitor-disaster/ingest`  |
| Type   | Synchronous (with Async events) |

- **Description:** รับข้อมูลจากเซ็นเซอร์เพื่อประเมินสถานการณ์

**เมื่อระบบรับข้อมูลสำเร็จ:**

1. ระบบจะประเมินสถานะภัยพิบัติ (`NORMAL`, `WATCH`, `WARNING`, `CRITICAL`)
2. ระบบจะบันทึกข้อมูลลงใน **DynamoDB (ตาราง Disaster_Areas)**
3. หากสถานะมีการเปลี่ยนแปลง ระบบจะสร้างและส่ง **Asynchronous Event** ไปยัง Amazon SNS เพื่อแจ้งเตือนหน่วยงานที่เกี่ยวข้อง

- **Request Body Schema:**
    - `area_id` (String, Required): รหัสพื้นที่
    - `area_name` (String, Optional): ชื่อพื้นที่
    - `source_api` (String, Required): แหล่งที่มาของข้อมูล
    - `water_level_cm` (Number, Required): ระดับน้ำ (เซนติเมตร)
    - `rainfall_mm` (Number, Required): ปริมาณน้ำฝน (มิลลิเมตร)
    - `timestamp` (String/ISO8601, Required): เวลาที่วัดค่าได้

**Response**

- **success (200 OK)**

```
{
    "message": "Data ingested successfully",
    "updated_status": "WARNING"
}
```

- **success (Old data) (200 OK)**

```
{
    "message": "Old data ignored",
    "updated_status": "WARNING"
}
```

- **400 Bad Request**

```
{
    "error": {
        "code": "VALIDATION_ERROR",
        "message": "Invalid input"
    }
}
```

## 2. Get Area Status by ID

| Field  | Value                                   |
| :----- | :-------------------------------------- |
| Name   | Get area status detail                  |
| Method | GET                                     |
| Path   | `/api/monitor-disaster/areas/{area_id}` |
| Type   | Synchronous                             |

- **Description:** ดึงข้อมูลสถานะล่าสุดของพื้นที่ที่ระบุด้วย `area_id`

**Headers**

```
Accept: application/json
```

**Response**

- **success (200 OK)**

```
{
    "area_id": "TH-BKK-001",
    "area_name": "Bangkok - Don Mueang",
    "water_level_cm": 120.5,
    "rainfall_mm": 80.0,
    "disaster_status": "WARNING",
    "is_manual_override": false,
    "source_api": "RID-API",
    "is_outdated": false,
    "last_updated": "2026-03-08T15:05:00Z"
}
```

- **404 Not Found**

```
{
    "error": {
        "code": "NOT_FOUND",
        "message": "Area not found"
    }
}
```

## 3. List All Areas

| Field  | Value                         |
| :----- | :---------------------------- |
| Name   | List all disaster areas       |
| Method | GET                           |
| Path   | `/api/monitor-disaster/areas` |
| Type   | Synchronous                   |

- **Description:** ดึงข้อมูลทุกพื้นที่ในระบบ สำหรับนำไปทำ Dashboard

**Headers**

```
Accept: application/json
```

**Response**

- **success (200 OK)**

```
[
    {
        "area_id": "TH-BKK-001",
        "area_name": "Bangkok - Don Mueang",
        "disaster_status": "WARNING",
        "water_level_cm": 120.5,
        "is_outdated": false,
        "last_updated": "2026-03-08T15:05:00Z"
    }
]

## 4. Manual Status Override

| Field  | Value                         |
| :----- | :---------------------------- |
| Name   | Manual override area status       |
| Method | PATCH                           |
| Path   | `/api/monitor-disaster/areas/{area_id}/status` |
| Type   | Synchronous                   |

- **Description:** เปลี่ยนสถานะพื้นที่แบบ Manual โดยเจ้าหน้าที่
- อนุญาตให้เจ้าหน้าที่ (Dispatcher) บังคับเปลี่ยนสถานะภัยพิบัติของพื้นที่ (เช่น ในกรณีฉุกเฉินด่วน)
- ระบบจะเปลี่ยนค่า is_manual_override เป็น true ซึ่งจะล็อคสถานะไม่ให้อัปเดตอัตโนมัติจากข้อมูลเซ็นเซอร์

**Headers**

```

Accept: application/json

```

**Request**

**Response**

- **Request Body**

```

{
"disaster_status": "CRITICAL",
"status_description": "Evacuation needed immediately",
"overridden_by": "dispatcher_tanat"
}

```
- **success (200 OK)**
```

{
"message": "Status overridden successfully"
}

````
- **400 Bad Request**
```
{
    "error": {
        "code": "VALIDATION_ERROR",
        "message": "Invalid input"
    }
}
````

- **Request Body Schema:**
    - `disaster_status` (String, Required): ต้องเป็น "NORMAL", "WATCH", "WARNING", หรือ "CRITICAL"
    - `status_description` (String, Required): เหตุผลที่เปลี่ยนสถานะ
    - `overridden_by` (String, Required): ชื่อเจ้าหน้าที่

## 5. Debug Database

| Field  | Value                            |
| :----- | :------------------------------- |
| Name   | Debug Database Status            |
| Method | GET                              |
| Path   | `/api/monitor-disaster/debug/db` |
| Type   | Synchronous                      |

- **Description:** ดึงข้อมูลทั้งหมดจากฐานข้อมูล (In-memory/DynamoDB)

- **Response**
- **200 OK**

(ส่งคืนอ็อบเจกต์ JSON ที่ประกอบด้วย Array ของพื้นที่ (areas), ประวัติ (audit_logs), และเหตุการณ์ (incident_reports))
