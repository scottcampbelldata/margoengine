# @margoengine/scene

Scene graph conveniences over core meshes, in an optional package so core stays small: `children`, `parent`, `traverse`, `userData`, `lookAt`, `getWorldPosition`, `getWorldQuaternion`, `getWorldScale` and `worldMatrix`. Import only the functions you use, or call `extendMeshes()` once to have them as members of every mesh.

```ts
import { box, Engine, PbrMaterial } from '@margoengine/core';
import { children, getWorldPosition, lookAt, traverse, userData } from '@margoengine/scene';

const canvas = document.querySelector('canvas')!;
const engine = await Engine.create(canvas);
const geometry = box();
const turret = engine.createMesh().setGeometry(geometry).setPosition([2, 0, 0]);
const barrel = engine.createMesh(turret).setGeometry(geometry).setPosition([0, 1, 0]);
barrel.setMaterial(new PbrMaterial({ color: '#d0a040' }));

userData(barrel).ammo = 12;
lookAt(turret, [0, 0, 5]);
console.log(children(turret).length, getWorldPosition(barrel));
traverse(engine.scene, (mesh) => {
  mesh.visible = true;
});
engine.start();
```

As members, for code that already reads this way:

```ts
import { box, Engine } from '@margoengine/core';
import { extendMeshes } from '@margoengine/scene/mesh';

extendMeshes();
const engine = await Engine.create(document.querySelector('canvas')!);
const parent = engine.createMesh().setGeometry(box());
const child = engine.createMesh(parent).setGeometry(box()).setPosition([0, 2, 0]);

child.userData.kind = 'lamp';
child.lookAt(0, 0, 5);
parent.traverse((mesh) => console.log(mesh.children.length, mesh.getWorldPosition()));
engine.start();
```

`extendMeshes()` adds the members to every mesh on this thread, existing ones included, and its types come with the entry. Importing changes nothing until you call it, and calling it again changes nothing.

| Function | Member | Result |
| --- | --- | --- |
| `children(mesh)` | `mesh.children` | Direct children in attach order, as a new array. |
| `parent(mesh)` | `mesh.parent` | The parent, or null. Change it with `mesh.setParent`. |
| `traverse(meshOrScene, visitor)` | `mesh.traverse(visitor)` | Calls `visitor` for each mesh, parents before children. A scene starts from its meshes with no parent. The visitor may dispose or move meshes. |
| `userData(mesh, value?)` | `mesh.userData` | The mesh's own object for your data, made on first use. Margo never reads it. |
| `lookAt(mesh, target, {up})` | `mesh.lookAt(target, {up})`, `mesh.lookAt(x, y, z)` | Turns the mesh so +Z points at the target, +Y leaning toward `up` (default `[0, 1, 0]`). |
| `getWorldPosition(mesh, out?)` | `mesh.getWorldPosition(out?)` | World position. |
| `getWorldQuaternion(mesh, out?)` | `mesh.getWorldQuaternion(out?)` | World rotation `[x, y, z, w]`. |
| `getWorldScale(mesh, out?)` | `mesh.getWorldScale(out?)` | World scale. A mirror shows as a negative x. |
| `worldMatrix(mesh)` | | World matrix, column-major, float64. |

`out` is an array of 3 numbers or an object with `x`, `y` and `z`, such as a `Vector3` from `@margoengine/math`; left out, the result is a new `[x, y, z]`. `target` is `[x, y, z]`, `{x, y, z}` or a mesh, meaning its world position.

## Many transforms at once

For scenes where thousands of meshes move every frame, `TransformWriter` from `@margoengine/scene/bulk` writes them from typed arrays in one call. Make it once for a list of meshes and call `write` each frame:

```ts
import { box, Engine } from '@margoengine/core';
import { TransformWriter } from '@margoengine/scene/bulk';

const canvas = document.querySelector('canvas')!;
const engine = await Engine.create(canvas);
const geometry = box();
const meshes = Array.from({ length: 1000 }, () => engine.createMesh().setGeometry(geometry));
const writer = new TransformWriter(meshes);
const positions = new Float32Array(meshes.length * 3);
const quaternions = new Float32Array(meshes.length * 4);

let time = 0;
engine.onFrame((_, delta) => {
  time += delta;
  for (let i = 0; i < meshes.length; i++) {
    positions[i * 3] = (i % 40) * 2;
    positions[i * 3 + 1] = Math.sin(time + i);
    positions[i * 3 + 2] = Math.floor(i / 40) * 2;
    quaternions[i * 4 + 3] = 1;
  }
  writer.write({ positions, quaternions });
});
engine.start();
```

`write(rows, range?)` takes any of `positions` (3 per mesh), `quaternions` (4) or `rotations` (Euler XYZ, 3, not both) and `scales` (3), as typed or plain arrays. Row `i` belongs to mesh `i` of the list. `{ from, count }` writes part of the list, with row 0 of the arrays for mesh `from`.

The result is what the setters give, bit for bit, `mesh.rotation` and the world matrix included. A write is all or nothing: a value the setters refuse throws `RangeError`, and a mesh disposed since the writer was made throws MargoError `disposed` naming its row, before anything changes. Make a new writer then.

## Asset containers

`@margoengine/scene/container` handles a set of root meshes, loaded models and plugins as one unit: load it, add it to the scene, take it out without destroying it, copy it and dispose it.

```ts
import { Engine } from '@margoengine/core';
import { loadContainer } from '@margoengine/scene/container';

const engine = await Engine.create(document.querySelector('canvas')!);
// Loaded, but not in the scene yet.
const crew = await loadContainer(engine, '/examples/assets/khronos/RiggedFigure/RiggedFigure.glb', {
  signal: AbortSignal.timeout(30_000),
});
crew.addAllToScene();
const second = await crew.instantiate({ name: (name) => `${name} 2` });
second.models[0].root.setPosition([1.5, 0, 0]);
crew.removeAllFromScene(); // hidden, not destroyed
crew.addAllToScene();
console.log(crew.models.length, second.models[0].root.name);
second.dispose(); // the copy only
engine.start();
```

`loadContainer` loads a glTF file with `@margoengine/gltf/pbr`, and `instantiate` copies such a model with `@margoengine/animation` (its own skeleton). Install both to use these defaults, or pass your own `load` and `cloneModel`.

A container you fill yourself holds meshes you made and plugin factories:

```ts
import { box, Engine, PbrMaterial } from '@margoengine/core';
import { AssetContainer } from '@margoengine/scene/container';

const engine = await Engine.create(document.querySelector('canvas')!);
const tent = engine.createMesh().setGeometry(box()).setMaterial(new PbrMaterial({ color: '#b04030' }));
const flag = engine.createMesh(tent).setGeometry(box()).setPosition([0, 1.5, 0]).setScale([0.2, 1, 0.2]);

const camp = new AssetContainer(engine).add(tent, () => ({
  name: 'flag-spin',
  setup() {},
  onPreUpdate: (delta: number) => void (flag.rotation.y += delta),
}));
camp.removeAllFromScene(); // the meshes hide and the plugin is removed
camp.addAllToScene(); // the meshes show and the factory runs again

const other = await camp.instantiate({ cloneMaterials: true });
other.meshes[0].setPosition([3, 0, 0]);
other.meshes[0].material.set({ color: '#3060b0' });
engine.start();
```

| Call | Result |
| --- | --- |
| `new AssetContainer(engine, {scene, cloneModel})` | An empty container, in the scene. `scene` defaults to `engine.scene`, `cloneModel` to the one in `@margoengine/animation`. |
| `loadContainer(engine, url, {scene, signal, load, cloneModel})` | A promise of a container holding the loaded model, out of the scene. A failed or aborted load leaves nothing. |
| `add(...items)` | Adds root meshes (each brings its children), loaded models and plugin factories. All or nothing. |
| `addAllToScene()` | Shows every member with the visibility it had and runs the factories. All or nothing. |
| `removeAllFromScene()` | Hides every member (not drawn or picked) and removes the factories' plugins. |
| `moveAllFromScene(keep?)` | Moves every root mesh and model of the scene into the container and removes them. `keep(item)` true leaves one. |
| `instantiate({name, cloneMaterials, filter, signal})` | A promise of a new container, in the scene, with copies of the meshes and models. Geometry and materials are shared; `cloneMaterials: true` (default false) gives copied mesh trees their own. `name` defaults to the source name. All or nothing. |
| `release(item)` | Takes an item out of the container without disposing it. |
| `contains(mesh)` | Whether the mesh is a member or under one. |
| `dispose()`, `using` | Disposes the plugins, the models and the member mesh trees. |

`meshes`, `models`, `plugins`, `inScene`, `disposed`, `scene` and `engine` read its state. Refused arguments throw `TypeError`; calls after disposal throw MargoError `disposed`.

A mesh belongs to its scene for life, so removal hides the member roots: leave their `visible` alone while the container is out. Plugins can only be disposed, so a factory makes a new one on each add, and `instantiate` does not copy plugins.

### Save a container

The `contains` filter saves one container with `captureScene` of `@margoengine/save/engine`. Capture it while it is in the scene (a removed one saves as hidden), and restore with `clear: false` so the rest of the scene stays. The save also holds the scene's lighting, background and plugin state; leave a plugin out with `plugins: { name: null }`.

```ts
import { box, Engine } from '@margoengine/core';
import { captureScene, restoreScene } from '@margoengine/save/engine';
import { parent } from '@margoengine/scene';
import { AssetContainer } from '@margoengine/scene/container';

const engine = await Engine.create(document.querySelector('canvas')!);
const tent = engine.createMesh().setGeometry(box());
tent.name = 'tent';
const camp = new AssetContainer(engine).add(tent);

const text = JSON.stringify(captureScene(engine, { filter: (mesh) => camp.contains(mesh) }));
camp.dispose();

const { meshes, models } = await restoreScene(engine, JSON.parse(text), { clear: false, camera: false });
const roots = [...meshes].filter(([, mesh]) => !parent(mesh));
const restored = new AssetContainer(engine).add(...roots.map(([id, mesh]) => models.get(id) ?? mesh));
console.log(restored.meshes[0].name);
engine.start();
```

## Good to know

- World results are right as soon as a value is written, before any frame: they read the local values up the parents, while `mesh.matrix` holds the last frame's matrix. Each call walks up the parents, so read `mesh.matrix` when a per-frame loop over many meshes needs no fresher value.
- Joint limits apply at the next frame. Until then a value outside its limit counts as written.
- `lookAt` turns +Z, the way a glTF model faces. A camera looks down its -Z and aims with `camera.target`.
- `lookAt` holds under any parent, scaled, mirrored or sheared: the direction goes back through the parent's matrix. At the target itself the mesh keeps its rotation, and looking straight along `up` uses the world axis furthest from it.
- Under a rotated, unevenly scaled parent the world matrix has shear, which no rotation and scale can hold: `getWorldQuaternion` and `getWorldScale` give the nearest ones, and `worldMatrix` stays exact.

## Helpers: Float, Center, Resize, ScreenSizer, interaction prompt (`@margoengine/scene/helpers`)

The small helpers people know from react-three-drei and model-viewer, as plain functions over meshes.
`worldBounds(mesh | scene)` is the exact world box of a mesh and its descendants (it reads every vertex once).
`center(root, { align, target })` moves `root` so that box lands on a point (the middle by default; `{ align: { y: 'min' } }`
stands it on the target). `resize(root, size, { axis })` scales `root` uniformly so the longest side (or one axis)
measures `size`. `float(mesh, options)` bobs and tilts a mesh from a time you pass to `update`, a pure function of time.
`screenSizeScale({ distance, fov, viewportHeight, pixels })` is the scale that makes a unit object span `pixels` on
screen. `InteractionPrompt` is the timing of a "drag me" hint: `visible` after `threshold` ms without interaction.

```ts
import { box, Engine } from '@margoengine/core';
import { InteractionPrompt, center, float, resize, screenSizeScale } from '@margoengine/scene/helpers';

const engine = await Engine.create(document.querySelector('canvas')!);
const model = engine.createMesh().setGeometry(box());
const marker = engine.createMesh().setGeometry(box());

resize(model, 2); // longest side is now 2 world units
center(model, { align: { y: 'min' } }); // centred on x and z, standing on y = 0
const bob = float(model, { floatIntensity: 2 });
const prompt = new InteractionPrompt({ threshold: 2500 });

function frame(seconds: number, distance: number): void {
  bob.update(seconds);
  marker.scale.setAll(screenSizeScale({ distance, fov: Math.PI / 3, viewportHeight: 720, pixels: 48 }));
  prompt.update(seconds * 1000); // show your hint while prompt.visible; call prompt.interact(ms) on pointerdown
}
frame(0, 10);
engine.start();
```
