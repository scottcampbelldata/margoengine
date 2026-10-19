# @margoengine/shadows

Cascade descriptors, attachments and matrix views are retained between frames.
Custom `drawShadow` callbacks receive a borrowed context reused for that cascade;
consume it synchronously rather than retaining it after the pass.

Optional WebGPU directional shadows. Four practical/logarithmic frustum splits (fewer with `cascades`) render to a `depth32float` 2D texture array. Stable spherical extents and world-space texel snapping limit edge swimming. PCSS searches 16 blockers and filters 32 comparison samples using directional-light angular size and blocker/receiver separation. The samples follow a golden-angle spiral that each pixel turns by interleaved gradient noise of its screen position, so penumbrae show fine noise instead of steps; there is no time term, so a still view renders the same pixels every frame. The last tenth of each cascade's depth range dithers into the next cascade with a second noise pattern, so a cascade switch shows no hard seam and still costs one map lookup per tap.

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

`filter` picks the edge: `'soft'` (default) is the PCSS above; `'pcf'` takes four hardware comparison taps half a texel apart (each is the sampler's own 2x2 bilinear comparison, together a smooth edge about three texels wide) with no blocker search and no spiral, for phones and light tiers; `'hard'` takes one tap. `cascades` (1-4, default 4) renders fewer layers: fewer depth passes per frame, coarser texels over the same `distance`; `bounds` always uses one map. `@margoengine/quality` sets `filter:'pcf'` on its light and phone tiers and `cascades:2` on phones when the app leaves them unset.

`lambda:0` gives uniform splits; `lambda:1` gives logarithmic splits. `lightSize` is the tangent of the sun's angular radius; `bias` is normalized depth and `normalBias` is world distance. `casterMargin` extends the depth bounds to include casters outside the camera slice. Shadows follow the engine's directional light.

Core meshes receive shadows automatically. `shadows.add(pbrModel)` or `shadows.add(loadedMesh)` adds the owning model's lighting hook and reads current stride-80 buffers after animation compute. Registering both draws each primitive once; a dynamic registration takes precedence over a cached registration. Removing one registration preserves the remaining lighting hook. Alpha-masked PBR casters honor their base map, vertex alpha, UV set, texture transform and cutoff; blended casters are omitted. No duplicate core geometry is created. `shadows.add(clipmapTerrain)` uses its GPU height sampling for depth and its lighting hook for reception. Custom sources can implement `drawShadow(ShadowContext)`.

Per object, as Crocotile's Cast Shadows and Receive Shadows (both default on): `shadows.add(source, {castShadow: false})` lights the object with the shadow map but leaves it out of the map, and `{receiveShadow: false}` draws it into the map but keeps its own lighting unshadowed (no lighting hook is added). Receiving is per object for sources with their own lighting hook (glTF-pro models, materials meshes, clipmap terrain) and for core meshes: `receiveShadow: false` on a core mesh sets core's `mesh.receiveShadow = false` and the remover restores the earlier value. Setting `mesh.receiveShadow` directly works too, for meshes added or not:

```ts
shadows.add(groundTile);            // casts and receives
shadows.add(lamp, { receiveShadow: false }); // casts, lit as if unshadowed
marker.receiveShadow = false;      // same for any core mesh, next frame
```

While a core mesh opts out, core's shader patch keeps that mesh's direct light where it is shadowed (`select` on its instance factor); with none, the patch is the original text. To change either flag of another source, call the remover and add the object again.

Static geometry renders into a cached depth array. Each frame copies that array and adds dynamic casters, so dynamic geometry cannot overwrite the cache. Cache invalidation occurs when snapped cascade matrices, clipmap origins, source membership, disposal or device change. Call `invalidate()` after moving/hiding a static mesh, editing its geometry/material, or changing a height texture. Moving the camera far enough to move a cascade rerenders static geometry. No fixed draw-call reduction is promised. `stats` reports static/dynamic primitive draws and cache hits; custom sources record their own draws.

At resolution 2048, the two four-layer maps occupy 128 MiB. Choose smaller maps for constrained devices. All resources are released by `dispose()`/`destroy()` and recreated after device restoration. `cascadeSplits()` and `fitCascades()` are exported for custom cameras. The package has no core/stage imports from other feature packages and does not enter their base bundle.
