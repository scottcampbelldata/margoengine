# @margoengine/shadows

Cascade descriptors, attachments and matrix views are retained between frames.
Custom `drawShadow` callbacks receive a borrowed context reused for that cascade;
consume it synchronously rather than retaining it after the pass.

Optional WebGPU directional shadows. Four practical/logarithmic frustum splits render to a `depth32float` 2D texture array. Stable spherical extents and world-space texel snapping limit edge swimming. PCSS searches 16 blockers and filters 32 comparison samples using directional-light angular size and blocker/receiver separation.

```ts
import {EngineKernel,box} from '@margoengine/core';
import {Shadows} from '@margoengine/shadows';
const engine = await EngineKernel.create(document.querySelector<HTMLCanvasElement>('#viewport')!, {backend:'webgpu'});
const terrain = engine.createMesh().setGeometry(box()).setScale([100,1,100]);
const character = engine.createMesh().setGeometry(box()).setPosition([0,2,0]);
const shadows = Shadows.attach(engine, {resolution:2048, distance:500, lambda:0.5, lightSize:0.02});
shadows.add(terrain, {static:true});
const removeCharacter = shadows.add(character);
engine.start();
// removeCharacter() when unloading; engine.dispose() releases attached plugins.
```

`lambda:0` gives uniform splits; `lambda:1` gives logarithmic splits. `lightSize` is the tangent of the sun's angular radius; `bias` is normalized depth and `normalBias` is world distance. `casterMargin` extends the depth bounds to include casters outside the camera slice. Shadows follow the engine's directional light.

Core meshes receive shadows automatically. `shadows.add(pbrModel)` also adds its lighting hook and reads the current deformed vertex buffer after the animation compute pass. Alpha-masked PBR casters honor their base map, vertex alpha, UV set and cutoff; blended casters are omitted. `shadows.add(clipmapTerrain)` uses its GPU height sampling for depth and its lighting hook for reception. Custom sources can implement `drawShadow(ShadowContext)`.

Static geometry renders into a cached depth array. Each frame copies that array and adds dynamic casters, so dynamic geometry cannot overwrite the cache. Cache invalidation occurs when snapped cascade matrices, clipmap origins, source membership, disposal or device change. Call `invalidate()` after moving/hiding a static mesh, editing its geometry/material, or changing a height texture. Moving the camera far enough to move a cascade rerenders static geometry. No fixed draw-call reduction is promised. `stats` reports static/dynamic primitive draws and cache hits; custom sources record their own draws.

At resolution 2048, the two four-layer maps occupy 128 MiB. Choose smaller maps for constrained devices. All resources are released by `dispose()`/`destroy()` and recreated after device restoration. `cascadeSplits()` and `fitCascades()` are exported for custom cameras. The package has no core/stage imports from other feature packages and does not enter their base bundle.
