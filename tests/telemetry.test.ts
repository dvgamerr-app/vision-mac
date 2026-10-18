import { describe, expect, test } from "bun:test";
import { trace } from "@opentelemetry/api";
import { aiSpan, extractTraceContext, imageTokens, runTask, TRACE_HEADER } from "../src/telemetry";

describe("x-trace-parrent", () => {
  test("header name", () => expect(TRACE_HEADER).toBe("x-trace-parrent"));

  test("valid value becomes the remote parent", () => {
    const ctx = extractTraceContext("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01");
    expect(trace.getSpanContext(ctx!)).toEqual({
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736", spanId: "00f067aa0ba902b7", traceFlags: 1, isRemote: true,
    });
  });

  test("garbage, short and all-zero values are ignored", () => {
    for (const v of [undefined, "", "garbage", "00-4bf92f35-00f067aa-01",
      "00-00000000000000000000000000000000-00f067aa0ba902b7-01", "00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01"]) {
      expect(extractTraceContext(v)).toBeNull();
    }
  });
});

describe("AI span tokens", () => {
  test("image tokens follow the high-detail tile formula", () => {
    expect(imageTokens(512, 512)).toBe(85 + 170); // 1 tile
    expect(imageTokens(1024, 1024)).toBe(85 + 170 * 4); // scaled to 768x768, 2x2 tiles
    expect(imageTokens(4000, 1000)).toBe(85 + 170 * 4); // fit 2048x512, short side already < 768 → 4x1 tiles
    expect(imageTokens(0, 0)).toBe(0);
  });

  test("aiSpan passes the native result through untouched (telemetry off)", async () => {
    const res = { ok: true, result: { text: "สวัสดี hello", durationMs: 3 }, durationMs: 3 };
    const out = await runTask("job:ocr", null, (span) =>
      aiSpan(span, { op: "ocr", jobId: "j1", opts: { level: "accurate" }, files: [new Uint8Array([1, 2, 3])] }, async () => res));
    expect(out).toBe(res);
  });

  test("aiSpan rethrows when the call throws", async () => {
    await expect(runTask("job:tts", null, (span) =>
      aiSpan(span, { op: "tts", jobId: "j2", opts: { text: "hi" }, files: [] }, async () => { throw new Error("boom"); }))).rejects.toThrow("boom");
  });
});
