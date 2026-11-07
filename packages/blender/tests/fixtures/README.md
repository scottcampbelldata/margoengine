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
- `pbr-ext.margo`: exported for this project by Blender 5.2.3 LTS from `tools/blender-addon/tests/blender_pbr_ext.py`:
  Principled planes with transmission, IOR, coat, sheen and subsurface over a backdrop (Apache-2.0, as this
  repository). Regenerate the same way and copy the file here.
