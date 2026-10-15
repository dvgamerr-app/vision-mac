import { Elysia, t } from "elysia";
import { call } from "./native";
import { nativeAvailable, nativeError } from "./platform";
import { checkVoice, voices } from "./tts";
import { enqueue, findFile, getJob, listFiles, listJobs } from "./queue";
import { openapi } from "@elysiajs/openapi";
import { fileURLToPath } from "node:url";
import pkg from "../package.json";

const textOpts = t.Object({
  level: t.Optional(t.Union([t.Literal("fast"), t.Literal("accurate")])),
  lang: t.Optional(t.String()),
  correction: t.Optional(t.String()),
});
const toOpts = (q: { level?: string; lang?: string; correction?: string }) => ({
  level: q.level,
  languages: q.lang?.split(",").filter(Boolean),
  correction: q.correction !== "false",
});
const bytesOf = async (f: File) => new Uint8Array(await f.arrayBuffer());
// every processing route is async: validate, enqueue, answer 202 with a job to poll at GET /jobs/:id
const submit = async (op: string, files: File[], opts: unknown = {}) => {
  const id = await enqueue(op, await Promise.all(files.map(bytesOf)), opts);
  return { id, status: "queued", url: `/jobs/${id}` };
};
const accepted = { 202: t.Object({ id: t.String({ format: "uuid" }), status: t.Literal("queued"), url: t.String() }, { description: "Job accepted; poll GET /jobs/{id}" }) };
const d = (tag: string, summary: string, description?: string) => ({ detail: { tags: [tag], summary, description } });
const imageBody = t.Object({ file: t.File({ type: "image/*" }) });

const SCALAR_JS = fileURLToPath(new URL("../node_modules/@scalar/api-reference/dist/browser/standalone.js", import.meta.url));

const app = new Elysia()
  .use(openapi({
    path: "/docs",
    specPath: "/docs/json",
    provider: "scalar",
    exclude: { paths: ["/docs/scalar.js"] },
    documentation: {
      info: {
        title: "vision-mac",
        version: pkg.version,
        description: "macOS Vision framework over HTTP. Every processing route is **async**: it answers `202` with a job id; fetch the result from `GET /jobs/{id}` (`?wait=<ms>` long-polls up to 30 s). Bounding boxes are normalized 0–1 with the origin at the bottom-left.",
      },
      tags: [
        { name: "System" }, { name: "Jobs" }, { name: "OCR" }, { name: "Detect" }, { name: "Image" }, { name: "TTS" },
      ],
    },
    // docs only: no request client, no code samples, no downloads, no AI/MCP, no telemetry, no external fonts
    scalar: {
      cdn: "/docs/scalar.js", // served locally so the page works under the strict CSP in Caddy
      hideTestRequestButton: true,
      hideClientButton: true,
      hideDownloadButton: true,
      hideModels: true,
      showDeveloperTools: "never",
      agent: { disabled: true },
      mcp: { disabled: true },
      telemetry: false,
      withDefaultFonts: false,
      hiddenClients: true,
    },
  }))
  .get("/docs/scalar.js", () => new Response(Bun.file(SCALAR_JS), { headers: { "content-type": "text/javascript", "cache-control": "public, max-age=86400" } }), { detail: { hide: true } })
  .get("/", async () => {
    const v = await call("version");
    return { name: pkg.name, version: pkg.version, bun: Bun.version, platform: process.platform, native: { available: nativeAvailable, error: nativeError }, ...v.result };
  }, d("System", "Versions", "App, Bun, macOS and Vision framework versions. `native.available` is false off macOS: the queue and docs work but processing jobs fail."))
  .get("/health", () => ({ ok: true }), d("System", "Health check"))
  .get("/capabilities", async ({ status }) => {
    const r = await call("capabilities");
    return r.ok ? r : status(501, r);
  }, d("System", "Capabilities", "OS version and supported OCR languages."))
  .post("/ocr/text", async ({ body, query, status }) =>
    status(202, await submit("ocr", [body.file], toOpts(query))), { body: imageBody, query: textOpts, response: accepted, ...d("OCR", "Recognize text", "`fast` is quicker but does not read Thai; use `accurate` (default) for Thai. `lang` is a comma list such as `th-TH,en-US`.") })
  .post("/ocr/document", async ({ body, query, status }) =>
    status(202, await submit("document", [body.file], toOpts(query))), { body: imageBody, query: t.Object({ lang: t.Optional(t.String()) }), response: accepted, ...d("OCR", "Recognize document structure", "Tables, lists, paragraphs and title. Needs macOS 26+.") })
  .post("/ocr/pdf", async ({ body, query, status }) =>
    status(202, await submit("pdf", [body.file], {
      ...toOpts(query),
      scale: query.scale ? Number(query.scale) : undefined,
      pages: query.pages?.split(",").map(Number).filter(Number.isInteger),
    })), {
    body: t.Object({ file: t.File({ type: "application/pdf" }) }),
    query: t.Object({ ...textOpts.properties, scale: t.Optional(t.String()), pages: t.Optional(t.String()) }),
    response: accepted,
    ...d("OCR", "OCR a PDF", "Renders each page and recognizes text. `pages` is a 1-based comma list; `scale` is the render scale (default 2)."),
  })
  .post("/detect/barcode", async ({ body, status }) => status(202, await submit("barcode", [body.file])), { body: imageBody, response: accepted, ...d("Detect", "Read barcodes and QR codes") })
  .post("/image/similarity", async ({ body, status }) => status(202, await submit("similarity", [body.a, body.b])),
    { body: t.Object({ a: t.File({ type: "image/*" }), b: t.File({ type: "image/*" }) }), response: accepted, ...d("Image", "Compare two images", "Feature-print distance: 0 means identical, larger means less similar.") })
  .get("/voices", async ({ status }) => nativeAvailable ? voices() : status(501, { ok: false, error: nativeError }), d("System", "List TTS voices", "Voices installed on this Mac. Pass `name` (or its short form, e.g. `Kanya`) as `voice` to POST /tts."))
  .post("/tts", async ({ body, status }) => {
    const bad = await checkVoice(body);
    if (bad) return status(422, { ok: false, error: bad });
    const id = await enqueue("tts", [], body);
    return status(202, { id, status: "queued" as const, url: `/jobs/${id}` });
  }, {
    body: t.Object({
      text: t.String({ minLength: 1, maxLength: 5000 }),
      ssml: t.Optional(t.Boolean({ description: "Treat `text` as SSML markup" })),
      voice: t.Optional(t.String({ description: "Voice identifier or name from GET /voices; the highest quality match wins when a name repeats" })),
      language: t.Optional(t.String({ description: "BCP-47 such as th-TH; ignored when `voice` is set. Thai text defaults to th-TH" })),
      rate: t.Optional(t.Number({ minimum: 0, maximum: 1, description: "AVSpeechUtterance rate, 0–1 (default 0.5)" })),
      pitch: t.Optional(t.Number({ minimum: 0.5, maximum: 2, description: "Pitch multiplier (default 1)" })),
      volume: t.Optional(t.Number({ minimum: 0, maximum: 1, description: "Default 1" })),
      markers: t.Optional(t.Boolean({ description: "Include word/sentence/phoneme/bookmark markers in the result" })),
      format: t.Optional(t.Union([t.Literal("wav"), t.Literal("m4a")], { default: "wav" })),
    }),
    response: { ...accepted, 422: t.Object({ ok: t.Boolean(), error: t.String() }) },
    ...d("TTS", "Text to speech", "Uses AVSpeechSynthesizer. Thai text picks a Thai voice automatically. The audio is an output file of the job: download it from `GET /jobs/{id}/files/speech.wav` (or `.m4a`) within 6 h."),
  })
  .get("/jobs", ({ query }) => listJobs(query.status, query.limit ? Number(query.limit) : 50),
    { query: t.Object({ status: t.Optional(t.String()), limit: t.Optional(t.String()) }), ...d("Jobs", "List jobs", "Newest first. `status` is one of queued, running, done, failed.") })
  .get("/jobs/:id", async ({ params, query, status }) => {
    const job = await getJob(params.id, Math.min(Number(query.wait ?? 0), 30_000));
    return job ?? status(404, { ok: false, error: "job not found" });
  }, { params: t.Object({ id: t.String({ format: "uuid" }) }), query: t.Object({ wait: t.Optional(t.String()) }), ...d("Jobs", "Get a job", "`status` goes queued → running → done | failed. Results are kept for 24 h. `wait` (ms, max 30000) long-polls until the job finishes.") })
  .get("/jobs/:id/files", ({ params }) => listFiles(params.id), {
    params: t.Object({ id: t.String({ format: "uuid" }) }),
    ...d("Jobs", "List a job's output files", "Images, audio and video produced by the job. Files expire 6 h after the job finishes (`FILE_TTL_HOURS`)."),
  })
  .get("/jobs/:id/files/:name", async ({ params, query, status }) => {
    const f = await findFile(params.id, params.name);
    if (!f) return status(404, { ok: false, error: "file not found" });
    if (f === "expired") return status(410, { ok: false, error: "file expired" });
    return new Response(Bun.file(f.path), {
      headers: {
        "content-type": f.mime,
        "content-disposition": `${query.download === "1" ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(params.name)}`,
        "cache-control": "private, no-store",
      },
    });
  }, {
    params: t.Object({ id: t.String({ format: "uuid" }), name: t.String() }),
    query: t.Object({ download: t.Optional(t.Literal("1")) }),
    ...d("Jobs", "Download an output file", "`410` once the file has expired, `404` if the job never produced it. Add `?download=1` to force a download instead of inline display."),
  });

// single-image ops that share one Swift entry point (vision_run): route -> op
const RUN: Record<string, string> = {
  "/detect/face": "face", "/detect/human": "human", "/detect/body": "body", "/detect/hand": "hand", "/detect/animal": "animal",
  "/detect/contours": "contours", "/detect/horizon": "horizon", "/detect/rectangles": "rectangles", "/detect/page": "page",
  "/image/classify": "classify", "/image/saliency": "saliency", "/image/mask": "mask", "/image/featureprint": "featureprint",
};
const SUMMARY: Record<string, [string, string]> = {
  face: ["Detect", "Detect faces — boxes, landmarks (relative to the face box), pose angles, capture quality"],
  human: ["Detect", "Detect people (`upperBodyOnly=true` for upper body)"], body: ["Detect", "Body pose joints"],
  hand: ["Detect", "Hand pose joints (`maxHands`, default 2)"], animal: ["Detect", "Detect cats and dogs only"],
  contours: ["Detect", "Contours (`max`, `contrast`)"], horizon: ["Detect", "Horizon angle"],
  rectangles: ["Detect", "Detect rectangles"], page: ["Detect", "Find the document page edges"],
  classify: ["Image", "Classify the image (`top`, `minConfidence`)"], saliency: ["Image", "Saliency regions (`type=attention|objectness`, `heatmap=true`)"],
  mask: ["Image", "Foreground mask, or `type=person`; returns a base64 grayscale PNG"], featureprint: ["Image", "Feature-print size (embedding)"],
};
const num = (v?: string) => (v === undefined || v === "" ? undefined : Number(v));
for (const [path, op] of Object.entries(RUN)) {
  app.post(path, async ({ body, query, status }) => status(202, await submit(`run:${op}`, [body.file], {
    minConfidence: num(query.minConfidence), top: num(query.top), max: num(query.max), maxHands: num(query.maxHands),
    contrast: num(query.contrast), type: query.type, heatmap: query.heatmap === "true", upperBodyOnly: query.upperBodyOnly === "true",
  })), {
    body: imageBody,
    response: accepted,
    ...d(...SUMMARY[op]),
    query: t.Object({
      minConfidence: t.Optional(t.String()), top: t.Optional(t.String()), max: t.Optional(t.String()), maxHands: t.Optional(t.String()),
      contrast: t.Optional(t.String()), type: t.Optional(t.String()), heatmap: t.Optional(t.String()), upperBodyOnly: t.Optional(t.String()),
    }),
  });
}

app.listen({ hostname: "0.0.0.0", port: Number(process.env.PORT ?? 8090) });

console.log(`vision-mac listening on :${app.server?.port}`);
