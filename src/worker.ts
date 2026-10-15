import { dlopen, FFIType, ptr, CString } from "bun:ffi";
import { LIB_PATH } from "./platform";

const lib = dlopen(LIB_PATH, {
  vision_free: { args: [FFIType.ptr], returns: FFIType.void },
  vision_version: { args: [], returns: FFIType.ptr },
  vision_run: { args: [FFIType.cstring, FFIType.ptr, FFIType.u64, FFIType.cstring], returns: FFIType.ptr },
  vision_similarity: { args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64], returns: FFIType.ptr },
  vision_voices: { args: [], returns: FFIType.ptr },
  vision_capabilities: { args: [], returns: FFIType.ptr },
  vision_ocr: { args: [FFIType.ptr, FFIType.u64, FFIType.cstring], returns: FFIType.ptr },
  vision_pdf: { args: [FFIType.ptr, FFIType.u64, FFIType.cstring], returns: FFIType.ptr },
  vision_document: { args: [FFIType.ptr, FFIType.u64, FFIType.cstring], returns: FFIType.ptr },
  vision_barcode: { args: [FFIType.ptr, FFIType.u64], returns: FFIType.ptr },
}).symbols;

// copy the returned C string into JS, then free it on the Swift side
const take = (p: number | null) => {
  if (!p) return { ok: false, error: "null result" };
  const out = JSON.parse(new CString(p).toString());
  lib.vision_free(p);
  return out;
};

declare var self: Worker;
self.onmessage = ({ data }: MessageEvent<{ id: number; op: string; bytes?: Uint8Array; bytes2?: Uint8Array; opts?: unknown }>) => {
  const { id, op, bytes, bytes2, opts } = data;
  let result;
  try {
    if (op === "version") result = take(lib.vision_version());
    else if (op === "voices") result = take(lib.vision_voices());

    else if (op === "capabilities") result = take(lib.vision_capabilities());
    else if (bytes && bytes2 && op === "similarity") result = take(lib.vision_similarity(ptr(bytes), bytes.length, ptr(bytes2), bytes2.length));
    else if (bytes && op.startsWith("run:")) result = take(lib.vision_run(Buffer.from(op.slice(4) + "\0"), ptr(bytes), bytes.length, Buffer.from(JSON.stringify(opts ?? {}) + "\0")));
    else if (bytes && op === "barcode") result = take(lib.vision_barcode(ptr(bytes), bytes.length));
    else if (bytes && (op === "ocr" || op === "pdf" || op === "document")) {
      const fn = { ocr: lib.vision_ocr, pdf: lib.vision_pdf, document: lib.vision_document }[op];
      result = take(fn(ptr(bytes), bytes.length, Buffer.from(JSON.stringify(opts ?? {}) + "\0")));
    }
    else result = { ok: false, error: `unknown op: ${op}` };
  } catch (e) {
    result = { ok: false, error: String(e) };
  }
  self.postMessage({ id, result });
};
