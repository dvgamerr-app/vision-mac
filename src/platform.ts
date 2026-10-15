import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Vision and AVSpeechSynthesizer exist only on macOS. Anywhere else (Windows/Linux dev machines, CI) the API, DB, queue and docs
// still run, but processing jobs fail fast with `nativeError` instead of crashing on dlopen.
export const LIB_PATH = fileURLToPath(new URL("../native/libvision.dylib", import.meta.url));
export const TTS_BIN = fileURLToPath(new URL("../native/vision-tts", import.meta.url));

function check(): string | null {
  if (process.platform !== "darwin") return `Vision and AVSpeechSynthesizer need macOS (this is ${process.platform}); processing jobs are unavailable`;
  if (!existsSync(LIB_PATH)) return "native/libvision.dylib is missing: run `bun run build:native`";
  return null;
}

export const nativeError = check();
export const nativeAvailable = nativeError === null;
