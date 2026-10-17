import { nativeAvailable, nativeError } from "./platform";

// Small round-robin pool: each worker dlopens the dylib, so a blocking Vision call never stalls the HTTP event loop.
// Not macOS (or dylib not built): no workers are started and every call answers ok:false with the reason.
// A call that outlives NATIVE_TIMEOUT_MS, or a worker that errors or exits, answers ok:false and the worker is retired;
// the next call on that slot starts a fresh one (lazily, so a dylib that fails to load cannot spin a respawn loop).
const SIZE = Math.max(1, Math.floor(Number(process.env.WORKERS)) || 2);
const TIMEOUT_MS = Math.max(1000, Number(process.env.NATIVE_TIMEOUT_MS) || 300_000);
const workers: (Worker | undefined)[] = [];
const pending = new Map<number, { resolve: (r: any) => void; slot: number; timer: Timer }>();
let seq = 0;

function settle(id: number, result: unknown) {
  const p = pending.get(id);
  if (!p) return;
  clearTimeout(p.timer);
  pending.delete(id);
  p.resolve(result);
}

function spawn(slot: number) {
  const w = new Worker(new URL("./worker.ts", import.meta.url));
  w.onmessage = ({ data }) => settle(data.id, data.result);
  w.onerror = (e) => retire(slot, w, `native worker error: ${e.message}`);
  w.addEventListener("close", () => retire(slot, w, "native worker exited"));
  return (workers[slot] = w);
}

// fail every call in flight on this worker and drop it (no-op once it was already replaced)
function retire(slot: number, w: Worker, error: string) {
  if (workers[slot] !== w) return;
  workers[slot] = undefined;
  w.terminate();
  for (const [id, p] of pending) if (p.slot === slot) settle(id, { ok: false, error });
}

if (nativeAvailable) for (let i = 0; i < SIZE; i++) spawn(i);

export function call(op: string, bytes?: Uint8Array, opts?: unknown, bytes2?: Uint8Array): Promise<any> {
  if (!nativeAvailable) return Promise.resolve({ ok: false, error: nativeError });
  const id = seq++;
  const slot = id % SIZE;
  const w = workers[slot] ?? spawn(slot);
  return new Promise((resolve) => {
    const timer = setTimeout(() => retire(slot, w, `native call timed out after ${TIMEOUT_MS} ms (${op})`), TIMEOUT_MS);
    pending.set(id, { resolve, slot, timer });
    w.postMessage({ id, op, bytes, bytes2, opts });
  });
}
