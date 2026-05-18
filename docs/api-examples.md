# API Examples

ชุดตัวอย่างการใช้งาน API สำหรับสถานการณ์ต่างๆ (อ้างอิงตาม Postman Collection)

## 1. Ingest Environmental Data

### 1.1 Normal Data (SAFE ZONE)
พื้นที่ปกติ ไม่มีการกระตุ้นระบบรายงานเหตุการณ์

**Request:**
```json
{
    "area_id": "TH-BKK-006",
    "area_name": "Thammasat Rangsit",
    "water_level_cm": 20.0,
    "rainfall_mm": 10.0,
    "timestamp": 1708560000000,
    "source_api": "BKK-Water-Sensor-V1",
    "geo_location": {
        "lat": 13.961,
        "lon": 101.5986
    },
    "media_urls": [
        "https://cctv.bkk/donmueang/normal.jpg"
    ]
}
```

**Response (200 OK):**
```json
{
    "updated_status": "NORMAL",
    "sync_status": "NOT_REQUIRED",
    "traceId": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
}
```

### 1.2 Critical Data (CRITICAL ZONE)
ระดับน้ำเข้าเกณฑ์วิกฤต ระบบจะทำการเปิด Incident ไปยังระบบส่วนกลาง

**Request:**
```json
{
    "area_id": "TH-BKK-011",
    "area_name": "กรุงเทพฯ - เขตลาดกระบัง",
    "water_level_cm": 165.0,
    "rainfall_mm": 110.0,
    "timestamp": 1708560000000,
    "source_api": "BKK-Water-Sensor-V1",
    "geo_location": {
        "lat": 13.7225,
        "lon": 100.7816
    },
    "media_urls": [
        "https://cctv.bkk/latkrabang/flood_critical.jpg"
    ]
}
```

**Response (200 OK):**
```json
{
    "updated_status": "CRITICAL",
    "sync_status": "PENDING_INCIDENT",
    "traceId": "yyyyyyyy-yyyy-yyyy-yyyy-yyyyyyyyyyyy"
}
```

### 1.3 Bypass Active Incident
กรณีส่งข้อมูลวิกฤตซ้ำในพื้นที่ที่ยังมีตั๋วเหตุการณ์เปิดอยู่ ระบบจะไม่ยิงซ้ำซ้อน

**Request (ส่งซ้ำหลังข้อ 1.2):**
```json
{
    "area_id": "TH-BKK-011",
    "water_level_cm": 170.0,
    "rainfall_mm": 115.0,
    "timestamp": 1708560600000
}
```

**Response (200 OK):**
```json
{
    "updated_status": "CRITICAL",
    "sync_status": "BYPASSED_ACTIVE_INCIDENT",
    "traceId": "zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz"
}
```

---

## 2. Manual Status Override
เจ้าหน้าที่ (Dispatcher) ปรับสถานะเป็น CRITICAL ด้วยตนเองแม้เซ็นเซอร์จะยังไม่ถึงเกณฑ์

**Request:**
```json
{
    "disaster_status": "CRITICAL",
    "status_description": "คันกั้นน้ำชำรุด น้ำทะลักเข้าเกาะเมืองฉับพลัน",
    "overridden_by": "dispatcher_01",
    "geo_location": {
        "lat": 14.3532,
        "lon": 100.5681
    },
    "media_urls": [
        "https://official-app.th/uploads/ayutthaya_leak.mp4"
    ]
}
```

**Response (200 OK):**
```json
{
    "message": "Status overridden",
    "sync_status": "PENDING_INCIDENT",
    "traceId": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
}
```

---

## 3. Security (Unauthorized Access)
กรณีไม่ได้แนบ X-Api-Key หรือรหัสไม่ถูกต้อง

**Response (401 Unauthorized):**
```json
{
    "error": "UNAUTHORIZED",
    "traceId": "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"
}
```
