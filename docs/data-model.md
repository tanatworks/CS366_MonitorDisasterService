# Data Models (Amazon DynamoDB)

ระบบ MonitoringDisaster ใช้ Amazon DynamoDB ในการจัดเก็บข้อมูลหลัก โดยแบ่งออกเป็น 3 ตารางเพื่อรองรับการทำงานแบบ Event-driven และ Transactional Outbox

---

## 1. Area Disaster Operational State (ตาราง `Disaster_Areas`)
ข้อมูลตารางหลักที่เก็บสถานะล่าสุดของแต่ละพื้นที่ เพื่อใช้ในการตัดสินใจและแสดงผลแบบเรียลไทม์

| Field Name | Type | Required | Description | Example |
| :--- | :--- | :--- | :--- | :--- |
| **area_id** | string | Y (PK) | รหัสพื้นที่ (อ้างอิง Location Service) | TH-BKK-001 |
| area_name | string | Y | ชื่อพื้นที่เพื่อความสะดวกในการแสดงผล | Bangkok - Don Mueang |
| disaster_status | enum | Y | สถานะภัยพิบัติ (NORMAL / WATCH / WARNING / CRITICAL) | WARNING |
| incident_id | uuid | N | รหัส Incident จากส่วนกลาง (รอรับจาก SQS Webhook) | 550e8400-e29b-...33 |
| water_level_cm | float | Y | ระดับน้ำล่าสุด ณ ปัจจุบัน | 120.50 |
| rainfall_mm | float | Y | ปริมาณน้ำฝนสะสมล่าสุด | 185.20 |
| geo_location | object | Y | พิกัดทางภูมิศาสตร์ `{ "lat": Number, "lon": Number }` | {"lat": 13.91, "lon": 100.59} |
| status_description | string | N | รายละเอียด (ระบบใส่ให้ หรือ Dispatcher พิมพ์) | Updated via Sensor |
| is_outdated | boolean | Y | true ถ้าระบบไม่ได้รับ API อัปเดตเกิน 15 นาที | false |
| source_api | string | Y | รหัส API หรือแหล่งต้นทางที่ส่งข้อมูลมาให้ | IOT_SENSOR_V1 |
| is_manual_override | boolean | Y | true ถ้าระบุโดย Dispatcher (กันเซ็นเซอร์เขียนทับ) | false |
| last_timestamp | number | Y | Unix timestamp จากเซ็นเซอร์ ป้องกันข้อมูล Out-of-order | 1708560000000 |
| last_updated | datetime | Y | เวลาที่ข้อมูลแถวนี้มีการแก้ไขล่าสุดในระบบ | 2026-02-21T10:00:00Z |

---

## 2. Disaster Status Audit Log (ตาราง `Disaster_AuditLogs`)
ข้อมูลประวัติการเปลี่ยนแปลงสถานะ (History) เพื่อใช้ตรวจสอบย้อนหลัง และเป็นข้อมูลตั้งต้นสำหรับยิง Async Event แจ้งเตือนไปยัง SNS

| Field Name | Type | Required | Description | Example |
| :--- | :--- | :--- | :--- | :--- |
| **logId** | uuid | Y (PK) | รหัสบันทึกประวัติ (ใช้เป็น event_id ตอน Publish SNS) | 550e8400-e29b-... |
| incident_id | uuid | N | รหัส Incident จากส่วนกลาง ณ เวลาที่เกิด Log (ถ้ามี) | 550e8400-e29b-...33 |
| area_id | string | Y | อ้างอิงรหัสพื้นที่ที่เกิดการเปลี่ยนแปลง | TH-BKK-001 |
| previous_status | enum | Y | สถานะก่อนหน้า | WATCH |
| new_status | enum | Y | สถานะใหม่ที่ถูกเปลี่ยน | WARNING |
| water_level_cm | float | Y | ระดับน้ำ ณ เวลาที่บันทึกประวัตินี้ | 120.50 |
| rainfall_mm | float | Y | ปริมาณน้ำฝน ณ เวลาที่บันทึกประวัตินี้ | 185.20 |
| triggered_by | string | Y | รหัสผู้สั่งเปลี่ยน (Dispatcher) หรือ "SYSTEM_AUTO" | SYSTEM_AUTO |
| createdAt | datetime | Y | เวลาที่เกิดการเปลี่ยนแปลงสถานะ | 2026-02-21T10:00:00Z |

---

## 3. Incident Reports / Outbox (ตาราง `Disaster_IncidentReports`)
ตารางจัดการสถานะการยิง API ไปหาส่วนกลาง ทำหน้าที่เป็น Transactional Outbox รองรับระบบ Retry เมื่อ Network ขัดข้อง และรอจับคู่รหัสผ่าน SQS

| Field Name | Type | Required | Description | Example |
| :--- | :--- | :--- | :--- | :--- |
| **report_id** | string | Y (PK) | รหัสอ้างอิงของ Report (Local ID) เพื่อรอเปลี่ยนเป็นของจริง | temp-uuid หรือ r-12345 |
| incident_id | uuid | N | รหัส Incident อ้างอิงระบบส่วนกลาง (Global ID) เติมผ่าน SQS | 550e8400-e29b-...33 |
| area_id | string | Y | อ้างอิงรหัสพื้นที่ที่เกิดการเปลี่ยนแปลง | TH-BKK-001 |
| incident_type | string | Y | ประเภทของภัยพิบัติ (Service นี้กำหนดค่า "flood") | flood |
| incident_description | string | N | คำอธิบายเหตุการณ์ หรือข้อความจาก Dispatcher | [CRITICAL] พนังกั้นน้ำพัง... |
| impact_level | integer | Y | ระดับความรุนแรงตาม Schema กลาง (1-4) | 4 |
| threshold_water_cm | float | Y | ค่าระดับน้ำที่ทำให้ตัดสินใจเปิด Incident นี้ | 155.00 |
| threshold_rain_mm | float | Y | ค่าปริมาณฝนที่ทำให้ตัดสินใจเปิด Incident นี้ | 120.50 |
| geo_location | object | Y | พิกัดทางภูมิศาสตร์ {lat, lon} สำหรับรายงาน | {"lat": 13.91, "lon": 100.59} |
| media_urls | list | N | รายการ URL รูปภาพ/วิดีโอ (ถ้ามี) | ["http://image.jpg"] |
| report_source | string | Y | แหล่งข้อมูลที่สั่งเปิดเหตุการณ์ (IOT_SENSOR, OFFICIAL_APP) | IOT_SENSOR |
| reporter_id | string | Y | รหัสผู้รายงาน หรือชื่อเซ็นเซอร์ | sensor-th-bkk-001 |
| sync_status | enum | Y | สถานะเชื่อมต่อ (PENDING_RETRY, PENDING_INCIDENT, SUCCESS, CLOSED, FAILED_PERMANENTLY) | SUCCESS |
| idempotency_key | string | Y | Trace ID สำหรับตรวจสอบการยิงซ้ำ (Deduplication) | uuid-trace-1234 |
| retry_count | integer | Y | จำนวนรอบที่ Retry ไปแล้ว (สำหรับ Cron Job) | 0 |
| next_retry_time | number | N | Unix timestamp สำหรับรอบการยิงซ้ำครั้งถัดไป (Backoff) | 1708560300000 |
| remote_trace_id | string | N | Trace ID ที่ตอบกลับมาจากบริการส่วนกลาง | remote-uuid-5678 |
| reported_at | datetime | Y | เวลาที่ออกรายงาน Incident ฉบับนี้ | 2026-02-21T10:00:00Z |
| resolved_at | datetime | N | เวลาที่ได้รับสถานะ CLOSED จาก Webhook | 2026-02-22T10:00:00Z |
