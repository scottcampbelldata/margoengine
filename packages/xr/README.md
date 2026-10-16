# @margoengine/xr

Optional WebGPU WebXR session negotiation, input poses and instanced stereo PBR rendering. XR owns a compatible GPU device and attaches through the existing core extension interface. Core and the stage facade remain frozen.

```ts
import {Engine,box} from '@margoengine/core';
import {XR} from '@margoengine/xr';

const canvas=document.createElement('canvas');document.body.append(canvas);
const engine=await Engine.create(canvas,{backend:'webgpu'});
const cube=engine.createMesh().setGeometry(box());
if(await XR.isSupported('immersive-vr')) {
  const xr=await XR.create(engine); // prepare before the user gesture
  const enter=document.createElement('button');enter.textContent='Enter VR';document.body.append(enter);
  enter.onclick=()=>{void xr.requestSession('immersive-vr',{
    onFrame({delta,inputs}) {
      cube.rotation.y+=delta;
      // inputs expose native sources/gamepads plus targetRay and optional grip poses.
    }
  }).then(session=>session.addEventListener('end',()=>engine.start(),{once:true})).catch(engine.onError);};
  // await xr.end() exits; xr.dispose() detaches and releases GPU resources.
}
engine.start();
```

`XRManager` is an alias for `XR`. `useXRSession(manager, mode, options)` is a framework-neutral request helper; prepare the manager before the user gesture and dispose it with the owning engine. It adds no React dependency.

`requestSession` supports `immersive-vr`, `immersive-ar`, and `inline`. Immersive sessions require native `XRGPUBinding`, require `webgpu`, and default to `local` space. Inline sessions use `viewer` space and track poses/inputs while the desktop canvas continues rendering. The [WebGPU XR draft](https://immersive-web.github.io/webxr-webgpu-binding/#feature-descriptor) prohibits WebGPU inline layers and mixing `XRWebGLLayer` with WebGPU sessions. Missing immersive bindings leave desktop rendering active. Reference-space and feature options are forwarded. AR clears transparently. Failed initialization closes the session and frees its layer. Engine disposal ends XR and frees buffers/device. Device loss ends the session; recreate the manager to recover.

Use HTTPS or localhost and call `requestSession` from a user gesture. `isSupported` checks APIs and session mode; adapter compatibility, permissions and feature support are established during creation/negotiation. Support follows browser capabilities without headset brand detection. Vision Pro VR support does not imply AR support. See the [binding draft](https://immersive-web.github.io/webxr-webgpu-binding/) and [WebKit announcement](https://webkit.org/blog/17640/webkit-features-for-safari-26-2/).

Immersive XR stops the engine RAF after entry and automatically restarts it on exit/disconnection. Update animation in XR `onFrame`; engine `onFrame` and React `useFrame` belong to the window RAF. Core plugin `onPreUpdate` runs once per immersive XR frame. Inline tracking leaves the window RAF active.

Core geometry/materials use the shared base shader, per-eye uniforms, native [0,1] projections, viewports and texture-array descriptors. Loader-owned PBR models are discovered through the optional triangle registry and use their PBR shader in both eyes. The canvas mirror and XR buffers use separate devices; each eye owns independent PBR resources and deformation kernels, sharing current CPU pose data without advancing playback twice. Late animation attachment/removal and extension replacements synchronize before drawing. Caller-owned material extension texture views require recreation for the XR device and report an explicit error. Advanced post effects, controller visuals, locomotion, hit testing and WebGL XR fallback remain outside this renderer.

`XRController` reuses target-ray/grip matrices, 32 button triplets (value/pressed/touched), 16 axes, and 25 hand joint matrices/tracking flags when granted. Controllers change on `inputsourceschange`. Frame state, input arrays and existing controller buffers retain identity; copy to retain a past frame. Browser-owned poses and GPU descriptors may allocate; this is not a whole-runtime zero-GC guarantee.

Run `npx vite --host 127.0.0.1` at the root and open `/examples/webxr-orbit/`. Peer ranges accept core 0.1.x and 1.x.

`npm test` checks negotiation, inputs, eye buffers, reference-space failure, device loss and disposal races. Root `npm run modern:test:xr:browser` checks actual stereo pixels, GPU validation and teardown using simulated sessions with real WebGPU. Physical Meta Quest and Apple Vision Pro sessions remain untested. No Apple hardware is required for these checks.

Build with root `npm run build:packages` or local `npm run build`. MIT licensed.
