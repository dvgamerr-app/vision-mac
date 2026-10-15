import AVFoundation
import Foundation

// Standalone helper: `vision-tts '<opts json>' <out.wav|out.m4a>` → one JSON line on stdout.
// AVSpeechSynthesizer.write delivers its buffer callbacks on the MAIN thread (verified), so this must run a main run loop.
// That is why it is a separate process and not part of libvision.dylib: Bun's main thread has no CFRunLoop to drain.

func out(_ obj: [String: Any]) -> Never {
    let data = (try? JSONSerialization.data(withJSONObject: obj)) ?? Data("{\"ok\":false,\"error\":\"encode\"}".utf8)
    print(String(decoding: data, as: UTF8.self))
    exit(0)
}
func fail(_ m: String) -> Never { out(["ok": false, "error": m]) }

func voiceJSON(_ v: AVSpeechSynthesisVoice) -> [String: Any] {
    let q: String
    switch v.quality { case .premium: q = "premium"; case .enhanced: q = "enhanced"; default: q = "default" }
    let g: String
    switch v.gender { case .male: g = "male"; case .female: g = "female"; default: g = "unspecified" }
    return ["identifier": v.identifier, "name": v.name, "language": v.language, "quality": q, "gender": g,
            "personal": v.voiceTraits.contains(.isPersonalVoice), "novelty": v.voiceTraits.contains(.isNoveltyVoice)]
}
func rank(_ v: AVSpeechSynthesisVoice) -> Int { v.quality == .premium ? 2 : v.quality == .enhanced ? 1 : 0 }

/// voice (identifier or name) → language → Thai text → system default (nil)
func resolveVoice(_ opts: [String: Any], _ text: String) -> AVSpeechSynthesisVoice? {
    let all = AVSpeechSynthesisVoice.speechVoices()
    if let name = opts["voice"] as? String, !name.isEmpty {
        if let v = AVSpeechSynthesisVoice(identifier: name) { return v }
        guard let v = all.filter({ $0.name.caseInsensitiveCompare(name) == .orderedSame }).sorted(by: { rank($0) > rank($1) }).first
        else { fail("unknown voice: \(name)") }
        return v
    }
    var lang = opts["language"] as? String
    if lang == nil, text.unicodeScalars.contains(where: { (0x0E00...0x0E7F).contains($0.value) }) { lang = "th-TH" }
    guard let lang else { return nil }
    guard let v = all.filter({ $0.language.replacingOccurrences(of: "_", with: "-") == lang }).sorted(by: { rank($0) > rank($1) }).first
    else { fail("no voice for language: \(lang)") }
    return v
}

let args = CommandLine.arguments
guard args.count == 3, let opts = (try? JSONSerialization.jsonObject(with: Data(args[1].utf8))) as? [String: Any] else { fail("usage: vision-tts '<json>' <out>") }
guard let text = opts["text"] as? String, !text.isEmpty else { fail("empty text") }
let url = URL(fileURLWithPath: args[2])

let utt: AVSpeechUtterance
if (opts["ssml"] as? Bool) == true {
    guard let u = AVSpeechUtterance(ssmlRepresentation: text) else { fail("invalid SSML") }
    utt = u
} else { utt = AVSpeechUtterance(string: text) }
let voice = resolveVoice(opts, text)
utt.voice = voice
if let r = opts["rate"] as? Double { utt.rate = Float(r) }
if let p = opts["pitch"] as? Double { utt.pitchMultiplier = Float(p) }
if let v = opts["volume"] as? Double { utt.volume = Float(v) }

let wantMarkers = (opts["markers"] as? Bool) == true
let ns = text as NSString
let synth = AVSpeechSynthesizer()
var file: AVAudioFile?
var frames: AVAudioFramePosition = 0
var rate = 0.0
var failure: String?
var finished = false
var markers: [[String: Any]] = []
let start = Date()

synth.write(utt, toBufferCallback: { buf in
    guard let pcm = buf as? AVAudioPCMBuffer else { return }
    if pcm.frameLength == 0 { finished = true; return } // empty buffer = end of utterance
    do {
        if file == nil {
            // 16-bit PCM WAV is the most widely playable (the synthesizer's native buffers are Float32)
            var settings: [String: Any] = [AVFormatIDKey: kAudioFormatLinearPCM, AVSampleRateKey: pcm.format.sampleRate, AVNumberOfChannelsKey: pcm.format.channelCount,
                AVLinearPCMBitDepthKey: 16, AVLinearPCMIsFloatKey: false, AVLinearPCMIsBigEndianKey: false]
            if url.pathExtension.lowercased() == "m4a" {
                settings = [AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: pcm.format.sampleRate, AVNumberOfChannelsKey: pcm.format.channelCount]
            }
            file = try AVAudioFile(forWriting: url, settings: settings, commonFormat: pcm.format.commonFormat, interleaved: pcm.format.isInterleaved)
            rate = pcm.format.sampleRate
        }
        try file!.write(from: pcm)
        frames += AVAudioFramePosition(pcm.frameLength)
    } catch { failure = "audio write: \(error.localizedDescription)"; finished = true }
}, toMarkerCallback: { ms in
    guard wantMarkers else { return }
    for m in ms {
        let kind: String
        switch m.mark { case .word: kind = "word"; case .sentence: kind = "sentence"; case .paragraph: kind = "paragraph"
                        case .phoneme: kind = "phoneme"; case .bookmark: kind = "bookmark"; @unknown default: kind = "other" }
        var d: [String: Any] = ["mark": kind, "byteOffset": m.byteSampleOffset]
        if m.textRange.location != NSNotFound, NSMaxRange(m.textRange) <= ns.length { d["text"] = ns.substring(with: m.textRange) }
        if !m.bookmarkName.isEmpty { d["bookmark"] = m.bookmarkName }
        if !m.phoneme.isEmpty { d["phoneme"] = m.phoneme }
        markers.append(d)
    }
})

let deadline = Date().addingTimeInterval(120)
while !finished && Date() < deadline { RunLoop.main.run(mode: .default, before: Date().addingTimeInterval(0.05)) }
if !finished { synth.stopSpeaking(at: .immediate); fail("tts timeout") }
if let failure { fail(failure) }
file = nil // flush and close
guard frames > 0, rate > 0 else { fail("no audio produced") }
var result: [String: Any] = ["durationSec": Double(frames) / rate, "sampleRate": rate, "voice": voice.map(voiceJSON) ?? NSNull()]
if wantMarkers { result["markers"] = markers }
out(["ok": true, "result": result, "durationMs": Int(Date().timeIntervalSince(start) * 1000)])
