# CS366_MonitorDisasterService

## Service Owner
นาย ธนัช เกิดทิพย์ รหัสนักศึกษา 6609611980 ภาคปกติ

## 1. Project Overview (ภาพรวมระบบ)
MonitoringDisaster Service เป็นระบบต้นน้ำที่ทำหน้าที่รับข้อมูลสภาพแวดล้อม (Ingestion) แบบ Real-time เช่น ระดับน้ำ และปริมาณน้ำฝน เพื่อประเมินความรุนแรงของสถานการณ์ภัยพิบัติในแต่ละพื้นที่ พร้อมทั้งกระจายข่าวสารในรูปแบบ Asynchronous Events ไปยังระบบอื่น ๆ ที่เกี่ยวข้อง เพื่อเตรียมการรับมือได้อย่างทันท่วงที


## 2. Architecture & Infrastructure (สถาปัตยกรรมและโครงสร้างพื้นฐาน)
สถาปัตยกรรมถูกออกแบบภายใต้หลักการ Decoupling และ High Availability โดยใช้ทรัพยากรบน AWS ดังนี้:
- Entry Point: Amazon API Gateway ทำหน้าที่เป็นช่องทางรับ Request แบบรวมศูนย์ ทั้งจากการเรียก API สากลและการรับ Webhook
- Compute Layer: Amazon ECS (Fargate) ประกอบด้วย Worker 3 ส่วน ได้แก่ Main API Task (ประมวลผล Ingress/Egress หลัก), Events SQS Poller และ Status SQS Poller
- Storage Layer: Amazon DynamoDB ฐานข้อมูล NoSQL สำหรับจัดเก็บสถานะพื้นที่ (Areas), ประวัติการทำงาน (AuditLogs), และประวัติการประเมินเหตุการณ์ (IncidentReports)
- Message Broker: Amazon SQS (รองรับ Inbound Webhook ข้ามคลาวด์) และ Amazon SNS (รองรับ Outbound Publish-Subscribe)

## 3. Core Capabilities & System Features (คุณสมบัติหลักของระบบ)

* Hybrid Interaction Flow:
  - Downstream (Sync): เมื่อสถานะวิกฤต จะยิง HTTP POST ออกไปยัง Report Ingestion Service ทันที
  - Upstream (Async Pull): Background Workers ทำการ Long Polling จากคิว `events-queue` และ `status-queue` เพื่อรอรับ Webhook ตั๋วเหตุการณ์จาก GCP
  - Downstream (Async Push): กระจาย Event แจ้งระดับความรุนแรงพื้นที่ (Impact Level) ออกไปยังปลายทางผ่าน Amazon SNS แบบ Fire-and-Forget
* Resiliency & Failure Handling (Outbox Pattern):
  - หากการส่งข้อมูลข้ามบริการล้มเหลว (เช่น Timeout) ระบบจะจัดการผ่าน Local Database โดยตั้งสถานะเป็น `PENDING_RETRY`
  - Cron Job จะทำงานทุก 5 นาทีโดยใช้กลไก Adaptive Exponential Backoff เพื่อดึงข้อมูลมายิงซ้ำและทำ ID Swapping เมื่อสำเร็จ โดยไม่ทำให้กระบวนการหลักสะดุด
* Data Integrity & Idempotency:
  - ป้องกันการประมวลผลข้อมูลเก่าหรือผิดลำดับ (Out-of-order) ด้วยการทวนสอบ `last_timestamp` (หากเก่ากว่าระบบจะตอบกลับ HTTP 409 Conflict)
  - ใช้ `req.traceId` (หรือ `X-Amzn-Trace-Id`) ตลอดทั้ง Transaction เพื่อรักษา Correlation ข้าม Microservices
* Concurrency Control:
  - ล็อคความสำคัญของสถานะทันทีเมื่อเข้าสู่โหมด Manual (`is_manual_override: true`)

## 4. API Endpoints (v1)

ระบบบังคับใช้มาตรการความปลอดภัยด้วย Header `X-Api-Key` ในทุก Request

| Method | Endpoint | คำอธิบายการทำงาน |
| :--- | :--- | :--- |
| **POST** | `/api/v1/monitor-disaster/ingest` | รับข้อมูลเซนเซอร์เรียลไทม์ ประเมินสถานะอัตโนมัติ หากสถานะเป็น **CRITICAL** จะทริกเกอร์การเปิดรายงานแบบ Non-blocking |
| **GET** | `/api/v1/monitor-disaster/areas` | ดึงข้อมูลภาพรวมสถานะทุกพื้นที่แบบ Synchronous (สำหรับ Dashboard) |
| **GET** | `/api/v1/monitor-disaster/areas/:area_id` | ดึงข้อมูลและสถานะล่าสุดเจาะจงรายพื้นที่ |
| **PATCH** | `/api/v1/monitor-disaster/areas/:area_id/status` | บังคับเปลี่ยนสถานะโดยเจ้าหน้าที่ (**Manual Override**) ระบบจะเพิกเฉยข้อมูลเซนเซอร์จนกว่าจะมีการปลดล็อค |
