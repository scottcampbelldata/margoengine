# Demo model assets

These models are served from the demo's own origin so startup does not depend on
GitHub's asset server. The original GLBs retain their geometry, materials and animation.

- `robot-expressive.glb`: [RobotExpressive from three.js](https://github.com/mrdoob/three.js/tree/dev/examples/models/gltf/RobotExpressive).
  Model by Tomás Laulhé, facial morphs and glTF conversion by Don McCurdy, CC0 1.0.
  See [upstream credits](robot-CREDITS.md).
- `damaged-helmet.glb`: [Damaged Helmet from Khronos glTF Sample Assets](https://github.com/KhronosGroup/glTF-Sample-Assets/tree/main/Models/DamagedHelmet).
  Earlier model by theblueturtle_ (CC BY-NC 4.0), conversion by ctxwing (CC BY 4.0).
  See [upstream credits](helmet-CREDITS.md).
- `damaged-helmet-mobile.glb`: derivative of the same helmet, with 512-pixel JPEG
  maps and 6,179 triangles (original: 15,452). Meshoptimizer preserves normals/UVs
  during simplification with an error bound of 0.005. It retains the source licenses.

Regenerate the phone assets with `node scripts/optimize-demo-assets.js`. This uses
the image and mesh tools already installed in this workspace and validates the GLB.
