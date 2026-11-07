import AppKit
import Foundation
import QuickLookThumbnailing

// Asks the system for the same thumbnail Finder shows, and saves it as a PNG.
let args = CommandLine.arguments
let outDir = args[1]
let group = DispatchGroup()
for path in args.dropFirst(2) {
  let url = URL(fileURLWithPath: path)
  let request = QLThumbnailGenerator.Request(fileAt: url, size: CGSize(width: 384, height: 384), scale: 1, representationTypes: .thumbnail)
  group.enter()
  QLThumbnailGenerator.shared.generateBestRepresentation(for: request) { rep, error in
    defer { group.leave() }
    guard let rep else { print(url.lastPathComponent, "NO THUMBNAIL", error?.localizedDescription ?? ""); return }
    let image = rep.nsImage
    guard let tiff = image.tiffRepresentation, let bitmap = NSBitmapImageRep(data: tiff), let png = bitmap.representation(using: .png, properties: [:]) else { print(url.lastPathComponent, "NO PNG"); return }
    try? png.write(to: URL(fileURLWithPath: outDir + "/" + url.deletingPathExtension().lastPathComponent + ".png"))
    print(url.lastPathComponent, "ok", Int(image.size.width), Int(image.size.height), "type", rep.type.rawValue)
  }
}
let done = group.wait(timeout: .now() + 120)
print(done == .success ? "done" : "TIMED OUT")
