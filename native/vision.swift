import Foundation
import Vision
import ImageIO
import PDFKit
import AVFoundation

// All exports are C ABI. Every call returns a malloc'd JSON string (free with vision_free).
// Errors never cross the FFI boundary: they come back as {"ok":false,"error":...}.

private func json(_ obj: [String: Any]) -> UnsafeMutablePointer<CChar>? {
    let data = (try? JSONSerialization.data(withJSONObject: obj, options: [])) ?? Data("{\"ok\":false,\"error\":\"encode\"}".utf8)
    return strdup(String(decoding: data, as: UTF8.self))
}

private func fail(_ msg: String) -> UnsafeMutablePointer<CChar>? { json(["ok": false, "error": msg]) }

private func box(_ r: CGRect) -> [String: Double] {
    ["x": r.origin.x, "y": r.origin.y, "w": r.size.width, "h": r.size.height] // normalized 0-1, origin bottom-left
}

@_cdecl("vision_free")
public func vision_free(_ p: UnsafeMutablePointer<CChar>?) { free(p) }

@_cdecl("vision_capabilities")
public func vision_capabilities() -> UnsafeMutablePointer<CChar>? {
    let req = VNRecognizeTextRequest()
    req.recognitionLevel = .accurate
    let langs = (try? req.supportedRecognitionLanguages()) ?? []
    let v = ProcessInfo.processInfo.operatingSystemVersion
    return json(["ok": true, "result": [
        "os": "\(v.majorVersion).\(v.minorVersion).\(v.patchVersion)",
        "ocr": ["levels": ["fast", "accurate"], "languages": langs],
    ]])
}

private func parseOpts(_ optsJSON: UnsafePointer<CChar>?) -> [String: Any] {
    guard let optsJSON, let o = try? JSONSerialization.jsonObject(with: Data(String(cString: optsJSON).utf8)) as? [String: Any] else { return [:] }
    return o
}

private func decode(_ bytes: UnsafePointer<UInt8>?, _ len: Int) -> CGImage? {
    guard let bytes, len > 0,
          let src = CGImageSourceCreateWithData(Data(bytes: bytes, count: len) as CFData, nil) else { return nil }
    return CGImageSourceCreateImageAtIndex(src, 0, nil)
}

private func ocrLines(_ image: CGImage, _ opts: [String: Any]) throws -> [[String: Any]] {
    let req = VNRecognizeTextRequest()
    req.recognitionLevel = (opts["level"] as? String) == "fast" ? .fast : .accurate
    req.usesLanguageCorrection = (opts["correction"] as? Bool) ?? true
    if let langs = opts["languages"] as? [String], !langs.isEmpty {
        req.recognitionLanguages = langs
    } else {
        req.automaticallyDetectsLanguage = true
    }
    try VNImageRequestHandler(cgImage: image, options: [:]).perform([req])
    return (req.results ?? []).compactMap { obs in
        guard let top = obs.topCandidates(1).first else { return nil }
        return ["text": top.string, "confidence": top.confidence, "box": box(obs.boundingBox)]
    }
}

private func timed(_ start: Date, _ result: [String: Any]) -> UnsafeMutablePointer<CChar>? {
    json(["ok": true, "result": result, "durationMs": Int(Date().timeIntervalSince(start) * 1000)])
}

/// opts: {"level":"fast|accurate","languages":["th-TH","en-US"],"correction":true}
@_cdecl("vision_ocr")
public func vision_ocr(_ bytes: UnsafePointer<UInt8>?, _ len: Int, _ optsJSON: UnsafePointer<CChar>?) -> UnsafeMutablePointer<CChar>? {
    guard let image = decode(bytes, len) else { return fail("cannot decode image") }
    let start = Date()
    do {
        let lines = try ocrLines(image, parseOpts(optsJSON))
        return timed(start, [
            "text": lines.map { $0["text"] as! String }.joined(separator: "\n"),
            "lines": lines, "width": image.width, "height": image.height,
        ])
    } catch { return fail("vision: \(error.localizedDescription)") }
}

/// opts: {"scale":2,"pages":[1,2]} plus the text options above. Pages are 1-based.
@_cdecl("vision_pdf")
public func vision_pdf(_ bytes: UnsafePointer<UInt8>?, _ len: Int, _ optsJSON: UnsafePointer<CChar>?) -> UnsafeMutablePointer<CChar>? {
    guard let bytes, len > 0, let doc = PDFDocument(data: Data(bytes: bytes, count: len)) else { return fail("cannot read pdf") }
    let opts = parseOpts(optsJSON)
    let scale = CGFloat((opts["scale"] as? Double) ?? 2)
    let wanted = Set((opts["pages"] as? [Int]) ?? Array(1...max(doc.pageCount, 1)))
    let start = Date()
    var pages: [[String: Any]] = []
    for i in 0..<doc.pageCount where wanted.contains(i + 1) {
        guard let page = doc.page(at: i) else { continue }
        let r = page.bounds(for: .mediaBox)
        let w = Int(r.width * scale), h = Int(r.height * scale)
        guard let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0,
                                  space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { continue }
        ctx.setFillColor(CGColor(gray: 1, alpha: 1)); ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
        ctx.scaleBy(x: scale, y: scale)
        page.draw(with: .mediaBox, to: ctx)
        guard let img = ctx.makeImage() else { continue }
        do {
            let lines = try ocrLines(img, opts)
            pages.append(["page": i + 1, "text": lines.map { $0["text"] as! String }.joined(separator: "\n"), "lines": lines])
        } catch { pages.append(["page": i + 1, "error": error.localizedDescription]) }
    }
    return timed(start, ["pageCount": doc.pageCount, "pages": pages])
}

@_cdecl("vision_barcode")
public func vision_barcode(_ bytes: UnsafePointer<UInt8>?, _ len: Int) -> UnsafeMutablePointer<CChar>? {
    guard let image = decode(bytes, len) else { return fail("cannot decode image") }
    let start = Date()
    let req = VNDetectBarcodesRequest()
    do { try VNImageRequestHandler(cgImage: image, options: [:]).perform([req]) }
    catch { return fail("vision: \(error.localizedDescription)") }
    let codes: [[String: Any]] = (req.results ?? []).map {
        ["payload": $0.payloadStringValue ?? NSNull(), "symbology": $0.symbology.rawValue, "confidence": $0.confidence, "box": box($0.boundingBox)]
    }
    return timed(start, ["barcodes": codes])
}

@available(macOS 26.0, *)
private func recognizeDocument(_ image: CGImage, _ opts: [String: Any]) async throws -> [String: Any] {
    var req = RecognizeDocumentsRequest()
    if let langs = opts["languages"] as? [String], !langs.isEmpty {
        req.textRecognitionOptions.automaticallyDetectLanguage = false
        req.textRecognitionOptions.recognitionLanguages = langs.map { Locale.Language(identifier: $0) }
    }
    let docs = try await req.perform(on: image, orientation: nil)

    func text(_ c: DocumentObservation.Container) -> String { c.text.transcript }
    return ["documents": docs.map { d -> [String: Any] in
        let c = d.document
        return [
            "title": c.title?.transcript ?? NSNull(),
            "text": c.text.transcript,
            "paragraphs": c.paragraphs.map { $0.transcript },
            "tables": c.tables.map { t in
                t.rows.map { row in row.map { cell in text(cell.content) } }
            },
            "lists": c.lists.map { l in
                l.items.map { ["marker": $0.markerString, "text": $0.itemString] }
            },
            "barcodes": c.barcodes.map { b -> [String: Any] in ["payload": (b.payloadString as Any?) ?? NSNull(), "symbology": String(describing: b.symbology)] },
            "confidence": d.confidence,
        ]
    }]
}

/// Structured document parsing (tables, lists, paragraphs). macOS 26+.
@_cdecl("vision_document")
public func vision_document(_ bytes: UnsafePointer<UInt8>?, _ len: Int, _ optsJSON: UnsafePointer<CChar>?) -> UnsafeMutablePointer<CChar>? {
    guard let image = decode(bytes, len) else { return fail("cannot decode image") }
    guard #available(macOS 26.0, *) else { return fail("RecognizeDocumentsRequest needs macOS 26+") }
    let opts = parseOpts(optsJSON)
    let start = Date()
    let sem = DispatchSemaphore(value: 0)
    nonisolated(unsafe) var out: Result<[String: Any], Error> = .failure(NSError(domain: "vision", code: 0))
    nonisolated(unsafe) let o = opts
    Task.detached {
        do { out = .success(try await recognizeDocument(image, o)) } catch { out = .failure(error) }
        sem.signal()
    }
    sem.wait()
    switch out {
    case .success(let r): return timed(start, r)
    case .failure(let e): return fail("vision: \(e.localizedDescription)")
    }
}

@_cdecl("vision_version")
public func vision_version() -> UnsafeMutablePointer<CChar>? {
    let v = ProcessInfo.processInfo.operatingSystemVersion
    let fw = Bundle(for: VNRequest.self)
    var build = [CChar](repeating: 0, count: 64); var size = build.count
    sysctlbyname("kern.osversion", &build, &size, nil, 0)
    var model = [CChar](repeating: 0, count: 64); var msize = model.count
    sysctlbyname("hw.model", &model, &msize, nil, 0)
    return json(["ok": true, "result": [
        "macos": ["version": "\(v.majorVersion).\(v.minorVersion).\(v.patchVersion)", "build": String(cString: build), "arch": "arm64", "model": String(cString: model)],
        "vision": [
            "framework": fw.infoDictionary?["CFBundleShortVersionString"] ?? NSNull(),
            "build": fw.infoDictionary?["CFBundleVersion"] ?? NSNull(),
            "textRecognitionRevision": VNRecognizeTextRequest.currentRevision,
            "documentRequest": { if #available(macOS 26.0, *) { return true } else { return false } }(),
        ],
    ]])
}

// ---- phase 2: generic dispatcher --------------------------------------------------------------

private func pt(_ p: CGPoint) -> [String: Double] { ["x": p.x, "y": p.y] }

private func png(_ buf: CVPixelBuffer) -> String? {
    let ci = CIImage(cvPixelBuffer: buf)
    return CIContext().pngRepresentation(of: ci, format: .L8, colorSpace: CGColorSpaceCreateDeviceGray())?.base64EncodedString()
}

private func poseJSON<K: Hashable & RawRepresentable>(_ pts: [K: VNRecognizedPoint], _ minConf: Float) -> [String: Any] where K.RawValue == VNRecognizedPointKey {
    var out: [String: Any] = [:]
    for (k, p) in pts where p.confidence >= minConf {
        out[k.rawValue.rawValue] = ["x": p.location.x, "y": p.location.y, "confidence": p.confidence]
    }
    return out
}

private func run(_ op: String, _ image: CGImage, _ opts: [String: Any]) throws -> [String: Any] {
    let handler = VNImageRequestHandler(cgImage: image, options: [:])
    let minConf = Float((opts["minConfidence"] as? Double) ?? 0.1)

    switch op {
    case "face":
        let lm = VNDetectFaceLandmarksRequest()
        let q = VNDetectFaceCaptureQualityRequest()
        try handler.perform([lm, q])
        let quality = (q.results ?? []).map { $0.faceCaptureQuality as Any? }
        let faces: [[String: Any]] = (lm.results ?? []).enumerated().map { (i, f) in
            var d: [String: Any] = ["box": box(f.boundingBox), "confidence": f.confidence]
            if let r = f.roll { d["roll"] = r }; if let y = f.yaw { d["yaw"] = y }; if let p = f.pitch { d["pitch"] = p }
            if i < quality.count, let cq = quality[i] { d["captureQuality"] = cq }
            if let l = f.landmarks { // points are relative to the face box
                var regions: [String: Any] = [:]
                let all: [(String, VNFaceLandmarkRegion2D?)] = [("leftEye", l.leftEye), ("rightEye", l.rightEye), ("leftEyebrow", l.leftEyebrow),
                    ("rightEyebrow", l.rightEyebrow), ("nose", l.nose), ("noseCrest", l.noseCrest), ("outerLips", l.outerLips),
                    ("innerLips", l.innerLips), ("faceContour", l.faceContour), ("leftPupil", l.leftPupil), ("rightPupil", l.rightPupil)]
                for (n, r) in all { if let r { regions[n] = r.normalizedPoints.map(pt) } }
                d["landmarks"] = regions
            }
            return d
        }
        return ["faces": faces]

    case "human":
        let r = VNDetectHumanRectanglesRequest(); r.upperBodyOnly = (opts["upperBodyOnly"] as? Bool) ?? false
        try handler.perform([r])
        return ["humans": (r.results ?? []).map { ["box": box($0.boundingBox), "confidence": $0.confidence] }]

    case "body":
        let r = VNDetectHumanBodyPoseRequest(); try handler.perform([r])
        return ["bodies": try (r.results ?? []).map { ["joints": poseJSON(try $0.recognizedPoints(.all), minConf), "confidence": $0.confidence] }]

    case "hand":
        let r = VNDetectHumanHandPoseRequest(); r.maximumHandCount = (opts["maxHands"] as? Int) ?? 2
        try handler.perform([r])
        return ["hands": try (r.results ?? []).map { ["chirality": String(describing: $0.chirality), "joints": poseJSON(try $0.recognizedPoints(.all), minConf), "confidence": $0.confidence] }]

    case "animal":
        let r = VNRecognizeAnimalsRequest(); try handler.perform([r])
        return ["animals": (r.results ?? []).map { o in
            ["box": box(o.boundingBox), "labels": o.labels.map { ["label": $0.identifier, "confidence": $0.confidence] }]
        }]

    case "classify":
        let r = VNClassifyImageRequest(); try handler.perform([r])
        let top = (opts["top"] as? Int) ?? 10
        let items = (r.results ?? []).filter { $0.confidence >= minConf }.sorted { $0.confidence > $1.confidence }.prefix(top)
        return ["labels": items.map { ["label": $0.identifier, "confidence": $0.confidence] }]

    case "saliency":
        let objectness = (opts["type"] as? String) == "objectness"
        let r: VNImageBasedRequest = objectness ? VNGenerateObjectnessBasedSaliencyImageRequest() : VNGenerateAttentionBasedSaliencyImageRequest()
        try handler.perform([r])
        guard let o = r.results?.first as? VNSaliencyImageObservation else { return ["type": objectness ? "objectness" : "attention", "regions": []] }
        var out: [String: Any] = ["type": objectness ? "objectness" : "attention", "regions": (o.salientObjects ?? []).map { ["box": box($0.boundingBox), "confidence": $0.confidence] }]
        if (opts["heatmap"] as? Bool) == true { out["heatmapPng"] = png(o.pixelBuffer) as Any }
        return out

    case "mask":
        if (opts["type"] as? String) == "person" {
            let r = VNGeneratePersonSegmentationRequest(); r.qualityLevel = .accurate
            try handler.perform([r])
            guard let o = r.results?.first else { return ["maskPng": NSNull()] }
            return ["type": "person", "maskPng": png(o.pixelBuffer) as Any]
        }
        let r = VNGenerateForegroundInstanceMaskRequest(); try handler.perform([r])
        guard let o = r.results?.first else { return ["type": "foreground", "instances": 0, "maskPng": NSNull()] }
        let buf = try o.generateScaledMaskForImage(forInstances: o.allInstances, from: handler)
        return ["type": "foreground", "instances": o.allInstances.count, "maskPng": png(buf) as Any]

    case "contours":
        let r = VNDetectContoursRequest(); r.contrastAdjustment = Float((opts["contrast"] as? Double) ?? 2)
        try handler.perform([r])
        guard let o = r.results?.first else { return ["contourCount": 0, "contours": []] }
        let maxN = (opts["max"] as? Int) ?? 50
        return ["contourCount": o.contourCount, "contours": o.topLevelContours.prefix(maxN).map { c in
            ["points": c.normalizedPoints.map { ["x": Double($0.x), "y": Double($0.y)] }, "children": c.childContourCount]
        }]

    case "horizon":
        let r = VNDetectHorizonRequest(); try handler.perform([r])
        guard let o = r.results?.first else { return ["horizon": NSNull()] }
        return ["horizon": ["angleRadians": o.angle, "angleDegrees": o.angle * 180 / .pi]]

    case "rectangles":
        let r = VNDetectRectanglesRequest(); r.maximumObservations = (opts["max"] as? Int) ?? 10
        r.minimumConfidence = minConf; try handler.perform([r])
        return ["rectangles": (r.results ?? []).map { ["box": box($0.boundingBox), "confidence": $0.confidence,
            "corners": ["topLeft": pt($0.topLeft), "topRight": pt($0.topRight), "bottomRight": pt($0.bottomRight), "bottomLeft": pt($0.bottomLeft)]] }]

    case "page":
        let r = VNDetectDocumentSegmentationRequest(); try handler.perform([r])
        return ["documents": (r.results ?? []).map { ["box": box($0.boundingBox), "confidence": $0.confidence,
            "corners": ["topLeft": pt($0.topLeft), "topRight": pt($0.topRight), "bottomRight": pt($0.bottomRight), "bottomLeft": pt($0.bottomLeft)]] }]

    case "featureprint":
        let r = VNGenerateImageFeaturePrintRequest(); try handler.perform([r])
        guard let o = r.results?.first else { return [:] }
        return ["elementCount": o.elementCount, "elementType": String(describing: o.elementType)]

    default:
        throw NSError(domain: "vision", code: 1, userInfo: [NSLocalizedDescriptionKey: "unknown op: \(op)"])
    }
}

/// One entry point for all single-image operations.
@_cdecl("vision_run")
public func vision_run(_ op: UnsafePointer<CChar>?, _ bytes: UnsafePointer<UInt8>?, _ len: Int, _ optsJSON: UnsafePointer<CChar>?) -> UnsafeMutablePointer<CChar>? {
    guard let op, let image = decode(bytes, len) else { return fail("cannot decode image") }
    let start = Date()
    do { return timed(start, try run(String(cString: op), image, parseOpts(optsJSON))) }
    catch { return fail("vision: \(error.localizedDescription)") }
}

@_cdecl("vision_similarity")
public func vision_similarity(_ a: UnsafePointer<UInt8>?, _ alen: Int, _ b: UnsafePointer<UInt8>?, _ blen: Int) -> UnsafeMutablePointer<CChar>? {
    guard let ia = decode(a, alen), let ib = decode(b, blen) else { return fail("cannot decode image") }
    let start = Date()
    do {
        let ra = VNGenerateImageFeaturePrintRequest(), rb = VNGenerateImageFeaturePrintRequest()
        try VNImageRequestHandler(cgImage: ia, options: [:]).perform([ra])
        try VNImageRequestHandler(cgImage: ib, options: [:]).perform([rb])
        guard let fa = ra.results?.first, let fb = rb.results?.first else { return fail("no feature print") }
        var d: Float = 0
        try fa.computeDistance(&d, to: fb)
        return timed(start, ["distance": d]) // 0 = identical; larger = less similar
    } catch { return fail("vision: \(error.localizedDescription)") }
}


// ---- TTS voice list (synthesis itself lives in tts.swift: AVSpeechSynthesizer delivers its callbacks on the main thread) ----

private func voiceJSON(_ v: AVSpeechSynthesisVoice) -> [String: Any] {
    let q: String
    switch v.quality { case .premium: q = "premium"; case .enhanced: q = "enhanced"; default: q = "default" }
    let g: String
    switch v.gender { case .male: g = "male"; case .female: g = "female"; default: g = "unspecified" }
    return ["identifier": v.identifier, "name": v.name, "language": v.language, "quality": q, "gender": g,
            "personal": v.voiceTraits.contains(.isPersonalVoice), "novelty": v.voiceTraits.contains(.isNoveltyVoice)]
}

@_cdecl("vision_voices")
public func vision_voices() -> UnsafeMutablePointer<CChar>? {
    json(["ok": true, "result": ["voices": AVSpeechSynthesisVoice.speechVoices().map(voiceJSON)]])
}
