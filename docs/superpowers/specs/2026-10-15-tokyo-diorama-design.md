# Tokyo street diorama demo — design

Date: 2026-10-15 · Branch: `perf/auto-quality`

## Goal

An animated, stylized Japanese street-corner diorama shown in Margo Engine, in the spirit of the three.js
`webgl_animation_keyframes` example (Glen Fox's *Littlest Tokyo*). That example is a **reference for genre,
density and presentation only**. Every model, layout, sign and character in this demo is our own design; no
geometry, textures, signage text or characters are copied or traced from Littlest Tokyo.

Success means: the page loads one GLB, the diorama plays a looping keyframed clip (tram moving, small parts
turning), the view slowly turns and can be orbited, and the page uses Margo's equivalent of every package the
three.js example uses.

## Constraints

- Core and the stage facade are frozen for v1.0.0 (AGENTS.md). No changes to `@margoengine/core` or the stage;
  everything lives in the example page and optional packages that already exist.
- No engine package changes are expected. If one turns out to be needed, stop and re-scope.
- Must run on desktop and phone WebGPU browsers.

## Package mapping

| three.js example | Margo | Use |
|---|---|---|
| `GLTFLoader` | `@margoengine/gltf-pro` `loadGLTF` | Load `tokyo-diorama.glb`. |
| `DRACOLoader` | `@margoengine/decoders` `DracoDecoder` | Passed as `decoders.draco`; GLB is Draco-compressed. |
| `AnimationMixer` | `@margoengine/animation` `Animation.attach(model).play(clip)` | Node TRS keyframes (translation/rotation/scale) are already supported. |
| `OrbitControls` (damping, no pan) | `@margoengine/controls` `OrbitControls` | `enableDamping`, `enablePan = false`, `autoRotate` for the slow turn. |
| `RoomEnvironment` + `PMREMGenerator` | `@margoengine/environment` `Environment` | Margo has no RoomEnvironment; the page builds a small procedural studio `CubeFaces` (bright ceiling panels, soft walls). No HDR download. |
| `scene.background = 0xbfe3dd` | `@margoengine/environment` `EnvironmentBackground` (colour) | Same pale mint backdrop. |
| `Stats` | `@margoengine/stats` | FPS panel, top-left. |

## The scene (authored in Blender 5.3 through the Blender MCP)

One original diorama on a raised slab with rounded corners, roughly 1:1 footprint with the reference, viewed
as a corner lot.

- **Buildings:** three or four narrow 2–4 storey shop houses of different widths and roof styles (tiled gable,
  flat roof with water tank, stepped parapet). Awnings, a balcony with laundry pole, AC units, drain pipes,
  window frames, a fire escape.
- **Hero prop:** an original rooftop mascot sign — a round, friendly **tanuki holding a lantern**, outlined
  sign board style. Its paw/lantern swings in the clip. No panda, no maneki-neko.
- **Signs:** vertical banners, a projecting blade sign, a lit shop sign and noren curtains, using simple
  shapes and abstract glyph-like marks rather than real or copied text. Emissive where lit.
- **Street:** one utility pole with transformer, sagging power lines (curves converted to thin meshes) running
  off the slab, a vending machine, red post box, potted plants and a small tree, railings, bench, bicycle,
  crates.
- **Tram:** a two-tone vintage tram on a short curved track along the front edge of the slab.
- **Materials:** flat stylized PBR colours (base colour, roughness, metallic, emissive) — no texture atlases in
  the first version. Palette: warm timber, cream plaster, teal and brick accents, red signal accents.
- **Budget:** ≤150k triangles, GLB ≤5 MB after Draco.

### Animation (one looping clip, ~12 s)

- Tram travels along the curved track and returns (node translation + rotation).
- Tanuki sign's lantern arm swings.
- AC fans and a rooftop spinner rotate.
- Banners sway slightly.

All motion is object-level keyframes (no armatures), which `@margoengine/animation` plays as node TRS tracks.

### Export

glTF Binary from Blender: apply modifiers, +Y up, Draco mesh compression, animation included, single clip
named `Diorama`. Output `examples/assets/tokyo-diorama.glb` plus `examples/assets/tokyo-diorama-CREDITS.md`
stating it is original work for Margo Engine (MIT-compatible), inspired in genre by Littlest Tokyo. The `.blend`
source is saved alongside under `examples/assets/source/` for later edits.

## The page

`examples/tokyo-diorama.html` + `examples/tokyo-diorama.ts`, styled with the existing `extension-demo.css`
like `robot-expressive.html`.

- Preload the GLB; status line while loading; accessible error alert on failure.
- Camera framed like the reference (three-quarter view from slightly above), fit to model bounds.
- Controls panel: pause/play, playback speed, auto-rotate toggle, reset view.
- `prefers-reduced-motion`: auto-rotate off and clip paused by default.
- Page exit disposes animation, model, environment, stats and controls.
- Credits line: "Original diorama for Margo Engine. Presentation inspired by the three.js keyframes example
  (Littlest Tokyo by Glen Fox, CC-BY)."

## Testing

- One browser check (same harness as the existing example checks): page loads without console errors, the
  model loads, and the tram node's world position differs between two sampled times.
- Manual check on desktop and an emulated phone viewport.

## Out of scope

Walkable scene, interaction with props, texture atlases, bloom/SSAO (the reference does not use them),
a full showcase app with quality tiers (can follow later as its own task).
