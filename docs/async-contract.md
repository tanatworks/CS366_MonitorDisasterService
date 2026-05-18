# Asynchronous Event Contract

เอกสารนี้อธิบายรูปแบบของ Event ที่ระบบ MonitoringDisaster จะทำการ Publish ออกไปเมื่อสถานะภัยพิบัติมีการเปลี่ยนแปลง

## Message Contract #1: Publish Disaster Incident Reported

| ข้อมูลทั่วไป | รายละเอียด |
| :--- | :--- |
| **Message Name** | DisasterStatusChanged |
| **Interaction Style** | Publish-Subscribe (Fire-and-forget) |
| **Producer** | DisasterMonitoring Service |
| **Consumer** | Notification Service (และบริการอื่นๆ ที่เกี่ยวข้อง) |
| **Broker** | Amazon SNS |
| **Topic ARN** | `arn:aws:sns:us-east-1:<AWS_ACCOUNT_ID>:MonitoringDisaster-Topic` |
| **Version** | v1 |

### คำอธิบาย
กระจายข่าว (Publish Event) อัปเดตสถานการณ์แบบ Asynchronous ทุกครั้งที่พื้นที่ใดพื้นที่หนึ่งมีการเปลี่ยนระดับความรุนแรง (NORMAL ⇄ WATCH ⇄ WARNING ⇄ CRITICAL)

ระบบจะทำงานแบบ Non-blocking โดยพ่น Event แจ้งเตือนออกไปที่ Amazon SNS ทันทีพร้อมแนบพิกัด (area_id) และระดับผลกระทบ (impact_level) เพื่อให้ระบบปลายทางนำข้อมูลไปประมวลผลต่อได้ทันที โดยระบบจะไม่หยุดรอเพื่อขอรับรหัส `incident_id` (กระบวนการรับรหัสเหตุการณ์จะถูกแยกไปจัดการผ่าน SQS)

### Message Format

**Headers (Metadata บน SNS/SQS)**
- `messageType`: `DisasterIncidentReported`
- `eventId`: UUID (สร้างใหม่ทุกครั้งเพื่อป้องกันการส่งซ้ำ)
- `publishedAt`: ISO-8601 datetime

**Payload (JSON)**
```json
{
  "event_id": "123e4567-e89b-12d3-a456-426614174000",
  "timestamp": "2026-04-29T15:05:00.000Z",
  "event_type": "DisasterStatusChanged",
  "data": {
    "area_id": "TH-BKK-001",
    "old_status": "WARNING",
    "new_status": "CRITICAL",
    "incident_id": null,
    "impact_level": 4
  }
}
```

### Data Dictionary

| Field | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `event_id` | UUID | Y | รหัสอ้างอิงการเปลี่ยนสถานะ (จาก logId ใน AuditLogs) ใช้ตรวจสอบการประมวลผลซ้ำ (Deduplication) |
| `timestamp` | Datetime | Y | วันที่และเวลาที่เกิดการเปลี่ยนแปลง (ISO-8601) |
| `event_type` | String | Y | ประเภทของเหตุการณ์ (คือ "DisasterStatusChanged" เสมอ) |
| `data` | Object | Y | ก้อนข้อมูลหลักที่เกี่ยวข้องกับการเปลี่ยนสถานะ |
| `data.area_id` | String | Y | รหัสพื้นที่เกิดเหตุ อ้างอิงตาม Location Service |
| `data.old_status` | String | Y | สถานะภัยพิบัติก่อนหน้า เพื่อเช็ค State Transition |
| `data.new_status` | String | Y | สถานะภัยพิบัติใหม่ (NORMAL, WATCH, WARNING, CRITICAL) |
| `data.incident_id` | UUID | N | รหัสอ้างอิงเหตุการณ์กลาง (Global ID) (เป็น null หากยังไม่ได้รับ Webhook กลับมา) |
| `data.impact_level` | Number | Y | ระดับความรุนแรงที่แปลงจาก Status (1 ถึง 4) |

---

## Message Contract #2: Subscribe Incident Created

| ข้อมูลทั่วไป | รายละเอียด |
| :--- | :--- |
| **Message Name** | INCIDENT_CREATED |
| **Interaction Style** | Worker Queue (Pull / Long Polling) |
| **Producer** | IncidentTracking Service (GCP) |
| **Consumer** | DisasterMonitoring Service (Worker 1: Linker Worker) |
| **Channel** | `monitor-disaster-events-queue` (Amazon SQS) |

### คำอธิบาย
ใช้สำหรับรับรหัส `incident_id` (Global ID) ที่ระบบส่วนกลางสร้างขึ้น เพื่อนำมาผูกกับรายงานท้องถิ่น (`source_report_id`) และพื้นที่ (`area_id`) ในฐานข้อมูลของ MonitoringDisaster

### Message Format (JSON)
```json
{
  "eventType": "INCIDENT_CREATED",
  "data": {
    "incident_id": "inc-859c77de-6435-51d2-9ea9-d6529323c21a",
    "source_report_id": "b46618db-234b-5544-8843-09748b99d525"
  }
}
```

---

## Message Contract #3: Subscribe Status Changed

| ข้อมูลทั่วไป | รายละเอียด |
| :--- | :--- |
| **Message Name** | STATUS_CHANGED |
| **Interaction Style** | Worker Queue (Pull / Long Polling) |
| **Producer** | IncidentTracking Service (GCP) |
| **Consumer** | DisasterMonitoring Service (Worker 2: Resolver Worker) |
| **Channel** | `monitor-disaster-status-queue` (Amazon SQS) |

### คำอธิบาย
ใช้สำหรับรับแจ้งการอัปเดตสถานะของเหตุการณ์จากส่วนกลาง หากสถานะเป็น `CLOSED` หรือ `RESOLVED` ระบบ MonitoringDisaster จะทำการปลดล็อคพื้นที่ (`incident_id = null`) เพื่อให้กลับมารับข้อมูลจากเซ็นเซอร์ได้ตามปกติ

### Message Format (JSON)
```json
{
  "eventType": "STATUS_CHANGED",
  "data": {
    "incident_id": "inc-859c77de-6435-51d2-9ea9-d6529323c21a",
    "new_status": "CLOSED"
  }
}
```
