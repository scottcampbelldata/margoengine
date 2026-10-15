# Demo model assets

These models are served from the demo's own origin so startup does not depend on
GitHub's asset server. The original GLBs retain their geometry, materials and animation.

- `robot-expressive.glb`: [RobotExpressive from three.js](https://github.com/mrdoob/three.js/tree/dev/examples/models/gltf/RobotExpressive).
  Model by Tomás Laulhé, facial morphs and glTF conversion by Don McCurdy, CC0 1.0.
  See [upstream credits](robot-CREDITS.md).
- `flight-helmet.glb`: [Flight Helmet from Khronos glTF Sample Assets](https://github.com/KhronosGroup/glTF-Sample-Assets/tree/main/Models/FlightHelmet),
  CC0 1.0 Universal (© 2018, Public; conversion from Maya credited to Gary Hsu). Credit is a courtesy; CC0 does not
  require it. Derived from `khronos/FlightHelmet/` (glTF + PNG, see `khronos/README.md` in the repository): all
  94,722 triangles, 1024-pixel JPEG maps, quantized normals/tangents/UVs (`KHR_mesh_quantization`).
- `flight-helmet-mobile.glb`: the same helmet with 512-pixel JPEG maps and 20,734 triangles (meshoptimizer,
  normal/UV-aware, error bound 0.005). Also CC0.

- `tokyo-diorama.glb`: original work for Margo Engine (MIT), built by `npm run build:tokyo`. Its baked textures use
  Poly Haven CC0 textures and its lettering uses Noto Sans CJK (SIL OFL 1.1). See [its credits](tokyo-diorama-CREDITS.md).

Regenerate both helmet GLBs with `node scripts/optimize-demo-assets.js`. This uses
the image and mesh tools already installed in this workspace and validates each GLB
(Khronos glTF-Validator: 0 errors, 0 warnings).

## Internal tests and benchmarks only (not served on margoengine.com)

- `damaged-helmet.glb`: [Damaged Helmet from Khronos glTF Sample Assets](https://github.com/KhronosGroup/glTF-Sample-Assets/tree/main/Models/DamagedHelmet).
  Earlier model by theblueturtle_ (CC BY-NC 4.0), conversion by ctxwing (CC BY 4.0).
  See `damaged-helmet-CREDITS.md` in the repository. Because of the non-commercial licence it is used only by
  repository tests and benchmarks, never by a public demo, the site or the docs' runnable examples.
