import Foundation
import RealityKit
import Metal
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers
// Steps the real RealityKit animation on a file and reads what RealityKit itself computed.
func modelEntity(_ e: Entity) -> ModelEntity? {
  if let m = e as? ModelEntity, !m.jointNames.isEmpty { return m }
  for c in e.children { if let m = modelEntity(c) { return m } }
  return nil
}
func worldJoints(_ m: ModelEntity) -> [String: simd_float4x4] {
  var w = [String: simd_float4x4]()
  for (i, n) in m.jointNames.enumerated() {
    let parts = n.split(separator: "/"); let parent = parts.dropLast().joined(separator: "/")
    w[n] = (w[parent] ?? matrix_identity_float4x4) * m.jointTransforms[i].matrix
  }
  return w
}
@main struct Main {
  static func main() async throws {
    let path = CommandLine.arguments[1], out = CommandLine.arguments[2]
    let e = try await Entity(contentsOf: URL(fileURLWithPath: path))
    let r = try RealityRenderer()
    r.entities.append(e)
    let floor = ModelEntity(mesh: .generatePlane(width: 6, depth: 6), materials: [UnlitMaterial(color: .init(red: 0.2, green: 0.5, blue: 0.9, alpha: 1))])
    r.entities.append(floor)
    let lift = Float(CommandLine.arguments.count > 3 ? CommandLine.arguments[3] : "0.05")!; let dist = Float(CommandLine.arguments.count > 4 ? CommandLine.arguments[4] : "2.6")!; let cam = PerspectiveCamera(); cam.position = [0, lift, dist]; cam.camera.fieldOfViewInDegrees = 40
    r.entities.append(cam); r.activeCamera = cam
    let dev = MTLCreateSystemDefaultDevice()!
    let d = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: .bgra8Unorm_srgb, width: 640, height: 640, mipmapped: false)
    d.usage = [.renderTarget, .shaderRead]; d.storageMode = .shared
    let tex = dev.makeTexture(descriptor: d)!
    let m = modelEntity(e)
    if let a = e.availableAnimations.first { e.playAnimation(a.repeat()) ; print("playing", e.availableAnimations.count) }
    for step in 0..<14 {
      try await withCheckedThrowingContinuation { (c: CheckedContinuation<Void, Error>) in
        do {
          try r.updateAndRender(deltaTime: step == 0 ? 0 : 0.1, cameraOutput: .init(.singleProjection(colorTexture: tex)), onComplete: { _ in c.resume() })
        } catch { c.resume(throwing: error) }
      }
      if let m {
        let w = worldJoints(m)
        let low = w.min { $0.value.columns.3.y < $1.value.columns.3.y }!
        let b = e.visualBounds(relativeTo: nil)
        print("t", String(format: "%.1f", Double(step) * 0.1), "lowestJointY", low.value.columns.3.y, low.key.split(separator: "/").last ?? "", "rootPos", m.jointTransforms[0].translation, "visual y", b.min.y, b.max.y, "entityY", e.position.y)
      }
      if step == 0 || step == 5 || step == 13 {
        var px = [UInt8](repeating: 0, count: 640 * 640 * 4)
        tex.getBytes(&px, bytesPerRow: 640 * 4, from: MTLRegionMake2D(0, 0, 640, 640), mipmapLevel: 0)
        let cs = CGColorSpace(name: CGColorSpace.sRGB)!
        let ctx = CGContext(data: &px, width: 640, height: 640, bitsPerComponent: 8, bytesPerRow: 640 * 4, space: cs, bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue)!
        let u = URL(fileURLWithPath: "\(out)-\(step).png")
        let dst = CGImageDestinationCreateWithURL(u as CFURL, UTType.png.identifier as CFString, 1, nil)!
        CGImageDestinationAddImage(dst, ctx.makeImage()!, nil); CGImageDestinationFinalize(dst)
      }
    }
  }
}
