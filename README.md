# vision-mac

macOS Vision framework as an HTTP API. Swift dylib (`@_cdecl`) → `bun:ffi` in a Worker pool → Elysia.
Runs on the host only (Vision does not exist in Linux containers). LAN: `http://vision.local` → Caddy → `:8090`.

```sh
bun install
cp .env.example .env   # DATABASE_URL, matches compose.yaml
bun run db:up          # local Postgres 18 via docker compose (or point DATABASE_URL at your own)
bun run build:native   # swiftc → native/libvision.dylib + native/vision-tts (macOS only; skipped elsewhere)
bun run start          # PORT=8090 WORKERS=2 NATIVE_TIMEOUT_MS=300000; applies migrations on start
```

**Migrations** use [Kysely](https://kysely.dev) (`src/migrations/`): pgque install → queue `vision` → tables `vision_jobs`/`vision_files` → revoke pgque's PUBLIC read grants. Installing pgque needs a user with CREATEROLE (it creates `pgque_reader`/`pgque_writer`/`pgque_admin`); the compose superuser has it. They run automatically on start (`AUTO_MIGRATE=false` to turn off) or by hand: `bun run migrate [up|down|status]`. They are idempotent, so a database set up by hand before migrations existed is adopted as-is.

**Not on macOS** (Windows/Linux dev machines): the app still starts. DB, migrations, queue, job/file routes and `/docs` all work, so you can develop and test them; `GET /` shows `native.available: false` with the reason, `/voices` and `/capabilities` answer `501`, and every processing job (OCR, TTS, ...) ends `failed` with `Vision and AVSpeechSynthesizer need macOS`. Same if the dylib was never built.

Service: `~/Library/LaunchAgents/app.dvgamerr.vision-mac.plist` (log: `/tmp/vision-mac.log`).
After changing Swift: `bun run build:native && launchctl kickstart -k gui/$(id -u)/app.dvgamerr.vision-mac`

| Route | Body | Notes |
|---|---|---|
| `GET /health`, `GET /capabilities` | | OS version, OCR languages |
| `POST /ocr/text` | `file` (image) | `?level=fast\|accurate&lang=th-TH,en-US&correction=false` — `fast` loses Thai |
| `POST /ocr/document` | `file` (image) | tables, lists, paragraphs, title (macOS 26+) |
| `POST /ocr/pdf` | `file` (pdf) | text options + `?pages=1,2&scale=2` (scale > 0, max 8) |
| `POST /detect/barcode` | `file` (image) | QR / barcodes |
| `POST /detect/face` | `file` | boxes, landmarks (relative to face box), pose angles, capture quality |
| `POST /detect/human` `/body` `/hand` `/animal` | `file` | `?minConfidence=0.1`; hand: `?maxHands=2`; human: `?upperBodyOnly=true`; animal = cats/dogs only |
| `POST /detect/contours` `/horizon` `/rectangles` `/page` | `file` | `?max=`, `?contrast=`; `page` = document segmentation |
| `POST /image/classify` | `file` | `?top=10&minConfidence=0.1` |
| `POST /image/saliency` | `file` | `?type=attention\|objectness&heatmap=true` |
| `POST /image/mask` | `file` | foreground instances, or `?type=person`; returns base64 grayscale PNG |
| `POST /image/featureprint` | `file` | embedding size only |
| `POST /image/similarity` | `a`, `b` (images) | feature-print distance, 0 = identical |
| `GET /` | | app, macOS and Vision versions (sync) |
| `GET /docs`, `GET /docs/json` | | Scalar API reference (docs only; bundle served locally from `node_modules`) and the OpenAPI spec |
| `POST /tts` | JSON `{text, ssml?, voice?, language?, rate?, pitch?, volume?, markers?, format?: wav\|m4a}` | AVSpeechSynthesizer via `native/vision-tts` (child process, needs a main run loop); Thai text auto-picks a th-TH voice; audio is a job output file |
| `GET /voices` | | installed TTS voices (sync) |
| `GET /jobs/:id`, `GET /jobs` | | job status/result; `?wait=ms` long-polls |
| `GET /jobs/:id/files`, `GET /jobs/:id/files/:name` | | output files (images, later audio/video); stored in `storage/`, TTL 6 h after the job finishes (`FILE_TTL_HOURS`), `410` when expired |

**All processing routes are async**: they return `202 {id, status, url}`; fetch the result with `GET /jobs/:id?wait=20000` (see [docs/queue.md](docs/queue.md)). Needs `DATABASE_URL` in `.env` (db `vision`, pgque installed from `db/`).

Boxes are normalized 0–1, origin bottom-left. Example: `fetch(url, { method: "POST", body: formData })` with field `file`.
