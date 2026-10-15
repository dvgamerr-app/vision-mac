import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { call } from "./native";
import { nativeAvailable, nativeError, TTS_BIN } from "./platform";

// TTS is AVSpeechSynthesizer.write → AVAudioFile in native/tts.swift, run as a child process per job: the synthesizer delivers
// its buffers on the main thread, so it needs a main run loop that neither Bun's main thread nor its Workers have.
export type Voice = { identifier: string; name: string; language: string; quality: string; gender: string; personal: boolean; novelty: boolean };
export type TtsOpts = {
  text: string; ssml?: boolean; voice?: string; language?: string;
  rate?: number; pitch?: number; volume?: number; markers?: boolean; format?: "wav" | "m4a";
};

let cache: Voice[] | null = null;
export async function voices(): Promise<Voice[]> {
  if (cache) return cache;
  const res = await call("voices");
  if (!res.ok) throw new Error(res.error);
  return (cache = res.result.voices);
}

/** null when the requested voice or language has no match on this Mac (so the route can answer 422). */
export async function checkVoice(o: { voice?: string; language?: string }): Promise<string | null> {
  if (!nativeAvailable) return null; // cannot validate here; the job itself fails with the reason
  const all = await voices();
  if (o.voice && !all.some((v) => v.identifier === o.voice || v.name.toLowerCase() === o.voice!.toLowerCase())) return `unknown voice: ${o.voice}`;
  if (!o.voice && o.language && !all.some((v) => v.language.replace("_", "-") === o.language)) return `no voice for language: ${o.language}`;
  return null;
}

export async function synthesize(dir: string, o: TtsOpts) {
  if (!nativeAvailable) throw new Error(nativeError!);
  await mkdir(dir, { recursive: true });
  const ext = o.format === "m4a" ? "m4a" : "wav";
  const out = join(dir, `speech.${ext}`);
  try {
    const { format: _f, ...rest } = o;
    const p = Bun.spawn([TTS_BIN, JSON.stringify(rest), out], { stdout: "pipe", stderr: "pipe" });
    const [stdout, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
    let res: any;
    try { res = JSON.parse(stdout.trim().split("\n").pop() ?? ""); } catch { res = { ok: false, error: `vision-tts exited ${code} without a result` }; }
    if (!res.ok) throw new Error(res.error);
    return {
      bytes: new Uint8Array(await readFile(out)), name: `speech.${ext}`, mime: ext === "m4a" ? "audio/mp4" : "audio/wav",
      info: res.result as { durationSec: number; sampleRate: number; voice: Voice | null; markers?: unknown[] },
    };
  } finally { await rm(dir, { recursive: true, force: true }); }
}
