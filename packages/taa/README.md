# @margoengine/taa

Optional WebGPU temporal anti-aliasing. Eight Halton (2,3) projection offsets move raster samples by fractions of a pixel. An `rg16float` velocity buffer stores current minus previous UV coordinates. History is reprojected with bilinear depth-tested taps, clamped to the current 3×3 neighborhood in YCoCg, and blended in linear RGB. Two HDR color histories and two `r32float` depth histories alternate without GPU readback.

```ts
import {EngineKernel,box} from '@margoengine/core';
import {TAA} from '@margoengine/taa';
const engine = await EngineKernel.create(document.querySelector<HTMLCanvasElement>('#viewport')!, {backend:'webgpu'});
engine.createMesh().setGeometry(box());
const taa = TAA.attach(engine, {historyWeight:0.9, depthThreshold:0.01});
engine.start();
// taa.reset() after a camera teleport, scene replacement or abrupt lighting change.
```

Core mesh motion and loaded glTF/FBX node motion are automatic, including parent transforms and reused entity IDs. `taa.add(pbrModel)` remains available for explicit velocity sources and safely overlaps automatic discovery. TAA reads the current animated stride-80 vertex buffer after skinning/morph computation and snapshots it on the GPU for the next frame. Static PBR vertices receive a lazily allocated TAA-owned storage copy from retained CPU data; ordinary PBR buffer usage is unchanged. There is no animation pass or palette duplication. Alpha-masked primitives retain UV0/UV1 selection, affine texture transforms, vertex alpha and cutoff. The returned function unregisters the explicit source. Custom sources use the `shadowPrimitives` contract (24-byte core or 80-byte PBR vertices); PBR buffers need storage usage or retained `primitive.vertices`, plus alpha texture/sampler bindings. Disposed models are removed during rendering.

Other opaque renderers get camera-motion reprojection from scene depth. Custom deformation needs registered velocity primitives. Transparent particles, blended glTF and splats use the underlying opaque depth and neighborhood clamping; they do not supply their own velocity or occlusion history. Fast transparent effects can still ghost. Call `reset()` when a scene change cannot be described by motion.

`historyWeight` is in [0,1), default 0.9; zero disables history blending. `depthThreshold` is the relative reversed-depth rejection tolerance in [0,1], default 0.01. Parameters are validated before commands. History resets on resize, projection changes and device restoration; first-frame/newly visible primitives reject history. Rendering receives a retained camera view with the jittered matrix and the public camera's current properties. The public camera matrix stays unchanged, including when another pass throws; presentation restores the original context camera reference. Culling uses the normal camera frustum.

TAA captures the final display color before main and resolves at frame-graph order 40, after SSAO or creative post-processing at 30. For another plugin that replaces scene depth, provide `depth:()=>sourceTexture` in the options: `SSAO.depthTexture` or `PostProcessing.target?.depth`. Attachments must be sampleable, match the viewport and use the scene's depth format. SSAO and creative PostProcessing continue to own their respective HDR passes; TAA converts their final sRGB output to linear RGB before accumulation.

`gpuState` exposes velocity, current history color and history depth textures after rendering. `dispose()`/`destroy()` releases owned buffers, textures and source records. Device restoration recreates everything and discards stale history. The package is independent of PBR, animation, shadows, clustered lighting, particles and stage; helper-only imports discard the renderer. It follows the workspace's `@margoengine/*` naming convention.
