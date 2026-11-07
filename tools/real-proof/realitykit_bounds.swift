import Foundation
import RealityKit
@main struct Main {
  static func main() async throws {
    let dir = CommandLine.arguments[1]
    let files = try FileManager.default.contentsOfDirectory(atPath: dir).filter { $0.hasSuffix(".usdz") }.sorted()
    for f in files {
      do {
        let e = try await Entity(contentsOf: URL(fileURLWithPath: dir + "/" + f))
        let b = e.visualBounds(relativeTo: nil)
        print(f, "min", b.min.x, b.min.y, b.min.z, "max", b.max.x, b.max.y, b.max.z, "scale", e.scale.x, "anims", e.availableAnimations.count)
      } catch { print(f, "ERROR", error) }
    }
  }
}
