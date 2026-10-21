# Reading the three.js parity counts

Date: 2026-10-21. The table in [threejs-parity.md](threejs-parity.md) was recounted after the visual-parity pass:
**160 features, 138 COVERED, 16 PARTIAL, 6 MISSING** (it was 117 / 29 / 14 that morning). The pass closed 21 rows in
optional packages; core + stage stayed at 21,343 bytes gzip, 3,657 bytes below the 25,000-byte ceiling. The rows and the
[to-do tables](threejs-parity.md#what-is-missing-or-partial-and-what-to-do) are the source; this page only explains how
to read them.

COVERED can still name a limit. PARTIAL means one common three.js use is absent. MISSING means no package `src/`
implements that feature. Public copy should keep calling Margo an alternative path; the matrix is not a claim that
Margo replaces three.js.

## WebGL2 draws core meshes only

That is a closed decision for v1.0: HANDOFF records WebGL beyond core as gap 8, closed as won't-do on 2026-10-14.
`@margoengine/webgl` implements one `Renderer` that draws core meshes (constant colours, one directional light, no
textures or effects); an app opts in with `Engine.create(canvas, {backend: 'auto', fallback: webglRenderer})`. A full
WebGL2 path at zero core bytes is planned for the next version in
[webgl2-compat-roadmap.md](webgl2-compat-roadmap.md).

## The 6 MISSING rows

| Row | How to treat it |
| --- | --- |
| StereoCamera, AnaglyphEffect, ParallaxBarrierEffect | Use `@margoengine/xr` for stereo. Anaglyph is not planned. |
| Long-tail model loaders (LDraw, VRML, 3DS, LWO, AMF, MD2, PDB, GCode, BVH motion capture, 3DM, KMZ, TDS) | Add one when a project brings that file. |
| DRACOExporter, EXRExporter, KTX2Exporter | glTF export is `@margoengine/exporters`; these three are not planned. |
| ArcballControls | Orbit, map, trackball, fly, first-person and pointer-lock exist; add it in `@margoengine/controls` when needed. |
| BatchedMesh | Distinct geometries stay separate draws; machinery `PartPacks` and geometry `mergeGeometries` bake static meshes. |
| XRControllerModelFactory, XRHandModelFactory | Poses and 25 hand joints exist; models come after a headset test. |

## The 16 PARTIAL rows

Limits of core's single-scene design, planned next in [multi-view-roadmap.md](multi-view-roadmap.md): Scene object and
multiple scenes (one engine per canvas; `SceneSwitch` swaps mesh sets), Multiple viewports / scissor (core draws only),
ArrayCamera (stereo inside XR only).

Closed or v1 limits: WebGL2 fallback (above).

Narrower APIs that already have a Margo path: Node materials (typed WGSL nodes, not a statement language), MRT (low-level
only), Clipping planes (stencil caps on core meshes only), DepthTexture (borrowed from an effect), glTF extensions
(`KHR_animation_pointer` beyond base-colour UV tracks), ColladaLoader (no skins, morphs or animations), other texture
loaders (TGA, DDS, KTX v1, TIFF), LoadingManager (no shared manager), USDZExporter (no textures), KeyframeTrack (no
arbitrary-property tracks), WebXR VR and AR (untested on a headset, no hit testing).
