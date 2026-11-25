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

`layers` (an option of `XR.create` and `XR.attach`, and a property you can change at any time) is the render layer mask both eyes draw, on either route, as `RenderView.layers` is for a desktop view; unset draws every layer. A mesh whose mask (`setRenderLayers` from `margoengine/cameras/layers`) shares no bit with it is drawn in neither eye. This is how a first-person avatar hides its own head in the headset (`addVRMFirstPerson` from `margoengine/rigging/vrm-first-person`):

```ts
import {Engine,box} from 'margoengine/core';
import {setRenderLayers} from 'margoengine/cameras/layers';
import {XR} from 'margoengine/xr';

const canvas=document.createElement('canvas');document.body.append(canvas);
const engine=await Engine.create(canvas,{backend:'webgpu'});
engine.createMesh().setGeometry(box()).setPosition([0,1.5,-2]); // layer 0: seen in the headset
const hidden=engine.createMesh().setGeometry(box()).setPosition([0,1.6,0]);
setRenderLayers(hidden,1<<30); // on layer 30 only
if(await XR.isSupported('immersive-vr')) {
  const xr=await XR.create(engine,{layers:~(1<<30)>>>0}); // every layer but 30
  const enter=document.createElement('button');enter.textContent='Enter VR';document.body.append(enter);
  enter.onclick=()=>void xr.requestSession('immersive-vr').catch(engine.onError);
  // xr.layers=undefined draws every layer again; a mask outside 0 to 0xffffffff throws a RangeError.
}
engine.start();
```

`XRManager` is an alias for `XR`. `useXRSession(manager, mode, options)` is a framework-neutral request helper; prepare the manager before the user gesture and dispose it with the owning engine. It adds no React dependency.

`requestSession` supports `immersive-vr`, `immersive-ar`, and `inline`. Immersive sessions require native `XRGPUBinding`, require `webgpu`, and default to `local` space. On the WebGL2 compatibility layer the layer's `installXR()` takes the binding's place and the session runs on an `XRWebGLLayer` instead, without `webgpu` ([its README](../webgl2-compat/README.md#xr-margoenginewebgl2-compatxr)). Inline sessions use `viewer` space and track poses/inputs while the desktop canvas continues rendering. The [WebGPU XR draft](https://immersive-web.github.io/webxr-webgpu-binding/#feature-descriptor) prohibits WebGPU inline layers and mixing `XRWebGLLayer` with WebGPU sessions. Missing immersive bindings leave desktop rendering active. Reference-space and feature options are forwarded. AR clears transparently. Failed initialization closes the session and frees its layer. Engine disposal ends XR and frees buffers/device. Device loss ends the session; recreate the manager to recover.

Use HTTPS or localhost and call `requestSession` from a user gesture. `isSupported` checks APIs and session mode; adapter compatibility, permissions and feature support are established during creation/negotiation. Support follows browser capabilities without headset brand detection. Vision Pro VR support does not imply AR support. See the [binding draft](https://immersive-web.github.io/webxr-webgpu-binding/) and [WebKit announcement](https://webkit.org/blog/17640/webkit-features-for-safari-26-2/).

Immersive XR stops the engine RAF after entry and automatically restarts it on exit/disconnection. Update animation in XR `onFrame`; engine `onFrame` and React `useFrame` belong to the window RAF. Core plugin `onPreUpdate` runs once per immersive XR frame. Inline tracking leaves the window RAF active.

Core geometry/materials use the shared base shader, per-eye uniforms, native [0,1] projections, viewports and texture-array descriptors. Loader-owned PBR models are discovered through the optional triangle registry and use their PBR shader in both eyes. The canvas mirror and XR buffers use separate devices; each eye owns independent PBR resources and deformation kernels, sharing current CPU pose data without advancing playback twice. Late animation attachment/removal and extension replacements synchronize before drawing. Glass (`KHR_materials_transmission`) on a display-encoded layer adds its light to the light behind it in linear values, as on the canvas: when a drawn model has glass, the eye pass keeps its samples and gltf/pbr's snapshot hook resolves them before each glass surface (one extra resolve pass and one reopened eye pass per surface); scenes without glass draw one pass per eye as before. Caller-owned material extension texture views require recreation for the XR device and report an explicit error. That separate route draws no package passes or post effects; an engine from `createXREngine` draws them all (below).

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

Create the engine with `createXREngine` instead of `Engine.create` and XR draws through the engine's own frame graph on its own GPU device: lines, point clouds, terrain, shadows, sky and post effects appear in both eyes as they do on the desktop. `xr.route` is `'engine'`. An engine from `Engine.create` keeps the older `'separate'` route, which draws core meshes and glTF PBR models only.

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

Each eye is a view of `engine.render({views})` drawn into a texture, then copied into the session's layer, with the scene's depth written to the layer's depth so the compositor can reproject. In AR the real world shows where the scene draws neither depth nor light. A stage gets the same route with `new Stage(await createXREngine(canvas))`. On the WebGL2 compatibility layer, call `installXR()` from `@margoengine/webgl2-compat/xr` first and `createXREngine` takes the same route there.

## Controller and hand models

`XRModels` from `@margoengine/xr/models` draws every input source the session has: a controller at its grip, whose trigger swings, squeeze sinks and thumbstick leans as they are used and turn blue while pressed (on a gamepad with the `xr-standard` mapping; other mappings leave the parts at rest), and each tracked hand as a sphere per joint (sized by the joint radius WebXR reports) and a cylinder per bone. The models are core meshes and need no files. A source whose `skipRendering` is true (the system draws it) is hidden. The models are made in the scene the XR is in, whichever scene is active when a frame arrives, and are disposed with that scene.

```ts
import {Engine} from 'margoengine/core';
import {XR} from 'margoengine/xr';
import {XRModels} from 'margoengine/xr/models';

const canvas=document.createElement('canvas');document.body.append(canvas);
const engine=await Engine.create(canvas,{backend:'webgpu'});
const xr=await XR.create(engine);
const models=XRModels.attach(xr,engine,{handColor:'#d8b49a'});
const enter=document.createElement('button');enter.textContent='Enter VR';document.body.append(enter);
enter.onclick=()=>void xr.requestSession('immersive-vr',{optionalFeatures:['hand-tracking']}).catch(engine.onError);
// models.dispose() removes the meshes.
```

For a device's own model, serve the [WebXR input profile assets](https://github.com/immersive-web/webxr-input-profiles) and call `fetchProfile(source, baseUrl)`: it picks the most specific listed profile and gives its layout and model URL. `componentStates(layout, controller)` and `responseWeight(response, state)` give each node's weight for the layout's visual responses each frame. `xr.onFrame(callback)` runs a function every XR frame, before the session's own `onFrame`.

## AR planes, depth and light

`@margoengine/xr/ar` reads what an AR device knows about the room, each in the session's reference space. Ask for the features when the session starts; `init` passes module options such as `depthSensing` through to `navigator.xr.requestSession`.

- `ARPlanes.create(xr, { onAdd, onChange, onRemove, show })` follows `frame.detectedPlanes`: each plane's pose (its y axis is the normal), outline, orientation and label, and with `show` a flat mesh per plane.
- `ARDepth.create(xr)` reads CPU depth: `depthAt(frame, view, x, y)` in metres at a point of the view (0 to 1 from the top left) and `pointAt(...)` the real-world point there.
- `await ARLight.create(xr, { lighting: engine.lighting })` turns the room's light estimate into `estimate` (spherical harmonics in `@margoengine/math` SH3 order, the brightest light's direction and colour) and points the engine's sun at the room's brightest light, with the ambient set to the room's average light.

```ts
import {Engine,PbrMaterial} from 'margoengine/core';
import {XR} from 'margoengine/xr';
import {ARDepth,ARLight,ARPlanes,DEPTH_SENSING} from 'margoengine/xr/ar';

const canvas=document.createElement('canvas');document.body.append(canvas);
const engine=await Engine.create(canvas,{backend:'webgpu'});
const xr=await XR.create(engine);
const enter=document.createElement('button');enter.textContent='Enter AR';document.body.append(enter);
enter.onclick=async()=>{
  await xr.requestSession('immersive-ar',{optionalFeatures:['plane-detection','depth-sensing','light-estimation'],init:{depthSensing:DEPTH_SENSING}});
  const planes=ARPlanes.create(xr,{show:{engine,material:new PbrMaterial({color:'#4f9be8'})},onAdd:(plane)=>console.log('plane',plane.label)});
  const light=await ARLight.create(xr,{lighting:engine.lighting});
  const depth=ARDepth.create(xr);
  xr.onFrame(({frame,viewer})=>{const view=viewer?.views[0];if(view)console.log(depth.depthAt(frame,view,0.5,0.5));});
  // planes.dispose() and light.dispose() stop them.
};
```

Each `create` throws a coded error naming the feature to ask for when the session lacks it.

## AR occlusion by real depth

`@margoengine/xr/occlusion` hides the scene where the real world is in front of it, so a virtual box behind a real chair disappears behind the chair. It reads the session's depth sensing each frame and runs one full-screen pass per eye after the scene draws, on both XR routes and on the WebGL2 layer.

- CPU-optimized depth (`DEPTH_SENSING`, `float32`, `unsigned-short` or `luminance-alpha`) is uploaded to a small texture each frame; GPU-optimized depth (`usagePreference: ['gpu-optimized']`, `float32` or `unsigned-short`) is read where the browser leaves it, with no copy.
- Each drawn sample of the eye's depth becomes a point, carried into the depth sensor's own view (its pose and projection when they differ from the eye's), and compared with the real depth there. Pixels with no depth (0, invalid) hide nothing.
- `feather` (metres, default `0.05`) fades a surface from shown to hidden around equal depth, which hides the sensor's noise along the contact line; `0` gives a hard edge. `enabled = false` skips the pass.
- Content that writes no depth has nothing to compare and is kept: a `Line` needs `depthWrite: true` to be hidden. A pixel with colour but no depth sample of its own (the antialiased fringe of a line or an edge) takes its neighbours' verdict.

```ts
import {Engine,PbrMaterial,box} from 'margoengine/core';
import {XR} from 'margoengine/xr';
import {DEPTH_SENSING} from 'margoengine/xr/ar';
import {AROcclusion} from 'margoengine/xr/occlusion';

const canvas=document.createElement('canvas');document.body.append(canvas);
const engine=await Engine.create(canvas,{backend:'webgpu'});
engine.createMesh().setGeometry(box(0.3,0.3,0.3)).setMaterial(new PbrMaterial({color:'#e8a04f'})).setPosition([0,0,-1.5]);
const xr=await XR.create(engine);
const enter=document.createElement('button');enter.textContent='Enter AR';document.body.append(enter);
enter.onclick=async()=>{
  await xr.requestSession('immersive-ar',{requiredFeatures:['depth-sensing'],init:{depthSensing:DEPTH_SENSING}});
  const occlusion=AROcclusion.create(xr,{feather:0.05});
  // occlusion.enabled=false shows the scene over everything again; occlusion.dispose() stops it.
};
```

`AROcclusion.create` throws `state` without a session and `unsupported` when the session has no depth sensing, or has GPU depth in `luminance-alpha`, which WebGPU cannot read. Tested with stand-in sessions on real GPUs (`npm run test:gpu:occlusion`); not yet run on an AR device.

## AR reflections from the room's light

`@margoengine/xr/reflection` turns the room's light estimate into a cube texture, which an `Environment` from `@margoengine/environment` filters into the scene's specular reflections and diffuse harmonics, so a shiny virtual object reflects the room it sits in. Start the session with `light-estimation`.

- `ARReflection.create(xr, { device })` follows the browser's light probe. Where the WebGPU binding gives the probe's reflection cube map (`getReflectionCubeMap`, the `reflectionchange` event of the WebXR Lighting Estimation API), that texture is copied into the cube; everywhere else the cube is painted from the probe's nine spherical harmonics, a soft room of bands 0 to 2 (Ramamoorthi and Hanrahan, 2001).
- Options and defaults: `size` 32 (power of two, 8 to 256; the harmonics path), `reflectionFormat` `'rgba16f'`, `interval` 500 ms between harmonics repaints, `forceSH` false, `light` (an `ARLight` to share; one is made otherwise).
- `await reflection.ready` gives the cube texture after the first estimate; make the `Environment` from it and `reflection.attach(environment)` so it is refreshed after each repaint.

```ts
import {Engine} from 'margoengine/core';
import {Environment} from 'margoengine/environment';
import {XR} from 'margoengine/xr';
import {ARReflection} from 'margoengine/xr/reflection';

const canvas=document.createElement('canvas');document.body.append(canvas);
const engine=await Engine.create(canvas,{backend:'webgpu'});
const xr=await XR.create(engine);
const enter=document.createElement('button');enter.textContent='Enter AR';document.body.append(enter);
enter.onclick=async()=>{
  await xr.requestSession('immersive-ar',{requiredFeatures:['light-estimation']});
  const reflection=await ARReflection.create(xr,{device:engine.gpu,size:32});
  const cube=await reflection.ready;
  const environment=await Environment.create(engine,{texture:cube},{size:cube.width});
  engine.use(environment);
  reflection.attach(environment);
  // reflection.dispose() stops it.
};
```

Tested with stand-in sessions on real GPUs (`npm run test:gpu:reflection`); not yet run on an AR device.

## Layers, haptics, video and locomotion

`@margoengine/xr/layers` adds WebXR composition layers, controller vibration and teleport movement. Layers are drawn by the headset's compositor at their own resolution, so text and video stay sharp. Ask for `optionalFeatures: ['layers']`.

- `XRLayers.attach(xr)` then `quad`, `cylinder`, `equirect`, `cube` or `video(element)`: each takes `pixels`, a placement and `content` (an image, a `{left, right}` pair, six cube faces, or a function that draws into each eye's texture). Quads, cylinders and video sit above the scene, equirect and cube skies below it; `isStatic: true` draws once until `redraw()` or the compositor asks. A video or `VideoFrame` as `content` in a browser that takes no video as a copy source (Firefox) is drawn on a canvas each frame and copied from there.
- Every layer also takes `quality` (`'default'`, `'text-optimized'` or `'graphics-optimized'`, what the compositor favours when it resamples), `blendTextureSourceAlpha` (default true), `chromaticAberrationCorrection` and `mipLevels` (default 1); each is left to the browser when you do not pass it. Use `quality: 'text-optimized'` for menus and captions.
- `pulse(controller, intensity, milliseconds)` vibrates a controller and resolves false when it has no actuator.
- `teleportArc(origin, direction, options)` samples the parabola a teleport pointer draws and where it lands; `Locomotion.attach(xr)` moves the player there with `teleport(point, yaw)` and turns with `turn(yaw)`, by offsetting the reference space.

```ts
import {Engine} from 'margoengine/core';
import {XR} from 'margoengine/xr';
import {Locomotion,XRLayers,pulse,teleportArc} from 'margoengine/xr/layers';

const canvas=document.createElement('canvas');document.body.append(canvas);
const engine=await Engine.create(canvas,{backend:'webgpu'});
const xr=await XR.create(engine);
const menu=new OffscreenCanvas(512,256);const pen=menu.getContext('2d')!;pen.fillStyle='#223';pen.fillRect(0,0,512,256);pen.fillStyle='#fff';pen.font='48px sans-serif';pen.fillText('Hello',40,140);
const enter=document.createElement('button');enter.textContent='Enter VR';document.body.append(enter);
enter.onclick=async()=>{
  await xr.requestSession('immersive-vr',{optionalFeatures:['layers']});
  const layers=XRLayers.attach(xr);
  layers.quad({pixels:[512,256],size:[1,0.5],position:[0,1.5,-1.5],content:menu,isStatic:true});
  const move=Locomotion.attach(xr);
  xr.onFrame(({inputs})=>{
    const c=xr.controllers[0],ray=c?.targetRay;if(!ray)return;
    const p=ray.transform.position,m=c.targetRayMatrix;
    const arc=teleportArc([p.x,p.y,p.z],[-m[8],-m[9],-m[10]]);
    if(arc.hit&&c.buttons[1]){move.teleport(arc.hit);void pulse(c,0.6,40);}
  });
};
```

Without the browser's layer support `XRLayers.attach` and each layer throw a coded error that names the feature to ask for.

## Session state: blend mode, frame rate, visibility and play area

`@margoengine/xr/session` reads and follows what the WebXR session says about the display and the room, with no rendering of its own.

- `XRSessionState.attach(xr, { signal })` gives `environmentBlendMode` (`'opaque'`, `'additive'` or `'alpha-blend'`), `interactionMode`, `visibility` (`'visible'`, `'visible-blurred'` while a system menu is up, `'hidden'`) with `onVisibilityChange(callback)`, and `frameRate`.
- `supportedFrameRates` lists the rates the device accepts and `await setFrameRate(rate)` asks for one; a rate not in the list throws a `RangeError`, and a browser without frame rate control rejects with an `unsupported` error.
- `bounds` is the play area of a `referenceSpace: 'bounded-floor'` session as x and z metres per corner (null otherwise), and `onReset(callback)` runs when the space resets, so you can read `bounds` again.

```ts
import {Engine} from 'margoengine/core';
import {XR} from 'margoengine/xr';
import {XRSessionState} from 'margoengine/xr/session';

const canvas=document.createElement('canvas');document.body.append(canvas);
const engine=await Engine.create(canvas,{backend:'webgpu'});
const xr=await XR.create(engine);
const enter=document.createElement('button');enter.textContent='Enter VR';document.body.append(enter);
enter.onclick=async()=>{
  await xr.requestSession('immersive-vr',{referenceSpace:'bounded-floor',optionalFeatures:['bounded-floor']});
  const state=XRSessionState.attach(xr);
  const fastest=state.supportedFrameRates.at(-1);
  if(fastest&&fastest!==state.frameRate)await state.setFrameRate(fastest);
  state.onVisibilityChange((visibility)=>console.log('session is',visibility));
  console.log(state.environmentBlendMode,state.frameRate,state.bounds);
  // state.dispose() stops it.
};
```

Tested with stand-in sessions; not yet run on a headset.

## Smooth movement, skinned hands, AR extras and performance

Four more entries are separate imports, so a page that does not use them does not load them. Each attaches to a running session and stops when the session ends or its `AbortSignal` aborts.

- `@margoengine/xr/locomotion` adds `SmoothLocomotion.attach(xr, options)`: thumbstick walking and smooth turning next to the teleport and snap turn of `Locomotion`, with a vignette that fades in while you move (`vignette: false` turns it off; `comfort` reads its strength). Options and defaults: `speed` 2 (metres per second), `turnSpeed` `Math.PI / 2` (radians per second), `moveHand` `'left'`, `turnHand` `'right'`, `direction` `'head'`, `deadZone` 0.15, `axes` `[2, 3]`, `fieldOfView` `Math.PI / 2`, `feather` 0.2 and `fade` 0.15. Set `enabled = false` to pause it.
- `@margoengine/xr/hands` adds `SkinnedHands.create(xr, {left, right}, options)`, which drives your own skinned glTF hand models from the 25 tracked joints (`HAND_JOINT_NAMES` lists them). It keeps each asset's inverse binds and weights and loads `@margoengine/animation` when you call it. `jointNames` maps WebXR joint names to your node names when they differ from the generic-hand profile names. Pass at least one model, and not the same model for both hands.
- `@margoengine/xr/ar-extra` adds `DOMOverlay` (with `domOverlaySessionOptions(root)` for the session request), `ImageTracking` (with `imageTrackingSessionOptions(images)`), `MeshDetection` for the room's triangle meshes, which can draw them as Margo meshes through its `show` option, and `PersistentAnchors`, whose handles belong to the browser and the origin until you delete them. Each needs its WebXR feature in the session and rejects with an `unsupported` error naming what is missing.
- `@margoengine/xr/performance` adds `performanceSessionOptions({framebufferScale, cameraAccess})` for the session request and `XRPerformance.attach(xr, {fixedFoveation, signal})` for a live foveation setting (0 to 1) that is restored when the session ends or the signal aborts. Camera images are a borrowed WebGL texture, valid only inside their XR frame; native WebGPU raw camera access rejects with the capability reason.

## Interaction toolkit

`Interaction.attach(xr, { grabbables, sockets, panels })` from `@margoengine/xr/interaction` handles the usual hand and controller interactions. Squeeze (or pinch, on a tracked hand) near an object or with the ray on it to pick it up; it follows the grip as you hold it. Let go over a socket that fits and it snaps in; otherwise `onRelease` gets its speed for a throw. Point the ray at a panel and press the trigger (or pinch) for `down` and `up`, with `u` and `v` from the panel's top left. The arrays stay live: push or remove items at any time.

```ts
import {Engine,PbrMaterial,box as boxGeometry} from 'margoengine/core';
import {Quaternion} from 'margoengine/math/quaternion';
import {Vector3} from 'margoengine/math/vector3';
import {XR} from 'margoengine/xr';
import {Interaction,grabbable} from 'margoengine/xr/interaction';

const canvas=document.createElement('canvas');document.body.append(canvas);
const engine=await Engine.create(canvas,{backend:'webgpu'});
const xr=await XR.create(engine);
const box=engine.createMesh().setGeometry(boxGeometry()).setMaterial(new PbrMaterial({color:'#e8a33d'})).setScale([0.1,0.1,0.1]).setPosition([0,1,-0.5]);
const cube=grabbable(box,{radius:0.08});
const shelf={position:new Vector3(0.3,1,-0.5),orientation:new Quaternion(),radius:0.1,held:null};
const button={position:new Vector3(0,1.4,-1),orientation:new Quaternion(),size:[0.3,0.1] as const,onPointer:(e:{type:string})=>{if(e.type==='up')console.log('clicked');}};
const ui=Interaction.attach(xr,{grabbables:[cube],sockets:[shelf],panels:[button]});
const enter=document.createElement('button');enter.textContent='Enter VR';document.body.append(enter);
enter.onclick=()=>void xr.requestSession('immersive-vr',{optionalFeatures:['hand-tracking']}).catch(engine.onError);
// ui.rays[i] tells where each ray points, for drawing a pointer; ui.dispose() lets go of everything.
```

## Preview tier refusal

`XR.create` and `XR.attach` reject the small WebGL2 preview with linked `MargoError` code `unsupported`, so an awaited call inside `autoEngine` setup can trigger `loadCompat`. After installing the full layer, WebXR also needs its `/xr` route and browser session support as documented above. An already attached or disposed engine remains a state error.

## Mesh pointer events

`XRPointerEvents` from `@margoengine/xr/pointer` sends `pointerover`, `pointerout`,
`pointermove`, `pointerdown`, `pointerup`, `pointercancel` and `click` to selection
hits on any supported mesh or glTF primitive. `SpatialPicking` from
`@margoengine/selection/spatial` supplies GPU ray picking and exact triangle
proximity. A source has one stable pointer id. Touch wins over grab, then ray;
`types` can change that order or disable modes. Capture keeps the selected target
through a miss. Session end, source removal, tracking loss and disposal cancel a
press. Pending picks retain pose snapshots and press/release ordering; moves
coalesce. Native select/squeeze events support sources without gamepads.

Copy `packages/exporters/tests/fixtures/Box.glb` to your app's
`public/xr-pointer-box.glb` before running this example. The README gate serves
that exact licensed fixture at the same URL.

```ts
import { Engine } from '@margoengine/core';
import { loadGLTF } from '@margoengine/gltf/pbr';
import { Picking } from '@margoengine/selection';
import { SpatialPicking } from '@margoengine/selection/spatial';
import { XR } from '@margoengine/xr';
import { XRPointerEvents } from '@margoengine/xr/pointer';

const canvas = document.createElement('canvas'); document.body.append(canvas);
const engine = await Engine.create(canvas, { backend: 'webgpu', camera: { position: [0, 0, 4] } });
await loadGLTF(engine, '/xr-pointer-box.glb');
const picking = Picking.attach(engine);
const spatial = new SpatialPicking(engine, picking);
const xr = await XR.create(engine);
const pointers = XRPointerEvents.attach(xr, spatial, {
  onEvent(event) { if (event.type === 'click') console.log(event.target, event.pointerType); },
  onError: engine.onError,
});
const enter = document.createElement('button'); enter.textContent = 'Enter VR'; document.body.append(enter);
enter.onclick = () => void xr.requestSession('immersive-vr', { optionalFeatures: ['hand-tracking'] }).catch(engine.onError);
engine.start();
// On teardown: pointers.dispose(); spatial.dispose(); picking.dispose(); xr.dispose(); engine.dispose();
```

The sample model is Cesium's Khronos Box, CC BY 4.0; see
[its fixture notice](../exporters/tests/fixtures/NOTICE.md). Serve this repository
or copy that standard asset to your application's public folder.

Distances are metres: `touchRadius` defaults to 0.01 in addition to the reported
fingertip radius, `grabRadius` to 0.08, `near` to 0.0001 and `far` to 1000. Pinch
uses a 0.025 metre thumb/index-tip threshold. Controller trigger selects; squeeze
grabs. Touch presses on surface contact and releases/clicks on leaving it. A
held pointer keeps its mode through release. `signal` aborts the attachment;
`dispose()` and `Symbol.dispose` detach it. `onError` is required. `onEvent` may
call `stopPropagation` and `setPointerCapture(target?)`, `releasePointerCapture`
or `hasPointerCapture`; the optional target lets a parent capture a child hit.
A custom picker can implement the exported `XRPointerPicker` interface.

React apps mount `XRPointerEvents` from `@margoengine/react/xr-pointer` inside
`Canvas` and `XR`; existing mesh handlers receive the events with the source and
selection hit at `event.xr`. See that package's example. These deterministic and
browser checks do not replace the still-missing physical device runs.

`npm run test:gpu:pointers --workspace @margoengine/xr` is registered in the GPU
package plan and check:merge, with a 3 minute hard limit. Pass `-- --compat` for
the WebGL2 implementation. The dedicated compatibility XR bridge suite remains
packages/webgl2-compat/test/xr-browser.mjs.

### Attaching from a second scene

`XR.create` remembers the scene that is active when you call it, before its first await, and joins that scene when it finishes. Start it inside a second scene's plugin `setup` and the plugin belongs to that scene; start it anywhere else and it belongs to the default scene. An abort or a failure leaves nothing in either scene.
