# แผนระบบเว็บปลอดภัยครบวงจร (C# / Next.js): สมัครสมาชิก, Login, RBAC, Logging/Audit, Upload, Notification

> **สถานะ:** เอกสารด้านล่างเป็นแผนเดิมสำหรับระบบเต็มรูปแบบและไม่ใช่ข้อกำหนดของ implementation ปัจจุบันโดยตรง ระบบที่สร้างใน workspace นี้เป็น auth slice ด้วย Node.js/TypeScript และ Angular ตาม [README.md](./README.md) เท่านั้น เนื้อหาเดิมที่ขัดกับขอบเขตหรือ flow ปัจจุบัน (เช่น self-signup หรือ stack C# / Next.js) ถือเป็นข้อมูลอ้างอิงเก่า ไม่ใช่ behavior ที่ implement แล้ว
## ภาพรวมเอกสาร
เอกสารนี้รวมแผนระบบ 6 ส่วนที่ต่อยอดกันเป็นลำดับ เพื่อใช้เป็นแนวทางสร้างเว็บที่ปลอดภัย ตรวจสอบย้อนหลังได้ และดูแลง่าย 
ส่วน
ระบบ
เป้าหมายหลัก
1
สมัครสมาชิกและยืนยันอีเมล
สมัครได้จริง ยืนยันได้จริง กันบอทปั่น
2
Login ปลอดภัย
พิสูจน์ตัวตนอย่างปลอดภัยด้วย JWT + Refresh Token Rotation
3
RBAC
จัดการสิทธิ์แบบ Role/Permission ที่ดูแลง่าย
4
Logging และ Audit Trail
ตามรอยปัญหาได้ด้วย correlation_id
5
อัปโหลดไฟล์
รับไฟล์อย่างปลอดภัยและไม่พังง่าย
6
Notification
แจ้งเตือน In-app, Email, Push อย่างมืออาชีพ
ตัวเชื่อมกลางของทุกระบบคือ correlation_id, user_id, permission และ audit log

## ส่วนที่ 1 ระบบสมัครสมาชิกแบบยืนยันอีเมล ปลอดภัย และกันปั่น
### เป้าหมายของระบบนี้
สมัครได้จริง ยืนยันได้จริง โดนบอทปั่นยาก และดูแลสเกลการส่งอีเมลได้
### ขั้นที่ 1 ออกแบบตารางข้อมูลให้รองรับการยืนยัน
ตาราง users
- เก็บ email แบบ unique (แนะนำทำเป็น lowercase ก่อนเก็บ)
- มีช่อง email_verified_at (null แปลว่ายังไม่ยืนยัน)
- มี status เช่น pending, active, banned (ช่วยงานหลังบ้าน)
ตาราง email_verifications (หรือ verification_tokens)
- user_id
- token_hash (ห้ามเก็บ token ดิบ)
- expires_at
- used_at
- created_at
- request_ip และ user_agent (ช่วยตรวจพฤติกรรมผิดปกติ)
- purpose เช่น signup, change_email (กันปนกัน)
### ขั้นที่ 2 สร้าง Token ให้เดายาก และเก็บแบบ hash
แนวที่ปลอดภัย
- สร้าง token แบบสุ่ม 32-64 bytes แล้ว encode เป็น base64url
- เก็บใน DB เป็น hash เช่น SHA-256(token + server_pepper)
- pepper คือ secret ใน env ไม่เก็บใน DB
- ผลลัพธ์คือ DB หลุดก็เอา token ไปใช้ต่อไม่ได้
ตัวอย่างแนวคิด
- token_plain = randomBytes(32) แล้ว base64url
- token_hash = sha256(token_plain + PEPPER)
### ขั้นที่ 3 ทำลิงก์ยืนยันแบบใช้ครั้งเดียว (Single-use)
ลิงก์ในอีเมล: https://yourapp.com/verify-email?token=...&amp;email=...
ตอนกดลิงก์ ให้ทำขั้นตอนตามลำดับ
- หา user จาก email (normalize ให้ตรง)
- หาแถว token ที่ user_id ตรง และ purpose=signup
- เทียบ hash แล้วตรวจ used_at ต้องเป็น null
- ตรวจ expires_at ยังไม่หมดอายุ
- ผ่านแล้ว set used_at=now และ set users.email_verified_at=now
- เปลี่ยน status เป็น active
ทำใน transaction เดียวกัน เพื่อตัดปัญหากดซ้ำพร้อมกัน
### ขั้นที่ 4 ตั้งอายุ Token ให้พอดี และจัดการ token เก่า
- แนะนำหมดอายุ 15-30 นาที (เว็บทั่วไป)
- หรือ 1-2 ชั่วโมง (ถ้าเป็นระบบที่ผู้ใช้เปิดอีเมลช้า)
เวลาส่ง token ใหม่ ไม่ควรมี token active หลายอันพร้อมกันสำหรับ user เดียว ทำได้ 2 แบบ
- แบบ A: ลบหรือทำให้ token เก่าหมดสภาพทันที
- แบบ B: อนุญาต 1 อันล่าสุดเท่านั้น (invalidate อันก่อน)
### ขั้นที่ 5 กันสมัครซ้ำ และกันอีเมลซ้ำแบบไม่เผยข้อมูล
กติกา
- email ต้อง unique ใน users
- แต่การตอบกลับหน้าเว็บควรเหมือนกันเสมอเพื่อกันไล่เช็กอีเมล
- เช่น ส่งข้อความว่า "ถ้าอีเมลนี้ใช้งานได้ ระบบจะส่งลิงก์ยืนยันให้"
- ไม่บอกว่าอีเมลนี้มีอยู่แล้วหรือยัง
กรณีผู้ใช้สมัครแล้วแต่ยังไม่ยืนยัน เลือกได้
- อนุญาตให้ resend verification ได้ แต่ต้อง rate limit
- หรือยกเลิกบัญชี pending ที่เก่ามากๆ (เช่น 7 วัน) แล้วเปิดให้สมัครใหม่
### ขั้นที่ 6 ใส่ Rate Limit ให้ครบทุกจุดที่โดนปั่นง่าย
Endpoint
ตัวแปรที่ใช้จำกัด
ค่าเริ่มต้นที่แนะนำ
สมัครสมาชิก
ต่อ IP, ต่ออีเมล, ต่อ device fingerprint
5 ครั้ง / 10 นาที / IP
Resend verification
ต่ออีเมล
3 ครั้ง / 60 นาที / อีเมล
Verify token
ต่อ IP (กัน brute force token)
20 ครั้ง / 10 นาที / IP
ค่าทั้งหมดเป็นจุดเริ่มต้น แล้วค่อยปรับตามพฤติกรรมจริง
### ขั้นที่ 7 ส่งอีเมลแบบ Queue เพื่อไม่ให้เว็บช้าและกันโดนถล่ม
ตอนผู้ใช้กดสมัคร เว็บทำแค่
- สร้าง user pending
- สร้าง verification token
- enqueue job ส่งอีเมล แล้วตอบกลับทันที
Worker ทำหน้าที่
- ดึง job
- ยิง SMTP/Provider
- retry แบบมี backoff เช่น 1 นาที, 5 นาที, 15 นาที
- dead-letter queue ถ้าล้มเหลวหลายครั้ง
ข้อดี: ถ้าโดนบอทถล่ม request เว็บไม่ล่ม เพราะงานหนักไปอยู่ที่ worker
### ขั้นที่ 8 ป้องกันการเดา token และรั่วข้อมูลจาก URL
- ใช้ HTTPS ตลอด
- อย่าใส่ข้อมูลสำคัญอื่นใน query string
- token ต้องยาวพอและสุ่มจริง (CSPRNG)
- ถ้ากังวล token หลุดผ่าน referrer ให้ทำหน้า verify เป็น POST โดยให้หน้าเว็บรับ token แล้วโพสต์ไปเซิร์ฟเวอร์อีกที
### ขั้นที่ 9 ทำ Audit และ Monitoring ช่วยจับบอท
เก็บ event
- signup_requested
- verification_sent
- verification_success
- verification_failed
ดูสัญญาณผิดปกติ
- IP เดิมยิงหลายอีเมล
- โดเมนอีเมลแปลกๆ จำนวนมาก
- verify fail ถี่ๆ
แล้วค่อย block หรือเพิ่ม captcha เฉพาะกรณี
### ขั้นที่ 10 UX ที่ดีช่วยลดการกดซ้ำและลดโหลดระบบ
- หน้าแจ้งหลังสมัคร บอกให้เช็ก spam และมีปุ่ม resend พร้อม cooldown
- ถ้าลิงก์หมดอายุ ให้สร้าง token ใหม่และ invalidate อันเก่าอัตโนมัติ
### สรุปภาพรวม Flow ที่แนะนำ
สมัครสมาชิก → สร้าง user pending → สร้าง token hash + expires → enqueue ส่งอีเมล → ผู้ใช้กดลิงก์ → ตรวจหมดอายุ + ใช้ครั้งเดียว → activate
### ทริคเล็กที่หลายคนพลาด
- อย่าเก็บ token ดิบใน DB เด็ดขาด
- ทำ verification update แบบ transaction ไม่งั้นกดซ้ำอาจ active ได้หลายรอบใน log
- ตอบข้อความแบบเดียวกันเสมอเพื่อกัน enumeration

## ส่วนที่ 2 ระบบ Login ปลอดภัย (C# / Next.js)
### แนวคิดหลัก
- ใช้ JWT แบบ Access Token (อายุสั้น) + Refresh Token พร้อม Refresh Token Rotation เพื่อลดความเสี่ยงจากการขโมย token
- เก็บรหัสผ่านด้วย argon2id ร่วมกับ pepper
- ไม่เก็บ token ไว้ใน localStorage เพื่อลดความเสี่ยงจาก XSS (แนะนำ cookie แบบ HttpOnly, Secure, SameSite)
- ตั้งค่า Content Security Policy (CSP)
- ใช้ Rate Limiting กัน brute force โดยแนะนำให้ใช้ Redis เพื่อให้ทำงานแบบกระจายได้หลายเครื่อง
- เก็บความลับ (pepper, signing key) ใน Environment Variables หรือ Key Vault ไม่ฝังในโค้ด
### จุดเชื่อมกับส่วนสมัครสมาชิก
- ผู้ใช้ที่ status เป็น pending หรือ email_verified_at ยังเป็น null ต้อง login ไม่ได้ (หรือเข้าได้เฉพาะหน้าขอ resend verification)
- ข้อความตอบกลับตอน login ผิดพลาดต้องเป็นแบบทั่วไป ไม่บอกว่าอีเมลมีอยู่หรือไม่ เพื่อกัน enumeration เช่นเดียวกับตอนสมัคร
- ใช้ pepper และหลักการเก็บค่า hash แนวเดียวกันกับ verification token
### จุดเชื่อมกับระบบอื่น
- RBAC: หลัง login สำเร็จ ระบบบรรจุข้อมูลสิทธิ์ (permission) ของผู้ใช้ลงใน JWT claim หรือ permission cache
- Logging/Audit: ทุกเหตุการณ์ login/logout สร้าง correlation_id เริ่มต้นและบันทึก log ทันที
- Notification: เมื่อมี login ใหม่ เปลี่ยนอุปกรณ์ หรือเปลี่ยนรหัสผ่าน ระบบส่งแจ้งเตือนผ่าน Email, Push, In-app

## ส่วนที่ 3 ระบบจัดการสิทธิ์ผู้ใช้ (RBAC) แบบไม่ยุ่งยาก
### ภาพรวมที่ต้องมีเพื่อให้ใช้งานได้จริง
- Role = กลุ่มงาน เช่น Admin, Editor, Support
- Permission = สิทธิ์ย่อย เช่น user.read, user.write, post.publish
- User ได้ Role หนึ่งหรือหลายอัน แล้ว Role ผูก Permission อีกที
- แนวคิดนี้ทำให้ "เปลี่ยนสิทธิ์ทั้งทีม" แค่แก้ Role จุดเดียว
### Step 1 ออกแบบ Permission ให้เป็น "คำกริยา.ทรัพยากร"
ตัวอย่างที่ดี
- user.read, user.create, user.update, user.delete
- role.read, role.update
- post.read, post.publish
- billing.read
ควรตั้งชื่อให้สม่ำเสมอ และไม่ยาวเกินไป ถ้าระบบใหญ่แนะนำเพิ่ม prefix ตามโมดูล เช่น crm.lead.read
### Step 2 โครงสร้างฐานข้อมูลแบบที่ดูแลง่าย
ตารางหลักที่พอสำหรับ 90% ของเว็บ
- users
- roles
- permissions
- user_roles (user_id, role_id)
- role_permissions (role_id, permission_id)
- audit_logs
ถ้าอยากยืดหยุ่นมากขึ้น ค่อยเพิ่ม user_permissions ภายหลัง แต่เริ่มต้นให้ Role เป็นตัวหลักจะไม่รก
### Step 3 สร้าง "แหล่งความจริง" ของสิทธิ์ (Permission Cache)
ทุก request ไป join ตารางสิทธิ์หลายชั้นจะช้าเมื่อข้อมูลโต วิธีง่ายๆ
- ตอน login สร้างชุด permission ของ user แล้วเก็บไว้ใน session/JWT claim หรือ cache
- ถ้าใช้ JWT ให้ใส่เป็น array สั้นๆ หรือ hash/version ก็ได้
- ถ้าใช้ session/redis จะเปลี่ยนสิทธิ์แล้ว invalidate ง่ายกว่า
ทริคที่คนมักพลาด: ใส่ "permission_version" ใน user แล้วบังคับ refresh เมื่อเปลี่ยน role/permission
### Step 4 ทำ Middleware แบบอ่านง่ายและ composable
เป้าหมายคือแยก Authentication กับ Authorization ออกจากกันชัดๆ
- Authentication ตรวจว่า login แล้วไหม
- Authorization ตรวจว่ามี permission ไหม
รูปแบบการเรียกใช้ที่อ่านแล้วเข้าใจ
- requirePermission("post.publish")
- requireAnyPermission(["user.update","role.update"])
- requireRole("Admin")
อย่าผูก logic กับชื่อ route มากเกินไป เพราะ refactor แล้วพังง่าย
### Step 5 จัดการหน้า Admin สำหรับ Role/Permission ไม่ให้กลายเป็นงานใหญ่
มี 4 หน้าเท่านั้นก็พอเริ่มได้
- Users: รายชื่อผู้ใช้ + role ที่ได้รับ
- Roles: สร้าง/แก้ชื่อ role
- Role Permissions: เลือก permission ให้ role แบบ checklist
- Audit Logs: ดูการเปลี่ยนสิทธิ์และเหตุการณ์สำคัญ
### Step 6 เทคนิค UX ที่ช่วยลดความผิดพลาดของแอดมิน
- จัด permission เป็นหมวด เช่น User, Content, Billing
- มี search/filter หา permission ได้เร็ว
- มีปุ่ม "Select all ในหมวด" และ "Copy permissions จาก role อื่น"
- มี preview สรุปว่า Role นี้ทำอะไรได้บ้างก่อนกดบันทึก
- แสดง "ผลกระทบ" เช่น มีผู้ใช้กี่คนใช้ role นี้อยู่
### Step 7 หลักการสำคัญ: Default Deny และ Least Privilege
- ผู้ใช้ใหม่ควรได้ role ที่สิทธิ์น้อยที่สุดก่อนเสมอ
- อย่าให้ role กว้างๆ แบบ SuperUser กับทุกคนเพราะแก้ง่าย
- สร้าง role ตามงานจริง เช่น Support อ่านอย่างเดียว, Editor แก้คอนเทนต์ได้
### Step 8 Audit Log ที่มีประโยชน์จริง
Audit log ควรเก็บ
- actor_user_id: ใครเป็นคนทำ
- action: เช่น role.assign, role.permission.update
- target_type/target_id: เช่น user:123 หรือ role:5
- before/after: เป็น snapshot หรือ diff อย่างย่อ
- ip_address, user_agent
- created_at
ทริคที่ดีมาก: ใส่ "reason" เหตุผลการเปลี่ยนสิทธิ์ (เช่น ตาม ticket #)
### Step 9 เชื่อมกับระบบหลังบ้านแบบปลอดภัย
- จำกัดหน้า admin ด้วย role/permission แยกชุดจากระบบทั่วไป
- เปิดใช้ 2FA สำหรับกลุ่มที่แก้สิทธิ์ได้
- ทำ route แยก /admin และล็อก rate limit สำหรับ endpoint สำคัญ
### Step 10 Checklist ทดสอบก่อนขึ้นโปรดักชัน
- ผู้ใช้ไม่มี permission แล้วถูกบล็อกจริง
- สิทธิ์ที่เปลี่ยนแล้วมีผลทันที (หรือภายในเวลาที่กำหนด)
- ยกเลิก role แล้วไม่หลงเหลือสิทธิ์ค้าง
- Audit log เก็บครบ และค้นหาย้อนหลังได้
- มีบัญชี break-glass (ผู้ดูแลฉุกเฉิน) เก็บไว้อย่างปลอดภัย
### ตัวอย่างการ map Permission กับฟีเจอร์
ฟีเจอร์
Permission ที่ต้องมี
หน้า Users List
user.read
ปุ่ม Create User
user.create
ปุ่ม Reset Password
user.update และอาจมี permission แยก auth.reset_password
หน้า Billing
billing.read และ billing.update แยกกัน
### สรุปแนวทาง RBAC
- ใช้ Role เป็นศูนย์กลาง แล้ว Permission เป็นหน่วยย่อย
- ทำ middleware ให้เรียกใช้ง่ายและตรวจได้หลายแบบ
- มีหน้า admin เท่าที่จำเป็น พร้อม UX ลดความผิดพลาด
- ทำ audit log ที่ตอบคำถาม "ใครทำอะไร เมื่อไหร่ เพราะอะไร"
### ถ้าจะต่อยอดในอนาคต
- เพิ่ม ABAC (เงื่อนไขตามข้อมูล) เช่น อ่านเฉพาะของทีมตัวเอง
- เพิ่ม policy ตาม resource เช่น post ของตัวเองแก้ได้ แต่ของคนอื่นไม่ได้

## ส่วนที่ 4 ระบบบันทึก Log และ Audit Trail ที่ตามรอยปัญหาได้จริง
หลายทีมมี "Log เยอะ" แต่พอโปรดักชันล่มกลับ "ตามไม่เจอ" เพราะไม่มีโครงสร้างและไม่มีรหัสเชื่อมเหตุการณ์ แนวทางนี้ช่วยให้ Log ใช้ได้จริงทั้ง Debug, Incident, Security และ Compliance
### ขั้นที่ 1 แยกให้ชัด Log vs Audit Trail
- Log: เหตุการณ์เชิงเทคนิค เช่น request error, timeout, query ช้า, service down
- Audit Trail: การกระทำของผู้ใช้/ระบบที่มีผลกับข้อมูล เช่น สร้างคำสั่งซื้อ, เปลี่ยนสิทธิ์, ลบข้อมูล
หลักจำง่าย: Log เอาไว้ "ตามปัญหา" ส่วน Audit เอาไว้ "พิสูจน์ว่าใครทำอะไรเมื่อไหร่"
### ขั้นที่ 2 วางโครงสร้าง Log แบบอ่านง่ายและค้นง่าย
ใช้ Structured Logging เป็น JSON ทุกบรรทัด ไม่ใช่ข้อความยาวๆ
ฟิลด์ที่ควรมีเสมอ
- timestamp แบบ ISO-8601 และ timezone
- level เช่น DEBUG INFO WARN ERROR
- service/app name และ environment (prod/stage/dev)
- version หรือ git commit
- message สั้นๆ ที่สื่อความ
- event_name เช่น payment.charge_failed
- correlation_id สำหรับเชื่อมหลายบริการ
- request_id สำหรับ 1 request ต่อ 1 ID
- user_id (แบบไม่ใช่ข้อมูลส่วนตัวตรงๆ)
- ip (พิจารณา mask)
- latency_ms
- error_code และ stacktrace เฉพาะ error
### ขั้นที่ 3 ใส่ Correlation ID ให้ไหลไปทั้งระบบ
เป้าหมายคือ "คลิกหนึ่งครั้ง แล้วเห็นรอยทั้งหมดข้าม service ได้" ทำได้โดย
- รับ correlation_id จาก header ถ้ามี เช่น X-Correlation-Id
- ถ้าไม่มี ให้สร้างใหม่ (random/uuid)
- แปะกลับไปที่ response header ด้วย เพื่อให้ front-end และลูกค้าระบบอื่นตามได้
- ส่งต่อไปทุก downstream call (HTTP/gRPC/Queue message)
- เก็บ correlation_id ลงทุก log line ที่เกี่ยวข้อง
ตัวอย่างการไหลของ ID: Browser → API Gateway → User Service → Order Service → Payment Service โดยทุกจุดใช้ correlation_id เดียวกัน
### ขั้นที่ 4 เลือก "จุดที่ต้อง log" ไม่ใช่ log ทุกอย่าง
จุดขั้นต่ำที่ควรมี
- Request start (แบบย่อ) เฉพาะที่จำเป็น
- Request end พร้อม status code และ latency
- Error ทุกครั้ง พร้อม error_code และสาเหตุ
- External dependency call เช่น เรียก payment, email, storage
- Business milestones เช่น order_created, payment_success
- Rate limit หรือ auth failure เพื่อความปลอดภัย
หลีกเลี่ยง
- Log body เต็มๆ ของ request/response โดยไม่จำเป็น
- Log ข้อมูลบัตร, รหัสผ่าน, token, OTP เด็ดขาด
### ขั้นที่ 5 ทำ Audit Trail ให้ "แก้ไขไม่ได้" และเชื่อถือได้
Audit record ที่ดีควรมี
- actor_type เช่น user/admin/system
- actor_id
- action เช่น update_role, delete_order
- resource_type และ resource_id
- result success/fail และ reason
- before/after เฉพาะฟิลด์สำคัญ (ระวังข้อมูลส่วนตัว)
- timestamp
- source เช่น web/api/batch
- correlation_id เชื่อมกับ log ฝั่งเทคนิค
แนวป้องกันการแก้ไขย้อนหลัง
- แยก storage ของ audit ออกจาก database หลัก
- ตั้งสิทธิ์เขียนได้แต่ลบ/แก้ไม่ได้ (append-only)
- ทำ retention และ backup ชัดเจน
### ขั้นที่ 6 เก็บแบบรวมศูนย์ (Centralized Logging)
แนวคิดคือ "ทุกเครื่องส่ง log ไปที่เดียว" องค์ประกอบที่พบบ่อย
- Application ส่งออกเป็น stdout หรือ file
- Agent/Collector เก็บและส่งต่อ เช่น Fluent Bit / Vector / Filebeat
- Storage/Search เช่น Elasticsearch/OpenSearch หรือ Loki
- Dashboard/Query เช่น Kibana/Grafana
ทริคที่คนมักพลาด
- ใส่ tag service, env, region ตั้งแต่ต้น ไม่งั้นค้นทีหลังปวดหัว
- บีบอัดและตั้ง retention แยกตามระดับความสำคัญ (ERROR เก็บนานกว่า INFO)
### ขั้นที่ 7 ตั้ง Alert ให้เตือน "สิ่งที่ควรตื่น"
Alert ที่ดีไม่ใช่เตือนทุก error แต่เตือนเมื่อกระทบจริง ตัวอย่างที่ใช้งานได้มาก
- อัตรา 5xx เกิน threshold ต่อเนื่อง 5 นาที
- p95 latency เกินเป้าหมาย
- payment failed rate สูงผิดปกติ
- จำนวน login failed พุ่ง (อาจโดน brute force)
- queue lag เกินกำหนด
- disk/storage ใกล้เต็มในระบบ log
เพิ่มคุณภาพ alert ด้วย
- รวมสัญญาณหลายตัว (error rate + traffic) ลด false alarm
- ใส่ runbook link และตัวอย่าง query ที่ต้องเปิดดูต่อ
### ขั้นที่ 8 ผูก Log กับ Tracing และ Metrics เพื่อเห็นภาพครบ
- Log ตอบคำถาม "เกิดอะไร"
- Metrics ตอบ "เกิดบ่อยแค่ไหน/หนักแค่ไหน"
- Tracing ตอบ "ช้าตรงไหนใน chain"
ถ้าใช้ OpenTelemetry จะต่อภาพรวมได้ดีมาก อย่างน้อยให้ correlation_id ไปผูกกับ trace_id ได้
### ขั้นที่ 9 ระวังข้อมูลส่วนตัวและกฎหมาย (Privacy by Design)
- ทำ allowlist ว่าฟิลด์ไหน log ได้ แทนที่จะ blacklist
- mask/redact ฟิลด์สำคัญ เช่น email, phone, address
- ห้าม log access token, refresh token, session cookie
- กำหนด retention ตามความจำเป็น ไม่เก็บยาวโดยไม่มีเหตุผล
- จำกัดสิทธิ์เข้าถึง log/audit และทำ access audit อีกชั้น
### ขั้นที่ 10 ทำ "เหตุการณ์ตัวอย่าง" เพื่อทดสอบว่าตามรอยได้จริง
ซ้อม incident แบบง่ายๆ
- ยิงคำสั่งซื้อ 1 รายการ
- จด correlation_id จาก response header
- ค้นในระบบรวมศูนย์ด้วย correlation_id
- ต้องเห็นครบตั้งแต่ API รับ request → สร้าง order → เรียก payment → ผลลัพธ์
ถ้าเห็นขาดช่วง จุดนั้นคือการบ้านในการใส่ propagation/log เพิ่ม
### สรุปแนวคิดจำง่าย
- Log ต้องมีโครงสร้าง
- Correlation ID ต้องไหลทั้งระบบ
- Audit ต้องเชื่อถือได้และแก้ยาก
- รวมศูนย์และมี alert ที่ไม่รบกวนเกินไป
- ระวังข้อมูลส่วนตัวตั้งแต่วันแรก

## ส่วนที่ 5 ระบบอัปโหลดไฟล์ให้ปลอดภัยและไม่พังง่าย
### ขั้น 0 วางแนวคิดก่อนเริ่ม
ไฟล์ที่ผู้ใช้ส่งมา "ไม่ควรเชื่อใจ" และ "ไม่ควรเสิร์ฟตรงจากโฟลเดอร์เว็บ" แยกเส้นทางเป็น 2 ส่วน
- รับไฟล์เข้า (ingest) แล้วเก็บแบบดิบ
- ตรวจสอบ/แปลง/สแกน แล้วค่อยปล่อยให้ดาวน์โหลดหรือใช้งาน
### ขั้น 1 จำกัดชนิดไฟล์แบบที่ถูกต้อง
- อย่าดูแค่ .jpg .pdf จากชื่อไฟล์
- ตรวจจาก MIME type ที่อ่านจากเนื้อไฟล์ (magic bytes) ด้วย เช่น PNG มีลายเซ็นเฉพาะ
- ฝั่งหน้าเว็บช่วยกรองได้ด้วย accept แต่ฝั่งเซิร์ฟเวอร์ต้องตรวจซ้ำเสมอ
- ทำ allowlist เช่น image/jpeg, image/png, application/pdf
- เจอชนิดอื่น ปฏิเสธทันที พร้อมข้อความสั้นๆ
### ขั้น 2 จำกัดขนาดไฟล์แบบ "กันพัง"
กำหนดเพดานชัดเจน เช่น 5MB หรือ 20MB แล้วแต่ use case โดยจำกัด 3 ชั้นพร้อมกัน
- client-side แจ้งผู้ใช้เร็ว
- server/gateway limit กัน RAM/CPU ระเบิด
- object storage presigned policy กันอัปโหลดเกิน
หลุมที่คนพลาด: อัปโหลดแบบ chunk ต้องจำกัดขนาดรวมด้วย
### ขั้น 3 เปลี่ยนชื่อไฟล์ทุกครั้ง (ห้ามใช้ชื่อเดิม)
- ชื่อเดิมอาจมีอักขระแปลกๆ, path traversal, หรือชน URL พัง
- ตั้งชื่อใหม่เป็น UUID หรือ ULID เพื่อเรียงตามเวลาได้
- เก็บนามสกุลตามชนิดที่ตรวจแล้วเท่านั้น
- แยก "display name" เก็บใน DB ไว้โชว์ แต่ไม่ใช้เป็นชื่อไฟล์จริง
- โครงสร้างที่แนะนำ: tenant/user/date/uuid.ext
### ขั้น 4 อัปโหลดเข้า Object Storage แทนดิสก์เครื่อง
- สเกลได้ ไม่เต็มดิสก์ ไม่ผูกกับเครื่องใดเครื่องหนึ่ง
- ทำ lifecycle ได้ เช่น ลบไฟล์ชั่วคราวอัตโนมัติ
- เปิดใช้ versioning กันไฟล์โดนทับโดยไม่ตั้งใจ
- ตั้ง bucket ให้เป็น private ทั้งหมดเป็นค่าเริ่มต้น
### ขั้น 5 ใช้ Direct Upload + Pre-signed ลดโหลดเซิร์ฟเวอร์
- เซิร์ฟเวอร์ออก URL ให้ผู้ใช้ไปอัปโหลดตรงเข้า storage
- เซิร์ฟเวอร์เก็บ metadata และตรวจ policy เช่น ขนาด/ชนิด/เวลา
- ข้อดี: เซิร์ฟเวอร์ไม่ต้องรับไฟล์ก้อนใหญ่ ลด timeout และค่า bandwidth
- ตั้งเวลาหมดอายุสั้นๆ เช่น 60-300 วินาที
### ขั้น 6 สแกนไวรัสแบบแยกกระบวนการ
อย่าสแกนใน request เดียวกับการอัปโหลด (ช้าและ timeout ง่าย) ใช้ flow แบบ async
- อัปโหลดเข้าโซน quarantine
- ส่ง event/queue ให้ worker ดึงไฟล์ไปสแกน
- ถ้าผ่าน ย้าย/คัดลอกไปโซน clean และเปลี่ยนสถานะใน DB
เครื่องมือยอดนิยม: ClamAV หรือบริการสแกนจากผู้ให้บริการคลาวด์ ถ้าไม่ผ่านให้ลบและบันทึกเหตุการณ์เพื่อ audit
### ขั้น 7 ทำ Signed URL สำหรับดาวน์โหลดแทนการเปิด public
- ไฟล์อยู่ private แต่ให้ลิงก์ดาวน์โหลดชั่วคราว
- ใช้ signed URL หมดอายุสั้น เช่น 1-10 นาที ตามความเหมาะสม
- ใส่เงื่อนไขเพิ่มได้ เช่น content-disposition=attachment กันเปิดรันทันที
- ถ้าเป็นไฟล์ที่ควรแคชได้ ให้กำหนด cache-control แยกตามประเภท
### ขั้น 8 ป้องกันไฟล์ "แฝงตัวรัน" บนเบราว์เซอร์
ตั้งค่า header เวลาเสิร์ฟไฟล์ (ผ่าน CDN หรือ proxy)
- X-Content-Type-Options: nosniff
- Content-Security-Policy สำหรับหน้า preview
- แยกโดเมนเสิร์ฟไฟล์ออกจากโดเมนแอป เช่น files.example.com
- ลดความเสี่ยง XSS ผ่านไฟล์ SVG/HTML ที่หลุดมา
### ขั้น 9 บันทึก Metadata ให้ครบเพื่อแก้ปัญหาง่าย
เก็บอย่างน้อย
- original_name, detected_mime, size, checksum (SHA-256), uploader_id
- storage_key, status (uploaded/scanning/clean/rejected)
- created_at, expires_at (ถ้ามี)
checksum ช่วยกันไฟล์ซ้ำและตรวจความถูกต้องตอนย้ายไฟล์
### ขั้น 10 ใส่ Rate limit และกัน bot
- จำกัดจำนวนอัปโหลดต่อ user/IP ต่อเวลา
- ทำ captcha เฉพาะจุดที่เสี่ยง (เช่น guest upload)
- ปิดช่องทาง spam จน storage bill พุ่ง
### ตัวอย่าง Flow สรุปที่ใช้จริง
- แอปขอ "upload ticket" จาก API
- API ตรวจสิทธิ์ + ออก presigned upload URL + บันทึกสถานะ uploaded
- Client อัปโหลดตรงเข้า object storage
- Storage ส่ง event ไป queue
- Worker สแกนไวรัส + ตรวจชนิดไฟล์ซ้ำ
- ผ่านแล้ว mark clean + ออก signed download URL เมื่อมีการร้องขอ
### ทริคที่คนมักไม่รู้
- การตรวจ MIME จาก header ที่ browser ส่งมา เชื่อไม่ได้ ต้องอ่านจากเนื้อไฟล์
- การเปิด bucket public แล้วค่อย "ซ่อน URL" เป็นความเสี่ยงสูงมาก
- อย่าให้ user เลือก path เองเด็ดขาด แม้จะ sanitize แล้วก็ตาม

## ส่วนที่ 6 ระบบแจ้งเตือนแบบมืออาชีพ (In-app, Email, Push)
### ภาพรวมแนวคิดก่อนเริ่ม
Notification ที่ดีต้อง "ส่งถึง" + "ไม่รบกวน" + "ตรวจสอบได้" + "ขยายได้" และแยก 2 ส่วนให้ชัด คือ เก็บเหตุการณ์ (Event) กับการส่ง (Delivery)
### ขั้นที่ 1 แยกประเภทแจ้งเตือนให้เป็นมาตรฐาน
- กำหนด notification_type เช่น order_paid, comment_reply, security_login, weekly_digest
- แต่ละ type มีความสำคัญ (priority) และช่องทางเริ่มต้น (default channels)
### ขั้นที่ 2 ออกแบบตารางหลักสำหรับ In-app
ตาราง notifications
- id (uuid)
- user_id
- type
- title
- body
- data_json (payload เช่น order_id, url)
- url (optional)
- status (unread/read/archived)
- created_at
- read_at
แนะนำ index: (user_id, created_at), (user_id, status)
### ขั้นที่ 3 เก็บ "เหตุการณ์ต้นทาง" เพื่อกันยิงซ้ำและตรวจสอบย้อนหลัง
ตาราง notification_events
- id (uuid)
- event_key (string) ใช้กันซ้ำ เช่น "order:123:paid"
- type
- actor_id (คนกระทำ ถ้ามี)
- target_user_id
- payload_json
- created_at
ตั้ง unique index ที่ event_key ข้อดีคือ ถ้าเว็บยิงซ้ำ Event เดิม ระบบไม่สร้างซ้ำ
### ขั้นที่ 4 แยกตาราง "การส่งแต่ละช่องทาง" (Delivery)
ตาราง notification_deliveries
- id (uuid)
- event_id
- user_id
- channel (inapp/email/push)
- provider (ses/sendgrid/fcm/webpush)
- status (pending/sending/sent/failed/canceled)
- attempts
- next_retry_at
- last_error
- idempotency_key (unique)
- created_at
- sent_at
แนะนำ unique index: (channel, idempotency_key)
### ขั้นที่ 5 นิยาม idempotency_key ให้คิดง่ายและไม่พลาด
- idempotency_key = event_key + ":" + channel เช่น order:123:paid:email
- ผลลัพธ์: ต่อให้ worker ทำงานซ้ำ ก็จะไม่ส่งซ้ำ
### ขั้นที่ 6 สร้าง Preference ให้ผู้ใช้เลือกได้ละเอียด
ตาราง notification_preferences
- user_id
- type
- channel
- enabled (true/false)
- quiet_hours_json (optional)
- created_at
- updated_at
ตั้ง unique: (user_id, type, channel) และมี fallback: ถ้าไม่มี record ให้ใช้ default จาก notification_type
### ขั้นที่ 7 สร้าง "Device/Endpoint" สำหรับ Push/WebPush
ตาราง notification_endpoints
- id
- user_id
- platform (ios/android/web)
- token_or_subscription_json
- status (active/revoked)
- last_seen_at
- created_at
unique (user_id, token) หรือ unique(token)
### ขั้นที่ 8 เส้นทางการทำงานที่แนะนำ (Flow)
- ระบบธุรกิจยิง event เช่น OrderPaid
- สร้าง notification_events ด้วย event_key
- สร้าง notifications (in-app) ทันทีหรือผ่าน job ก็ได้
- สร้าง notification_deliveries ตาม preference ของผู้ใช้
- ใส่ delivery ลงคิวให้ worker ส่งทีละ channel
### ขั้นที่ 9 เลือก Queue/Worker ให้เหมาะ
- เริ่มง่าย: Redis Queue (BullMQ/Sidekiq/RQ)
- งานหนักมาก: Kafka/RabbitMQ
- หลักการ: "event สร้างเร็ว, ส่งช้าได้" เพื่อไม่บล็อก request
### ขั้นที่ 10 แยก Worker ตามช่องทางเพื่อควบคุมปัญหา
- worker-email: จำกัด rate และจัดการ bounce
- worker-push: จัดการ token invalid
- worker-inapp: ส่วนใหญ่แค่ insert DB
การแยกทำให้ email ล่มไม่ลาก push ล่มตาม
### ขั้นที่ 11 ตั้งค่า Retry แบบมืออาชีพ
ใช้ exponential backoff
ครั้งที่
เวลารอ
1
1 นาที
2
5 นาที
3
15 นาที
4
60 นาที
5
6 ชั่วโมง
กำหนด attempts_max เช่น 5 เมื่อถึงเพดานให้ status=failed และเก็บ last_error
### ขั้นที่ 12 ระวัง "ส่งซ้ำเพราะ worker crash"
วิธีแก้
- อัปเดต status เป็น sending แบบ atomic ก่อนยิง provider
- ส่งสำเร็จแล้วค่อย set sent พร้อม sent_at
- ถ้าค้าง sending เกิน timeout ให้รีคิวได้ (stuck job recovery)
### ขั้นที่ 13 ตัวอย่างตรรกะสร้าง Delivery ตาม Preference
- อ่าน default channels ของ type
- เช็ก notification_preferences ของ user
- ตัดช่องทางที่ปิดออก
- ถ้า quiet hours เปิดอยู่ ให้ตั้ง next_retry_at เป็นเวลาที่เหมาะสม
### ขั้นที่ 14 ทำ "Dedup Window" กัน spam จาก event ถี่เกินไป
บาง type เช่น comment_reply อาจรวมภายใน 1-5 นาที ทำได้โดย
- ใส่ช่วงเวลาใน event_key เช่น thread:55:reply:2026-01-19T10:00
- หรือเก็บ aggregate_key แล้ว batch เป็น digest
### ขั้นที่ 15 เพิ่มการติดตามผล (Observability)
- เก็บ metrics: sent/failed/retry per channel
- log ที่ผูกกับ event_id และ delivery_id
- ทำ dashboard ดู backlog queue, retry rate
### ขั้นที่ 16 ความปลอดภัยและความเป็นส่วนตัว
- payload_json อย่าใส่ข้อมูลลับ เช่น เลขบัตร, token
- Email template ใส่แค่ข้อมูลจำเป็น และลิงก์ต้องมีสิทธิ์เข้าถึง
### ขั้นที่ 17 เคล็ดลับ UX ที่ช่วยให้ดู "โปร"
- In-app มี grouping เช่น วันนี้/เมื่อวาน
- มี mark all as read
- คลิกแล้วไปหน้าปลายทางได้ทันที
- สำหรับ Push ใส่ deep link และ action button (ถ้ารองรับ)
### ตัวอย่างเคสจริงแบบสั้น
OrderPaid → event_key=order:123:paid
- สร้าง In-app 1 แถว
- สร้าง deliveries 2 แถว (email + push) ตาม preference
- worker ส่ง email และ push แยกกัน พร้อม retry และกันส่งซ้ำ
### สรุปแนวทางที่ทำให้ระบบนิ่ง
- ใช้ event_key unique กันยิงซ้ำ
- ใช้ delivery idempotency_key unique กันส่งซ้ำต่อ channel
- แยกคิว/worker ตาม channel
- retry แบบ backoff + stuck recovery
- มี preference และ quiet hours เพื่อลดความรำคาญ

## ส่วนที่ 7 การเชื่อมโยงระหว่างระบบ (Cross-System Integration)
### ตารางเชื่อมโยงระหว่างระบบ
ระบบ
เชื่อมกับ Login
เชื่อมกับ RBAC
เชื่อมกับ Logging/Audit
สมัครสมาชิก
ผู้ใช้ต้อง active และ email_verified_at ไม่เป็น null จึง login ได้
ผู้ใช้ใหม่ได้ role สิทธิ์น้อยที่สุด (default deny) หลัง activate
บันทึก signup_requested, verification_sent, verification_success, verification_failed พร้อม correlation_id
Login
-
JWT claim บรรจุ permission หลัง login
ทุก login/logout สร้าง correlation_id เริ่มต้นและบันทึก log
RBAC
ตรวจ permission ก่อนเข้าหน้า admin
-
ทุกการเปลี่ยน role/permission บันทึกลง audit_logs พร้อม actor, before/after, reason
Logging/Audit
เก็บ user_id จาก token ในทุก log line
เชื่อม audit log เข้ากับ correlation_id เดียวกับ request อื่น
-
File Upload
ตรวจสิทธิ์ผ่าน token ก่อนออก presigned URL
ใช้ permission เช่น file.upload, file.delete
บันทึก audit log ทุกครั้งที่อัปโหลด/ลบ พร้อม correlation_id เชื่อมกับ request เดิม
Notification
แจ้งเตือนเมื่อ login ใหม่/เปลี่ยนรหัสผ่าน; ผูก push token กับ user ที่ยืนยันตัวตนแล้ว
ใช้ permission เช่น notification.read, notification.send, notification.template.update; แจ้งผู้ใช้เมื่อถูกเปลี่ยน role
เก็บ event_id/delivery_id พร้อม correlation_id ในทุก log; บันทึก audit เมื่อมีการแก้ไขหรือส่งแจ้งเตือน
### จุดเชื่อมเพิ่มเติมของระบบสมัครสมาชิกยืนยันอีเมล
ประเด็น
แนวทาง
การส่งอีเมลยืนยัน
ใช้คิวและ worker-email ชุดเดียวกับระบบ Notification (type เช่น email_verification) พร้อม retry, backoff และ idempotency_key
event_key ของอีเมลยืนยัน
เช่น verify:userId:tokenId เพื่อกันส่งซ้ำเมื่อ worker ทำงานซ้ำ
Rate limit
ใช้ Redis ตัวเดียวกับ Login เพื่อจำกัด signup, resend, verify แบบกระจายหลายเครื่อง
การเก็บ secret
pepper ของ verification token เก็บใน Environment Variables/Key Vault เช่นเดียวกับ pepper ของรหัสผ่าน
Alert
ใช้ระบบ Alert ของส่วน Logging เตือนเมื่อ verify fail พุ่ง หรือ IP เดียวสมัครหลายอีเมล
change_email
ใช้โครงสร้าง email_verifications เดิมด้วย purpose=change_email และแจ้งเตือนไปที่อีเมลเดิมด้วย
### ตารางเหตุการณ์ข้ามระบบที่ควรแจ้งเตือน
เหตุการณ์ต้นทาง
notification_type
ช่องทางที่แนะนำ
หมายเหตุ
สมัครสมาชิก ต้องยืนยันอีเมล
email_verification
Email
ไม่ให้ผู้ใช้ปิดได้ ใช้ token แบบ single-use และอายุสั้น
ยืนยันอีเมลสำเร็จ บัญชีเปิดใช้งาน
account_activated
In-app + Email
แจ้งขั้นตอนถัดไป เช่น ตั้งค่าโปรไฟล์
Login จากอุปกรณ์ใหม่
security_login
Email + Push + In-app
priority สูง ไม่ควรให้ผู้ใช้ปิดได้ทั้งหมด
Admin เปลี่ยน role ของผู้ใช้
role_changed
In-app + Email
อ้างอิง audit log เดียวกัน (ผูกด้วย correlation_id)
ไฟล์ผ่านการสแกนและพร้อมใช้งาน
file_ready
In-app
ส่งเมื่อ worker สแกนเสร็จ ไม่ต้องให้ผู้ใช้รอหน้าจอ
ไฟล์ไม่ผ่านการสแกนและถูกลบ
file_rejected
In-app + Email
ไม่ใส่ชื่อไวรัสหรือรายละเอียดเชิงเทคนิคเกินจำเป็น
คำสั่งซื้อชำระเงินสำเร็จ
order_paid
In-app + Email + Push
ใช้ event_key เช่น order:123:paid
### ตัวอย่าง Flow ครบวงจร (จากสมัครสมาชิกจนถึงการแจ้งเตือน)
- สมัครสมาชิก: ผู้ใช้กรอกอีเมล → ระบบสร้าง user สถานะ pending, สร้าง verification token (เก็บเป็น hash), enqueue อีเมลยืนยัน และตอบข้อความทั่วไปแบบเดียวกันเสมอ พร้อม correlation_id
- ยืนยันอีเมล: ผู้ใช้กดลิงก์ → ตรวจ hash, หมดอายุ, ใช้ครั้งเดียว ใน transaction เดียว → email_verified_at ถูกตั้งค่า, status เป็น active, ผู้ใช้ได้ role สิทธิ์น้อยที่สุด
- Login: ผู้ใช้ login จากอุปกรณ์ใหม่ → ระบบสร้าง correlation_id, ออก JWT พร้อม permission claim และสร้าง notification event security_login (event_key เช่น login:userId:deviceId:timestamp)
- ลงทะเบียน Push: ผู้ใช้ลงทะเบียน push endpoint → บันทึกใน notification_endpoints ผูกกับ user_id ที่ผ่านการยืนยันตัวตนแล้ว
- ตรวจสิทธิ์: ผู้ใช้ขอ presigned upload URL → middleware ตรวจ requirePermission("file.upload") จาก permission cache ที่เก็บไว้ตอน login
- อัปโหลด: อัปโหลดสำเร็จ → บันทึก log เชิงเทคนิค (latency, status) พร้อม correlation_id เดิม
- สแกนไฟล์: Worker สแกน → ถ้าผ่าน mark clean และสร้าง event file_ready; ถ้าไม่ผ่าน ลบไฟล์, บันทึก audit log (action: file.reject) พร้อม actor/reason/correlation_id เดิม และสร้าง event file_rejected
- แจ้งเตือน: Notification service สร้างการแจ้งเตือน in-app และ deliveries ตาม preference เข้าคิวตาม channel พร้อม retry และ idempotency_key ป้องกันการส่งซ้ำ
- ตรวจสอบย้อนหลัง: แอดมินเข้าหน้า Audit Logs ค้นด้วย correlation_id เดียว เห็นภาพรวมตั้งแต่สมัคร, login, การตรวจสิทธิ์, การอัปโหลด, ผลสแกน ไปจนถึงสถานะการส่งแจ้งเตือน

## Checklist รวมก่อนขึ้นโปรดักชัน
- Token ยืนยันอีเมลและ refresh token ไม่ถูกเก็บแบบดิบใน DB และไม่ปรากฏใน log
- ข้อความตอบกลับตอนสมัคร, resend และ login ไม่เผยว่าอีเมลมีอยู่ในระบบหรือไม่
- Rate limit ครอบคลุม signup, resend, verify, login, upload และ endpoint ของ admin
- ผู้ใช้ pending login ไม่ได้ และผู้ใช้ใหม่ได้ role สิทธิ์น้อยที่สุด
- ทุก request มี correlation_id และค้นย้อนกลับข้ามระบบได้
- Audit log เป็น append-only และเก็บ reason ของการเปลี่ยนสิทธิ์
- ไฟล์อยู่ใน bucket private, ผ่านสแกนก่อนใช้งาน และเสิร์ฟผ่าน signed URL
- Notification ไม่ส่งซ้ำ มี retry/backoff, stuck recovery และ dead-letter queue
- Secret ทั้งหมด (pepper, signing key, provider key) อยู่ใน Key Vault หรือ env
- ซ้อม incident ด้วยการตามรอย correlation_id เดียวตั้งแต่สมัครจนถึงแจ้งเตือน
## สรุปแนวคิดภาพรวม
- ไม่เชื่อ input, ไฟล์, หรือ token จากภายนอกจนกว่าจะตรวจสอบ
- สิทธิ์ใช้หลัก default deny และ least privilege
- งานหนักและงานที่อาจล้มเหลว (ส่งอีเมล, สแกนไฟล์, แจ้งเตือน) ให้ผ่านคิวและ worker
- ทุกเหตุการณ์สำคัญต้องตอบได้ว่า ใครทำอะไร เมื่อไหร่ เพราะอะไร ผ่าน correlation_id และ audit log