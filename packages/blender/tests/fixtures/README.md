# .margo test fixtures

- `triangle.margo`, `compact-triangle.margo`, `mixed-triangle.margo`, `triangle-uint16.margo`: written by
  `tools/blender-addon/writer.py` from `tools/blender-addon/tests/test_format.py` (Apache-2.0, as this repository).
- `anim.margo` and `anim-truth.json`: exported for this project by Blender 5.2.3 LTS (official build from blender.org,
  run as a black box) from `tools/blender-addon/tests/blender_anim.py`, which also records Blender's own deformed
  vertices per clip and frame (Apache-2.0, as this repository). Regenerate with
  `blender --background --factory-startup --python tools/blender-addon/tests/blender_anim.py -- <folder>` and copy both
  files here.
- `components.margo`: exported for this project by Blender 5.2.3 LTS from
  `tools/blender-addon/tests/blender_components.py`: a level whose objects carry `margo:` component tags (Apache-2.0, as
  this repository). Regenerate the same way and copy the file here.
- `bake.margo`: exported for this project by Blender 5.2.3 LTS from `tools/blender-addon/tests/blender_bake.py`: a
  procedural Principled material and a Diffuse BSDF baked to 32 x 32 images at export, beside a direct Principled
  plane (Apache-2.0, as this repository). Regenerate the same way and copy the file here.
- `scene.margo` and `scene-truth.json`: exported for this project by Blender 5.2.3 LTS from
  `tools/blender-addon/tests/blender_scene.py`: a floor and a cube lit by a sun, a spot and a point light, with a
  perspective scene camera and an orthographic one; the JSON holds Blender's own light directions and camera
  projections (Apache-2.0, as this repository). Regenerate the same way and copy both files here.
- `pbr-ext.margo`: exported for this project by Blender 5.2.3 LTS from `tools/blender-addon/tests/blender_pbr_ext.py`:
  Principled planes with transmission, IOR, coat, sheen and subsurface over a backdrop (Apache-2.0, as this
  repository). Regenerate the same way and copy the file here.
- `curves.margo` and `curves-truth.json`: exported for this project by Blender 5.2.3 LTS from
  `tools/blender-addon/tests/blender_curves.py` with `curves=True`: Bezier, poly, NURBS and hair curves, a point cloud
  and a volume; the JSON holds Blender's own evaluated polylines, points and openvdb voxel reads (Apache-2.0, as this
  repository). Regenerate the same way and copy both files here.
