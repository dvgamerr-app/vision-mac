import { $ } from "bun";

// swiftc and codesign exist only on macOS; elsewhere skip so `bun run dev` still starts (see src/platform.ts).
if (process.platform !== "darwin") {
  console.log(`build:native skipped on ${process.platform}: Vision is macOS-only`);
  process.exit(0);
}
await $`swiftc -swift-version 5 -emit-library -O -o native/libvision.dylib native/vision.swift`;
await $`codesign -s - -f native/libvision.dylib`;
await $`swiftc -swift-version 5 -O -o native/vision-tts native/tts.swift`;
