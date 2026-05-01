# API Contracts

Base URL: `https://p4j0q5vplh.execute-api.us-east-1.amazonaws.com`

## Authentication

Protected routes require the following header:

| Header      | Value              | Description                        |
| :---------- | :----------------- | :--------------------------------- |
| `X-Api-Key` | `disaster-monitoring-9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6` | API Key for service authentication |

---

## 1. Ingest External Data

| Field  | Value                           |
| :----- | :------------------------------ |
| Name   | Ingest External Data            |
| Method | POST                            |
| Path   | `/api/v1/monitor-disaster/ingest` |
| Type   | Synchronous                     |

- **Description:** ใช้รับข้อมูลระดับน้ำและฝนจากเซ็นเซอร์ (IoT) หรือ API ภายนอกแบบเรียลไทม์ เพื่อนำมาประมวลผลและปรับสถานะภัยพิบัติ (NORMAL, WATCH, WARNING, CRITICAL) อัตโนมัติ

**Headers**
```
Content-Type: application/json
x-api-key: <sensor_secret_key>
```

**Request Body Schema:**
- `area_id` (String, Required): รหัสพื้นที่
- `area_name` (String, Required): ชื่อพื้นที่
- `source_api` (String, Required): แหล่งที่มาของข้อมูล
- `water_level_cm` (Number, Required, ≥ 0): ระดับน้ำ (เซนติเมตร)
- `rainfall_mm` (Number, Required, ≥ 0): ปริมาณน้ำฝน (มิลลิเมตร)
- `timestamp` (Number, Required): Unix timestamp จากเซ็นเซอร์
- `geo_location` (Object, Required): พิกัด `{ "lat": Number, "lon": Number }`

**Response Headers**
- `X-Trace-Id`: `<uuid>`

**Response**

- **Success (200 OK):** กรณีบันทึกข้อมูลและอัปเดตสถานะสำเร็จ
```json
{
  "updated_status": "CRITICAL",
  "sync_status": "PENDING_INCIDENT",
  "traceId": "<uuid>"
}
```

- **Success (200 OK):** กรณีส่งข้อมูลวิกฤตซ้ำขณะที่ยังมี Incident เดิมเปิดอยู่ (Bypass)
```json
{
  "updated_status": "CRITICAL",
  "sync_status": "BYPASSED_ACTIVE_INCIDENT",
  "traceId": "<uuid>"
}
```

- **Success (200 OK):** กรณีข้อมูลเก่า ไม่บันทึกซ้ำ (Out-of-order message)
```json
{
  "message": "Out-of-order data ignored",
  "traceId": "<uuid>"
}
```

- **Error (401 Unauthorized):** กรณีไม่ได้แนบ X-Api-Key หรือรหัสผิด
```json
{
  "error": "UNAUTHORIZED",
  "traceId": "<uuid>"
}
```

- **Error (500 Internal Server Error):**
```json
{
  "error": "...",
  "traceId": "<uuid>"
}
```

**Dependency / Reliability**
- **Outbound Call:** เมื่อระบบประเมินสถานะเข้าสู่เกณฑ์ CRITICAL จะเรียกใช้งาน `POST /v1/reports` ของ Report Ingestion & Verification Service (`https://d8a7ds12a2.execute-api.us-east-1.amazonaws.com/dev/v1/reports`)
- **Explicit Timeout:** บังคับตั้งค่าการรอคอยสูงสุด (Timeout) ขาออกที่ 30 วินาที
- **Reliability:** หากเรียก Service ภายนอกล้มเหลว ระบบจะบันทึกข้อมูลลงตาราง `Disaster_IncidentReports` ด้วยสถานะ `PENDING_RETRY` และให้ Cron Job ทำการ Retry (Exponential Backoff) ทุกๆ 5 นาที
- **Idempotency:** ส่งค่า Trace ID ไปใน Header `X-IncidentTNX-Id` ไปยังปลายทางเพื่อป้องกันการเปิดตั๋วเหตุการณ์ซ้ำซ้อน

---

## 2. Get Area Status

| Field  | Value                                   |
| :----- | :-------------------------------------- |
| Name   | Get Area Status                         |
| Method | GET                                     |
| Path   | `/api/v1/monitor-disaster/areas/{area_id}` |
| Type   | Synchronous                             |

- **Description:** ดึงข้อมูลสถานการณ์น้ำและสถานะภัยพิบัติล่าสุดสำหรับ Frontend หรือ Citizen App

**Request Parameters**
- `area_id` (Path, String, Required)

**Headers**
```
Accept: application/json
```

**Response Headers**
- `X-Trace-Id`: `<uuid>`

**Response**

- **Success (200 OK):**
```json
{
  "area_id": "TH-BKK-001",
  "area_name": "Bangkok - Don Mueang",
  "disaster_status": "WARNING",
  "incident_id": "019C774D-1AC5-758B-AE95-5CD4AEB89258",
  "water_level_cm": 120.5,
  "rainfall_mm": 50.0,
  "is_outdated": false,
  "last_updated": "2026-02-21T10:00:00.000Z",
  "traceId": "<uuid>"
}
```

- **Error (404 Not Found):**
```json
{
  "error": "Area not found",
  "traceId": "<uuid>"
}
```

**Dependency / Reliability**
- ไม่เรียก service อื่น
- Idempotent (Read-only)
- Timeout: 30s

---

## 3. Override Disaster Status

| Field  | Value                         |
| :----- | :---------------------------- |
| Name   | Override Disaster Status      |
| Method | PATCH                         |
| Path   | `/api/v1/monitor-disaster/areas/{area_id}/status` |
| Type   | Synchronous                   |

- **Description:** สำหรับ Dispatcher ปรับสถานะด้วยตนเอง (Manual Override) มีลำดับความสำคัญสูงกว่าระบบอัตโนมัติ (Sensor)

**Headers**
```
X-Api-Key: <secret_key>
Content-Type: application/json
```

**Request Body Schema:**
- `disaster_status` (String, Required): ต้องอยู่ใน [NORMAL, WATCH, WARNING, CRITICAL]
- `status_description` (String, Required): เหตุผลการเปลี่ยนสถานะ
- `overridden_by` (String, Required): รหัสเจ้าหน้าที่

**Response Headers**
- `X-Trace-Id`: `<uuid>`

**Response**

- **Success (200 OK):**
```json
{
  "message": "Status overridden",
  "sync_status": "PENDING_INCIDENT",
  "traceId": "<uuid>"
}
```

- **Error (404 Not Found):**
```json
{
  "error": "Area not found",
  "traceId": "<uuid>"
}
```

**Dependency / Reliability**
- **Outbound Call:** หากปรับเป็น CRITICAL จะเรียกใช้ `POST /v1/reports` เพื่อเปิดเหตุการณ์ฉุกเฉิน (`https://d8a7ds12a2.execute-api.us-east-1.amazonaws.com/dev/v1/reports`)
- **Reliability:** ทำงานคู่กับ Outbox Pattern หากเพื่อนล่ม จะ Mark เป็น `PENDING_RETRY`
- **Concurrency Control:** เมื่ออัปเดตสำเร็จ จะปรับค่า `is_manual_override = true` เพื่อป้องกัน Sensor เขียนทับ

---

## 4. List All Areas

| Field  | Value                         |
| :----- | :---------------------------- |
| Name   | List All Areas                |
| Method | GET                           |
| Path   | `/api/v1/monitor-disaster/areas` |
| Type   | Synchronous                   |

- **Description:** ดึงรายการพื้นที่ทั้งหมดพร้อมสถานะปัจจุบัน เพื่อแสดงผลบน Dashboard (Composite API)

**Headers**
```
Accept: application/json
```

**Response**
- **Success (200 OK):**
```json
{
  "areas": [
    {
      "area_id": "TH-BKK-001",
      "disaster_status": "WARNING",
      "water_level_cm": 120.5,
      "is_outdated": false,
      "last_updated": "2026-02-21T10:00:00.000Z"
    }
  ],
  "traceId": "<uuid>"
}
```

---

## 5. Get Area Historical Trends

| Field  | Value                                         |
| :----- | :-------------------------------------------- |
| Name   | Get Area Historical Trends                    |
| Method | GET                                           |
| Path   | `/api/v1/monitor-disaster/areas/{area_id}/history` |
| Type   | Synchronous                                   |

- **Description:** ดึงข้อมูลประวัติย้อนหลัง (คิวรีจากตาราง Disaster_AuditLogs) สำหรับวิเคราะห์แนวโน้มและแสดงกราฟ

**Request Parameters**
- `area_id` (Path, String, Required)
- `hours` (Query, Number, Optional): จำนวนชั่วโมงย้อนหลัง (Default: 24)

**Response**
- **Success (200 OK):**
```json
{
  "area_id": "TH-BKK-001",
  "timeframe_hours": 24,
  "history": [
    {
      "timestamp": "2026-03-08T15:05:00Z",
      "water_level_cm": 120.5,
      "rainfall_mm": 80.0,
      "disaster_status": "WARNING"
    }
  ]
}
```
