# vision-mac

macOS Vision framework as an HTTP API. Swift dylib (`@_cdecl`) → `bun:ffi` in a Worker pool → Elysia.
Runs on the host only (Vision does not exist in Linux containers). LAN: `http://vision.local` → Caddy → `:8090`.

```sh
bun install
bun run build:native   # swiftc → native/libvision.dylib (ad-hoc signed)
bun run start          # PORT=8090 WORKERS=2
```

Service: `~/Library/LaunchAgents/app.dvgamerr.vision-mac.plist` (log: `/tmp/vision-mac.log`).
After changing Swift: `bun run build:native && launchctl kickstart -k gui/$(id -u)/app.dvgamerr.vision-mac`

| Route | Body | Notes |
|---|---|---|
| `GET /health`, `GET /capabilities` | | OS version, OCR languages |
| `POST /ocr/text` | `file` (image) | `?level=fast\|accurate&lang=th-TH,en-US&correction=false` — `fast` loses Thai |
| `POST /ocr/document` | `file` (image) | tables, lists, paragraphs, title (macOS 26+) |
| `POST /ocr/pdf` | `file` (pdf) | text options + `?pages=1,2&scale=2` |
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

**All processing routes are async**: they return `202 {id, status, url}`; fetch the result with `GET /jobs/:id?wait=20000` (see `docs/queue.md`). Needs `DATABASE_URL` in `.env` (db `vision`, pgque installed from `db/`).

Boxes are normalized 0–1, origin bottom-left. Example: `fetch(url, { method: "POST", body: formData })` with field `file`.
