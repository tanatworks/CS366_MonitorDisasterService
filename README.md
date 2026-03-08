# monitor-disaster-service

Microservice สำหรับรับข้อมูลสภาพแวดล้อมแบบเรียลไทม์ (ระดับน้ำ, ปริมาณฝน) ประเมินความรุนแรงของสถานการณ์ และกระจายข่าวสาร (Asynchronous Events) ไปยังระบบที่เกี่ยวข้อง

## การติดตั้งและใช้งานเบื้องต้น (Quick Start)

```bash
git clone https://github.com/tanatworks/monitor-disaster-service.git
cd monitor-disaster-service
npm install
node server.js
```

ระบบจะเริ่มทำงานที่ http://localhost:3000

## API Endpoints

| Method    | Endpoint                                      | คำอธิบายการทำงาน                                                                                    |
| :-------- | :-------------------------------------------- | :-------------------------------------------------------------------------------------------------- |
| **POST**  | `/api/monitor-disaster/ingest`                | รับข้อมูลจากเซนเซอร์ (ระดับน้ำ, ปริมาณฝน) และประเมินสถานะภัยพิบัติอัตโนมัติ                         |
| **GET**   | `/api/monitor-disaster/areas/:area_id`        | ดึงข้อมูลและสถานะล่าสุดของพื้นที่ที่ระบุ                                                            |
| **GET**   | `/api/monitor-disaster/areas`                 | ดึงข้อมูลสถานะของทุกพื้นที่ในระบบ (สำหรับทำหน้า Dashboard)                                          |
| **PATCH** | `/api/monitor-disaster/areas/:area_id/status` | บังคับเปลี่ยนสถานะโดยเจ้าหน้าที่ (Manual Override) ระบบจะล็อคสถานะไว้และเพิกเฉยต่อข้อมูลจากเซนเซอร์ |
| **GET**   | `/api/monitor-disaster/debug/db`              | ตรวจสอบข้อมูลดิบใน In-memory Database และประวัติ Event ทั้งหมด                                      |

## System Features

- **Concurrency Control:** ล็อคสถานะของระบบทันทีเมื่อมีการสั่งการด้วยโหมด Manual (is_manual_override: true)
- **Idempotency:** ป้องกันข้อมูลเซนเซอร์ที่เก่ากว่าหรือซ้ำซ้อนมาเขียนทับข้อมูลปัจจุบัน โดยตรวจสอบจาก Timestamp
- **Resiliency Job:** มีระบบทำงานเบื้องหลังเพื่อตรวจจับข้อมูลขาดการติดต่อ หากเกิน 15 นาที ระบบจะปรับสถานะเป็น is_outdated: true โดยอัตโนมัติ
