# Data Models (Amazon DynamoDB)

ระบบจำลองการเก็บข้อมูลแบบ NoSQL โดยแบ่งออกเป็น 3 ตารางหลัก ดังนี้:

## 1. Table: `Disaster_Areas`

เก็บข้อมูลสถานะปัจจุบันของแต่ละพื้นที่

- `area_id` (String) - **Partition Key**
- `area_name` (String)
- `water_level_cm` (Number)
- `rainfall_mm` (Number)
- `disaster_status` (String) - ["NORMAL", "WATCH", "WARNING", "CRITICAL"]
- `is_manual_override` (Boolean) - `true` หากถูกล็อคสถานะโดยเจ้าหน้าที่
- `source_api` (String)
- `is_outdated` (Boolean) - `true` หากไม่มีข้อมูลส่งมาเกิน 15 นาที
- `last_updated` (String/ISO8601)

## 2. Table: `Disaster_AuditLogs`

เก็บประวัติการเปลี่ยนแปลงสถานะทั้งหมด (History)

- `logId` (String / UUID) - **Partition Key**
- `area_id` (String)
- `previous_status` (String)
- `new_status` (String)
- `water_level_cm` (Number)
- `rainfall_mm` (Number)
- `triggered_by` (String)
- `createdAt` (String/ISO8601)

## 3. Table: `Disaster_IncidentReports`

เก็บรายการเหตุการณ์สำหรับใช้งานคู่กับรูปแบบ Outbox Pattern เพื่อรับประกันการส่ง Event

- `incident_id` (String / UUID) - **Partition Key**
- `area_id` (String)
- `incident_type` (String) - ค่าเริ่มต้นคือ "flood"
- `impact_level` (Number)
- `sync_status` (String) - สถานะการ Publish Event ["PENDING", "SUCCESS", "FAILED"]
- `reported_at` (String/ISO8601)
