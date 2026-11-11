# NVIDIA: a blended draw that covers a pixel more than once is not repeatable under 4x MSAA (draft)

Goes to: NVIDIA (driver), copied to Dawn and ANGLE for awareness. Not filed.

## Environment
Windows 11 Pro 10.0.26300, NVIDIA RTX A6000 (Ampere), Chromium 157 with WebGPU (Dawn, D3D12) and WebGL2 (ANGLE,
D3D11). Control GPUs: AMD Radeon iGPU (RDNA 2) on the same PC and browser, and Apple M6 (Metal) in Chromium 156 on macOS 27.2.

## Steps
Open `scripts/reference-rendering/fold-blend-repeat.html` (raw WebGPU and raw WebGL2, no engine, nothing loaded) and call
`await repeatFold({api: 'webgpu', frames: 24})`, then the same with `api: 'webgl2'`. From a Margo checkout:
`node scripts/gpu-lock.mjs run --owner=<you> -- node scripts/reference-rendering/fold-blend-repeat.mjs`.

Each frame clears a 512 x 512 4x multisampled rgba8unorm target, draws one 128 x 128 height-field grid (32,768
triangles, cull mode none) seen from a low camera so its slopes cover many pixels two or three times in that one draw,
resolves and reads back. Three cases, each 24 frames with identical commands and inputs:
- folded: alpha 0.85, blend src-alpha / one-minus-src-alpha, depth test on, depth write off;
- opaque: the same grid at alpha 1, blending off, depth write on;
- flat: the same blend on the grid flattened to z = 0 (each pixel covered once).

## Expected
Every frame equals the first frame byte for byte: the same commands on the same inputs (OpenGL ES 3.0 Appendix A
repeatability; WebGPU gives no weaker promise for one queue).

## Actual (24 frames, 23 compared with the first)
| GPU, API | folded | opaque | flat |
|---|---|---|---|
| RTX A6000, WebGPU (D3D12) | 23 of 23 differ, up to 62 bytes, by 1 | 0 | 0 |
| RTX A6000, WebGL2 (ANGLE D3D11) | 23 of 23 differ, up to 86 bytes, by 1 | 0 | 0 |
| AMD Radeon RDNA 2, WebGPU (D3D12) | 0 | 0 | 0 |
| AMD Radeon RDNA 2, WebGL2 (ANGLE D3D11) | 0 | 0 | 0 |
| Apple M6, WebGPU (Metal), 64 frames | 0 | 0 | 0 |
| Apple M6, WebGL2 (ANGLE Metal), 64 frames | 0 | 0 | 0 |

Only the NVIDIA board flips, on both of its APIs, and only where one blended draw covers a sample more than once.
Margo's earlier probes (docs/known-bugs.md, KB5700f) also found that a commutative max blend flips the same way and a
blend that adds nothing does not, so the blend order is not the cause: the colour or coverage of the overlapping
fragments changes between frames. A hypothesis, not checked: hardware that merges or reorders fragments of one draw
within a quad or tile (see K. Fatahalian et al., "Reducing Shading on GPUs using Quad-Fragment Merging", ACM TOG 29(4),
2010) would make the shaded or blended value depend on scheduling.

## Related
KB-GEO1 (docs/known-bugs.md, "sciviz geo-lod frames not bit-stable on native WebGPU"): the same board flipped a
single-coverage blended draw in another scene, on D3D12 only. Both need a blend that reads the destination; unblended
draws repeat exactly. The Margo-side regression that pins the stable cases is
`packages/sciviz/tests/surface-repeat-browser.mjs`.
