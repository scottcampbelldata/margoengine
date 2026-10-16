# Light Keeper workshop assets

The robot and workshop geometry, armature, smooth skin weights, idle animation,
silver interaction orb, asset generation code, and procedural paint, metal,
rubber, ceramic, and fabric surfaces are original work created for Margo Engine.
Copyright (c) 2026 Scott Campbell, under the repository's
[MIT license](../../LICENSE).

The case-back dedication, **Margo Engine ♡ / Made for Margie**, is original gold
ink artwork rasterized in Blender and baked onto the existing case surface.
Its editable generator, image, and authoring provenance are retained under
`source/skinning_ik/dedication.py` and `source/skinning_ik/dedication/`.

The exported `skinning-ik.glb` combines that original work with the following
photographic PBR surface maps from [Poly Haven](https://polyhaven.com):

- [Wood Table Worn](https://polyhaven.com/a/wood_table_worn), used on the wood
  surfaces. Photography by Dimitrios Savva; processing by Rico Cilliers.
- [Concrete Floor Worn 001](https://polyhaven.com/a/concrete_floor_worn_001), used
  on stone and concrete surfaces. Photography by Dimitrios Savva; processing by
  Rico Cilliers.

Both map sets are **CC0-1.0**, as described in the
[Poly Haven asset license](https://polyhaven.com/license). The source downloads
include 1K diffuse, OpenGL normal, and roughness JPGs. Exact file URLs, authors,
MD5/SHA-256 hashes, color spaces, and physical scan dimensions are recorded in
[`source/skinning_ik/textures/polyhaven/manifest.json`](source/skinning_ik/textures/polyhaven/manifest.json).
The maps are packed into the editable Blender file and embedded in the workshop
GLB through `source/skinning_ik/surface_textures.py`; the browser makes no live
Poly Haven requests.

The concrete scan is used as a derivative dry limestone finish: its diffuse map
is graded toward pale warm `#C9BDA9` with reduced contrast, roughness is remapped
with `0.80 + 0.15 × source`, normal strength is reduced to `0.25`, and metalness
is zero. The derived color/ORM images are generated and packed locally; the
original CC0 downloads and their manifest hashes remain unchanged.

The local environment file `skinning-ik-workshop.hdr` is the 1K Radiance HDR
edition of [Artist Workshop](https://polyhaven.com/a/artist_workshop), by
**Oliksiy Yakovlyev**, published by Poly Haven under **CC0-1.0**. Its exact source
URL, provider MD5, SHA-256, and attribution are recorded in
[`source/skinning_ik/textures/polyhaven/environment.json`](source/skinning_ik/textures/polyhaven/environment.json).
It provides the workshop environment light and reflection fallback; the live
orb probe also captures the original robot and furniture.

[Black Walnut Veneer 02](https://polyhaven.com/a/black_walnut_veneer_02), by
Jenelle van Heerden, is also stored in the source texture folder under CC0-1.0
as an **unused alternative**. The current surface pipeline does not assign it
to the model or embed it in the workshop GLB.

The Blender source and generators are under `source/skinning-ik.blend` and
`source/skinning_ik/`. No third-party geometry, rig, or animation is included.
The user-approved visual reference is preserved separately as
`source/skinning_ik/visual-target.png`; it is an art-direction reference and is
not embedded in the runtime assets.

The interaction design was studied from the Three.js
[skinning / inverse kinematics example](https://threejs.org/examples/#webgl_animation_skinning_ik).
The Margo demo does not use Three.js as its renderer or runtime.
