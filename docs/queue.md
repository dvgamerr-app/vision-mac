# vision-mac: async jobs บน pgque

`vision-mac` (Elysia + Swift Vision dylib) ไม่ตอบแบบ sync อีกแล้ว ทุก route ที่ประมวลผลภาพ/PDF จะ **ใส่ job ลง queue** แล้วคืน `202` ให้ไปดึงผลที่ `GET /jobs/:id`

## ภาพรวม

```
client ─POST /ocr/text─► Elysia ─┬─ insert vision_jobs (status=queued) + เก็บไฟล์ใน $JOBS_DIR/<id>/
   ▲                             └─ pgque.send('vision', {id}) ─► tick
   │                                                               │
   └──GET /jobs/:id?wait=ms── vision_jobs ◄── consumer 'vision-worker' (ในโปรเซสเดียวกัน)
                                              └─► Worker pool ─► libvision.dylib ─► Vision
```

- **pgque** ([NikolayS/pgque](https://github.com/NikolayS/pgque), Apache-2.0, PgQ แบบ pure SQL) เก็บแค่ event `{id}` ส่วนผลลัพธ์อยู่ในตาราง `vision_jobs`
- ติดตั้งแบบ pure SQL ไม่ใช้ extension (ไฟล์ vendor ไว้ที่ `db/pgque.sql` จาก commit `4a52258`, license ที่ `db/pgque.LICENSE`)
- **ไม่มี pg_cron** ใน `postgres:18-alpine` ตัว server เลยเรียก `pgque.ticker()` ทุก 1 วินาที และ `pgque.maint()` ทุก 30 วินาทีเอง ห้ามรันหลาย instance พร้อมกัน

## ฐานข้อมูล

| รายการ | ค่า |
|---|---|
| Container | `postgres` (published `5432` บน host) |
| Database | `vision` (เดิมชื่อ `queue` เปลี่ยนชื่อแล้ว; pgque อยู่ใน schema `pgque`, ตารางงานอยู่ใน `public`) |
| Queue / consumer | `vision` / `vision-worker` |
| ตาราง | `public.vision_jobs` (งาน/ผล JSON) และ `public.vision_files` (ไฟล์ผลลัพธ์) — `src/migrations/003_jobs.ts` |
| Connection | `DATABASE_URL` ใน `vision-mac/.env` (gitignore, แม่แบบ `.env.example`) |

### Migration (Kysely)

schema ทั้งหมดจัดการด้วย Kysely migration ใน `src/migrations/` (ลงทะเบียนใน `src/migrate.ts`):

| Migration | ทำอะไร |
|---|---|
| `001_pgque` | ติดตั้ง pgque จาก `db/pgque.sql` (ข้ามถ้ามี `pgque.queue` อยู่แล้ว) |
| `002_queue` | `create_queue('vision')` + `subscribe('vision','vision-worker')` |
| `003_jobs` | ตาราง `vision_jobs`, `vision_files` + index |

- รันอัตโนมัติตอน server start (`AUTO_MIGRATE=false` เพื่อปิด) หรือด้วยมือ `bun run migrate [up|down|status]`
- ทุกขั้น idempotent จึงใช้กับ DB ที่ติดตั้งด้วยมือมาก่อนได้ (Kysely แค่จดประวัติใน `kysely_migration`)
- เพิ่ม migration ใหม่: สร้างไฟล์ `00N_ชื่อ.ts` ที่ export `up`/`down` แล้วเพิ่มต่อท้ายใน `src/migrate.ts`
- ต้องสร้าง database เปล่าก่อนเอง (`create database vision`) หรือใช้ `compose.yaml` ที่สร้างให้แล้ว

### รัน local เพื่อทดสอบ

```sh
bun run db:up      # docker compose: postgres:18-alpine, user/password/db = vision, port ${PG_PORT:-5432}
bun run dev        # build native (เฉพาะ macOS) + รัน server
bun run db:down    # หยุด (เพิ่ม -v เพื่อลบข้อมูล)
```

`compose.yaml` มีแค่ Postgres เพราะ Vision รันใน container ไม่ได้ บนเครื่องที่ไม่ใช่ macOS (Windows/Linux) แอปยังรันได้ ทดสอบ DB/queue/job/ไฟล์/docs ได้ครบ แต่ job ที่ประมวลผลจะ `failed` พร้อม error `Vision and AVSpeechSynthesizer need macOS` (เช็คใน `src/platform.ts`; `GET /` แสดง `native.available`, `/voices` กับ `/capabilities` ตอบ `501`)

## API

| Route | หมายเหตุ |
|---|---|
| `POST /ocr/*`, `/detect/*`, `/image/*` | validate แล้ว `202 {id, status:"queued", url}` |
| `GET /jobs/:id?wait=<ms>` | long-poll ได้สูงสุด 30000 ms; `status` = `queued` → `running` → `done` \| `failed`; ผลอยู่ใน `result`, ความผิดพลาดใน `error` |
| `GET /jobs?status=&limit=` | ดู job ล่าสุด |
| `POST /tts` | JSON `{text, voice?, rate?, format?}` → job; เสียงออกมาเป็นไฟล์ `speech.wav` / `speech.m4a` ของ job (ดูหัวข้อ TTS) |
| `GET /voices` | เสียงที่ติดตั้งในเครื่อง พร้อม identifier/quality/gender (sync) |
| `GET /jobs/:id/files` | รายการไฟล์ผลลัพธ์ของ job (`name`, `mime`, `size`, `url`, `expiresAt`, `expired`) |
| `GET /jobs/:id/files/:name` | ดาวน์โหลด (inline; `?download=1` ให้เป็น attachment; รองรับ Range) — `404` ไม่มีไฟล์, `410` หมดอายุแล้ว |
| `GET /`, `/capabilities`, `/health` | ยังตอบ sync (เบา ไม่ผ่าน queue) |
| `GET /docs`, `/docs/json` | API reference ด้วย Scalar + OpenAPI spec (ปิดทุกอย่างยกเว้นหน้า docs; ไฟล์ Scalar เสิร์ฟจาก local เพราะ CSP ของ Caddy) |

ตัวอย่าง: `id=$(POST /ocr/text …).id` แล้ว `GET /jobs/$id?wait=20000`

## ไฟล์ผลลัพธ์ (รูป / เสียง / วิดีโอ)

ผลที่เป็นไฟล์ไม่ถูกยัดเป็น base64 ใน JSON อีก แต่เขียนลงดิสก์แล้วอ้างอิงด้วย URL

- โฟลเดอร์: `vision-mac/storage/<jobId>/<name>` (gitignore; ตั้งด้วย `STORAGE_DIR`) เป็น path บน host ธรรมดา **ไม่ได้ mount เข้า container** เพราะ vision-mac รันบน host
- ตอนนี้ ฟิลด์ `*Png` ที่ Vision คืนมา (`maskPng`, `heatmapPng`) ถูกย้ายเป็นไฟล์ `mask.png` / `heatmap.png` และใน `result` เหลือ `{name, url}`
- โค้ดเสียง/วิดีโอในอนาคตเรียก `saveFile(jobId, name, mime, bytes)` ใน `src/queue.ts` แล้วไฟล์จะได้ TTL และ endpoint ดาวน์โหลดเหมือนกัน
- **TTL ดีฟอลต์ 6 ชั่วโมงนับจาก job เสร็จ** (`FILE_TTL_HOURS`) เมื่อหมดอายุ sweeper (ทุก 30 วินาที และตอน start) ลบไฟล์ใน disk แล้วตั้ง `deleted_at`; แถว job และแถวไฟล์ยังอยู่เพื่อให้ตอบ `410` ได้ แถว job ถูกลบเมื่อพ้น `RETENTION_HOURS` (24) **และ**ไฟล์ถูกลบหมดแล้วเท่านั้น
- ไฟล์ input ที่อัปโหลดเข้ามาเก็บแยกที่ `$JOBS_DIR` (`/tmp/vision-mac-jobs`) และถูกลบทันทีที่ job จบ ไม่ได้ใช้ TTL นี้

## TTS

- ใช้ **AVSpeechSynthesizer** (`write(_:toBufferCallback:toMarkerCallback:)` → `AVAudioFile`) ใน `native/tts.swift`
- **รันเป็น child process ต่อ job** (`native/vision-tts`) ไม่ใช่ใน `libvision.dylib`: ทดสอบแล้วว่า callback ของ synthesizer ถูกส่งบน **main thread** ต้องมี main run loop วน ซึ่ง main thread ของ Bun และ Worker ไม่มี (ลองเรียกจาก Worker แล้ว job ค้าง) helper ตัวนี้วน `RunLoop.main` เอง
- body (JSON): `text` (≤ 5000), `ssml?` (ตีความ text เป็น SSML), `voice?` (identifier หรือชื่อ จาก `GET /voices`; ชื่อซ้ำเลือกคุณภาพสูงสุด), `language?` (เช่น `th-TH`), `rate?` (0–1, ดีฟอลต์ 0.5), `pitch?` (0.5–2), `volume?` (0–1), `markers?`, `format?` = `wav` (16-bit PCM) | `m4a` (AAC)
- ข้อความมีตัวอักษรไทยและไม่ระบุ `voice`/`language` → เลือกเสียง th-TH ให้เอง; voice/language ที่ไม่มีในเครื่อง → `422`
- ผลใน `result`: `voice` (identifier, name, language, quality, gender, personal, novelty), `durationSec`, `sampleRate`, `file`, และ `markers` (word/sentence/phoneme/bookmark พร้อม `text` และ `byteOffset` ดิบจาก Apple — ยังไม่ได้แปลงเป็นวินาที เพราะเอกสารระบุแค่ "byte offset into the associated audio buffer")
- ดึงไฟล์ที่ `GET /jobs/:id/files/speech.wav` (หรือ `.m4a`) TTL 6 ชั่วโมงเหมือนไฟล์อื่น
- เสียงไทยที่ติดตั้ง ณ ตอนทดสอบมีแค่ `Kanya` (compact) ถ้าอยากได้คุณภาพ enhanced/premium ต้องโหลดใน System Settings → Accessibility → Spoken Content

## พฤติกรรมที่ต้องรู้

- **Vision error = ล้มทันที ไม่ retry** (เช่น decode ภาพไม่ได้) job เป็น `failed` พร้อม `error` ส่วน error ฝั่ง infra (DB, worker) จะ throw ให้ pgque `nack` แล้ว retry หลัง 30 วินาที เกินจำนวนที่ queue กำหนดจะเข้า DLQ
- ไฟล์ input ถูกลบเมื่อ job จบ
- job ที่ค้างเกิน `STUCK_MINUTES` (10) ถูกตีเป็น `failed`
- consumer ประมวลผลทีละ job ต่อ 1 โปรเซส (Worker pool 2 ตัวถูกใช้ทีละตัว) ถ้าต้องการขนาน ต้องเพิ่ม cooperative consumer (ฟีเจอร์ experimental ของ pgque)
- latency ต่ำสุดราว 0.6 วินาที (poll 500 ms) งานหนักกว่านั้นขึ้นกับ Vision

## ดูแล

```sh
container exec postgres psql -U r00t -d vision -c "select status, count(*) from vision_jobs group by 1"
container exec postgres psql -U r00t -d vision -c "select * from pgque.get_queue_info()"
launchctl kickstart -k gui/$(id -u)/app.dvgamerr.vision-mac     # restart service
tail -f /tmp/vision-mac.log
```

ยังไม่ได้ทดสอบ: path ที่ Vision คืน `ok:false` ผ่าน queue, การ retry/DLQ ของ pgque เมื่อ infra error, และการรันหลายโปรเซส
