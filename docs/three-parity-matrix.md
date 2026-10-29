# Reading the three.js parity counts

Date: 2026-10-24. The table in [threejs-parity.md](threejs-parity.md) was recounted after the parity-closing work:
**161 features, 153 COVERED, 4 PARTIAL, 4 MISSING** (142 / 13 / 6 before the parity-closing work, 138 / 16 / 6 after
the visual-parity pass, 117 / 29 / 14 before it). The parity-closing work (2026-10-24) closed eleven rows (BatchedMesh, ArcballControls, MRT, clipping planes, DepthTexture, glTF extensions with `KHR_animation_pointer`, Collada, texture loaders, LoadingManager, USDZExporter, KeyframeTrack) and added hit testing to WebXR AR, which stays partial; multi-view closed three rows (scenes, viewports, ArrayCamera) and the EXR writer split EXRExporter out as covered; core + stage measured 22,253
bytes gzip with it (22,781 after the 2026-10-26 core fixes, 21,910 after the 2026-10-27 stage feature entries, 21,974 after the 2026-10-27 frame-loop fix (bug 19), 22,116 after the 2026-10-29 multi-view clear fix (bug 61), 2,884 bytes below the 25,000-byte ceiling; the parity work adds none). The rows and the
[to-do tables](threejs-parity.md#what-is-missing-or-partial-and-what-to-do) are the source; this page only explains how
to read them.

COVERED can still name a limit. PARTIAL means one common three.js use is absent. MISSING means no package `src/`
implements that feature. Public copy should keep calling Margo an alternative path; the matrix is not a claim that
Margo replaces three.js.

## WebGL2 draws core meshes only

That is a closed decision for v1.0: WebGL beyond core was closed as won't-do on 2026-10-14.
`@margoengine/webgl` implements one `Renderer` that draws core meshes (constant colours, one directional light, no
textures or effects); an app opts in with `Engine.create(canvas, {backend: 'auto', fallback: webglRenderer})`. A full
WebGL2 path: `@margoengine/webgl` is the basic preview; `loadFallback` and `fallbackContent` are the supported way to degrade today; a fuller WebGL2 compatibility package is in development as an optional download that WebGPU users never load ([webgl2-compat-roadmap.md](webgl2-compat-roadmap.md)).

## The 4 MISSING rows

| Row | How to treat it |
| --- | --- |
| StereoCamera, AnaglyphEffect, ParallaxBarrierEffect | Use `@margoengine/xr` for stereo. Anaglyph is not planned. |
| Long-tail model loaders (LDraw, VRML, 3DS, LWO, AMF, MD2, PDB, GCode, BVH motion capture, 3DM, KMZ, TDS) | Add one when a project brings that file. |
| DRACOExporter, KTX2Exporter | glTF export is `@margoengine/exporters`; these two are not planned (EXR is written by `@margoengine/environment/exr-write`). |
| XRControllerModelFactory, XRHandModelFactory | Poses and 25 hand joints exist; models come after a headset test. |

## The 4 PARTIAL rows

Closed or v1 limits: WebGL2 fallback (above).

Narrower APIs that already have a Margo path: Node materials (typed WGSL nodes, not a statement language), WebXR VR
(untested on a headset) and WebXR AR (hit testing and anchors, untested on a device; no plane detection, depth sensing
or light estimation).