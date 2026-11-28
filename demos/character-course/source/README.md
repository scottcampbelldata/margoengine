# Character Course

Walk through an original gauge station across a sandstone gorge. The route climbs six brass-edged steps, crosses the channel on a moving maintenance ferry, then descends a ramp to the lower deck. Use WASD or hold the arrows to walk, Space or Jump to hop, and drag the scene to orbit. The guided walk uses the same controller as manual input and waits on the ferry’s brass ring.

## Kinematic motion

The public Margo CharacterController moves a vertical capsule against actual course colliders at a fixed 60 Hz. Six 180 mm steps exercise auto-step, and the 17.5° ramp exercises slope following and ground snap. The scene reports Margo’s support and slope readings. The ferry is a position-kinematic platform with its own collision deck and rails. Its 4.65 m trip eases from dock to dock. When Margo identifies the ferry as the capsule’s support, its platform inheritance carries the walker without forward input.

ThirdPersonControls supplies the spring-arm view, camera-relative heading, drag and zoom. The overhead structures participate in its camera collision queries. The guided sequence supplies a velocity command for the same solver at each step. The avatar’s arm swing and planted/swing-foot poses follow measured travel and the authored deck heights. Capsule movement is kinematic throughout. The walking pose is an independent visual rig.

## Art and asset preparation

The intake works, cliff bands, flanged penstock, hand-lettered markers and other 3D geometry were made for this exhibit. The original inspector character was authored from the licensed MakeHuman/MPFB core body, skin references, ponytail, eyes, workwear and boots. The hardhat, palette and gait were made for this course. The compact asset retains 22 weighted joints and uses gzip, local position deltas and octahedral normals. Both renderers draw the same live skin and station through the Margo core PBR materials.

The early 3D view opens while the pinned rigid-body WASM module loads. A guided-walk request made during this interval is queued until the actual controller can move. The manual movement controls activate when the live solver is ready. WebGPU is tried first. Append '?backend=webgl2' to force the direct Margo WebGL2 renderer.

To regenerate the rig with Blender 5.3 and MPFB 2.0.18 plus the official MakeHuman core asset pack installed, run from this directory.

```sh
blender --factory-startup -b --python tools/author-inspector.py -- inspector.rig
```


## Physics delivery

The release’s courseKernelTransport Vite plugin preloads the selected XZ asset alongside the physics entry and its column descriptor. A worker decodes and compiles the original WebAssembly bytes. The pinned Physics facade receives that compiled module and runs its ordinary rigid-body and CharacterController code. The worker uses Margo’s public XZ decoder. Browser SIMD detection selects the matching module and descriptor.

The packed SIMD and scalar assets are 206,904 and 198,552 bytes. Their decoded module hashes are c03f876eb701bb5a4acff8be0fb8ae7477d4f1889312916dbde5206da3ecc360 and 22e3501b98f671264671c17453e4657f2325d147d9155e92676986e30257094b, respectively. Regenerate both with Node, Python’s standard lzma module and a built checkout of the pinned revision.

```sh
node tools/pack-course-kernel.mjs /path/to/margoengine
```
- [Pinned public Margo Engine revision](https://github.com/scottcampbelldata/margoengine/tree/0efd9cff8230507a32deb49907ecd499d46925f5)
- Erin Catto, *Physics for Game Programmers: Understanding Constraints*, 2014. [Swept collision for a geometric character controller](https://gdcvault.com/play/1021116/Physics-for-Game-Programmers-Understanding).
- NVIDIA, *Character Controllers*, PhysX 5.3.1. [Capsule movement, auto-step and slope limits](https://nvidia-omniverse.github.io/PhysX/physx/5.3.1/docs/CharacterControllers.html).
- Lucas Kovar, John Schreiner and Michael Gleicher, *Footskate Cleanup for Motion Capture Editing*, 2002. [The visual role of planted feet](https://graphics.cs.wisc.edu/Papers/2002/KSG02/).
- MakeHuman Community. [CC0 license for the core character assets](https://static.makehumancommunity.org/about/license.html).
- U.S. Bureau of Reclamation, *The Story of Hoover Dam*. [Visual references for penstocks, intake towers and maintenance cranes](https://www.usbr.gov/history/hoover.html).
- Lasse Collin and Igor Pavlov, *The .xz File Format*, version 1.2.1, 2024. [XZ and LZMA2 transport specification](https://tukaani.org/xz/xz-file-format.txt).
