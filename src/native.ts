import { nativeAvailable, nativeError } from "./platform";

// Small round-robin pool: each worker dlopens the dylib, so a blocking Vision call never stalls the HTTP event loop.
// Not macOS (or dylib not built): no workers are started and every call answers ok:false with the reason.
const SIZE = Number(process.env.WORKERS ?? 2);
const workers = nativeAvailable ? Array.from({ length: SIZE }, () => new Worker(new URL("./worker.ts", import.meta.url))) : [];
const pending = new Map<number, (r: any) => void>();
let seq = 0;

for (const w of workers) {
  w.onmessage = ({ data }) => {
    pending.get(data.id)?.(data.result);
    pending.delete(data.id);
  };
}

export function call(op: string, bytes?: Uint8Array, opts?: unknown, bytes2?: Uint8Array): Promise<any> {
  if (!nativeAvailable) return Promise.resolve({ ok: false, error: nativeError });
  const id = seq++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    workers[id % SIZE].postMessage({ id, op, bytes, bytes2, opts });
  });
}
