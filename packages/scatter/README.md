# @margoengine/scatter

`randomPlacements(count, bounds, [minScale,maxScale], seed)` generates seeded
rectangle candidates. `radialPlacements(centers, perCenter, [minDistance,maxDistance],
[minScale,maxScale], seed)` generates candidates around world XZ anchors. Both
produce `[x,z,scale,yaw]` tuples at initialization. Submit them to a shared
`PlacementLayout` to filter overlaps and reserve accepted footprints.

`instanceTransforms()` packs `[x,y,z,scale,yaw]` placements into affine matrices.
`groundTransforms(placements, height, offsetY)` accepts `[x,z,scale,yaw]`, samples
world height, and applies a vertical offset (negative values sink roots).
`placementBounds(placements,radius)` produces enclosing world XZ rectangles.
`clearPlacements(candidates,radius,exclusions,gap)` accepts rectangle exclusions
`[minX,minZ,maxX,maxZ]` and circle exclusions `[x,z,radius]`; the optional gap
defaults to 0. These initialization helpers preserve their inputs and validate
height samples, scales and exclusion data.

WebGPU seeded, stratified placement with density, world-height and slope rules. Compute culling packs instances into three distance LOD rings, followed by indexed indirect draws.

```ts
import {Scatter} from '@margoengine/scatter';
const scatter = Scatter.attach(engine, [nearGeometry, midGeometry, farGeometry], {
  count: 10000, area: [50,50], density: 0.8, maxSlope: 45, lod: [25,60,120], lodFade: 2
});
```

A single Geometry can be supplied for all rings; the package does not auto-decimate meshes. heightmap returns a sampleable red-channel height texture covering area around center. Heights are world units plus center Y; absent heightmap is flat. Rules are fixed at construction and distribution is evaluated on GPU each frame. Output uses random Y rotation and scale with a simple diffuse material. Three storage buffers reserve count instances each, so account for GPU memory; device limits are checked. No core geometry/material feature additions are needed.

The default LOD distances are `[25,60,120]` world units. `lodFade` defaults to a
2-unit overlap centered on each of the first two distances. Compute emits both
adjacent meshes inside that band; complementary 4x4 Bayer masks cross-fade them
in both diffuse and PBR rendering, without alpha blending or per-frame history.
The width is clamped to prevent overlapping bands. Identical adjacent Geometry
objects skip the extra draw instances. Set `lodFade: 0` for hard switches.
The third distance remains the culling boundary.

LOD meshes must use matching origins, scale and shading. For procedural rocks,
pass `true` as the third argument to `icosahedronGeometry(radius, detail, true)`
from `@margoengine/geometry`, including at detail 0, and keep the same radius in
every ring. Scatter preserves authored normals and does not rescale assets.

Supply `material: new PbrMaterial(...)` to shade the GPU-distributed instances
with the engine's PBR shader and receive any attached PCSS shadows. This preserves
the same GPU placement/culling and three indirect LOD draws. Material values are
uploaded through a retained uniform each frame. Opaque scatter draws before sky
and water, so water refraction and depth occlusion include grass and rocks.

Both `ScatterOptions` and `ScatterBatch` accept `wind: [directionX, directionZ,
strength]`, where direction is nonzero and strength is 0–1. Omit it for static
geometry. Rooted GPU bends vary by world position and time, and normals follow
the deformation. Grass LODs use identical motion; fixed instance shadows use the
same bend and clock in every cascade. Use `shadows.add(instances)` for moving
vegetation, without the static-shadow option. Cull bounds include wind movement.
Use upright vegetation whose local origin is its ground root. This is a lightweight
whole-plant bend. Fixed `ScatterBatch` can additionally set `windDetail: 1` (0–1)
for faster branch/foliage ripple. Radial stiffness anchors the trunk and plant
center, while two detail frequencies vary across each plant. Normals use the
deformation's analytic inverse Jacobian, and all shadow cascades share the same
deformation. Omit detail for the original sway. This approximation has no branch
skeletons, individual leaf simulation or collision deformation.

For fixed placement with the engine's PBR lighting and PCSS shadows, use the
separate `ScatterInstances` export:

```ts
import {ScatterInstances} from '@margoengine/scatter';
const instances = ScatterInstances.attach(engine, () => generateBatches());
shadows.add(instances, {static: true});
```

Each `ScatterBatch` supplies an 80-byte `vertices` stream, Uint32 `indices`,
column-major affine `transforms` (16 floats per instance), a `PbrMaterial`, and
a diagnostic `name`. Vertex RGB at byte offset 64 multiplies the instance albedo;
vertex alpha at byte offset 76 controls ambient occlusion, independently of direct
light, emission and opacity. `pbrVertexStream(data, occlusion)` from geometry packs
this layout. Old manually packed RGB occlusion must move to alpha to retain the
intended ambient-only effect. The factory runs at initialization and device restoration.
Geometry and transforms are uploaded and not retained on the JavaScript heap;
the factory must regenerate them instead of closing over large arrays. Each
material batch uses one indexed indirect draw, including in every shadow cascade.
The internal instance stream is 128 bytes, including HDR emission and wind data.
This fixed path renders all instances; use the existing GPU LOD path for large
distance-culled populations. The gameplay sandbox demonstrates both paths.

For collision-free ground decoration, use one shared occupancy layout before
packing transforms:

```ts
import {PlacementLayout, Scatter} from '@margoengine/scatter';
import {footprintRadius} from '@margoengine/geometry';
const layout = new PlacementLayout(buildingFootprints);
const rocks = layout.place(rockCandidates, footprintRadius(rockMesh));
const ferns = layout.place(fernCandidates, footprintRadius(fernMesh));
const bushes = layout.place(bushCandidates, footprintRadius(bushMesh));
Scatter.attach(engine, islandRockGeometry, {exclusions: layout.exclusions});
```

Building footprints are world-space `[minX, minZ, maxX, maxZ]` rectangles.
Submit each asset family to the same layout. Every accepted scaled footprint
automatically reserves space, so subsequent placements cannot overlap buildings,
previous assets or each other. A 30 cm gap applies by default; rejected candidates
are omitted. The layout snapshots building bounds, preserves candidate order and
does not mutate inputs. It is initialization-only CPU work for small populations.
Scenes supply geometry/coordinates and register existing buildings in the layout.

GPU `Scatter` accepts the layout's `exclusions` or an explicit rectangle array.
It rejects whole scaled bounding spheres intersecting a rectangle before emitting
any LOD. The largest LOD's bounds include geometry offsets from its origin.
Exclusions are validated and uploaded once per device, with no frame-time CPU
collision arrays. Rules remain fixed at construction. Footprints are conservative
XZ bounds; increase their clearance to reserve paths or porches.

For a single population, `spacePlacements` also filters ground placements:

```ts
import {spacePlacements} from '@margoengine/scatter';
const placements = spacePlacements(candidates, meshFootprintRadius, 0.3);
```

Candidates are `[x, z, uniformScale, yaw]` tuples. Supply the mesh's maximum XZ
radius about the instance origin. Each pair retains at least the requested gap
between its scaled footprints (30 cm by default). The deterministic filter keeps
candidate order and references, and leaves the input unchanged. Terrain height
and the supplied obstacle bounds belong to the scene. `clearPlacements` filters
against explicit rectangles or `[x, z, radius]` circles; `placementBounds` encloses
scaled footprints for GPU exclusion. `groundTransforms` samples a heightfield
once and packs flat transforms with an optional root-sinking Y offset.
This quadratic CPU filter is for small initialization sets; use GPU `Scatter`
for large distributed populations.

MIT. Optional, tree-shakable package; core peer: ^0.1.0 || ^1.0.0.

Build and unit tests: npm test --workspace @margoengine/scatter

Fixed `ScatterInstances` batches accept `emissive: [r, g, b]` in linear HDR.
Emission defaults to zero and is added after PBR lighting, shadows and baked
occlusion; for example `[3, 2.16, 0.9]` makes a warm window bloom with optional
`@margoengine/post`. Emission uploads with the batch and survives device restoration.
`instances.emissiveIntensity` multiplies every batch's emission without replacing
geometry or transforms. It defaults to 1 and accepts a nonnegative finite number
or a callback sampled each render, such as `() => sky.nightFactor` for night lights.
The value must fit a GPU float; the callback remains installed after restoration.

Real WebGPU LOD, diffuse/PBR fade-mask and device-restoration checks:
`npm run test:browser --workspace @margoengine/scatter` (build geometry/core first).

