# Proof audit

Scott's order of 2026-11-06: passing checks is not the same as working. All 76 USDZ files passed `usdchecker`, and the first iPhone run failed in seconds: Fox stood 79 m tall. This page goes through [claims.md](claims.md) and [limits.md](../limits.md) and lists each claim whose proof is only a validator, our own reader, a stand-in or a built file, what that proof cannot see, and what would really prove it.

Audited at `72ecd93f1`, and rerun at `c9b0a86ba` on 2026-11-10 for the 369 rows added since (the section "Rows added since the first audit"). Rerun it once more after the feature batches end.

## Counts

| Where | Audited | Proved only by a tool or stand-in | Partly | Note |
| --- | --- | --- | --- | --- |
| LIM rows in claims.md | 285 | 26 of 285 | 38 of 285 | 287 rows, 2 retired or relocated. |
| Headline numbers | 4 | 0 of 4 | 0 of 4 | They are facts about the built files and the source, so the built file is the right proof. |
| Whitepaper figures | 19 | 1 of 19 | 0 of 19 | The parity figure is our own reading of a table we wrote. Three voxel figures already read UNPROVEN and are not counted again. |
| Capabilities | 14 | 2 of 14 | 1 of 14 | Each points at LIM rows below. Input and controls ran on synthetic events, release readiness on a stand-in registry, and the WebGL2 row has stand-in XR. |
| "Not yet backed" list | 9 | 9 of 9 | 0 of 9 | The list says so itself. |
| limits.md table rows | 314 | 59 of 314 touch a claim below | | Most rows state an enforced limit or a method, which the source proves. |

Classes: **Validator**, a checker or outside file tool passed it and no program a person uses opened it. **Own reader**, only Margo's code or the test's reader read it back. **Stand-in**, simulated input, a fake device, a fake session or test data in place of the real thing. **Built file**, the test wrote the bytes it then read.

By class, whole claims: 0 validator, 1 own reader, 1 built file, 24 stand-in.

What is not counted: a claim about maths, an API or a limit, proved by running the real code, needs no device or outside program. A claim proved on a real GPU in a real browser counts as real, on that one GPU. Rows that say "RTX A6000 only" are real proof on one machine: that is a limit of breadth, and [limits.md](../limits.md) states it.

## Proved only by a tool or stand-in

| Claim | Proof today | Class | What that proof cannot detect | What would really prove it | Real test so far |
| --- | --- | --- | --- | --- | --- |
| LIM-205: MaterialX and Lottie output | Our parser, our graph, a canvas that uploads. The row says no reference was compared. | Own reader | Whether a material or an animation looks like it does in the tool that made it. | MaterialX reference renders, and frames from a Lottie player, compared by picture. | Lottie run: eight real exports against lottie-web 5.12.2, within 1 of 255 levels on a 16 by 16 grid. MaterialX renders not run; defaults pinned to the published nodedefs. |
| LIM-202: parseVDB | Files the test writes byte by byte. | Built file | Anything OpenVDB does that the test's author did not know. It has never read a file OpenVDB wrote. | A real .vdb from OpenVDB or Blender, with the values compared. | Not run. |
| LIM-032: Moving 14,500 meshes in 4 ms | Stand-in GPU device in Node. | Stand-in | The cost of real submission. The figure is CPU work on a fake device. | The same scene on a real page and GPU, frame time read from the engine. | Not run. |
| LIM-038: Mesh optimisation | A simulated 16-vertex cache and a software depth buffer. | Stand-in | Whether a real GPU gets faster: its cache is not this cache. | GPU frame time before and after on real meshes, on the quiet run. | Not run. |
| LIM-077: Even 60 FPS "on every display from 60 to 240 Hz" | Fake clock and fake GPU in a unit test. | Stand-in | Real displays and real browser frame timing. | A 60, 100, 120 and 240 Hz panel, with `requestAnimationFrame` times logged. | Not run. |
| LIM-109: WebGPU compatibility level | Forced device on an RTX A6000. | Stand-in | Real OpenGL ES or Direct3D 11 limits and bugs. | A device that only offers compatibility mode, such as an older Android phone. | Not run. |
| LIM-112, LIM-114, LIM-115, LIM-116, LIM-117, LIM-119: Controls: roll, third person, drag, orbit limits, many objects, platforms | Fake element and synthetic events in Node, on real core objects. Status corrected to PROVEN (STAND-IN). | Stand-in | Whether a real mouse, wheel or touch in a real page gives those events, and whether it feels right. | Real browser input on a real page, then a person trying each. | Not run. |
| LIM-120: Stage XR button | Simulated session. | Stand-in | Any real headset behaviour. | A headset browser with WebXR and WebGPU. | Not run. |
| LIM-127, LIM-132, LIM-148: Interactions, local players, input replay | Dispatched events on a fake clock. Status corrected to PROVEN (STAND-IN). | Stand-in | Real gamepads, key repeat and browser focus. An unplugged real pad has never been tried. | Two real gamepads and a keyboard in a real page. | Not run. |
| LIM-129: Stage physics | Real Rapier on a stand-in renderer in Node. | Stand-in | Whether what falls is what is drawn. | The same crate on a real page and GPU, the pixels following the body. | Not run. |
| LIM-134: Gyro aiming | Synthetic sensor events. | Stand-in | Real sensor signs, axes and rates. They come from the spec, not a phone. | A phone, with the page turned through each axis. | Not run. |
| LIM-137: First npm install | Stand-in registry. Status corrected to PROVEN (STAND-IN). | Stand-in | The real registry: names, scope, provenance. Nothing is published yet. | The first real publish, then an install in an empty folder. | Not run. |
| LIM-149: Pen input | Synthetic pointer events. | Stand-in | What a real pen sends: pressure curves, tilt ranges, coalesced rates. | A real pen on a tablet or an iPad. | Not run. |
| LIM-151: XR on the WebGL2 layer | Stand-ins for the browser's XR objects. | Stand-in | A real `XRWebGLLayer` and its framebuffer. | A headset browser with WebXR on WebGL2. | Not run. |
| LIM-211: Warping | A stand-in walk made for the test. | Stand-in | A real walk clip, whose feet do not plant as cleanly. | A real walk clip and a person looking at the feet. | Run on CMU walks of two people, contacts found from the data (`tests/modern-animator-real-mocap.test.js`). No person has looked at the feet. |
| LIM-216, LIM-221, LIM-224: Object-space normal maps, layered materials, your own mip levels | Real GPU, stand-in maps and small data textures. The rows say so, and the status now does. | Stand-in | A real baked map or authored layer set, with its noise, colour space and tiling. | A map baked by Blender or Substance, an authored terrain set, a real mip chain. | Not run. |
| LIM-259: Bump maps in glTF | A hand-written third-party file and a stand-in quad. | Stand-in | What an art tool would write. The extension is a draft. | A file from an art tool, once one exists. | Not run. |

## Partly proved by a tool or stand-in

Part of each claim stands on the real thing. The table names the part that does not.

| Claim | Proof today | Class | What that proof cannot detect | What would really prove it | Real test so far |
| --- | --- | --- | --- | --- | --- |
| LIM-014: Specular shift at distance | CPU emulation of the eye error. `FloatingOrigin` size is real. | Stand-in | A real GPU's float rounding. | Read the shift from a GPU render at 100 km. | Not run. |
| LIM-113, LIM-118: Gizmo and arcball input | Drawing runs on a real GPU, input is synthetic. | Stand-in | Real pointer behaviour. | As the controls row above. | Not run. |
| LIM-176: Heat detection | The battery API is real. Heat is on modelled frames. | Stand-in | A machine really throttling. | A laptop or phone run hot, with the pace logged. | Not run. |
| LIM-193: parse3DM | Unit test on a stand-in runtime. Real rhino3dm reads three files, opt in. | Stand-in | That run is by hand, not in `npm test`. | Already real by hand. Keep the opt-in run recorded. | Not run. |
| LIM-195: LWO bones | A built file. Everything else in the row is on real files. | Built file | How LightWave really writes bones. | A rigged LWO with a clear licence. | Not run. |
| LIM-197: LAZ compressors 0 and 1, chunk size 0 | The test's own encoder. Other formats equal LASzip and lazrs on real files. | Built file | Real files of those kinds. | Files from LASzip with those settings. | Not run. |
| LIM-208: 111 public files open | Real files, read by us, compared with counts from small readers in the same test, and "no blank picture". | Own reader | A model on its side, inside out or the wrong size has the right counts and is not blank. This is the 79 m fox again. | The same files through Blender's importers, bounds compared. | Blender 5.3 importers on the 8 of 108 it has an importer for: bounds equal to five figures, triangles equal on 7, and on Spider_ascii.stl Blender merges 56 of 1,368. The other 100 have no importer on these machines. |
| LIM-212, LIM-217: Full-body IK and mirroring tolerances | Tight numbers on a stand-in biped. Looser ones on real files. | Stand-in | How it looks on a real character. | A person watching a real character. | Not run. |
| LIM-213: Motion matching | Stand-in clips, plus Fox clips with hand-labelled speeds. | Stand-in | A motion capture set: scale, noise, foot contact. | A free motion capture set. | Run on eight CMU takes (`tests/modern-animator-real-mocap.test.js`). |
| LIM-226: VRM write side | Only Margo read a written file back. Reading real avatars is real. | Own reader | Whether another VRM tool accepts it. | Open a written file in a VRM viewer or a Blender add-on. | Not run. |
| LIM-228, LIM-230, LIM-239: Prefilter, lobes under clustered lights, eye refraction | Real GPU with a stand-in cube, quad or sphere. | Stand-in | A real sky or eye compared with another renderer. | Compare with a path traced picture of a real scene. | Not run. |
| LIM-232: Corrective shapes | Real rig and clip, a morph target added for the test. | Stand-in | An authored corrective. | A real file with correctives. | Not run. |
| LIM-237: Face tracking | Test-written frames and stand-in targets. | Stand-in | A live tracker's noise and rate. | A phone tracker or MediaPipe on a camera, with a person watching. | Not run. |
| LIM-244: Getting up | Real rig and Rapier, stand-in clips (Death played backward). Status corrected to PROVEN (STAND-IN). | Stand-in | A real get-up clip, and how it looks. | A real get-up clip and a person watching. | Not run. |
| LIM-256, LIM-264, LIM-266: Splats with meshes, volume scatter, image and type B lights | Real files for part, stand-in quads and cubes for the rest. | Stand-in | Any reference picture. Three of the extensions are drafts. | A path traced or vendor reference, where one exists. | Not run. |
| LIM-265: USDZ animation | Mac tools for 76 clips. 8 of 76 on one iPhone, with RiggedFigure open. | Stand-in | The other 68 on a device, and any other phone. | AR Quick Look on the rest, and the RiggedFigure run in known-bugs. | Mac tools for 76 clips. Quick Look thumbnails on the Mac, 6 of 6 right way up, right colours and textures: Fox, Robot, RiggedFigure, MorphStressTest, CommercialRefrigerator, InterpolationTest. |
| LIM-243: Draco export of 24 real GLBs | Khronos validator, Google's decoder, `gltf-transform` reads two. | Validator | What the file looks like in an app: pictures were not compared. | Pictures of source and file from one camera in Blender. | Blender 5.3: 10 of 10 equal meshes, triangles, materials, images, bones, clips, bounds within 2.98e-5 of size. Godot 4.7.2 refuses: no Draco support. |
| LIM-258: Meshopt export of 25 real GLBs | meshoptimizer decode, validator after decoding, `gltfpack`, `gltf-transform`, our own loader. | Validator | What the file looks like in an app: pictures were not compared. | Pictures of source and file from one camera in Blender. | Blender 5.3: 10 of 10 equal, bounds within 7.43e-6 of size. Godot 4.7.2 refuses: no meshopt support. |
| LIM-262: GLB optimize of 25 real GLBs, and levels | Validator, `gltfpack`, `gltf-transform`, vertex checks in our test. | Validator | No reader has shown `MSFT_lod` levels switching. Pictures were not compared. | A viewer that switches levels. | Blender 5.3: 10 of 10 equal, bounds gap 0. Godot 4.7.2: same indices, Robot 9,702 of 9,711 (3 triangles of no area dropped, as claimed). |
| LIM-250: KTX2 export of 211 images from 21 GLBs | `ktx validate`, Binomial's transcoder, `gltf-transform` reads two. | Validator | Whether the textures show in the right colour space and the right way up: no picture was compared. | A picture of the textured file in Godot against the source. | Godot 4.7.2: 9 of 10 textured with the source's indices; flight-helmet fails on `KHR_mesh_quantization`, its source too. Blender 5.3: geometry, 0 images (no `KHR_texture_basisu`). |
| LIM-278: XMP licence order | Seven published files for the rest. The `cc:license` and `xmpRights` order is on stand-in packets: no file found uses them. | Stand-in | How a real writer fills those two fields. | A published file that uses them. | Not run. |
| LIM-279: FBX texture to UV set link | A real Blender file for the layers. The link is on a hand-written file, as Blender writes no `UVSet`. | Stand-in | What Maya or 3ds Max writes for that link. | A Maya or 3ds Max file with a texture on a second UV set. | Not run. |
| LIM-280: FBX override at a partial weight, TCB tangents | Real Maya files for the rest. These two are on hand-written data from the public definition. | Stand-in | Whether a real writer means what the definition says. | A file with them, from Maya or MotionBuilder. | Not run. |
| LIM-281: FBX type 0 under a sheared parent | A real Maya rig for the rest. This case is a hand-worked result. | Stand-in | What the FBX SDK really gives. | A real file with it, or the SDK's output. | Not run. |
| LIM-282: Automatic rig | Real meshes, joints measured against authored skeletons. No rigged mesh was drawn on a GPU or opened in another tool. | Own reader | Whether the rig deforms well: a joint in the right place can still bend badly. | Export a rigged mesh, pose it in Blender, and look. | Not run. |
| LIM-283, LIM-286, LIM-289, LIM-290: Exact and moment transparency, blending in OIT, depth of glass | Real GPU against blending worked out by hand. Generated planes stand in for real glass. | Stand-in | A real model with deep overlapping glass. | A real transparent model drawn against a path traced picture. | Not run. |
| LIM-291: Render to video | Real GPU and the own encoders of the browser and decoders, on one machine. The scene and tone are generated. | Stand-in | Whether a player outside the browser opens the file. | Open a rendered file in VLC or QuickTime. | AVFoundation, under QuickTime Player, opens the MP4 from Chrome and from WebKit: 60 frames at i / 30, the tone from 1.000 s by `afconvert`. Running it in WebKit found three faults, fixed in `ba89faa5a`. QuickTime Player itself and VLC not run. |
| LIM-292: Take recorder | Real `Mesh`, `Camera` and `Input` classes, with events dispatched by the test. | Stand-in | A real device and a person playing a take. | Record a take with a real gamepad or mouse. | Not run. |
| LIM-253: USDZ of 25 static GLBs | `usdchecker --arkit`, `usdcat --flatten` with our bounds maths, SceneKit on one file. | Validator | What a person sees on a phone, at what size, and how it behaves in AR. A valid file is not a usable one: LIM-265 passed everything on a Mac and failed on the first iPhone. | AR Quick Look on an iPhone, for a sample. | Blender 5.3 USD importer: 27 of 27 equal in meshes, triangles and bounds within 2e-7, with three settled by plain glTF maths in the file's favour. Quick Look thumbnails on the Mac: 18 of 28 read by eye, right way up and textured; 10 not drawn, the system extension stopped answering. |

## Real, but compared with ourselves

These run on a real GPU or on real code, so they are not counted above. Their comparison is against Margo itself or a twin written alongside, so if both sides share a mistake the check passes. The answer here is a picture check, which exists for core and the visual views.

| Rows | Compared with | What it cannot detect |
| --- | --- | --- |
| LIM-133, 135, 136, 138, 139, 141, 143, 145 | Core drawing the same scene, 0 differing pixels. | Whether core's picture is right. It proves culling changed nothing, which is all it claims. |
| 62 visual views, 4 captures each | Stored pictures of our own output. | A picture wrong from the day it was stored. |
| Optimization proofs, 31 table rows | GPU call logs on a mock GPU, baseline against candidate. | Real driver behaviour. They prove the same calls went out, and the wording claims no more. Mock GPU timings are not results. |
| LIM-188, 203, 201 | CPU twins of the skinning maths. | A mistake copied into both. LIM-188 also compares with `Animation` on the real Fox. |

## Promises with no claim row

These are promises in package READMEs with no row in claims.md, so nothing above counted them.

| Promise | Where | Proof today | What would really prove it | Real test so far |
| --- | --- | --- | --- | --- |
| GLB for Godot, import bundle | exporters README | Package tests, plus a by-hand Godot import of four exports. | Godot opens the bundle in a real project. | Godot 4.7.2: exports match, clips 3, 1, 14. The README bundle's convex helper becomes `StaticBody3D` with a 4 point `ConvexPolygonShape3D`, margin 0.04. |
| Unity sampler add-on and pixel art postprocessor | exporters README | Package tests. An earlier real measure of sampling in `examples/package-benchmarks/results/pixel-art-native.json`. | Unity 6 imports the file with the script in place. | Sampling only, in the record named. The batch 121 run is blocked: the Editor needs Scott to sign in to Unity Hub, and an agent never signs in. |
| Unreal names, helper and pixel art script | exporters README | Package tests. An earlier real measure of sampling in `examples/package-benchmarks/results/pixel-art-native.json`. | Unreal 5.8 imports the file and runs the script. | Unreal 5.8 Interchange: 8 of 8 `exportModel` files equal source in static and skeletal meshes, triangles, materials, textures and sizes. Clips of 4 of 4 animated files import with the source's count and lengths: 3, 3, 1 and 14 for each of 2 skeletal sets. |
| Roblox preset | exporters README | Package tests. | Roblox Studio. It needs an account, so it goes on Scott's list. | Not run. |

## limits.md rows tied to these claims

MaterialX and Lottie (`@margoengine/loaders/materialx`, `/lottie`, 2026-11-06); OpenVDB volumes (`@margoengine/loaders/vdb`, 2026-11-06); Moving transforms per frame (CPU budget); Mesh optimisation (`@margoengine/geometry/optimize`); Light-tier frame rate; WebGPU compatibility level (`@margoengine/webgl2-compat/adapter`, 2026-11-05, packages 2026-11-06); Roll in `FlyControls` and `TrackballControls` (`enableRoll`, 2026-11-05); Third-person camera (`ThirdPersonControls` in `@margoengine/controls/third-person`, 2026-11-05); `DragControls` rotate mode, groups and children (2026-11-05); Orbit target radius and `orthoZoom` (2026-11-05); Several objects on `TransformControls` (`attachMany`, `pivot`, 2026-11-05); Moving platforms for `WalkControls` (`carry`, 2026-11-05); Stage XR button (`@margoengine/stage/xr`, 2026-11-05); Interactions (`@margoengine/input/interactions`, 2026-11-05); Local players (`@margoengine/input/players`, 2026-11-05); Input recording (`@margoengine/input/replay`, 2026-11-05); Stage physics (`@margoengine/stage/physics`, 2026-11-05); Gyro aiming (`@margoengine/input/motion`, 2026-11-05); First npm install; Pen input (`@margoengine/input/pen`, 2026-11-05); XR on the WebGL2 compatibility layer (`@margoengine/webgl2-compat/xr`, 2026-11-06); Warping (`@margoengine/animator/warping`, 2026-11-06); Object-space normal maps (`@margoengine/materials/object-normal`, 2026-11-06); Layered materials (`@margoengine/materials/layered`, 2026-11-06); Your own mip levels (`@margoengine/materials/mips`, 2026-11-06); Bump maps in glTF (`EXT_materials_bump` in `@margoengine/gltf-pro/extended`, 2026-11-06); Gizmo occlusion (`occlude` on `TransformControls`, 2026-11-05); `ArcballGizmo`, double-click focus and arcball keys (2026-11-05); Battery and heat (`@margoengine/quality/power`, 2026-11-06); Rhino 3DM (`@margoengine/loaders/3dm`, 2026-11-06); Long-tail formats (`/3ds`, `/tds`, `/lwo`, `/amf`, `/md2`, `/pdb`, `/kmz`, 2026-11-06); LAS and LAZ (`@margoengine/loaders/las`, `@margoengine/points/las`, 2026-11-06); Real files (`npm run test:real-files -w @margoengine/loaders`, 2026-11-06); Full-body IK (`@margoengine/animator/fbik`, 2026-11-06); Runtime mirroring (`@margoengine/animator/mirror`, 2026-11-06); Motion matching (`@margoengine/animator/motion-matching`, 2026-11-06); VRM avatars (`@margoengine/rigging/vrm`, 2026-11-06); Prefiltered cube maps (`@margoengine/materials/prefilter`, 2026-11-06); Physical lobes under clustered lights (`@margoengine/clustered/physical-lobes`, 2026-11-06); Hair, eye and skin shading (`@margoengine/materials/hair`, `/eye`, `/skin`, 2026-11-06); Corrective shapes (`@margoengine/rigging/correctives`, 2026-11-06); Face tracking (`@margoengine/rigging/face`, 2026-11-06); Getting up (`@margoengine/ragdoll/getup`, 2026-11-06); Gaussian splats in glTF (`@margoengine/gltf-pro/splats`, 2026-11-06); USDZ animation (`@margoengine/exporters/usdz-anim`, 2026-11-06); Draco export (`@margoengine/exporters/draco`, 2026-11-06); Meshopt export (`@margoengine/exporters/meshopt`, 2026-11-06); GLB optimize (`@margoengine/exporters/optimize`, 2026-11-06); KTX2 export (`@margoengine/exporters/ktx2`, 2026-11-06); Author, licence and copyright in glTF (`KHR_xmp_json_ld` in `@margoengine/gltf-pro/metadata`, 2026-11-06); FBX UV sets and colour layers (`layers` option, 2026-11-06); FBX animation layers and cubic curves (`@margoengine/fbx/layers`, 2026-11-06); FBX inherit types (2026-11-06); Automatic rig (`@margoengine/rigging/autorig`, 2026-11-06); Exact transparency (`@margoengine/oit/exact`, 2026-11-06); Moment transparency (`@margoengine/oit/moments`, 2026-11-06); Blending in OIT (`blending` of `@margoengine/oit`, 2026-11-06); Depth of glass (`@margoengine/oit/depth`, 2026-11-06); WebXR AR hit testing.

Rows with no LIM row of their own:

- WebXR AR hit testing: says itself it has never run on an AR headset or phone. Needs a headset.

## Rows added since the first audit (rerun of 2026-11-10)

Rerun at `c9b0a86ba` for the 369 LIM rows added after `72ecd93f1` (LIM-293 to LIM-656). Method: each row was sorted by its own words (status, evidence and note: "stand-in", "generated", "synthetic", "fake", "mock", "own reader", "round trip", "no real", "hand-written", "Margo-written"), then each group below was read by hand. A row whose status says STAND-IN counts as whole; a row with real files, a real GPU or a real browser for part and a stand-in for the rest counts as partly.

| Where | Rows | Proved only by a tool or stand-in | Partly | Note |
| --- | --- | --- | --- | --- |
| LIM rows added since `72ecd93f1` | 369 | 109 of 361 | 87 of 361 | 8 retired or a decision (LIM-615, React Native dropped). 165 of 361 stand on real files, a real outside tool or a real browser on real content. |
| Whole claims.md, both audits | 646 live rows | 135 of 646 | 125 of 646 | 26 and 38 from the first audit. |
| Table rows of claims.md that are not LIM rows | 141 | 6 of 141 | | Batch sections, optimization proofs and measurements; the 6 say stand-in themselves. |
| limits.md table rows | 819 | 93 of 819 name a stand-in, a synthetic input or no real device | | Most rows state an enforced limit or a method, which the source proves. |

By class, the 109 whole: 0 validator, 0 own reader, 0 built file, 109 stand-in. Of the 87 partly: 4 own reader (LIM-488, 555, 557, 618), 2 built file (LIM-647 multi-level files, LIM-360 pnts), the rest stand-in scenes on a real GPU. No new row rests on a validator alone: the batches after the first iPhone failure wrote their proofs against outside readers.

Not counted as a gap: a generator whose input is a seed (WFC, BSP rooms, caves, space colonisation, Poisson darts, road graphs) proves what it claims by running, as its generated input is the real use. They are listed so the count is honest, and the real proof named for them is a person judging the output.

### Stand-in in whole or in part, by package

| Package and rows | Proof today | What that proof cannot detect | What would really prove it | Real test so far |
| --- | --- | --- | --- | --- |
| `@margoengine/xr` LIM-421, 424, 427, 429, 431, 436, 531; `webgl2-compat` LIM-433 | Stand-in `XRSession`, layers and inputs over real WebGPU or a real WebGL framebuffer. `runDeviceCheck` reads NOT RUN on all four routes. | Head tracking, real controllers and hands, real planes and depth, haptics, layer compositing, frame pacing on a headset. | `runDeviceCheck` on a Vision Pro (Safari, WebXR) and a Quest browser. | None. On Scott's list. |
| `@margoengine/vfx` LIM-485, 489, 492, 496, 505, 508, 509, 511, 569, 581, 590, 594, 595; LIM-576 | One generated particle scene on one GPU, often one particle, compared with maths written beside it. | How an authored effect looks: a real flipbook atlas, a real skinned character, thousands of overlapping particles. | An effect made from a real atlas and a real rigged character, checked by a person and against a reference picture. | WebKit on the M6 (Metal): see "Real tests of 2026-11-10". |
| `@margoengine/navmesh` LIM-346, 347, 350, 352, 353, 354, 355, 356, 365; `behavior` LIM-368, 371, 382, 385, 392, 404, 415 | Generated levels and scenes. | A real level: thin walls, stairs, overlapping floors, non-manifold meshes from an art tool. | A free real level (a Sponza or a CC0 game level GLB) baked, routes checked, agents watched. | Not run. |
| `@margoengine/cache` LIM-338 to 343 | In-memory IndexedDB and a stand-in HTTP server in Node. | A browser's real IndexedDB, quota and eviction (Safari evicts script-written storage after 7 days without use), real `Cache-Control` from a real server. | The package's browser suite in Safari and Chromium against a real HTTP server. | WebKit on the M6: see "Real tests of 2026-11-10". |
| `@margoengine/netcode` LIM-384, 387, 393, 395, 398, 400, 403, 406; `net` LIM-373, 379; `voxel-net` LIM-582, 598, 618 | Stand-in links in one process, or real pages on loopback on one PC. | Real loss, jitter, NAT, HTTP/3 certificates, two machines. | Two machines over a real network, one on Wi-Fi with loss, and a WebTransport server with a real certificate. | Not run. |
| `@margoengine/audio` LIM-602, 603, 605, 607, 608, 610; `mixer` LIM-583, 586, 589, 591, 596 | Generated tones on a real Edge audio thread. | Real programme material; another browser's Web Audio; a reference meter. | LUFS against a reference meter on real speech and music; the suites in Safari. | WebKit on the M6: see "Real tests of 2026-11-10". |
| `@margoengine/video` LIM-566, 571, 573; LIM-575, 578 | Generated `VideoFrame`s and canvas streams on Edge. LIM-575 is real CC0 MDN frames against FFprobe. | Real movie content and codecs; whether a recorded file opens outside the browser. | A real film file (Big Buck Bunny, CC BY 3.0) on the material, and a recorded file opened in QuickTime and VLC. | WebKit on the M6: see "Real tests of 2026-11-10". |
| `@margoengine/tiles` LIM-360, 370, 374; LIM-344, 362, 364 | Real Draco bitstreams in a pnts made here; ion and Google answered by stand-ins; real CesiumJS terrain with stand-in imagery. | A real ion account, a real Draco pnts tileset, deep real zoom. | A live ion asset with a token (Scott's account) and a published Draco point tileset. | Not run. Needs an account. |
| `@margoengine/usdz` LIM-324; LIM-303, 310, 315, 319, 320, 331 | Real files for the rest; `!resetXformStack!` on a stage OpenUSD wrote, as no real file uses it. | What a DCC writes for it. | A Maya or Houdini USD with a reset transform. | 546 local files scanned, none use it. |
| `@margoengine/splats` LIM-453, 488, 490, 500, 574, 471 | A procedural 16,777,216-splat cloud; SPZ and SOG read back by Margo only. | Whether another tool opens our SPZ and SOG; a real large capture. | Open written SPZ and SOG in SuperSplat or Niantic's `spz` reader. | Not run. |
| `@margoengine/voxel-edit` LIM-555, 557 | Round trip through Margo; `.vxm` 4 and 12 on real files. | Whether Goxel and VoxEdit open a written file. | Open a written `.gox` in Goxel and `.vxm` in VoxEdit. | Not run: neither is installed on any machine. |
| `@margoengine/environment` LIM-493, 498, 504, 543, 545; LIM-644, 647 | Synthetic HDR fields, stand-in scenes; tiled EXR on files Margo wrote from the spec. | A photographed environment; a tiled EXR a studio tool wrote. | Real HDRIs; the OpenEXR project's tiled sample images, values against Apple ImageIO or OpenEXR. | See "Real tests of 2026-11-10". |
| `@margoengine/cinematic` LIM-308, 312, 313, 316 | Generated curves. | Whether a move reads well in a real scene. | A person watching a shot on a real scene. | Not run. |
| `@margoengine/post` LIM-434, 441, 442, 446, 455, 459, 472, 474; `taa` LIM-515, 523, 525, 533; `tonemap` LIM-477, 482, 486; `sprites` LIM-475, 476, 478, 480, 484, 487; `tilemap` LIM-491; `cameras` LIM-326, 536 | Real GPU, stand-in scenes, compared with maths written beside the test. | A real scene, and any reference renderer. | A real scene against a path traced or vendor reference. | WebKit on the M6: see "Real tests of 2026-11-10". |
| `@margoengine/labels` LIM-532, 540, 542, 546; `html` LIM-550, 552, 559 | Fake layout elements in Node for part, a real page for the rest. | Real CSS layout and transforms in every browser. | The browser suites in Safari and Chromium. | WebKit on the M6: see "Real tests of 2026-11-10". |
| `@margoengine/save` LIM-411, 413, 414; `react` LIM-448, 449, 451; `fsm` LIM-321, 322, 323, 325, 332; `inspector` LIM-570, 649; `mcp` LIM-465 | Stand-in storage, generated machines, fake GPU objects for part. | Real browser storage quota and eviction; a real editor session. | The browser suites in Safari; a person using the inspector. | WebKit on the M6: see "Real tests of 2026-11-10". |
| Generators: `procedural` LIM-621, 628, 631, 632, 639, 642, 643; `road` LIM-633 to 636, 638, 640; `wfc` LIM-613, 614, 616, 623, 624; `transitions` LIM-625, 627, 629; `creative` LIM-606, 619 | Generated input, which is the use. | Whether the output is good to play or look at. | A person judging the output. WFC: the published sample tile sets. | Not counted as a gap. |
| Light transport: LIM-617, 622, 626, 630, 637, 641; `clustered` LIM-645, 650, 654; LIM-293 | Real GPU against quadrature and maths written beside it, generated scenes. | Any outside reference picture. | A path traced reference of a real scene (Cycles, as LIM-298 and 318 did). | Not run. |
| Other partly: LIM-294, 296, 297 (FBX, a stand-in for one case each), 329, 330, 335, 376, 394, 445, 503, 524, 537, 587 | Real files or a real GPU for the claim, a stand-in for one corner each, named in the row. | That corner. | A real file with that corner. | As each row says. |

## Moved out by real tests

These were in the tables above until batch 121 ran them.

| Claim | What the real test showed |
| --- | --- |
| LIM-093 | `decodePNG` now equals Chromium byte for byte on 162 of 162 PngSuite files and refuses 14 of 14 corrupt ones. It was 127 equal, 35 interlaced refused and 3 corrupt accepted, so the test found two bugs. |
| LIM-094 | Blender 5.3 reads half and float EXR with values to 1,000 and alpha, every value exact and the rows the right way up. Apple `sips` reads both. |
| LIM-095 | ABeautifulGame: Apple `usdcat --flatten` composes 49 meshes from 10 classes and 44 references, and Blender 5.3 reads 49 meshes and 1,499,072 triangles, bounds gap 4.22e-8. Status back to PROVEN. |
| LIM-233 | Safari 27.2 on an Apple M6 ran the browser path on 9 of 9 fixtures, Wasm hashes equal 9 of 9. It also found an open bug: `bench_oriented_brg` is red in Safari and green from the Wasm path, as the Wasm path applies no colour profile (known-bugs.md). |

## Apple proofs on the Mac, list 4 (2026-11-10)

Batch 121 again, on the M6 Mac mini, Apple tools first. The screen was locked from 08:06, which matters: Safari's page reported itself hidden, so it drew and decoded but presented no canvas frames, and `qlmanage` hung where `QLThumbnailGenerator` did not.

| What ran | Tool | Result |
| --- | --- | --- |
| The `tools/real-proof/safari` page: 5 models, 9 JPEG XL files | Safari 27.2 (WebGPU on Metal), and the same page in Chrome | 5 of 5 models draw with no error and look the same in both. JPEG XL: Wasm hashes equal 9 of 9, and `bench_oriented_brg` now agrees within 1 of 255 between Safari and the Wasm path (LIM-233 updated). |
| `renderCutscene` to WebM and MP4 (LIM-291) | Playwright WebKit, Chrome, then AVFoundation (`tools/real-proof/avfoundation_video.swift`) and `afconvert` | WebKit failed: its AAC description is a whole ES_Descriptor, it stamps chunks from each AudioData, and with no `roll` group its `decodeAudioData` cut the lead-in twice (tone 44 ms early). Fixed with three tests in `ba89faa5a`; now passes in both, and Apple's frameworks read both files right. |
| `recordCanvas` MP4 (LIM-571) | Chrome, then AVFoundation | Chrome's own MP4 was VP9, and AVFoundation said "Cannot Decode". Fixed in `34463ac6d` (H.264, with AAC for sound); the new file opens, 87 frames. |
| `recordCanvas` WebM colour (LIM-571) | Playwright WebKit, ffmpeg | WebKit draws its own VP8 recording of #336699 as (61, 113, 164); ffmpeg reads the same file as (47, 103, 155). A plain 2D canvas does the same, so it is WebKit's, in known-bugs.md. |
| `recordCanvas` in Safari | Safari 27.2 | Not proved. From 08:06 the page was hidden and recorded nothing; an earlier run (07:52, page state not logged) made a 2-frame MP4 whose header says 5,576 s, and AVFoundation reads it so. Open in known-bugs.md; needs the screen unlocked (Scott's list below). |
| 25 static, 31 animated and 8 textured USDZ from current main | `usdchecker --arkit` | 64 of 64 pass, 4 with the known normal-scale warning. |
| The 31 animated files at set heights | RealityKit `visualBounds` | Every height as asked (Fox 0.45, robot 1.0, RiggedFigure 1.8) and the floor at 0, robot-expressive's posed parts aside. MorphStressTest's 3 clips have no animation in RealityKit: morph weights are not written, so they are still files (LIM-265 corrected). |
| 6 of those files | Quick Look thumbnails (`QLThumbnailGenerator`) | All 6 draw upright and textured. ToyCar's cloth is black where glTF's sheen makes it red: a USDZ cannot hold sheen, as limits.md says. |

Not installed on the Mac, so not run here: Godot, PrusaSlicer, Unity, Unreal, VLC. Blender 5.3 is installed and was not rerun: its earlier rows stand. The Playwright WebKit sweep of every package's GPU suite (2026-11-10, 06:45) failed 47 commands; batch 121 triaged only the video ones, and the rest are in finish-later.md.

## Tests only Scott can do

An agent has no phone, no headset and no account, so these wait for a person. Each takes minutes once the files are on the device.

| Test | What it closes | What to look at |
| --- | --- | --- |
| Open the static and animated USDZ files on an iPhone in AR Quick Look: the set made on 2026-11-10 is in `~/Development/Projects/margo-device-tests/2026-11-10/` on the Mac (`static`, `animated` at set heights, `textured`), AirDrop the folder | LIM-253, LIM-265, "Animated USDZ: the fix for the first iPhone failure awaits a retest", "RiggedFigure first loads off the floor" | Right size against the room, standing on the floor, clip plays, textures right. |
| Open the eight files of `scripts/make-usdz-quicklook-kit.mjs` on an iPhone | "USDZ export with textures: Quick Look on a Mac only" | Compare with the file descriptions at the top of that script. |
| Open the stage XR example in a headset browser with WebXR and WebGPU, and the WebGL2 layer example in one with WebGL2 | LIM-120, LIM-151, "WebXR AR hit testing: never run on an AR device" | The session starts, the view tracks the head, a hit test lands on a real surface. |
| Unlock the Mac, keep Safari in front, and open `http://127.0.0.1:18765/index.html?only=record` while `python3 tools/real-proof/safari/server.py tools/real-proof/safari/dist 18765 report.json` runs | LIM-571 in Safari | `record.mp4` beside `report.json` opens in QuickTime Player, about 3 s, Fox turning. |
| Play `cutscene-chrome.mp4` and `cutscene-webkit.mp4` from the same folder on the iPhone | LIM-291 on a device | A cube moves right, the shot cuts at 1 s, a tone starts at 1 s. |
| Sign in to Unity Hub on the PC | The Unity sampler add-on and postprocessor row above | Then an agent runs the import. |
| Open a Roblox Studio account | The Roblox preset row above | Then an agent or Scott imports the preset file. |
