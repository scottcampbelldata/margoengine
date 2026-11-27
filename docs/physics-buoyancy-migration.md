# Migrate buoyancy to Margo Physics

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
