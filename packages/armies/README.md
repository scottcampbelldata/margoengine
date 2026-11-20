# @margoengine/armies

Armies of hundreds of soldiers and horses, drawn at every distance. A `@margoengine/navmesh/formations` `Army` moves
the men and horses in line, column, square, wedge or skirmish order, on the march or in a charge; `addArmy` draws them:
every foot soldier and rider as one crowd of a baked person (skinned on the GPU when big on screen, a vertex animation
of a simplified mesh when small, culled when off screen or too small to see, all inside a budget), every horse in one
`@margoengine/horses/crowd` herd, each rider seated on the saddle its horse is drawn with. Clips follow each man's
ground speed (stand, walk, run) at the phase the ground he covered gives, so feet never slide; soldiers keep step;
each has his own height and outfit. Every frame is a pure function of the army's film time and the camera, so a film
seeks exactly.

Any person plugs in: a Character Creator export loaded through `@margoengine/fbx` and dressed by
`@margoengine/humans` `addPerson`, a glTF, or a body built in code. Bake it once with `bakePerson`.

```ts
import {Engine} from 'margoengine';
import {loadGLTF} from 'margoengine/gltf/pbr';
import {Animation} from 'margoengine/animation';
import {Army} from 'margoengine/navmesh/formations';
import {addArmy, bakePerson} from 'margoengine/armies';
const engine = await Engine.create(document.querySelector('canvas')!, {camera: {position: [0, 6, -40], target: [0, 1, 10], fov: 35}});
const model = await loadGLTF(engine, '/examples/assets/khronos/RiggedFigure/RiggedFigure.glb');
const person = await bakePerson(new Animation(model));
model.dispose();
const army = new Army();
army.add({count: 200, shape: 'line', ranks: 2}).march();
army.add({count: 30, kind: 'cavalry', shape: 'line', ranks: 2, position: [0, -25]}).charge({goal: [0, 150]});
const drawn = await addArmy(engine, army, {person});
army.advanceTime(4);
drawn.update(engine.camera);
console.log(drawn.persons.length, drawn.horses?.count, drawn.people.counts); // 230 people (200 on foot, 30 riders), 30 horses
```

| Option of `addArmy` | Default |
| --- | --- |
| `person` | needed: a `bakePerson` bake |
| `clips` | `{stand: 'stand', walk: 'walk', run: 'run', ride: 'ride'}` by name or index; a missing run walks, a missing stand holds the walk, a missing ride stands |
| `strides` | ground one clip cycle covers at scale 1: walk 1.524 m (two 30 inch steps, quick time), run 1.829 m (two 36 inch steps, double time), Infantry Drill Regulations 1911 |
| `runAbove`, `blendBand`, `standBelow` | 2 m/s (the walk-run change), 0.4 m/s, 0.1 m/s |
| `step` | `'cadence'`: the men keep step; `'route'`: each his own phase |
| `stature` | 0.04: one standard deviation of height as a fraction of the mean (about 7 cm on 1.75 m), cut at 2.5 |
| `variants` | outfits as atlas regions (`castVariants` of `@margoengine/humans/cast` fits), handed out by a seeded hash |
| `facing` | 0: the model faces +Z (glTF) |
| `horses` | `addHorseCrowd` options for cavalry; `false` draws no horses (and no riders) |
| `rider` | `{height, hipHeight, seatHip, pitchShare}` as `riderMatrix` |
| `near`, `far`, `vertices`, `nearScreen`, `cullScreen`, `hysteresis` | the crowd budget: see Levels |
| `map`, `color`, `roughness`, `metalness` | the person's look, as `VATCrowd` |
| `seed` | 1 |

`drawn.update(view, aspect?)` reads `army.members` and `army.time`: call it after `army.advanceTime(dt)` or
`army.seek(t)` and after placing the camera, with the engine's camera. A core Camera only refreshes its frustum as it
renders, so `update` brings it up to date first (at `aspect`, default the canvas's): the plan follows where the camera
is now, on the first frame and on a seek alike. `drawn.people.near` and `drawn.people.far` are the two draws and `drawn.horses.crowd` the
herd, for `shadows.add(...)` and `lighting.add(...)`.

## Baking a person (`./bake`)

`bakePerson(animation, {fps, clips, farTriangles})` bakes the person's clips into a bone texture (the near level,
`@margoengine/animation/instanced-skin` `bakeBones`), simplifies the mesh to at most `farTriangles` (3000) by quadric
collapses (`@margoengine/lod/auto`; every kept vertex is one of the source's, with its own position, normal, UV and skin
weights; vertices that follow different bones are never welded), and poses the simplified mesh on the CPU from the same
bone rows into a vertex animation texture (the far level, `@margoengine/animation/vat`). Skinning is linear in the bone
matrices, so posing the rows and interpolating them gives what the shader gets by interpolating the matrices: a member
handed from one level to the other stands where it stood, within 1e-5 m. The far texture of four one-second clips at
30 a second and 3000 triangles is about 12 MB; past 8192 texture rows `bakePerson` throws and names the fix.

```ts
import {Engine} from 'margoengine';
import {loadGLTF} from 'margoengine/gltf/pbr';
import {Animation} from 'margoengine/animation';
import {bakePerson} from 'margoengine/armies/bake';
const engine = await Engine.create(document.querySelector('canvas')!);
const model = await loadGLTF(engine, '/examples/assets/khronos/RiggedFigure/RiggedFigure.glb');
const bake = await bakePerson(new Animation(model), {farTriangles: 500});
console.log(bake.near.vertexCount, bake.far.vertexCount, bake.height.toFixed(2)); // near and far vertices, the bind pose height
```

`reduceBones(bake, ratio)` and `vatFromBones(bake)` are the two steps on their own; `personHeight(bake)` the bind pose
height.

## Levels (`./lod`)

`PersonCrowd.attach(engine, bake, options)` draws a person crowd in two draws and `update(people, view)` plans each
member's level from its size on screen, the biggest first: skinned near while at least `nearScreen` (0.08) of the
view tall and inside the `near` (128) and `vertices` (8,000,000 a frame) budgets, otherwise far inside the `far`
(16,384) and vertex budgets, otherwise not drawn; members smaller than `cullScreen` (0.002, two pixels of a 1080 line
view) or outside the camera's frustum planes are not drawn. `hysteresis` (0) keeps a near member near down to
`nearScreen * (1 - hysteresis)` in an interactive view; at 0 every frame depends on nothing but the members and the
camera. The near level blends two clips; the far one plays the clip with more weight. `planCrowd` is the plan alone,
pure.

```ts
import {planCrowd, NEAR, FAR} from 'margoengine/armies/lod';
const members = Array.from({length: 100}, (_, i) => ({x: 0, y: 0.9, z: 5 + i * 3, radius: 0.96}));
const levels = planCrowd(members, {position: [0, 1.7, 0], fov: 35}, {near: 20}, {near: 12000, far: 1500});
console.log(levels.filter((l) => l === NEAR).length, levels.filter((l) => l === FAR).length); // 12 near (to 38 m), 88 far
```

## Riders (`./riders`)

`riderMatrix(saddles, at, scale, placement)` places a rider's root from a horse's seat frame (`herd.saddles` of
`@margoengine/horses/crowd`, read back from the bone texture the horse is drawn with): the rider's hip joint 0.055 of
his height above the seat point (`@margoengine/horses/seat` riderSeat), his root `hipHeight` (0.53 of his height) below
it, facing the horse's way with `pitchShare` (0.4) of the trunk's pitch. A crowd rider follows the saddle rigidly, so
frames seek exactly; `mountRider` adds the damped spring for a single close-up rider. The rider plays the `ride` clip
one cycle a horse stride.

```ts
import {riderMatrix} from 'margoengine/armies/riders';
const seat = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 2, 1.55, 5, 1]); // a seat frame at 1.55 m
const root = riderMatrix(seat, 0, 1, {height: 1.75});
console.log(root[13].toFixed(2)); // 0.72: the hip 0.096 m above the seat, the root 0.928 m below the hip
```

## Settings (`./settings`)

`ARMY_SETTINGS` holds every option above as slider rows on the shared shape (`@margoengine/sky/settings` is the
model): the budget and level rows, the gait rows, step, stature, facing, seed and the rider rows are live (the next
`update` takes them); `fps` and `farTriangles` rebake. No row follows the weather. The formation has its own rows in
`@margoengine/navmesh/formation-settings`.

```ts
import {armyOptionsFromSettings} from 'margoengine/armies/settings';
const {options, bake} = armyOptionsFromSettings({near: 64, step: 'route', farTriangles: 2000});
console.log(options.near, options.step, bake.farTriangles); // 64 route 2000
```

## Limits

People need a person source that passes the bar: the package draws whoever it is given, and the period cast kit's
garments are not yet skinned to a rig. The far level plays one clip (no walk-run blend) and a simplified mesh; at 0.08 of
the view the difference is a few pixels. One person bake a crowd (variety comes from heights, outfits and phases);
several bakes need several crowds. Riders follow the saddle rigidly. Members are culled by bounding sphere only, not
by occlusion. See [docs/limits.md](../../docs/limits.md).

## Sources

C. W. Reynolds, "Flocks, herds and schools: a distributed behavioral model", SIGGRAPH 1987; J. van den Berg, S. J.
Guy, M. Lin and D. Manocha, "Reciprocal n-body collision avoidance", ISRR 2009 (Springer STAR 70, 2011); A. Treuille,
S. Cooper and Z. Popovic, "Continuum crowds", SIGGRAPH 2006 (the formations and flow fields this package draws);
B. Dudash, "Animated crowd rendering", GPU Gems 3, chapter 2, 2007; A. Beacco, N. Pelechano and C. Andujar, "A survey
of real-time crowd rendering", Computer Graphics Forum 35(8):32-50, 2016; M. Garland and P. S. Heckbert, "Surface
simplification using quadric error metrics", SIGGRAPH 1997; A. Thorstensson and H. Roberthson, "Adaptations to
changing speed in human locomotion: speed of transition between walking and running", Acta Physiologica Scandinavica
131:211-214, 1987; P. M. Visscher, "Sizing up human height variation", Nature Genetics 40:489-490, 2008; G. E. P. Box
and M. E. Muller, "A note on the generation of random normal deviates", Annals of Mathematical Statistics 29:610, 1958;
U.S. War Department, Infantry Drill Regulations, 1911.
