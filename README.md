# CS366_MonitorDisasterService

MonitoringDisaster Service เป็นระบบต้นน้ำที่ทำหน้าที่รับข้อมูลสภาพแวดล้อม (Ingestion) แบบ Real-time เช่น ระดับน้ำ และปริมาณน้ำฝน เพื่อประเมินความรุนแรงของสถานการณ์ภัยพิบัติในแต่ละพื้นที่ พร้อมทั้งกระจายข่าวสารในรูปแบบ Asynchronous Events ไปยังระบบอื่น ๆ ที่เกี่ยวข้อง เพื่อเตรียมการรับมือได้อย่างทันท่วงที

## Service Owner
นาย ธนัช เกิดทิพย์ รหัสนักศึกษา 6609611980 ภาคปกติ

## System Architecture
**Main components:**
* **AWS Application Load Balancer (ALB)** – ทำหน้าที่เป็นประตูหน้าบ้าน (Entry Point) และกระจายทราฟฟิกไปยังระบบเบื้องหลัง
* **Amazon ECS (Fargate)** – รันบริการ Microservice ในรูปแบบ Containerized Node.js Application
* **Amazon DynamoDB** – จัดเก็บข้อมูลสถานะพื้นที่ (Areas), บันทึกประวัติ (Audit Logs) และรายการอุบัติการณ์ (Incident Reports)
* **Amazon SNS** – ทำหน้าที่เป็น Message Broker สำหรับกระจายข่าวสารแบบ Pub/Sub (Fan-out) ไปยัง Service ของเพื่อนคนอื่น ๆ

## API Endpoints

| Method    | Endpoint                                      | คำอธิบายการทำงาน                                                                                    |
| :-------- | :-------------------------------------------- | :-------------------------------------------------------------------------------------------------- |
| **POST**  | `/api/monitor-disaster/ingest`                | รับข้อมูลจากเซนเซอร์ (ระดับน้ำ, ปริมาณฝน) และประเมินสถานะภัยพิบัติอัตโนมัติ                         |
| **GET**   | `/api/monitor-disaster/areas/:area_id`        | ดึงข้อมูลและสถานะล่าสุดของพื้นที่ที่ระบุ                                                            |
| **GET**   | `/api/monitor-disaster/areas`                 | ดึงข้อมูลสถานะของทุกพื้นที่ในระบบ (สำหรับทำหน้า Dashboard)                                          |
| **GET**   | `/api/monitor-disaster/debug/db`              | ตรวจสอบข้อมูลดิบใน In-memory Database และประวัติ Event ทั้งหมด                                      |
| **PATCH** | `/api/monitor-disaster/areas/:area_id/status` | บังคับเปลี่ยนสถานะโดยเจ้าหน้าที่ (Manual Override) ระบบจะล็อคสถานะไว้และเพิกเฉยต่อข้อมูลจากเซนเซอร์ |


**Base URL:** `http://monitor-disaster-alb-1866264118.us-east-1.elb.amazonaws.com`

### API Contract 1: Ingest Environmental Data
**POST** `/api/monitor-disaster/ingest`

ใช้สำหรับรับข้อมูลจากเซนเซอร์เพื่อประเมินสถานะภัยพิบัติ หากระดับน้ำถึงเกณฑ์วิกฤต ระบบจะบันทึกข้อมูลและ Publish Event ไปยัง SNS โดยอัตโนมัติ

**Example request:**
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

**Example response:**
- **Status:** 200 OK

- **Response Body:**
```json
{
    "message": "Data ingested successfully",
    "updated_status": "WARNING"
}
```

### API Contract 2: Get Area Status by ID
**GET** `/api/monitor-disaster/areas/{area_id}`

ใช้ดึงข้อมูลรายละเอียดและสถานะภัยพิบัติล่าสุดของพื้นที่ที่ระบุ

**Example response:**
- **Status:** 200 OK

- **Response Body:**
```json
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

### API Contract 3: List All Areas (Dashboard)
**GET** `/api/monitor-disaster/areas`

ใช้สำหรับดึงรายการพื้นที่ทั้งหมดในระบบ เพื่อนำไปแสดงผลบน Dashboard

**Example response:**
- **Status:** 200 OK

- **Response Body:**
```json
[
    {
        "area_id": "TH-BKK-001",
        "area_name": "Bangkok - Don Mueang",
        "disaster_status": "WARNING",
        "water_level_cm": 120.5,
        "is_outdated": false,
        "last_updated": "2026-03-08T15:05:00Z"
    },
    {
        "area_id": "TH-BKK-002",
        "area_name": "Bangkok - Lak Si",
        "disaster_status": "NORMAL",
        "water_level_cm": 45.0,
        "is_outdated": true,
        "last_updated": "2026-03-08T10:00:00Z"
    }
]
```

### API Contract 4: Debug Database 
**GET** `/api/monitor-disaster/debug/db`

ดึงข้อมูลดิบทั้งหมดจาก DynamoDB (Areas, Audit Logs, Incident Reports) เพื่อตรวจสอบความถูกต้องของระบบ

**Example response:**
- **Status:** 200 OK

- **Response Body:**
```json
{
    "areas": [ /* ข้อมูลพื้นที่ทั้งหมด */ ],
    "audit_logs": [
        {
            "logId": "a1b2c3d4...",
            "area_id": "TH-BKK-001",
            "previous_status": "NORMAL",
            "new_status": "WARNING",
            "triggered_by": "SYSTEM_AUTO",
            "createdAt": "2026-03-08T15:05:00Z"
        }
    ],
    "incident_reports": [
        {
            "incident_id": "uuid-123",
            "sync_status": "SUCCESS",
            "impact_level": 3,
            "reported_at": "2026-03-08T15:05:00Z"
        }
    ]
}
```

### API Contract 5: Manual Status Override
**PATCH** `/api/monitor-disaster/areas/{area_id}/status`

ใช้สำหรับให้เจ้าหน้าที่ (Dispatcher) บังคับเปลี่ยนสถานะพื้นที่ด้วยตนเองในกรณีฉุกเฉิน ซึ่งระบบจะล็อคสถานะไว้และเพิกเฉยต่อข้อมูลจากเซนเซอร์ชั่วคราว

**Example request:**
```json
{
    "disaster_status": "CRITICAL",
    "status_description": "Evacuation needed immediately",
    "overridden_by": "dispatcher_tanat"
}
```
**Example response:**
- **Status:** 200 OK

- **Response Body:**
```json
{
    "message": "Status overridden successfully"
}
```

## Event Flow

```
1. ข้อมูลเซ็นเซอร์ (จำลองยิงผ่าน Postman)
       │
       ▼
2. AWS ALB (Application Load Balancer)
       │   
       ▼
3. Amazon ECS Fargate (Node.js Microservice)
       │   
       │
       ├──▶ 4. Amazon DynamoDB (NoSQL Database)
       │    
       │        
       ▼
5. Amazon SNS (Simple Notification Service)
       │   - (Publisher) เมื่อน้ำท่วม ระบบเราจะตะโกนแจ้งเตือนผ่านช่องทางนี้แค่ "ครั้งเดียว"
       │
       ├──▶ 6. Amazon SQS ของเพื่อน A 
       │    
       │
       └──▶ 7. Amazon SQS ของเพื่อน B
```
## System Features

- **Concurrency Control:** ล็อคสถานะของระบบทันทีเมื่อมีการสั่งการด้วยโหมด Manual (is_manual_override: true)
- **Idempotency:** ป้องกันข้อมูลเซนเซอร์ที่เก่ากว่าหรือซ้ำซ้อนมาเขียนทับข้อมูลปัจจุบัน โดยตรวจสอบจาก Timestamp
- **Resiliency Job:** มีระบบทำงานเบื้องหลังเพื่อตรวจจับข้อมูลขาดการติดต่อ หากเกิน 15 นาที ระบบจะปรับสถานะเป็น is_outdated: true โดยอัตโนมัติ

## Technologies Used
- **Backend:** Node.js (Express)
- **Cloud Infrastructure:** AWS ECS Fargate, ALB
- **Database:** Amazon DynamoDB
- **Messaging System:** Amazon SNS
- **Containerization:** Docker
