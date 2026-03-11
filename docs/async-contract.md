# Asynchronous Event Contract

เอกสารนี้อธิบายรูปแบบของ Event ที่ระบบ MonitoringDisaster จะทำการ Publish ออกไปเมื่อสถานะภัยพิบัติมีการเปลี่ยนแปลง

## Event Publisher

- **Service:** MonitoringDisaster Service
- **Broker:** Amazon SNS
- **Topic ARN:** `arn:aws:sns:us-east-1:462632273029:MonitoringDisaster-Topic`
- **Trigger Condition:** เมื่อ `disaster_status` ของพื้นที่มีการเปลี่ยนแปลง (เช่น จาก NORMAL -> WARNING) หรือเมื่อเจ้าหน้าที่สั่ง Manual Override

## Event Payload (JSON)

ข้อความที่ถูกส่งเข้า SNS (และ SQS ของผู้ Subscribe จะได้รับ) มีโครงสร้างดังนี้:

```json
{
    "incident_id": "b1b86d1b-7a19-4b41-893d-XXXXXXXXXXXX",
    "incident_type": "flood",
    "exact_location": "TH-BKK-001",
    "impact_level": 3,
    "status": "Reported",
    "reported_by": "SYSTEM_AUTO",
    "created_at": "2026-03-08T15:05:00.000Z",
    "details": {
        "water_level_cm": 120.5,
        "rainfall_mm": 80,
        "previous_status": "NORMAL"
    }
}
```

## Data Dictionary
* impact_level (Number): ระดับผลกระทบ (1 = NORMAL, 2 = WATCH, 3 = WARNING, 4 = CRITICAL)
* reported_by (String): ระบุว่าถูกสั่งงานโดยระบบอัตโนมัติ (SYSTEM_AUTO) หรือชื่อของเจ้าหน้าที่ (dispatcher_name)