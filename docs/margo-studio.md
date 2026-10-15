# Margo Studio (planned, post-launch)

Three authoring tools built on Margo and for Margo, each a feature-for-feature equivalent of an existing tool,
written as new, modern TypeScript on WebGPU. They are also the strongest proof that Margo is more than a viewer:
interactive editing of voxels, tiles and skinned characters at 60 FPS in the browser.

Scott's requirement (2026-10-15): replicate the features of each tool exactly; faster, newer, more modern code.

## Ground rules

- **Features, not code or branding.** MagicaVoxel and Crocotile 3D are closed source: reproduce behaviour only,
  never decompile or copy assets. Dust3D is MIT-licensed: studying it is allowed, but we write our own code.
  Our own product names and icons; no look-alike branding.
- **Their file formats are fair game** for import/export so users can bring work over: MagicaVoxel `.vox` (documented
  chunk format), Crocotile scenes, Dust3D `.ds3`.
- **Verify before building.** The inventories below are drafts from memory. Step one for each tool is a feature audit
  against its current release (menus, tools, shortcuts, file formats, export options), checked off line by line,
  with every behaviour difference recorded. "Exact" means the audit list is fully covered.
- **Built under the hygiene gates** (HANDOFF 5k) like any Margo package, with tests and proofs.

## Reference sources for the feature audits (from Scott)

| Tool | Source |
|---|---|
| MagicaVoxel | https://ephtracy.github.io/ (official site; also the `.vox` format notes linked from it) |
| Crocotile 3D | https://crocotile3d.com/howto.html#overview (official how-to / manual) |
| Dust3D | https://github.com/huxingyi/dust3d (MIT source and docs; study allowed, our own code) |

Each audit reads its source end to end and lists every tool, menu item, shortcut, option and file format before any
building starts.

## Shared shell ("Margo Studio")

- One Margo viewport kernel for all three: camera navigation profiles (5h.b; each tool's own bindings as a profile),
  ViewCube, orthographic/perspective, grid and snapping, environment lighting, post stack, picking (bvh/selection),
  undo/redo (command stack), autosave (asset cache / IndexedDB), file open/save (File System Access API with download
  fallback), keyboard-shortcut map per tool, light/dark UI.
- Instant play-test: swap the editor camera for a character controller with `@margoengine/physics` and `input`.
- Web first; optional desktop shell (Tauri) later.
- Outputs: glTF/GLB via `@margoengine/exporters`, plus Margo-native extras (colliders, navmesh, animator graphs).

## 1. Voxel editor (MagicaVoxel equivalent)

Draft inventory to verify:
- Models up to 256 x 256 x 256; multiple models per scene; scene/world editor with groups, transforms, layers,
  visibility; per-model animation frames.
- 256-colour palette with palette editor, import/export, colour picking from the scene.
- Brushes: voxel, face, box, line, centre, pattern; modes attach / erase / paint / move; fill; selection (marquee,
  colour, connected), selection transforms; mirror axes; resize, rotate, flip, crop.
- Shader scripting: procedural voxel generation with user shaders (MagicaVoxel's script DSL - define our equivalent
  in WGSL/TS compute, plus importers where feasible).
- Renderer: path-traced preview with materials (diffuse, metal, glass, emissive, cloud/media, blend), sun/sky/area
  lighting, depth of field, bloom, ground shadows; render to image.
- Export: `.vox`, `.obj`, `.ply`, glTF, slices/images and the other formats the current release offers.
- Margo advantages to add on top: greedy meshing with per-vertex AO in a worker, direct GPU upload (no export step),
  LOD/imposters for huge scenes.

## 2. Tile / level editor (Crocotile 3D equivalent)

Draft inventory to verify:
- Tilesets from images (multiple), tile picking, draw tiles onto camera-aligned or grid-aligned 3D planes.
- Vertex / edge / face editing, extrude, subdivide, merge, flip, rotate/mirror tiles, UV editing.
- Objects, prefabs/instances, layers, billboards, lights/vertex colours.
- Skeletal animation features of the current release (verify scope).
- Snapping, grid sizes, selection modes, camera presets.
- Export: `.obj`, `.gltf`/`.glb`, `.dae` and others the current release offers; import of its scene files.
- Margo advantages: per-tile game metadata (walkable, sound, collider type, triggers) carried into the level,
  baked navmesh (`@margoengine/navigation`) and Rapier colliders (`@margoengine/physics`) on save, instanced batching.

## 3. Node / skeleton modeller (Dust3D equivalent)

Draft inventory to verify:
- Place and connect nodes with radii in front/side views; symmetry; parts tree with per-part settings (subdivision,
  rounding, chamfer, cut faces, colour, material, deform).
- Automatic mesh generation around the skeleton, automatic UV unwrap, materials/textures.
- Auto-rigging from the node graph; procedural motion (walk/run cycles) and a motion editor.
- Export glTF/FBX/OBJ as the current release does; import `.ds3`.
- Margo advantages: live preview with `@margoengine/animation` + `animator` (state machines, blend trees, foot IK),
  saved straight into Margo's animator format; VAT bake for crowds.

## Order and size

After Margo 1.0 launches. Suggested order: voxel editor (smallest, most self-contained, great demo), tile/level editor
(feeds the game guide), node modeller (hardest: meshing and auto-rigging). Each starts with its feature audit and a
written scope sign-off from Scott before building.
