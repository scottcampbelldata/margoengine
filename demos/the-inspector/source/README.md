# The Inspector

The Aperture Bench is an original tabletop optical comparator. Its teal housing, copper rings, coated lens, graticule and graduated mount are procedural Margo meshes. The geometry represents an instrument for inspection.

## Visit the bench

- Select **Slide lens out** to move the Lens cartridge 303 mm along the rail. The moving part is selected in the scene tree and the edit is recorded in the same history as property edits. Use **Seat lens** or **Undo** to return it.
- Open the scene tree, select a part, and edit its position, rotation, scale, name, or visibility. Select the Lens bezel child and clear **Visible** to examine the glass and carrier separately. **Undo** restores the bezel.
- Toggle **Wireframe** or **Normals** to read the meshes. Use either overlay or both.
- Select **Capture frame**, choose a pass, and open its recorded commands. Repeat with Wireframe enabled to compare the captured graph and draw counts.
- The Stats panel reads the rendering engine's rolling samples. Chrome with native WebGPU and the optional timestamp-query feature shows GPU pass times. WebGL2 compatibility reports CPU pass timing and the same captured graph and commands.

Desktop and phone use the same meshes, materials, shadows, diagnostic overlays, and scene tree. The narrow screen stacks the scene tree and performance panel below the bench.

## Implementation and provenance

`@margoengine/inspector` supplies the live panel, hit selection, edit history and geometry overlays. Its `/frame` entry records the engine's current frame graph and command calls. Built-in statistics come from `@margoengine/stats`. The scene uses Margo core and shadows with native WebGPU first, then the public Margo WebGL2 compatibility layer. The exhibit uses [public Margo Engine main at the gallery pin](https://github.com/scottcampbelldata/margoengine/tree/0efd9cff8230507a32deb49907ecd499d46925f5).

- Science Museum Group. *Optical bench with adjustable holders*. Collection record, accessed 2026-11-27. [Instrument reference](https://collection.sciencemuseumgroup.org.uk/objects/co433946/optical-bench-with-adjustable-holders)
- Science Museum Group. *Biunial lantern slide projector with lenses and attachments*. Collection record, accessed 2026-11-27. [Optical housing reference](https://collection.sciencemuseumgroup.org.uk/objects/co8404868/biunial-lantern-slide-projector-with-lenses-and-attachements)
- W3C GPU for the Web Working Group. *WebGPU*. Editor's Draft, accessed 2026-11-27. [Timestamp query and queue completion reference](https://gpuweb.github.io/gpuweb/)

All geometry and materials were authored for this exhibit. No museum photographs or meshes are distributed.

## Verification

A fresh signed-out Chromium context served the local production-style bundle with the gallery startup preloads. Phone emulation used a 390 × 844 CSS viewport, 2× device pixels, 4× CPU slowdown and a 150 ms / 1.6 Mb/s connection. The timing runs from navigation through trusted **Slide lens out** input and completion of its GPU submission.

| Profile | First rendered input | Frame capture timing |
| --- | ---: | --- |
| Desktop WebGPU | 0.481 s | GPU and CPU |
| Desktop forced WebGL2 | 0.593 s | CPU |
| Phone WebGPU | 1.309 s | GPU and CPU |
| Phone automatic WebGL2 | 2.410 s | CPU |
| Phone forced WebGL2 | 2.390 s | CPU |

Across all five profiles, the browser verified the physical transform, property edits, visibility, undo and redo, both overlays, live Stats, and frame capture drill-down. Captured draws increased from 27 to 54 with Wireframe enabled. Rendered canvas checks measured distinct seated, extended, hidden-bezel, wire and normal views. Native and compatibility renders at the same screen size differed by at most 0.0002 RGB levels on the 0–255 scale across the tested scene and overlays. These are local browser measurements.

Ignored local QA is under `qa-output/the-inspector/`. See `final.log`, `summary.json`, `pixel-check.txt` and `inspection-comparison.png`. From the gallery root, with the pinned checkout in `MARGO_ENGINE_CHECKOUT`, run the following.

```powershell
$env:INSPECTOR_PRELOAD='1'
node "$env:MARGO_ENGINE_CHECKOUT/scripts/run-with-timeout.mjs" --max=3 -- node qa-output/the-inspector/check.mjs desktop mobile mobile-auto mobile-compat desktop-compat
py qa-output/the-inspector/frames.py
```
