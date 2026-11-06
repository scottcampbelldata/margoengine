# Reading the three.js parity counts

Date: 2026-10-31. The table in [threejs-parity.md](threejs-parity.md) was rewritten by feature group:
**191 features, 158 COVERED, 5 PARTIAL, 16 MISSING**, plus 12 NOT PLANNED by decision. The earlier table
counted 161 rows (153 / 4 / 4); its coarse rows hid gaps that now have rows of their own. The rows and the
[to-do table](threejs-parity.md#what-is-missing-or-partial-and-what-to-do) are the source; this page only explains how
to read them.

COVERED can still name a limit. PARTIAL means one common three.js use is absent. MISSING means no package `src/`
implements that feature yet. NOT PLANNED means out of scope by decision, with the reason on the row. Public copy should keep calling Margo an alternative path; the matrix is not a claim that
Margo replaces three.js.

## WebGL2 runs on a compatibility layer

`@margoengine/webgl2-compat` (milestones M0 to M8 of [webgl2-compat-roadmap.md](webgl2-compat-roadmap.md)) puts a WebGPU-shaped
device on WebGL2 and translates every WGSL shader to GLSL ES 3.00, so core and the optional packages run unchanged at
zero core bytes. The row stays PARTIAL: the layer's base is 72,354 B gzip (limit
73,000 B, an accepted difference) with a lazy compute runtime of 28,002 B, the voxel path tracer refuses it, XR needs its `/xr` entry and has not run on a headset, and CPU-tier compute kernels run on a slower interpreter without `unsafe-eval`. Every site demo (27) and Khronos gallery model (32) loads it without WebGPU: 20 demos and all 32 models draw the same pixels as native, 7 demos run with one accepted difference. It is the site's fallback. The small
`@margoengine/webgl` preview (core meshes only) stays for v1.0; the React Canvas's `loadFallback` loads it and `fallbackContent` replaces the plain message. The layer is installed with `install()` before `Engine.create`.

## The 4 MISSING rows

| Row | How to treat it |
| --- | --- |
| StereoCamera, AnaglyphEffect, ParallaxBarrierEffect | Use `@margoengine/xr` for stereo. Anaglyph is not planned. |
| Long-tail model loaders (LDraw, VRML, 3DS, LWO, AMF, MD2, PDB, GCode, BVH motion capture, 3DM, KMZ, TDS) | Add one when a project brings that file. |
| DRACOExporter, KTX2Exporter | glTF export is `@margoengine/exporters`; these two are not planned (EXR is written by `@margoengine/environment/exr-write`). |
| XRControllerModelFactory, XRHandModelFactory | Poses and 25 hand joints exist; models come after a headset test. |

## The 5 PARTIAL rows

WebGL2 fallback: see above.

Narrower APIs that already have a Margo path: meshlets (`MeshletMesh`: one mesh, one matrix, no instancing), Node materials (typed WGSL nodes, not a statement language), WebXR VR
(untested on a headset) and WebXR AR (hit testing and anchors, untested on a device; no plane detection, depth sensing
or light estimation).