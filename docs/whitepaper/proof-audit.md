# Proof audit

Scott's order of 2026-11-06: passing checks is not the same as working. All 76 USDZ files passed `usdchecker`, and the first iPhone run failed in seconds: Fox stood 79 m tall. This page goes through [claims.md](claims.md) and [limits.md](../limits.md) and lists each claim whose proof is only a validator, our own reader, a stand-in or a built file, what that proof cannot see, and what would really prove it.

Audited at `a56efd87f`. Rerun it once more after the feature batches end.

## Counts

| Where | Audited | Proved only by a tool or stand-in | Partly | Note |
| --- | --- | --- | --- | --- |
| LIM rows in claims.md | 270 | 32 of 270 | 25 of 270 | 272 rows, 2 retired or relocated. |
| Headline numbers | 4 | 0 of 4 | 0 of 4 | They are facts about the built files and the source, so the built file is the right proof. |
| Whitepaper figures | 19 | 1 of 19 | 0 of 19 | The parity figure is our own reading of a table we wrote. Three voxel figures already read UNPROVEN and are not counted again. |
| Capabilities | 14 | 2 of 14 | 1 of 14 | Each points at LIM rows below. Input and controls ran on synthetic events, release readiness on a stand-in registry, and the WebGL2 row has stand-in XR. |
| "Not yet backed" list | 10 | 10 of 10 | 0 of 10 | The list says so itself. |
| limits.md table rows | 294 | 53 of 294 touch a claim below | | Most rows state an enforced limit or a method, which the source proves. |

Classes: **Validator**, a checker or outside file tool passed it and no program a person uses opened it. **Own reader**, only Margo's code or the test's reader read it back. **Stand-in**, simulated input, a fake device, a fake session or test data in place of the real thing. **Built file**, the test wrote the bytes it then read.

By class, whole claims: 5 validator, 2 own reader, 1 built file, 24 stand-in.

What is not counted: a claim about maths, an API or a limit, proved by running the real code, needs no device or outside program. A claim proved on a real GPU in a real browser counts as real, on that one GPU. Rows that say "RTX A6000 only" are real proof on one machine: that is a limit of breadth, and [limits.md](../limits.md) states it.

## Proved only by a tool or stand-in

| Claim | Proof today | Class | What that proof cannot detect | What would really prove it | Real test so far |
| --- | --- | --- | --- | --- | --- |
| LIM-243: Draco export of 24 real GLBs | Khronos validator, Google's decoder, `gltf-transform` reads two. | Validator | Whether a viewer or a tool people use opens the file and shows the model the right way up, at size, with materials. | Open compressed files in Blender and Godot, compare bounds and pictures with the source. | Not run. |
| LIM-250: KTX2 export of 211 images from 21 GLBs | `ktx validate`, Binomial's transcoder, `gltf-transform` reads two. | Validator | Whether an app shows the textures, in the right colour space and the right way up on the model. | Open a textured file in an app that reads KHR_texture_basisu (Godot) and compare with the source picture. | Not run. |
| LIM-258: Meshopt export of 25 real GLBs | meshoptimizer decode, validator after decoding, `gltfpack`, `gltf-transform`, our own loader. | Validator | Whether an app people use loads the file directly. Blender does not read this extension. | Open in an engine with EXT_meshopt_compression (Godot if it has it) and compare with the source. | Not run. |
| LIM-262: GLB optimize of 25 real GLBs, and levels | Validator, `gltfpack`, `gltf-transform`, vertex checks in our test. | Validator | Whether the optimized file looks the same in an app. No reader has shown `MSFT_lod` levels switching. | Open optimized files in Blender and Godot, compare bounds and pictures. Levels need a viewer that switches them. | Not run. |
| LIM-253: USDZ of 25 static GLBs | `usdchecker --arkit`, `usdcat --flatten` with our bounds maths, SceneKit on one file. | Validator | This is the exact pattern that failed on the iPhone: a valid file can hold a 79 m model. Nothing shows the size or look a person gets. | AR Quick Look on an iPhone, for a sample of the 25. Quick Look thumbnails on the Mac for all 25. | Not run. |
| LIM-095: USDZ shared geometry | Our two USD readers load it back. | Own reader | Both readers are ours and share our reading of USD. A mistake in both reads as a pass. | Apple's `usdcat` and Blender's USD importer read the same file; compare meshes and world bounds. | Not run. |
| LIM-205: MaterialX and Lottie output | Our parser, our graph, a canvas that uploads. The row says no reference was compared. | Own reader | Whether a material or an animation looks like it does in the tool that made it. | MaterialX reference renders, and frames from a Lottie player, compared by picture. | Not run. |
| LIM-202: parseVDB | Files the test writes byte by byte. | Built file | Anything OpenVDB does that the test's author did not know. It has never read a file OpenVDB wrote. | A real .vdb from OpenVDB or Blender, with the values compared. | Not run. |
| LIM-032: Moving 14,500 meshes in 4 ms | Stand-in GPU device in Node. | Stand-in | The cost of real submission. The figure is CPU work on a fake device. | The same scene on a real page and GPU, frame time read from the engine. | Not run. |
| LIM-038: Mesh optimisation | A simulated 16-vertex cache and a software depth buffer. | Stand-in | Whether a real GPU gets faster: its cache is not this cache. | GPU frame time before and after on real meshes, on the quiet run. | Not run. |
| LIM-077: Even 60 FPS "on every display from 60 to 240 Hz" | Fake clock and fake GPU in a unit test. | Stand-in | Real displays and real browser frame timing. | A 60, 100, 120 and 240 Hz panel, with `requestAnimationFrame` times logged. | Not run. |
| LIM-109: WebGPU compatibility level | Forced device on an RTX A6000. | Stand-in | Real OpenGL ES or Direct3D 11 limits and bugs. | A device that only offers compatibility mode, such as an older Android phone. | Not run. |
| LIM-112, LIM-114, LIM-115, LIM-116, LIM-117, LIM-119: Controls: roll, third person, drag, orbit limits, many objects, platforms | Fake element and synthetic events in Node, on real core objects. Status said PROVEN. | Stand-in | Whether a real mouse, wheel or touch in a real page gives those events, and whether it feels right. | Real browser input on a real page, then a person trying each. | Not run. |
| LIM-120: Stage XR button | Simulated session. | Stand-in | Any real headset behaviour. | A headset browser with WebXR and WebGPU. | Not run. |
| LIM-127, LIM-132, LIM-148: Interactions, local players, input replay | Dispatched events on a fake clock. Status said PROVEN. | Stand-in | Real gamepads, key repeat and browser focus. An unplugged real pad has never been tried. | Two real gamepads and a keyboard in a real page. | Not run. |
| LIM-129: Stage physics | Real Rapier on a stand-in renderer in Node. | Stand-in | Whether what falls is what is drawn. | The same crate on a real page and GPU, the pixels following the body. | Not run. |
| LIM-134: Gyro aiming | Synthetic sensor events. | Stand-in | Real sensor signs, axes and rates. They come from the spec, not a phone. | A phone, with the page turned through each axis. | Not run. |
| LIM-137: First npm install | Stand-in registry. Status said PROVEN. | Stand-in | The real registry: names, scope, provenance. Nothing is published yet. | The first real publish, then an install in an empty folder. | Not run. |
| LIM-149: Pen input | Synthetic pointer events. | Stand-in | What a real pen sends: pressure curves, tilt ranges, coalesced rates. | A real pen on a tablet or an iPad. | Not run. |
| LIM-151: XR on the WebGL2 layer | Stand-ins for the browser's XR objects. | Stand-in | A real `XRWebGLLayer` and its framebuffer. | A headset browser with WebXR on WebGL2. | Not run. |
| LIM-211: Warping | A stand-in walk made for the test. | Stand-in | A real walk clip, whose feet do not plant as cleanly. | A real walk clip and a person looking at the feet. | Not run. |
| LIM-216, LIM-221, LIM-224: Object-space normal maps, layered materials, your own mip levels | Real GPU, stand-in maps and small data textures. The rows say so, the status said PROVEN. | Stand-in | A real baked map or authored layer set, with its noise, colour space and tiling. | A map baked by Blender or Substance, an authored terrain set, a real mip chain. | Not run. |
| LIM-259: Bump maps in glTF | A hand-written third-party file and a stand-in quad. | Stand-in | What an art tool would write. The extension is a draft. | A file from an art tool, once one exists. | Not run. |

## Partly proved by a tool or stand-in

Part of each claim stands on the real thing. The table names the part that does not.

| Claim | Proof today | Class | What that proof cannot detect | What would really prove it | Real test so far |
| --- | --- | --- | --- | --- | --- |
| LIM-014: Specular shift at distance | CPU emulation of the eye error. `FloatingOrigin` size is real. | Stand-in | A real GPU's float rounding. | Read the shift from a GPU render at 100 km. | Not run. |
| LIM-093: `decodePNG` reads every colour type | PNGs built by the test, and our own `encodePNG`. | Built file | Files written by other encoders. | The PngSuite set, compared with a browser's decoder. | Not run. |
| LIM-094: EXR output "reads back exactly" | JPEG and WebP go through the browser's decoders. The EXR goes through our reader. | Own reader | Whether anyone else can open the EXR. | Open it in Blender and compare values. | Not run. |
| LIM-113, LIM-118: Gizmo and arcball input | Drawing runs on a real GPU, input is synthetic. | Stand-in | Real pointer behaviour. | As the controls row above. | Not run. |
| LIM-176: Heat detection | The battery API is real. Heat is on modelled frames. | Stand-in | A machine really throttling. | A laptop or phone run hot, with the pace logged. | Not run. |
| LIM-193: parse3DM | Unit test on a stand-in runtime. Real rhino3dm reads three files, opt in. | Stand-in | That run is by hand, not in `npm test`. | Already real by hand. Keep the opt-in run recorded. | Not run. |
| LIM-195: LWO bones | A built file. Everything else in the row is on real files. | Built file | How LightWave really writes bones. | A rigged LWO with a clear licence. | Not run. |
| LIM-197: LAZ compressors 0 and 1, chunk size 0 | The test's own encoder. Other formats equal LASzip and lazrs on real files. | Built file | Real files of those kinds. | Files from LASzip with those settings. | Not run. |
| LIM-208: 108 public files open | Real files, read by us, compared with counts from small readers in the same test, and "no blank picture". | Own reader | A model on its side, inside out or the wrong size has the right counts and is not blank. This is the 79 m fox again. | The same files through Blender's importers, bounds compared. | Not run. |
| LIM-212, LIM-217: Full-body IK and mirroring tolerances | Tight numbers on a stand-in biped. Looser ones on real files. | Stand-in | How it looks on a real character. | A person watching a real character. | Not run. |
| LIM-213: Motion matching | Stand-in clips, plus Fox clips with hand-labelled speeds. | Stand-in | A motion capture set: scale, noise, foot contact. | A free motion capture set. | Not run. |
| LIM-226: VRM write side | Only Margo read a written file back. Reading real avatars is real. | Own reader | Whether another VRM tool accepts it. | Open a written file in a VRM viewer or a Blender add-on. | Not run. |
| LIM-228, LIM-230, LIM-239: Prefilter, lobes under clustered lights, eye refraction | Real GPU with a stand-in cube, quad or sphere. | Stand-in | A real sky or eye compared with another renderer. | Compare with a path traced picture of a real scene. | Not run. |
| LIM-232: Corrective shapes | Real rig and clip, a morph target added for the test. | Stand-in | An authored corrective. | A real file with correctives. | Not run. |
| LIM-233: JPEG XL browser path | The Wasm path equals `djxl`. The browser path ran on a stand-in. | Stand-in | A browser that decodes JPEG XL itself. | Safari on the Mac reads JPEG XL: run the browser path there. | Not run. |
| LIM-237: Face tracking | Test-written frames and stand-in targets. | Stand-in | A live tracker's noise and rate. | A phone tracker or MediaPipe on a camera, with a person watching. | Not run. |
| LIM-244: Getting up | Real rig and Rapier, stand-in clips (Death played backward). Status said PROVEN. | Stand-in | A real get-up clip, and how it looks. | A real get-up clip and a person watching. | Not run. |
| LIM-256, LIM-264, LIM-266: Splats with meshes, volume scatter, image and type B lights | Real files for part, stand-in quads and cubes for the rest. | Stand-in | Any reference picture. Three of the extensions are drafts. | A path traced or vendor reference, where one exists. | Not run. |
| LIM-265: USDZ animation | Mac tools for 76 clips. 8 of 76 on one iPhone, with RiggedFigure open. | Stand-in | The other 68 on a device, and any other phone. | AR Quick Look on the rest, and the RiggedFigure run in known-bugs. | Not run. |

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
| GLB for Godot, import bundle | exporters README | Package tests, plus a by-hand Godot import of four exports. | Godot opens the bundle in a real project. | Not run. |
| Unity sampler add-on and pixel art postprocessor | exporters README | Package tests. | Unity 6 imports the file with the script in place. | Not run. |
| Unreal names, helper and pixel art script | exporters README | Package tests. | Unreal 5.8 imports the file and runs the script. | Not run. |
| Roblox preset | exporters README | Package tests. | Roblox Studio. It needs an account, so it goes on Scott's list. | Not run. |

## limits.md rows tied to these claims

Draco export (`@margoengine/exporters/draco`, 2026-11-06); KTX2 export (`@margoengine/exporters/ktx2`, 2026-11-06); Meshopt export (`@margoengine/exporters/meshopt`, 2026-11-06); GLB optimize (`@margoengine/exporters/optimize`, 2026-11-06); MaterialX and Lottie (`@margoengine/loaders/materialx`, `/lottie`, 2026-11-06); OpenVDB volumes (`@margoengine/loaders/vdb`, 2026-11-06); Moving transforms per frame (CPU budget); Mesh optimisation (`@margoengine/geometry/optimize`); Light-tier frame rate; WebGPU compatibility level (`@margoengine/webgl2-compat/adapter`, 2026-11-05, packages 2026-11-06); Roll in `FlyControls` and `TrackballControls` (`enableRoll`, 2026-11-05); Third-person camera (`ThirdPersonControls` in `@margoengine/controls/third-person`, 2026-11-05); `DragControls` rotate mode, groups and children (2026-11-05); Orbit target radius and `orthoZoom` (2026-11-05); Several objects on `TransformControls` (`attachMany`, `pivot`, 2026-11-05); Moving platforms for `WalkControls` (`carry`, 2026-11-05); Stage XR button (`@margoengine/stage/xr`, 2026-11-05); Interactions (`@margoengine/input/interactions`, 2026-11-05); Local players (`@margoengine/input/players`, 2026-11-05); Input recording (`@margoengine/input/replay`, 2026-11-05); Stage physics (`@margoengine/stage/physics`, 2026-11-05); Gyro aiming (`@margoengine/input/motion`, 2026-11-05); First npm install; Pen input (`@margoengine/input/pen`, 2026-11-05); XR on the WebGL2 compatibility layer (`@margoengine/webgl2-compat/xr`, 2026-11-06); Warping (`@margoengine/animator/warping`, 2026-11-06); Object-space normal maps (`@margoengine/materials/object-normal`, 2026-11-06); Layered materials (`@margoengine/materials/layered`, 2026-11-06); Your own mip levels (`@margoengine/materials/mips`, 2026-11-06); Bump maps in glTF (`EXT_materials_bump` in `@margoengine/gltf-pro/extended`, 2026-11-06); Image comparison (`@margoengine/headless/compare`, 2026-11-05); Output formats (`@margoengine/headless/formats`, 2026-11-05); Gizmo occlusion (`occlude` on `TransformControls`, 2026-11-05); `ArcballGizmo`, double-click focus and arcball keys (2026-11-05); Battery and heat (`@margoengine/quality/power`, 2026-11-06); Rhino 3DM (`@margoengine/loaders/3dm`, 2026-11-06); Long-tail formats (`/3ds`, `/tds`, `/lwo`, `/amf`, `/md2`, `/pdb`, `/kmz`, 2026-11-06); LAS and LAZ (`@margoengine/loaders/las`, `@margoengine/points/las`, 2026-11-06); Real files (`npm run test:real-files -w @margoengine/loaders`, 2026-11-06); Full-body IK (`@margoengine/animator/fbik`, 2026-11-06); Runtime mirroring (`@margoengine/animator/mirror`, 2026-11-06); Motion matching (`@margoengine/animator/motion-matching`, 2026-11-06); VRM avatars (`@margoengine/rigging/vrm`, 2026-11-06); Prefiltered cube maps (`@margoengine/materials/prefilter`, 2026-11-06); Physical lobes under clustered lights (`@margoengine/clustered/physical-lobes`, 2026-11-06); Hair, eye and skin shading (`@margoengine/materials/hair`, `/eye`, `/skin`, 2026-11-06); Corrective shapes (`@margoengine/rigging/correctives`, 2026-11-06); JPEG XL (`@margoengine/decoders/jxl`, 2026-11-06); Face tracking (`@margoengine/rigging/face`, 2026-11-06); Getting up (`@margoengine/ragdoll/getup`, 2026-11-06); Gaussian splats in glTF (`@margoengine/gltf-pro/splats`, 2026-11-06); USDZ animation (`@margoengine/exporters/usdz-anim`, 2026-11-06); WebXR AR hit testing.

Rows with no LIM row of their own:

- WebXR AR hit testing: says itself it has never run on an AR headset or phone. Needs a headset.
