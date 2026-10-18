import { context, ROOT_CONTEXT, SpanKind, SpanStatusCode, trace, type Context, type Span } from "@opentelemetry/api";
import { SeverityNumber } from "@opentelemetry/api-logs";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchLogRecordProcessor, LoggerProvider } from "@opentelemetry/sdk-logs";
import { BasicTracerProvider, BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { Elysia } from "elysia";
import { countTokens } from "gpt-tokenizer";
import { imageSize } from "image-size";
import pkg from "../package.json";

// Traceway over OTLP/HTTP. A no-op until both TRACEWAY_URL and TRACEWAY_TOKEN (project ingest token, not `tws_`) are set,
// and nothing in here may throw into request handling or a job.
const instance = process.env.TRACEWAY_URL?.trim().replace(/\/+$/, "");
const token = process.env.TRACEWAY_TOKEN?.trim();

let provider: BasicTracerProvider | null = null;
let loggerProvider: LoggerProvider | null = null;
if (instance && token) {
  const resource = resourceFromAttributes({ "service.name": process.env.OTEL_SERVICE_NAME || pkg.name, "service.version": pkg.version });
  const headers = { Authorization: `Bearer ${token}` };
  provider = new BasicTracerProvider({
    resource,
    spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter({ url: `${instance}/api/otel/v1/traces`, headers }))],
  });
  loggerProvider = new LoggerProvider({
    resource,
    processors: [new BatchLogRecordProcessor({ exporter: new OTLPLogExporter({ url: `${instance}/api/otel/v1/logs`, headers }) })],
  });
}

const tracer = provider ? provider.getTracer(pkg.name) : trace.getTracer(pkg.name);
const otelLogger = loggerProvider?.getLogger(pkg.name);
export const telemetryEnabled = Boolean(provider);
export const shutdownTelemetry = () => Promise.allSettled([provider?.shutdown(), loggerProvider?.shutdown()]);

// Inbound propagation: callers continue their own trace with this header (the owner's spelling, not the standard `traceparent`).
export const TRACE_HEADER = "x-trace-parrent";
const TRACE_PARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;
export function extractTraceContext(value: unknown): Context | null {
  const match = TRACE_PARENT.exec(String(value ?? "").trim().toLowerCase());
  if (!match) return null;
  const [, traceId, spanId, flags] = match;
  if (/^0+$/.test(traceId) || /^0+$/.test(spanId)) return null;
  return trace.setSpanContext(ROOT_CONTEXT, { traceId, spanId, traceFlags: Number.parseInt(flags, 16), isRemote: true });
}
const traceparent = (span: Span) => {
  const c = span.spanContext();
  return `00-${c.traceId}-${c.spanId}-${c.traceFlags.toString(16).padStart(2, "0")}`;
};

// One SERVER span per request, renamed to the matched route once it is known
const requestSpans = new WeakMap<Request, Span>();
/** traceparent of the request's span, stored with a queued job so the job's spans join the request's trace */
export const requestTrace = (request: Request) => { const s = requestSpans.get(request); return s ? traceparent(s) : null; };

export const requestTelemetry = new Elysia({ name: "traceway-request-telemetry" })
  .onRequest(({ request }) => {
    if (!provider) return;
    try {
      const url = new URL(request.url);
      requestSpans.set(request, tracer.startSpan(`${request.method} ${url.pathname}`,
        { kind: SpanKind.SERVER, attributes: { "http.request.method": request.method, "url.path": url.pathname } },
        extractTraceContext(request.headers.get(TRACE_HEADER)) ?? ROOT_CONTEXT));
    } catch {}
  })
  .onError({ as: "global" }, ({ request, code, error }) => {
    if (code === "NOT_FOUND" || code === "VALIDATION") return;
    try { if (error instanceof Error) requestSpans.get(request)?.recordException(error); } catch {}
  })
  .onAfterResponse({ as: "global" }, ({ request, route, set, response }) => {
    const span = requestSpans.get(request);
    if (!span) return;
    requestSpans.delete(request);
    try {
      const status = Number(response instanceof Response ? response.status : set.status ?? 200) || 200;
      if (route?.startsWith("/") && route !== "/*") {
        span.updateName(`${request.method} ${route}`);
        span.setAttribute("http.route", route);
      }
      span.setAttribute("http.response.status_code", status);
      if (status >= 500) span.setStatus({ code: SpanStatusCode.ERROR });
    } catch {}
    span.end();
  });

/** Background work as a CONSUMER span (the name is Traceway's Task grouping key), child of `parent` when given. */
export async function runTask<T>(name: string, parent: string | null, work: (span: Span) => Promise<T>, attributes: Record<string, string> = {}) {
  const span = tracer.startSpan(name, { kind: SpanKind.CONSUMER, attributes }, extractTraceContext(parent) ?? ROOT_CONTEXT);
  try {
    const r = await work(span);
    span.setStatus({ code: SpanStatusCode.OK });
    return r;
  } catch (e) {
    span.recordException(e as Error);
    span.setStatus({ code: SpanStatusCode.ERROR, message: (e as Error).message });
    throw e;
  } finally { span.end(); }
}

// --- AI traces: every native call is a gen_ai.* child span so it shows up in Traceway's AI Traces ---

// model = the Apple API that does the work for each op
const MODEL: Record<string, string> = {
  ocr: "VNRecognizeTextRequest", pdf: "PDFKit+VNRecognizeTextRequest", document: "RecognizeDocumentsRequest", barcode: "VNDetectBarcodesRequest",
  similarity: "VNGenerateImageFeaturePrintRequest", tts: "AVSpeechSynthesizer",
  face: "VNDetectFaceLandmarksRequest", human: "VNDetectHumanRectanglesRequest", body: "VNDetectHumanBodyPoseRequest",
  hand: "VNDetectHumanHandPoseRequest", animal: "VNRecognizeAnimalsRequest", contours: "VNDetectContoursRequest",
  horizon: "VNDetectHorizonRequest", rectangles: "VNDetectRectanglesRequest", page: "VNDetectDocumentSegmentationRequest",
  classify: "VNClassifyImageRequest", saliency: "VNGenerateSaliencyImageRequest", mask: "VNGenerateForegroundInstanceMaskRequest",
  featureprint: "VNGenerateImageFeaturePrintRequest",
};

// Vision has no tokens, so count them the way an LLM would bill the same request: text with the o200k tokenizer (gpt-tokenizer),
// images with the high-detail vision formula (fit in 2048, short side 768, 170 per 512px tile + 85).
export function imageTokens(width: number, height: number) {
  if (!(width > 0 && height > 0)) return 0;
  let s = Math.min(1, 2048 / Math.max(width, height));
  s *= Math.min(1, 768 / Math.min(width * s, height * s));
  return 85 + 170 * Math.ceil((width * s) / 512) * Math.ceil((height * s) / 512);
}
const PDF_PAGE = [612, 792]; // a PDF's page sizes are not known before rendering: count each processed page as US Letter at the render scale
const textTokens = (v: unknown) => { try { return v === undefined ? 0 : countTokens(typeof v === "string" ? v : JSON.stringify(v)); } catch { return 0; } };
const dims = (b: Uint8Array) => { try { const d = imageSize(b); return { width: d.width ?? 0, height: d.height ?? 0, type: d.type }; } catch { return null; } };

export type AiCall = { op: string; jobId: string; opts: unknown; files: Uint8Array[] };
export type AiResult = { ok: boolean; result?: any; error?: string };

/** Run one native call inside a gen_ai span (child of the job's task span). Prompt/completion carry metadata only, never content. */
export async function aiSpan<R extends AiResult>(parent: Span, call: AiCall, run: () => Promise<R>): Promise<R> {
  const op = call.op.replace(/^run:/, "");
  const span = tracer.startSpan(`vision.${op}`, { kind: SpanKind.INTERNAL }, trace.setSpan(context.active(), parent));
  let res: R;
  try { res = await run(); } catch (e) {
    span.recordException(e as Error);
    span.setStatus({ code: SpanStatusCode.ERROR, message: (e as Error).message });
    span.end();
    throw e;
  }
  try {
    const { text, ...opts } = (call.opts ?? {}) as Record<string, unknown>; // tts: the text is the prompt
    const images = op === "pdf" ? [] : call.files.map(dims);
    const pdfPages = op === "pdf" && res.ok ? (res.result?.pages?.length ?? 0) : 0;
    const scale = Number((opts as { scale?: number }).scale) || 2;
    const input = textTokens(text) + textTokens(opts)
      + images.reduce((n, d) => n + (d ? imageTokens(d.width, d.height) : 0), 0)
      + pdfPages * imageTokens(PDF_PAGE[0] * scale, PDF_PAGE[1] * scale);
    const output = res.ok ? textTokens(res.result) : 0;
    const keys = res.ok && res.result && typeof res.result === "object" ? Object.keys(res.result) : [];
    span.setAttributes({
      "trace.name": op,
      "gen_ai.system": "apple",
      "gen_ai.provider.name": "apple",
      "gen_ai.operation.name": op,
      "gen_ai.request.model": MODEL[op] ?? op,
      "gen_ai.conversation.id": call.jobId,
      "gen_ai.usage.input_tokens": input,
      "gen_ai.usage.output_tokens": output,
      "gen_ai.usage.total_tokens": input + output,
      "gen_ai.usage.total_cost": 0, // on-device
      "gen_ai.response.finish_reason": res.ok ? "stop" : "error",
      "gen_ai.prompt": JSON.stringify({
        op, opts, textLength: typeof text === "string" ? text.length : undefined,
        files: call.files.map((f, i) => ({ bytes: f.length, ...(images[i] ?? {}) })),
      }),
      "gen_ai.completion": JSON.stringify(res.ok
        ? { ok: true, keys, durationMs: res.result?.durationMs, pages: res.result?.pageCount, textLength: typeof res.result?.text === "string" ? res.result.text.length : undefined }
        : { ok: false, error: res.error }),
    });
    if (!res.ok) span.setStatus({ code: SpanStatusCode.ERROR, message: res.error });
  } catch {}
  span.end();
  return res;
}

// --- logs: mirror console.log/warn/error to Traceway (primitive values only, secrets dropped) ---
const SENSITIVE = /token|secret|authorization|cookie|password|key|signature/i;
export function emitLog(level: "info" | "warn" | "error", args: unknown[]) {
  if (!otelLogger) return;
  try {
    const attributes: Record<string, string | number | boolean> = {};
    const parts: string[] = [];
    for (const a of args) {
      if (a instanceof Error) {
        attributes["exception.type"] = a.name;
        attributes["exception.message"] = a.message;
        if (a.stack) attributes["exception.stacktrace"] = a.stack;
        parts.push(a.message);
      } else if (a && typeof a === "object") {
        for (const [k, v] of Object.entries(a)) if (!SENSITIVE.test(k) && ["string", "number", "boolean"].includes(typeof v)) attributes[k] = v as string;
      } else parts.push(String(a));
    }
    const severityNumber = { info: SeverityNumber.INFO, warn: SeverityNumber.WARN, error: SeverityNumber.ERROR }[level];
    otelLogger.emit({ severityNumber, severityText: level.toUpperCase(), body: parts.join(" "), attributes });
  } catch {}
}
if (otelLogger) {
  for (const level of ["log", "warn", "error"] as const) {
    const orig = console[level].bind(console);
    console[level] = (...args: unknown[]) => { orig(...args); emitLog(level === "log" ? "info" : level, args); };
  }
}
