// Opens a video with AVFoundation, the framework QuickTime Player plays through, and reports what a person would get:
// whether it is playable, its duration, every decoded video frame's time, and the first and last frames as PNG.
// swiftc -parse-as-library avfoundation_video.swift -o avv, then ./avv <out folder> a.mp4 [b.mov ...]
import AVFoundation
import CoreImage
import Foundation
import ImageIO
import UniformTypeIdentifiers

@main struct Probe {
  static func main() async {
    let args = CommandLine.arguments
    guard args.count > 2 else { print("usage: avv <out folder> <video> ..."); exit(2) }
    let out = URL(fileURLWithPath: args[1], isDirectory: true)
    try? FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
    var rows: [[String: Any]] = []
    for path in args.dropFirst(2) { rows.append(await probe(URL(fileURLWithPath: path), out)) }
    let data = try! JSONSerialization.data(withJSONObject: rows, options: [.prettyPrinted, .sortedKeys])
    print(String(data: data, encoding: .utf8)!)
  }

  static func probe(_ url: URL, _ out: URL) async -> [String: Any] {
    var row: [String: Any] = ["file": url.lastPathComponent]
    let asset = AVURLAsset(url: url)
    do {
      row["playable"] = try await asset.load(.isPlayable)
      row["duration"] = try await asset.load(.duration).seconds
      let tracks = try await asset.loadTracks(withMediaType: .video)
      row["videoTracks"] = tracks.count
      row["audioTracks"] = try await asset.loadTracks(withMediaType: .audio).count
      guard let track = tracks.first else { return row }
      row["trackRange"] = try await { let r = try await track.load(.timeRange); return [r.start.seconds, r.duration.seconds] }()
      row["nominalFrameRate"] = try await track.load(.nominalFrameRate)
      let size = try await track.load(.naturalSize)
      row["size"] = [size.width, size.height]
      let reader = try AVAssetReader(asset: asset)
      let output = AVAssetReaderTrackOutput(track: track, outputSettings: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA])
      reader.add(output)
      guard reader.startReading() else { row["readError"] = String(describing: reader.error); return row }
      var times: [Double] = [], first: CVPixelBuffer?, last: CVPixelBuffer?
      while let sample = output.copyNextSampleBuffer() {
        guard let image = CMSampleBufferGetImageBuffer(sample) else { continue }
        times.append(CMSampleBufferGetPresentationTimeStamp(sample).seconds)
        if first == nil { first = image }
        last = image
      }
      if reader.status == .failed { row["readError"] = String(describing: reader.error) }
      row["decodedFrames"] = times.count
      row["frameTimes"] = times.count > 12 ? Array(times.prefix(6)) + Array(times.suffix(6)) : times
      let stem = url.deletingPathExtension().lastPathComponent + "-" + url.pathExtension
      if let first { row["firstPng"] = write(first, out.appendingPathComponent(stem + "-first.png")) }
      if let last { row["lastPng"] = write(last, out.appendingPathComponent(stem + "-last.png")) }
    } catch { row["error"] = String(describing: error) }
    return row
  }

  static func write(_ buffer: CVPixelBuffer, _ url: URL) -> String {
    let image = CIImage(cvPixelBuffer: buffer)
    guard let cg = CIContext().createCGImage(image, from: image.extent),
      let dest = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil)
    else { return "failed" }
    CGImageDestinationAddImage(dest, cg, nil)
    return CGImageDestinationFinalize(dest) ? url.path : "failed"
  }
}
