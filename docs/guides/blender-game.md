# Build a small interactive game with Blender and Margo

A how-to for a small third-person game: you model the level and the character in Blender, export glTF, and write
the game in TypeScript with Margo's optional packages. The island demo
([`examples/gameplay-sandbox`](../../examples/gameplay-sandbox/README.md)) is the closest working example in this
repository; it builds its world procedurally instead of loading Blender files, so the loading, character, physics,
audio and navigation steps below go further than the demo does.

<!-- Every ```ts block in this file is type-checked against the built packages by tests/from-threejs-snippets.test.js.
     Snippets may use the ambient names engine, canvas, mesh and model. -->

## Contents

- [What you need](#what-you-need)
- [Export from Blender](#export-from-blender)
- [Blender as a level editor](#blender-as-a-level-editor)
- [Start the engine](#start-the-engine)
- [Load the level](#load-the-level)
- [Physics](#physics)
- [The character](#the-character)
- [Input](#input)
- [Camera](#camera)
- [Picking and ground snapping](#picking-and-ground-snapping)
- [Navigation for enemies](#navigation-for-enemies)
- [Many entities: ECS](#many-entities-ecs)
- [Sound](#sound)
- [Sky, water, light and post-processing](#sky-water-light-and-post-processing)
- [Quality tiers](#quality-tiers)
- [Deploying](#deploying)
- [What you build yourself](#what-you-build-yourself)
- [Measured numbers](#measured-numbers)

## What you need

- A browser with WebGPU. Everything in this guide needs it; the optional `@margoengine/webgl` fallback draws plain
  core meshes only (flat PBR, one light), so treat it as a basic preview, not a way to run the game.
- Blender 4.2 or later (the menu names below are from its built-in glTF 2.0 exporter).
- The packages are not on npm yet. Build them from source (`npm run build:packages` in this repository) and link
  them into your app, or work inside the repository's examples. Once published, a game like this one installs:

```sh
npm install @margoengine/core @margoengine/gltf-pro @margoengine/animation @margoengine/animator \
  @margoengine/input @margoengine/physics @dimforge/rapier3d-compat @margoengine/bvh @margoengine/cinematic \
  @margoengine/audio @margoengine/sky @margoengine/water @margoengine/shadows @margoengine/post @margoengine/quality
```

Add `@margoengine/navigation` (or `navmesh`), `@margoengine/ecs`, `@margoengine/decoders` and
`@margoengine/environment` only if you use them. Each package is separate and declares `sideEffects: false`, so your
bundle contains only what you import.

## Export from Blender

Use **File > Export > glTF 2.0 (.glb/.gltf)** with these settings:

| Setting | Value | Why |
| --- | --- | --- |
| Format | glTF Binary (.glb) | One file per level or character. |
| Include > Data > Custom Properties | On | Writes object custom properties to glTF `extras` (next section). Off by default. |
| Include > Data > Punctual Lights | On if you place lamps | Point and spot lamps arrive as `model.lights`; `model.clusteredLights()` feeds `@margoengine/clustered`. |
| Transform > +Y Up | On (the default) | Margo is Y-up, in meters. |
| Data > Mesh > Apply Modifiers | On | gltf-pro reads triangles only; modifiers are not evaluated at runtime. |
| Data > Mesh > UVs, Normals, Tangents | On | Materials may use two UV maps (gltf-pro rejects texture coordinate sets beyond the second). Without tangents gltf-pro derives a tangent frame. |
| Material > Materials | Export | Principled BSDF maps to glTF metallic-roughness. Procedural node textures do not export: bake them to images. |
| Animation | On, mode Actions | Each Action becomes a clip, by name. Push or stash every Action on the armature so the exporter finds it. |
| Animation > Shape Keys, Skinning | On | Morph targets and skins. Leave the skinning option **Include All Bone Influences** off: the animation package takes four influences per vertex and rejects more. |
| Compression (Draco) | Optional | Needs a Draco decoder at load time (see [Load the level](#load-the-level)). |

Before exporting:

- **Apply transforms** (Object > Apply > All Transforms, Ctrl+A) on level meshes, so their nodes carry identity
  transforms and the triangles you read back for colliders and navmeshes are already in world space. Apply the
  character's scale before skinning it.
- Keep the character's origin at its feet and facing -Y in Blender (glTF +Z after export).
- One file for the level, one per character. A level file must contain at least one mesh: gltf-pro rejects a file
  with only empties ("glTF contains no renderable meshes").

`@margoengine/blender` is a different path: a Blender add-on that writes `.margo` files, which load without glTF
accessor decoding ([README](../../packages/blender/README.md)). It suits static CAD-like scenes: it has no animation,
supports a narrower material set, keeps only `margo:`-prefixed custom properties, and its Blender-side export has no
recorded run yet. For a game with characters, use glTF.

## Blender as a level editor

Margo has no visual editor. Blender is the editor: place empties (or tag real meshes) where things belong, give them
custom properties (Object Properties > Custom Properties), and export with **Include > Data > Custom Properties** on. Blender
writes them to each node's glTF `extras`, and `model.extras()` returns every node that has an `extras` object, in
node order, with a copy of its world matrix:

| In Blender (Object custom properties) | In Margo (`model.extras()`) |
| --- | --- |
| Empty `PlayerStart`: `spawn` = `"player"` | `{name: 'PlayerStart', extras: {spawn: 'player'}, matrix, node, nodeIndex}` |
| Empty `Coin.001`: `spawn` = `"coin"`, `value` = `10` | `{name: 'Coin.001', extras: {spawn: 'coin', value: 10}, ...}` |
| Mesh `Rocks`: `collider` = `0` | `{name: 'Rocks', extras: {collider: 0}, ...}` |

```ts
import {box, PbrMaterial} from '@margoengine/core';
import {loadGLTF} from '@margoengine/gltf-pro';

const level = await loadGLTF(engine, '/assets/level.glb');
let playerStart: [number, number, number] = [0, 0, 0];
const coins: {at: [number, number, number]; value: number; visual: ReturnType<typeof engine.createMesh>}[] = [];
const gold = new PbrMaterial({color: '#f2c14e', metalness: 1, roughness: 0.3});

for (const {extras, matrix, node} of level.extras()) {
  const at: [number, number, number] = [matrix[12], matrix[13], matrix[14]]; // world position (column-major matrix)
  if (extras.spawn === 'player') playerStart = at;
  if (extras.spawn === 'coin') {
    const visual = engine.createMesh().setGeometry(box(0.4, 0.4, 0.08)).setMaterial(gold).setPosition(at);
    coins.push({at, value: Number(extras.value ?? 1), visual});
  }
  if (extras.hidden) node.visible = false; // a tagged mesh can also stay in place and be shown, hidden or moved
}
```

- Values are whatever JSON Blender wrote for the property (numbers, strings, arrays, ...). Check the types you rely on.
- The matrix is the node's world transform when you call `extras()` (the model root's transform included), so
  parenting empties under other empties in Blender works. Call it again after moving the model.
- `node` is the node's core `Mesh`. Tagged meshes stay drawn by the model; set `node.visible = false` to hide one,
  or `node.setPosition(...)` to move it (positions are relative to its parent node).
- Custom properties on mesh data and on materials land in `level.asset.doc.meshes[i].extras` and
  `level.asset.doc.materials[i].extras`; a primitive's material index is `primitive.definition.material`.
- `.margo` files from `@margoengine/blender` go through the same method: their properties are under
  `extras.margo.properties`.

The test `packages/gltf-pro/tests/extras.test.js` builds a GLB in this shape (an empty under a parent empty, a
non-object `extras`, mesh and material extras) and checks what `extras()` returns.

## Start the engine

```ts
import {EngineKernel} from '@margoengine/core';
import {applyQualityTier, paceEngine, watchQuality} from '@margoengine/quality';

applyQualityTier(); // before the engine exists: core reads the tier when it builds pipelines
const engine = await EngineKernel.create(document.querySelector<HTMLCanvasElement>('#game')!, {
  backend: 'webgpu', capacity: 4096,
  camera: {position: [0, 6, 14], target: [0, 1, 0], fov: 60, near: 0.1, far: 500},
});
paceEngine(engine); // light tier: about 60 FPS instead of swinging with the display rate
engine.onError = error => {engine.stop(); console.error(error);};
// ...load the level and attach features (below), then:
engine.start();
watchQuality();
addEventListener('pagehide', () => engine.dispose(), {once: true});
```

`capacity` is the number of core meshes (each glTF node and each model root takes one); the default is 1,024 and the
maximum 100,000. `engine.dispose()` disposes every attached plugin and model.

## Load the level

`loadGLTF` returns a `PBRModel` that is already drawing. For big files, `loadGLTFInWorker` moves download, parsing,
accessor decoding, vertex packing and image decoding to a worker and returns the same model:

```ts
import {loadGLTF} from '@margoengine/gltf-pro';
import {loadGLTFInWorker} from '@margoengine/gltf-pro/worker';
import {engineRuntime} from '@margoengine/core/extension';
import {DracoDecoder, KTX2Decoder, MeshoptDecoder} from '@margoengine/decoders';

const level = await loadGLTFInWorker(engine, '/assets/level.glb'); // same PBRModel as loadGLTF
const hero = await loadGLTF(engine, '/assets/hero.glb');

// Compressed files (Blender's Draco option, or gltfpack/gltf-transform output with KTX2 textures and meshopt):
const device = engineRuntime(engine).gpu ?? undefined; // lets KTX2 pick BC7/ASTC/ETC2 when the device has them
const decoders = {draco: new DracoDecoder(), meshopt: MeshoptDecoder, ktx2: new KTX2Decoder({device})};
const props = await loadGLTF(engine, '/assets/props-compressed.glb', {decoders});
decoders.draco.dispose(); decoders.ktx2.dispose(); // when no more loads are expected
```

- With `decoders`, the worker functions run on the calling thread (Draco and KTX2 already decode in their own
  worker pools).
- The worker script is a separate asset that Vite and webpack copy; apps that never import `/worker` ship none of it.
- Progressive loading (bounds and low detail first, full detail streamed in) is coming; it has not merged yet.
- A loaded model joins each lighting feature separately: `shadows.add(model)`, `lighting.add(model)` for image-based
  lighting, `fog.add(model)`, `ssao.add(model)`, `lights.add(model)` for clustered lights. Core meshes need none of
  these; a model missing one looks different from a core mesh next to it.

## Physics

`@margoengine/physics` wraps [Rapier](https://rapier.rs) but does not bundle it. Your app installs
`@dimforge/rapier3d-compat` (Apache-2.0; tested with 0.21.0, the compat build inlines its Wasm, so no bundler
configuration), initializes it, and passes the module in:

```ts
import RAPIER from '@dimforge/rapier3d-compat';
import {Physics} from '@margoengine/physics';
import {loadGLTF} from '@margoengine/gltf-pro';

await RAPIER.init();
const physics = Physics.attach(engine, {rapier: RAPIER}); // fixed 1/60 s steps, meshes interpolated between them
const level = await loadGLTF(engine, '/assets/level.glb');

// Static triangle colliders for the whole level in one call: a body per Blender object (hits then report that
// object's node), every node, instance and scale transform applied, objects tagged collider = 0 left out.
physics.addModel(level, {type: 'fixed', perNode: true, filter: primitive => level.asset.doc.nodes[primitive.nodeIndex].extras?.collider !== 0});
// A loose prop exported as its own file: dynamic, a convex hull per primitive, moving as one body.
const crate = await loadGLTF(engine, '/assets/crate.glb');
crate.root.setPosition([2, 3, 0]);
physics.addModel(crate, {collider: {density: 0.6, friction: 0.8}});

// A pickup trigger: sensors report overlaps instead of colliding.
const coin = engine.createMesh().setPosition([4, 1, 0]);
physics.addBody(coin, {type: 'fixed', colliders: {shape: 'sphere', radius: 0.6, sensor: true}});
physics.on('intersectionstart', ({meshA, meshB}) => {
  if (meshA === coin || meshB === coin) coin.visible = false; // score, sound, ...
});
```

- **Bodies on glTF nodes.** `addModel` builds trimesh colliders (fixed and kinematic) or convex hulls (dynamic) from
  a model's node hierarchy; without `perNode` one body on `model.root` holds them all. `addBody(level.nodes[i], ...)`
  also works on a single child node: the body starts at the node's world pose and the node gets its pose relative to
  its parent each frame. Skinned meshes are read in their bind pose, so give a character a capsule (below).
- **One merged triangle soup.** `worldTriangles(engine, [level])` from `@margoengine/bvh` returns the level's
  world-space `{vertices, indices}`: one trimesh (`physics.addBody(null, {type: 'fixed', colliders: {shape: 'trimesh',
  ...worldTriangles(engine, [level])}})`) or a navmesh (below).
- **Optional and not small.** Rapier ships its Wasm inlined in `rapier3d-compat` (about 1.6 MB gzip for `rapier.mjs`,
  see [Measured numbers](#measured-numbers)); load it only on the pages that need physics, for example with a dynamic
  `import()`. For walking around a static level without rigid bodies, `@margoengine/controls/walk` collides on the bvh
  trees without Wasm.
- Shapes: box, sphere, capsule, cylinder, cone, convex hull, trimesh, heightfield. Joints: fixed, spherical,
  revolute, prismatic, with limits and motors. Queries (`raycast`, `shapeCast`, ...) return the core `Mesh` hit.
- Not wrapped, reachable through `physics.world` and `physics.rapier`: vehicles, rope and spring joints, multibody
  joints, snapshots. There is no built-in debug view; `physics.debugRender()` returns line buffers for
  `@margoengine/lines`. Details: [physics README](../../packages/physics/README.md).

## The character

`@margoengine/animation` plays a model's clips (skins and morph targets, skinned on the GPU).
`@margoengine/animator` adds named states, 1D and 2D blend trees, cross-faded transitions, masked additive layers
and two-bone foot IK on top of it. Clip names are your Blender Action names.

```ts
import RAPIER from '@dimforge/rapier3d-compat';
import {loadGLTF} from '@margoengine/gltf-pro';
import {Animation} from '@margoengine/animation';
import {Animator} from '@margoengine/animator';
import {Physics} from '@margoengine/physics';
import {Raycaster} from '@margoengine/bvh';

await RAPIER.init();
const physics = Physics.attach(engine, {rapier: RAPIER});
const level = await loadGLTF(engine, '/assets/level.glb');
const hero = await loadGLTF(engine, '/assets/hero.glb'); // Actions: Idle, Walk, Run, Jump, Wave

const animation = Animation.attach(hero);
const animator = Animator.attach(animation, {
  initial: 'move', parameters: {speed: 0, airborne: 0},
  states: {
    move: {parameter: 'speed', samples: [{value: 0, clip: 'Idle'}, {value: 2, clip: 'Walk'}, {value: 6, clip: 'Run'}]},
    jump: 'Jump',
  },
  transitions: [
    {from: 'move', to: 'jump', when: p => p.airborne > 0, duration: 0.1}, // cross-fade seconds
    {from: 'jump', to: 'move', when: p => p.airborne === 0, duration: 0.2},
  ],
});

// Wave with the upper body only: an additive layer masked to glTF node indices (Blender bone names).
const upperBody = ['Spine', 'Spine1', 'Neck', 'Head', 'LeftArm', 'LeftForeArm', 'LeftHand'].map(name => hero.nodes.findIndex(node => node.name === name));
const stopWaving = animator.addLayer({clip: 'Wave', weight: 1, mask: upperBody});

// Feet on uneven ground: two-bone IK per leg, probing the level with a CPU ray.
const bone = (name: string) => hero.nodes.findIndex(node => node.name === name);
const ray = new Raycaster();
for (const side of ['Left', 'Right'])
  animator.addFootIK({
    hip: bone(`${side}UpLeg`), knee: bone(`${side}Leg`), ankle: bone(`${side}Foot`), pole: [0, 0, 1],
    raycast: (origin, direction) => {
      const [hit] = ray.set(origin, direction).intersectObjects(engine, [level]);
      return hit ? {position: hit.point, normal: hit.normal} : null;
    },
  });

// Movement: a kinematic capsule on the model root, moved by Rapier's character controller each fixed step.
const body = physics.addBody(hero.root, {type: 'kinematicPosition', position: [0, 1, 0], colliders: {shape: 'capsule', halfHeight: 0.5, radius: 0.3, offset: [0, 0.8, 0]}});
const controller = physics.createCharacterController(body, {maxSlopeClimbAngle: Math.PI / 4, snapToGround: 0.3});
const wish = {x: 0, z: 0, speed: 0};            // set from input every frame (next section)
let fall = 0;
physics.on('beforestep', dt => {
  fall = controller.grounded ? 0 : fall - 9.81 * dt;
  controller.move([wish.x * wish.speed * dt, fall * dt, wish.z * wish.speed * dt]);
  animator.parameters.speed = wish.speed;
  animator.parameters.airborne = controller.grounded ? 0 : 1;
});
void stopWaving; // call it to remove the layer
```

- `Animation.attach(model)` alone plays one clip at a time (`animation.play('Walk')`) with no blending; the animator
  takes over playback while attached.
- Foot IK needs a direct hip-knee-ankle chain with positive uniform scales on the bones and their ancestors.
- Many background characters: `@margoengine/animation/vat` bakes clips into a vertex animation texture and draws a
  crowd in one call, without shadows, SSAO or image-based lighting ([animation README](../../packages/animation/README.md)).
- Turn the character to face its movement with `hero.root.setRotation([0, Math.atan2(wish.x, wish.z), 0])`
  (adjust for your model's facing).

## Input

`@margoengine/input` maps keys, mouse buttons and motion, gamepad axes and buttons, and on-screen touch sticks and
buttons to named actions. Sample once per frame:

```ts
import {Input} from '@margoengine/input';

const input = new Input({
  moveX: [{type: 'key', code: 'KeyD'}, {type: 'key', code: 'KeyA', scale: -1}, {type: 'gamepad-axis', index: 0}, {type: 'touch', id: 'move', axis: 'x'}],
  moveZ: [{type: 'key', code: 'KeyS'}, {type: 'key', code: 'KeyW', scale: -1}, {type: 'gamepad-axis', index: 1}, {type: 'touch', id: 'move', axis: 'y'}],
  run: [{type: 'key', code: 'ShiftLeft'}, {type: 'gamepad-button', index: 10}],
  jump: [{type: 'key', code: 'Space'}, {type: 'gamepad-button', index: 0}, {type: 'touch', id: 'jump'}],
  lookX: [{type: 'pointer', axis: 'x', scale: 0.004}, {type: 'gamepad-axis', index: 2, scale: 0.05}],
}, {target: window, deadzone: 0.15});

const hud = document.querySelector<HTMLElement>('#touch')!;
input.createStick(hud, 'move');                                          // pointer-captured virtual stick
input.bindTouchButton(document.querySelector<HTMLElement>('#jump')!, 'jump');

const moveX = input.state('moveX'), moveZ = input.state('moveZ'), run = input.state('run'), jump = input.state('jump');
engine.onFrame(() => {
  input.update();
  if (jump.pressed) {/* start a jump */}
  const length = Math.hypot(moveX.value, moveZ.value) || 1;
  console.log(moveX.value / length, moveZ.value / length, run.down ? 6 : 2); // feed the character's wish vector
});
addEventListener('blur', () => input.reset());
input.rumble(120, 0.5); // resolves false when the gamepad has no actuator
```

- Opposing bindings sum and clamp to -1..1. `pressed` and `released` are true for the one update where the state
  changed. Typing in a text field does not trigger key actions.
- Mouse motion is relative. For mouse look, request pointer lock on the canvas yourself (the island demo does this
  on double-click).
- The island demo's `stepLocomotion` (`@margoengine/controls`) is a ready-made walk/run step with damped heading
  and a third-person camera yaw/pitch, for a character that follows a height function instead of physics.

## Camera

```ts
import {Cinematic} from '@margoengine/cinematic';
import {loadGLTF} from '@margoengine/gltf-pro';
import {Raycaster} from '@margoengine/bvh';

const level = await loadGLTF(engine, '/assets/level.glb');
const hero = await loadGLTF(engine, '/assets/hero.glb');
const down = new Raycaster();
const groundHeight = (x: number, z: number) => down.set([x, 100, z], [0, -1, 0]).intersectObjects(engine, [level])[0]?.point[1] ?? 0;

// Walls and ceilings: the first level hit along the arm from the character to the camera.
const wall = new Raycaster();
wall.firstHitOnly = true; wall.near = 0.05; // skip the floor under the character's feet
const collide = (origin: Float64Array, direction: Float64Array, distance: number) => {
  wall.far = distance;
  return wall.set(origin, direction).intersectObjects(engine, [level], {refresh: false})[0]?.distance;
};

const camera = Cinematic.attach(engine, {offset: [0, 3, 7], damping: 6, lookDamping: 8, ground: groundHeight, clearance: 0.6, collide});
camera.follow(hero.root);
camera.setOrbitOffset(0.3, 0.35, 7, 1.2); // yaw, pitch, distance, height: drive yaw from mouse or right stick
camera.shake(0.15, 0.3);                  // on a hit: amplitude in meters, seconds
```

The rig owns the camera while attached (critically damped follow and look-at springs), so do not also attach orbit
controls. `ground` keeps the camera arm above a height function. `collide` keeps it in front of walls and ceilings:
on a hit the camera moves in at once to `clearance` short of it and eases back out when the arm is clear. With
physics attached, a sphere cast (`physics.shapeCast({shape: 'sphere', radius: 0.2}, ...)`) also keeps the near plane
out of the wall.

## Picking and ground snapping

`@margoengine/bvh`'s `Raycaster` hits core meshes and loaded glTF models on the CPU, against a cached triangle BVH
per primitive. Combined with `extras()` it tells you which Blender object was clicked:

```ts
import {Raycaster, computePrimitiveBVHAsync} from '@margoengine/bvh';
import {loadGLTF} from '@margoengine/gltf-pro';

const level = await loadGLTF(engine, '/assets/level.glb');
// Build the BVHs in a worker after loading so the first click does not stall.
await Promise.all(level.primitives.map(primitive => computePrimitiveBVHAsync(primitive)));
const tagged = new Map(level.extras().map(entry => [entry.nodeIndex, entry.extras]));

const raycaster = new Raycaster();
engine.canvas.addEventListener('pointerdown', event => {
  const [hit] = raycaster.setFromEngine(engine, event.offsetX, event.offsetY).intersectEngine(engine);
  if (hit?.model === level) console.log('clicked', hit.mesh.name, tagged.get(hit.nodeIndex), 'at', hit.point);
});

// Snap a dropped object to the floor below it.
const drop = engine.createMesh().setPosition([3, 10, -2]);
const [floor] = raycaster.set([3, 10, -2], [0, -1, 0]).intersectObjects(engine, [level]);
if (floor) drop.setPosition([floor.point[0], floor.point[1], floor.point[2]]);
```

The same downward ray is the `ground` function for the camera rig and the height function for `stepLocomotion`.
With physics attached, `physics.raycast` answers the same question from the collider world instead.

## Navigation for enemies

Two packages, by size of problem:

- `@margoengine/navigation` builds a Recast/Detour navmesh from triangles (it depends on `recast-navigation`, a Wasm
  module) and answers path queries. Feed it the level's world-space triangles from `worldTriangles`.
- `@margoengine/navmesh` is dependency-free: A* over convex polygons you supply, funnel smoothing, and ORCA
  avoidance between agents (`avoid()`), up to 4,096 polygons. Good for a hand-made walk mesh exported from Blender.

```ts
import {Navigation} from '@margoengine/navigation';
import {worldTriangles} from '@margoengine/bvh';
import {loadGLTF} from '@margoengine/gltf-pro';

const level = await loadGLTF(engine, '/assets/level.glb');
const {vertices, indices} = worldTriangles(engine, [level]); // every node transform applied, merged
const navigation = await Navigation.create(vertices, indices, {cs: 0.2, ch: 0.2});
const enemy = engine.createMesh().setPosition([10, 0, 10]);
let path = navigation.path({x: 10, y: 0, z: 10}, {x: 0, y: 0, z: 0}) ?? [];
engine.onFrame((_engine, delta) => {
  const next = path[0];
  if (!next) return;
  const p = enemy.position, dx = next.x - p.x, dz = next.z - p.z, distance = Math.hypot(dx, dz), step = 3 * delta;
  if (distance <= step) {enemy.setPosition([next.x, next.y, next.z]); path = path.slice(1);}
  else enemy.setPosition([p.x + dx / distance * step, next.y, p.z + dz / distance * step]);
});
// navigation.dispose() when the level unloads.
```

Recast's crowd simulation, tiled meshes and off-mesh links are not wrapped; use `recast-navigation` directly for them.

## Many entities: ECS

For a dozen pickups, plain arrays are enough. For hundreds of similar things (projectiles, enemies, particles you
simulate on the CPU), `@margoengine/ecs` stores component fields in packed typed arrays:

```ts
import {World} from '@margoengine/ecs';

const world = new World(1024);
const position = world.component({x: Float32Array, y: Float32Array, z: Float32Array});
const velocity = world.component({x: Float32Array, y: Float32Array, z: Float32Array});
const bullet = world.create();
position.add(bullet, {x: 0, y: 1, z: 0});
velocity.add(bullet, {z: -30});

const moving = new Uint32Array(world.capacity);
engine.onFrame((_engine, delta) => {
  const count = world.query([position, velocity], moving);
  for (let i = 0; i < count; i++) {
    const p = position.index(moving[i]), v = velocity.index(moving[i]);
    position.fields.z[p] += velocity.fields.z[v] * delta;
  }
});
```

Entity IDs carry a generation, so a stale handle to a destroyed entity is rejected. Capacity is fixed. The ECS knows
nothing about meshes: keep a mesh per entity in your own array and copy positions after the systems run.

## Sound

`@margoengine/audio` is Web Audio with a listener that follows the engine camera and positional sounds that follow
a mesh:

```ts
import {AudioListener, Audio, PositionalAudio} from '@margoengine/audio';
import {loadGLTF} from '@margoengine/gltf-pro';

const level = await loadGLTF(engine, '/assets/level.glb');
const hero = await loadGLTF(engine, '/assets/hero.glb');
const listener = AudioListener.attach(engine, {volume: 0.8}); // resumes the context on the first click or key press
listener.follow(hero.root); // ears on the character (glTF faces +Z) instead of the camera
const coinClip = await listener.load('/assets/coin.ogg');

const waterfall = level.extras().find(entry => entry.extras.sound === 'waterfall')!.node;
const ambience = new PositionalAudio(listener, {mesh: waterfall, refDistance: 3, rolloffFactor: 1.5, loop: true, muteWhenHidden: true});
ambience.setBuffer(await listener.load('/assets/waterfall.ogg'));
ambience.play();

const music = new Audio(listener, {volume: 0.4, loop: true});
music.setBuffer(await listener.load('/assets/theme.ogg'));
music.fadeIn(2);

function collectCoin() {new Audio(listener).setBuffer(coinClip).play();}
collectCoin();
```

The listener follows the camera by default (HRTF panning, distance models and cones like Web Audio's `PannerNode`).
`listener.follow(mesh, forward)` puts it on any mesh (its world position, its local `forward` axis, default +Z);
`follow('camera')` goes back, and `follow(null)` leaves it where `listener.setPose(...)` puts it. There is no reverb
or occlusion; add Web Audio nodes through `setFilters`.

## Sky, water, light and post-processing

This is the island demo's setup ([main.ts](../../examples/gameplay-sandbox/src/main.ts)), trimmed: a physical sky
that also drives the sun light and ambient, distance fog, ocean water that reflects the sky and refracts the scene,
cascaded soft shadows, and bloom.

```ts
import {loadGLTF} from '@margoengine/gltf-pro';
import {Sky} from '@margoengine/sky/base';
import {bruneton} from '@margoengine/sky/bruneton';
import {clouds} from '@margoengine/sky/clouds';
import {fog} from '@margoengine/sky/fog';
import {reflection} from '@margoengine/sky/reflection';
import {lighting} from '@margoengine/sky/lighting';
import {Shadows} from '@margoengine/shadows';
import {Water} from '@margoengine/water';
import {Bloom} from '@margoengine/post/bloom';

const level = await loadGLTF(engine, '/assets/level.glb');
const hero = await loadGLTF(engine, '/assets/hero.glb');
const post = Bloom.attach(engine, {strength: 0.2, threshold: 1.2, exposure: 0.45});
const sky = Sky.attach(engine, {
  model: 'bruneton', hours: 17.5, timeScale: 1 / 120, clouds: {coverage: 0.38},
  fog: {depth: () => water.depthTexture, density: 0.008, start: 45},
  lighting: {intensity: 6, ambient: {day: [0.14, 0.19, 0.24], night: [0.02, 0.04, 0.09]}},
}, {bruneton, clouds, fog, reflection, lighting});
const shadows = Shadows.attach(engine, {resolution: 2048, distance: 115, lightSize: 0.018});
shadows.add(level, {static: true}); // cached; call shadows.invalidate() after moving static geometry
shadows.add(hero);                   // re-rendered each frame, reads the skinned vertices
const water = Water.attach(engine, {
  size: [400, 400], segments: 256, horizon: true, height: 0,
  depth: () => post.depthTexture, sceneColor: () => post.sceneTexture,
  reflection: () => sky.reflectionTexture, lights: sky.lights,
});
sky.options.hours = 21; // the clock drives sun, moon, ambient and sky colour; sky.nightFactor fades lamps in
```

Other pieces, each an optional package:

- **Image-based lighting** (studio or interior scenes without the sky): `@margoengine/environment`'s
  `Environment.attach(engine, await loadEnvironmentImage('/studio.hdr'))`, then `EnvironmentLighting.attach` and
  `lighting.add(level)`. `Fog` and `ColorBackground` live there too.
- **Local lights**: `@margoengine/clustered` for many point and spot lights (`lights.setLights(level.clusteredLights())`
  uses the lamps you placed in Blender); `@margoengine/clustered/shadows` gives a few of them shadows.
- **Post stack**: `PostStack.attach(engine, [new SSAO(), new SSR(), new Bloom(), new Tonemap({curve: 'agx'}), new FXAA()])`
  from `@margoengine/post/*` and `@margoengine/tonemap` runs several effects on one HDR capture. Register glTF models
  with `ssao.add(model)`.

Know these limits before you design around them:

- **Screen-space reflections reflect only in core-mesh surfaces today.** glTF models (so everything exported from
  Blender), water and terrain appear *in* reflections but do not *show* them. A glossy floor needs to be a core mesh
  with a core `PbrMaterial` for SSR to do anything.
- **Water has its own reflection** (the sky and its sun and moon paths), not SSR, and it does not reflect nearby
  objects.
- **Water refraction with SSAO goes through `PostStack`.** Standalone Bloom and SSAO refuse each other, so for both,
  give water the stack's shared HDR capture:

```ts
import {PostStack} from '@margoengine/post/stack';
import {SSAO} from '@margoengine/post/ssao';
import {Bloom} from '@margoengine/post/bloom';
import {Water} from '@margoengine/water';

const stack = PostStack.attach(engine, [new SSAO(), new Bloom({strength: 0.2, threshold: 1.2, exposure: 0.45})]);
const water = Water.attach(engine, {size: [400, 400], segments: 256, height: 0,
  depth: () => stack.depthTexture, sceneColor: () => stack.sceneTexture});
void water;
```

  Water draws into the stack's capture before the stack's effects run.
- **Volumetric fog and light shafts are coming**; they have not merged. Use sky's distance fog or environment's
  `Fog` (including height fog) today.
- A glTF material with every lighting package attached (physical material + shadows + IBL + local shadows) uses all
  16 texture slots WebGPU guarantees per shader stage; gltf-pro throws a `RangeError` naming the combination if a
  further texture would exceed the device limit ([gltf-pro README](../../packages/gltf-pro/README.md#texture-bindings)).

## Quality tiers

`@margoengine/quality` decides how hard to push the GPU by measuring it, not by device name. Desktops start on a
light tier (no MSAA, pixel ratio 1, paced to about 60 FPS) and time each frame on the GPU; a browser with headroom
gets the full 4x MSAA tier from its next page load. Phones stay single-sampled. Use the tier to scale your own
settings, since tier-aware feature presets in the packages are not built yet:

```ts
import {applyQualityTier, watchQuality} from '@margoengine/quality';
import {Shadows} from '@margoengine/shadows';

const tier = applyQualityTier(); // 'light' | 'high' | 'phone', before EngineKernel.create
const shadows = Shadows.attach(engine, {resolution: tier === 'high' ? 2048 : tier === 'light' ? 1024 : 512, distance: 115});
const enemyCount = tier === 'phone' ? 8 : 24;
void shadows; void enemyCount;
watchQuality(); // once rendering
```

`?quality=low` and `?quality=high` force a tier for testing; `localStorage.removeItem('margoQuality')` measures
again. On the full tier, five consecutive seconds under 55 FPS store the light tier and reload once.

## Deploying

The game is static files: build with Vite (or any bundler that copies `new URL(..., import.meta.url)` assets, which
the worker loaders and decoders use) and serve over HTTPS (WebGPU needs a secure context). [docs/deploying.md](../deploying.md)
has tested Content Security Policy, caching and compression configs for Cloudflare Pages, Netlify, Vercel and Nginx:
Margo needs `script-src 'wasm-unsafe-eval'` and `worker-src 'self'`, the Draco and KTX2 decoder workers need more
(see that page), and no cross-origin isolation headers are needed. Rapier (`@dimforge/rapier3d-compat`) and
`recast-navigation` also compile Wasm; they are not part of that page's CSP check, so test your policy with them.
An offline asset cache for GLB files and textures is coming; it has not merged.
## What you build yourself

Margo is a rendering engine plus optional building blocks, not a game engine with an editor. Plan for these:

- **Game rules and UI.** Scoring, health, win and lose states, menus, HUD and pause screens are your code. Plain
  HTML/CSS over the canvas works; `@margoengine/html` and `@margoengine/labels` place DOM elements at 3D positions.
- **Level logic.** `extras()` gives you markers and properties; deciding what a `spawn = "coin"` means, triggers,
  doors, checkpoints and scripted events is yours. `@margoengine/fsm` (a small state machine) and
  `@margoengine/tween` help.
- **Save state.** No save system: serialize your own game state (`localStorage`, IndexedDB or a server).
- **Networking.** `@margoengine/net` interpolates received snapshots (position, rotation, velocity) with capped dead
  reckoning; the transport, authority, prediction, lobbies and servers are yours.
- **No visual editor.** Blender plus code is the workflow: change the level in Blender, re-export, reload.
  `@margoengine/inspector` shows the entity hierarchy and edits transforms while the game runs, as a debugging aid;
  there is no prefab system.
- **WebGPU only for these features.** Browsers without WebGPU get, at best, the WebGL2 fallback's plain core meshes:
  no glTF PBR, skinning, shadows, sky, water or post-processing. Real-GPU tests so far ran in Edge (Chromium) on one
  Windows laptop with an Intel Arc 140V; Firefox, Safari and mobile GPUs are not yet verified.
- **Asset pipeline.** Texture compression (KTX2), mesh compression and LODs are offline steps with external tools
  (gltfpack, gltf-transform); Margo decodes them at load time.

## Measured numbers

Only numbers with a committed result or a reproducing command. All hardware numbers are from one machine: an ASUS
laptop with an Intel Arc 140V integrated GPU, Edge 155, on AC power.

| What | Number | Proof |
| --- | --- | --- |
| Core + `margoengine` stage, gzip | 19,793 bytes at `7dcc958` (the build fails at 20,000) | `npm run measure:size` ([scripts/measure-size.js](../../scripts/measure-size.js)) |
| Island demo, light tier (1x MSAA, DPR 1, paced to 60) | 60 FPS with 100k and with 1M particles in every round; GPU frame span medians about 10 ms (100k) and 12-16 ms (1M) | [vfx-island-final.json](../../examples/package-benchmarks/results/vfx-island-final.json) (`examples/package-benchmarks/vfx-island.mjs`, commit `76af7a0`) |
| Island demo, full tier (4x MSAA) on the same laptop | 45-53 FPS (100k), 40-44 FPS (1M): below 60, which is why the light tier exists | same file |
| Loading a generated 41 MB GLB (1.28M triangles) while rendering | longest main-thread task 222 ms with `loadGLTF`, 0 ms with `loadGLTFInWorker`; load time 0.60 s vs 0.68 s | [workers.json](../../examples/package-benchmarks/results/workers.json) (`examples/package-benchmarks/workers/run.mjs`) |
| Screen-space reflections, worst case (glossy floor filling the view) | 2.3 ms GPU at 1280x720 4x MSAA, 5.8 ms at 1920x1080 4x | [ssr-gpu.json](../../examples/package-benchmarks/results/ssr-gpu.json) |
| Package entries this game imports (min + gzip, each alone; Rapier and recast-navigation not included) | gltf-pro 16.9 kB, animation 5.0, animator 3.9, input 2.3, physics 8.2, bvh 13.6, cinematic 1.5, audio 6.3, sky base + bruneton + clouds + fog + reflection + lighting 11.7, water 13.9, shadows 6.4, Bloom 4.9, quality 1.3 | [entry-sizes.json](../../examples/package-benchmarks/results/entry-sizes.json) (`examples/package-benchmarks/entry-sizes.mjs`) |

| Rapier itself, `@dimforge/rapier3d-compat` 0.21.0 `rapier.mjs` (Wasm inlined as base64) | 1,645,573 bytes gzip (4,340,292 raw); the bare Wasm 1,176,707 gzip | [walk-size.json](../../examples/package-benchmarks/results/walk-size.json) (`examples/package-benchmarks/walk-size.mjs`) |

Entry sizes are compressed one at a time, so their sum overstates a combined bundle (shared code compresses once).
No frame-rate number here describes your game: it depends on your scene, your GPU and the tier. Measure with
`@margoengine/stats` (`Stats.attach(engine, {profiling: true})` with `features: ['timestamp-query']` for GPU timings).
