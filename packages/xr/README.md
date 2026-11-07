# @margoengine/xr

Import `margoengine/xr` from the `margoengine` package, or `@margoengine/xr` from this package alone; the two are the same module. Neither is on npm yet: the [Install](../../README.md#install) section lists the two routes that work today (run in a clone, or install local tarballs).

Optional WebGPU WebXR session negotiation, input poses and instanced stereo PBR rendering. XR owns a compatible GPU device and attaches through the existing core extension interface. Core and the stage facade remain frozen.

```ts
import {Engine,box} from 'margoengine/core';
import {XR} from 'margoengine/xr';

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

`requestSession` supports `immersive-vr`, `immersive-ar`, and `inline`. Immersive sessions require native `XRGPUBinding`, require `webgpu`, and default to `local` space. On the WebGL2 compatibility layer the layer's `installXR()` takes the binding's place and the session runs on an `XRWebGLLayer` instead, without `webgpu` ([its README](../webgl2-compat/README.md#xr-margoenginewebgl2-compatxr)). Inline sessions use `viewer` space and track poses/inputs while the desktop canvas continues rendering. The [WebGPU XR draft](https://immersive-web.github.io/webxr-webgpu-binding/#feature-descriptor) prohibits WebGPU inline layers and mixing `XRWebGLLayer` with WebGPU sessions. Missing immersive bindings leave desktop rendering active. Reference-space and feature options are forwarded. AR clears transparently. Failed initialization closes the session and frees its layer. Engine disposal ends XR and frees buffers/device. Device loss ends the session; recreate the manager to recover.

Use HTTPS or localhost and call `requestSession` from a user gesture. `isSupported` checks APIs and session mode; adapter compatibility, permissions and feature support are established during creation/negotiation. Support follows browser capabilities without headset brand detection. Vision Pro VR support does not imply AR support. See the [binding draft](https://immersive-web.github.io/webxr-webgpu-binding/) and [WebKit announcement](https://webkit.org/blog/17640/webkit-features-for-safari-26-2/).

Immersive XR stops the engine RAF after entry and automatically restarts it on exit/disconnection. Update animation in XR `onFrame`; engine `onFrame` and React `useFrame` belong to the window RAF. Core plugin `onPreUpdate` runs once per immersive XR frame. Inline tracking leaves the window RAF active.

Core geometry/materials use the shared base shader, per-eye uniforms, native [0,1] projections, viewports and texture-array descriptors. Loader-owned PBR models are discovered through the optional triangle registry and use their PBR shader in both eyes. The canvas mirror and XR buffers use separate devices; each eye owns independent PBR resources and deformation kernels, sharing current CPU pose data without advancing playback twice. Late animation attachment/removal and extension replacements synchronize before drawing. Caller-owned material extension texture views require recreation for the XR device and report an explicit error. That separate route draws no package passes or post effects; an engine from `createXREngine` draws them all (below).

`XRController` reuses target-ray/grip matrices, 32 button triplets (value/pressed/touched), 16 axes, and 25 hand joint matrices/tracking flags when granted. Controllers change on `inputsourceschange`. Frame state, input arrays and existing controller buffers retain identity; copy to retain a past frame. Browser-owned poses and GPU descriptors may allocate; this is not a whole-runtime zero-GC guarantee.

Run `npx vite --host 127.0.0.1` at the root and open `/examples/webxr-orbit/`. Peer ranges accept core 0.1.x and 1.x.

`npm test` checks negotiation, inputs, eye buffers, reference-space failure, device loss and disposal races. Root `npm run modern:test:xr:browser` checks actual stereo pixels, GPU validation and teardown using simulated sessions with real WebGPU. Physical Meta Quest and Apple Vision Pro sessions remain untested. No Apple hardware is required for these checks.

Build with root `npm run build:packages` or local `npm run build`. Apache-2.0 licensed.

## AR hit testing

`HitTest` uses the WebXR Hit Test Module in an `immersive-ar` session started with the `'hit-test'` feature. Its ray
starts at the viewer (the centre of the view, for a placement reticle), at an input source's target ray, or at transient
inputs such as screen taps (`{profile: 'generic-touchscreen'}`). `hits.results(frame)` gives this frame's hits nearest
first, each with a column-major `matrix`, `position` and `orientation` in the session's reference space;
`hits.anchor(hit)` anchors one (WebXR Anchors Module, feature `'anchors'`). The source is cancelled with `cancel()` or
when the session ends. Not yet tried on an AR headset or phone; tested against the specification's interfaces.

```ts
import { Engine, box } from 'margoengine/core';
import { XR, HitTest } from 'margoengine/xr';

const canvas = document.querySelector('canvas')!;
const engine = await Engine.create(canvas, { backend: 'webgpu' });
const reticle = engine.createMesh().setGeometry(box(0.2, 0.01, 0.2));
const xr = await XR.create(engine);
let hits: HitTest | undefined;
await xr.requestSession('immersive-ar', {
  requiredFeatures: ['hit-test'],
  onFrame({ frame }) {
    const hit = hits?.first(frame);
    reticle.visible = !!hit;
    if (hit) reticle.setPosition(hit.position).setQuaternion(hit.orientation);
  },
});
hits = await HitTest.create(xr, { from: 'viewer' });
```

## Device runs

`runDeviceCheck` from `@margoengine/xr/device-check` runs one session and gives back what happened: frames, poses, views, frame times, inputs, granted features and failures. `examples/xr-device-check` is the page to open on a headset or phone; [docs/xr-device-runs](../../docs/xr-device-runs/README.md) keeps the records, and `npm run check:xr-runs` prints which routes a real device has proven. No real device has run yet: all four routes read NOT RUN. A run whose `navigator.xr` is a JavaScript stand-in has `native: false` and proves nothing.

```ts
import { Engine } from 'margoengine/core';
import { XR } from 'margoengine/xr';
import { runDeviceCheck } from 'margoengine/xr/device-check';

const canvas = document.querySelector('canvas')!;
const engine = await Engine.create(canvas, { backend: 'webgpu' });
const xr = await XR.create(engine);
document.querySelector('button')!.onclick = async () => {
  const run = await runDeviceCheck(xr, { mode: 'immersive-vr', seconds: 20 });
  console.log(run.tracked, 'tracked frames at', run.frameMs.median, 'ms');
};
```

## Package passes and post effects in XR

Create the engine with `createXREngine` instead of `Engine.create` and XR draws through the engine's own frame graph on its own GPU device: lines, point clouds, terrain, shadows, sky and post effects appear in both eyes as they do on the desktop. `xr.route` is `'engine'`. An engine from `Engine.create` keeps the older `'separate'` route, which draws core meshes and glTF-pro models only.

```ts
import {box} from 'margoengine/core';
import {XR,createXREngine} from 'margoengine/xr';

const canvas=document.createElement('canvas');document.body.append(canvas);
const engine=await createXREngine(canvas);
engine.createMesh().setGeometry(box()).setPosition([0,1.5,-2]);
const xr=await XR.create(engine);
console.log(xr.route); // 'engine'
const enter=document.createElement('button');enter.textContent='Enter VR';document.body.append(enter);
enter.onclick=()=>void xr.requestSession('immersive-vr').catch(engine.onError);
engine.start();
```

Each eye is a view of `engine.render({views})` drawn into a texture, then copied into the session's layer, with the scene's depth written to the layer's depth so the compositor can reproject. In AR the real world shows where the scene draws neither depth nor light. A stage gets the same route with `new Stage(await createXREngine(canvas))`.
