# Migrate buoyancy to Margo Physics

## From three.js's floating spheres in one call

The three.js GPGPU water examples (`webgl_gpgpu_water`, `webgpu_compute_water`) read the water's height under each
sphere back from the GPU and move the sphere toward it by hand: a sphere only, no volume, no righting, no drag, and the
height a frame late. In Margo the body keeps its own colliders and one call floats it on the water the camera draws:

```ts
// three.js: per sphere, per frame, the height read back under its centre and the sphere eased toward it.
// Margo: the body's own colliders, buoyancy from the displaced volume, drag and the righting moment, every step.
const loads = new LoadSolver();
const sea = seaSurface(ripples);
world.add(loads, { sea, bodies: await floating(physics, [ball, crate, boat], { sea }) });
```

- `seaSurface` (`@margoengine/water/sea-state`) turns the `Water`, `FFTOcean` or `Ripples` (`cpu: true`) you draw into
  the water the solver reads, on the CPU this frame with no readback; `ripples.disturbRay` is the pointer push, and
  `ripples.trackBody(body)` lets each floating body make its own ripples.
- `floating(physics, bodies)` reads each body's colliders: spheres, boxes, capsules, hulls, closed meshes, cylinders,
  cones and compounds all float, from their displaced volume, with drag and angular drag.
- `loads.debugRender()` with `PhysicsDebugView.add(...)` draws the waterline, the submerged edges, the centre of buoyancy
  and the load arrows. [Live example](../examples/floating.html),
  [README section](../packages/physics/README.md#float-any-body-in-one-call-floating)

## By hand: rows and shapes

The official three.js GPGPU water demo shows spheres floating on a pointer-disturbed surface.
Margo puts the buoyant force, righting torque and viscous drag into `LoadSolver`. For a scene
using Rapier or Ammo, keep the mass and collision dimensions when creating the Margo rigid body.
Connect its row and wetted geometry to `LoadSolver` and point the solver at the sea in world
coordinates. Remove the old application's buoyancy and drag forces so the rigid step applies each
force once. [Official GPGPU water demo](https://threejs.org/examples/webgl_gpgpu_water.html),
[Rapier rigid-body forces](https://rapier.rs/docs/user_guides/javascript/rigid_bodies/#forces-and-impulses)

For a Babylon scene, carry over the physics aggregate's mass and collider. Put its physical water
surface into `LoadSolver`, then set the water appearance on the renderer. Transfer the material's
visual bump, refraction and lighting settings there.
[Babylon Physics V2 bodies](https://doc.babylonjs.com/features/featuresDeepDive/physics/rigidBodies),
[Babylon WaterMaterial](https://doc.babylonjs.com/toolsAndResources/assetLibraries/materialsLibrary/waterMat)

Register `LoadSolver` once with every floating body's row and `shape`. Sphere, box and capsule
shapes take the dimensions of the corresponding rigid collider. A hull uses a closed triangulated
mesh. Use the same sea coordinates in the renderer and the loads solver.
[Runnable Physics quick start](../packages/physics/README.md#float-a-rigid-body),
[Live flotation example](https://margoengine.com/demos/buoyancy.html)

Enable **Show loads** in the flotation example to inspect the held upward load on each body in newtons and the
box's signed roll torque in newton-metres. The shared `PhysicsDebugView` draws the components from
`LoadSolver`'s published force rows at each body's centre of mass. The held load includes the solver's implicit
added-mass response. Read the arrow directions and numeric values as you scrub the example.
