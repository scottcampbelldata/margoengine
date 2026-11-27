# Reading the three.js parity counts

Date: 2026-11-24. The table in [threejs-parity.md](threejs-parity.md) was rewritten by feature group on 2026-10-31 and
recounted on 2026-11-26: **195 features, 189 COVERED, 3 PARTIAL, 0 MISSING**, plus 3 NOT PLANNED by decision. The earlier table
counted 161 rows (153 / 4 / 4); its coarse rows hid gaps that now have rows of their own. The rows and the
[to-do table](threejs-parity.md#what-is-missing-or-partial-and-what-to-do) are the source; this page only explains how
to read them.

COVERED can still name a limit. PARTIAL means one common three.js use is absent. MISSING means no package `src/`
implements that feature yet. NOT PLANNED means out of scope by decision, with the reason on the row. Public copy should keep calling Margo an alternative path; the matrix is not a claim that
Margo replaces three.js.

## WebGL2 runs on a compatibility layer

`@margoengine/webgl2-compat` (milestones M0 to M8 of [webgl2-compat-roadmap.md](webgl2-compat-roadmap.md)) puts a WebGPU-shaped
device on WebGL2 and translates every WGSL shader to GLSL ES 3.00, so core and the optional packages run unchanged at
zero core bytes. The row stays PARTIAL because real phones, Safari's remaining browser-matrix rows, a headset and the
integrated-GPU frame budget are not measured (Firefox 157 and an AMD integrated GPU are, with 0 bugs, 2026-11-27). Its
accepted limits: the layer's base is 70,274 B gzip (limit
73,000 B, an accepted difference) with lazy compute and read-back chunks of 30,819 B, the voxel path tracer compiles slowly on ANGLE Direct3D, XR needs its `/xr` entry and has not run on a headset, and CPU-tier compute kernels run on a slower interpreter without `unsafe-eval`. Every site demo (27) and Khronos gallery model (32) loads it without WebGPU: 20 demos and all 32 models draw the same pixels as native, 7 demos run with one accepted difference. It is the site's fallback. The small
`@margoengine/webgl2-compat/preview` preview (core meshes only) stays for v1.0; the React Canvas's `loadFallback` loads it and `fallbackContent` replaces the plain message. The layer is installed with `install()` before `Engine.create`.

## No MISSING rows

The ten MISSING rows of 2026-11-07 (rendering in a worker, rendering into cube mips, array layers and 3D slices,
compute writing textures, object-space normal maps, your own mip levels, KTX2 arrays and cubes, shadows from alpha
cut-outs, environment blending and ground projection, screen-space subsurface blur, soft particles) are built, each in
its owning package with tests named on its row. Four NOT PLANNED rows were built as well and are COVERED now: GLSL into
node code (`@margoengine/shader/glsl`), stereo, anaglyph and parallax-barrier output (`@margoengine/cameras/stereo`),
the long-tail model loaders, and VDB, Lottie and MaterialX (`@margoengine/loaders`). XR controller and hand models are
COVERED by `@margoengine/xr/models`.

## The PARTIAL rows

WebGL2 fallback: see above.

On 2026-11-26 cloth simulation became COVERED with `drawSoftBody` (`@margoengine/gltf/soft-mesh`) and particle fluids with `DfsphSolver` (`@margoengine/physics/dfsph`); the two soft-body defects they named are fixed. Three rows stay PARTIAL.

Four rows became PARTIAL on 2026-11-24, when their code was found: cloth simulation, particle fluids and soft bodies,
the triangle-mesh path tracer and real-time caustics; real-time caustics became COVERED on 2026-11-25 with
`SurfaceCaustics` of `@margoengine/post/caustics`. Each row names what exists and what is missing; the wider list is in
[rival-parity-gaps.md](rival-parity-gaps.md).

Narrower APIs that already have a Margo path: WebXR VR (untested on a headset) and WebXR AR (hit testing, anchors, planes, depth and light estimation, untested on a device).
