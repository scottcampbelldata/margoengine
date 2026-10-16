# @margoengine/animator

Optional gameplay animation on the existing `@margoengine/animation` skinning pass. Named states select clips, 1D trees interpolate neighboring samples, and 2D trees use normalized inverse-square distance weights with exact sample reproduction. State transitions crossfade a captured pose into the destination. Masked additive layers apply translation/scale/quaternion and morph deltas relative to a sampled reference pose.

```ts
import {EngineKernel} from '@margoengine/core';
import {loadGLTF} from '@margoengine/gltf-pro';
import {Animation} from '@margoengine/animation';
import {Animator} from '@margoengine/animator';
const engine = await EngineKernel.create(document.querySelector<HTMLCanvasElement>('#viewport')!, {backend:'webgpu'});
const model = await loadGLTF(engine, '/hero.glb'); // clips named Idle, Walk, Run
const animation = Animation.attach(model);
const animator = Animator.attach(animation, {
  initial:'locomotion', parameters:{speed:0},
  states:{
    locomotion:{parameter:'speed', samples:[{value:0,clip:'Idle'},{value:1,clip:'Walk'},{value:3,clip:'Run'}]},
    idle:'Idle'
  },
  transitions:[{from:'locomotion',to:'idle',when:p=>p.speed<0,duration:0.15}]
});
animator.parameters.speed = 2;
engine.start();
```

For a 2D state use `{parameters:['strafe','forward'],samples:[{value:[0,0],clip:'Idle'},...]}` with unique coordinates. Parameters default to zero. 1D samples must be strictly increasing. Clips loop independently in seconds. `transition(state,duration)` switches states explicitly; predicates are evaluated in declaration order, at most once per frame. Add a layer with `addLayer({clip:'Aim',weight:0.5,mask:[upperBodyNodeIndex,...]})`. Masks use glTF node indices. The returned function removes the layer; mutable weights are validated each frame. `referenceTime` defaults to zero.

`addFootIK({hip,knee,ankle,pole,raycast,offset,probeHeight})` requires a direct three-node leg chain. The callback receives a world-space origin above the current ankle and a downward ray. Return `{position,normal?}` or `null`; supply terrain collision data or an existing BVH. For `AssemblyBVH`, adapt its result with `hit ? {position:hit.point} : null`. Normals align the ankle's local +Y with the terrain. Bones/ancestors require positive uniform scales. Unreachable targets clamp to the leg's reach; the pole chooses the knee bend direction. `solveTwoBoneIK()` is also exported as a standalone analytical solver.

Animator owns pose playback while attached: it pauses `Animation`, updates node transforms/morph weights before world-matrix evaluation, and lets that same animation pass write its existing bone palette storage buffer and deform vertices. There is no second skinning buffer or pass. Attach `Animation` first. Unloading the model removes both plugins; disposing the animator restores the prior playback flag. Removing Animation also removes its animator on the next update. GPU restoration retains gameplay state. Core/stage stay frozen.

## Explicit rotation writer

`AnimatorOptions.writeRotation?: (node: Mesh, rotation: readonly number[]) => void` is an optional, explicit commit hook for applications that own their transform writer. It is captured and validated once during construction. Omit it to keep the current dynamic `Mesh.setQuaternion` call, including method overrides. This is an additive public API option; it does not change core/stage.

The hook receives the actual destination mesh and a borrowed normal JavaScript array for both sampled/blended local poses and FootIK corrections. Commit synchronously, validate finite Float32-representable and nonzero quaternion values, normalize using the application's required numeric behavior, and synchronize the mesh's quaternion and XYZ Euler state. Do not mutate or retain the borrowed array, change Animator/model structure from the callback, or reenter pose evaluation. Recursive `onPreUpdate` from a writer throws before changing update state. A thrown writer does not advance the successful rotation cache; previously successful position/scale writes keep their existing partial-update behavior. The next update compares against that earlier successful cache. If a writer restores exactly the earlier accepted quaternion/Euler state before throwing, an unchanged request can legitimately skip another callback, matching the default setter path. Throws do not guarantee callback reinvocation.

Cached unchanged rotations skip the hook, just as they skip the default setter. It is not a per-frame notification or a generic purity guarantee. Construct a stable writer outside the frame loop. Default mesh setter behavior for caller-owned typed arrays is unchanged. An opted-in application is responsible for writer correctness; a hook that ignores validation or does not commit state violates this contract. No allocation-free or whole-scene performance guarantee follows from supplying a callback.
