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

## Asset queue and registry (`@margoengine/scene/assets`)

`AssetQueue` runs loading tasks and tells you how each ended; `AssetRegistry` keeps assets by key so a texture or model can be swapped while the scene runs.

```ts
import {AssetQueue, AssetRegistry} from 'margoengine/scene/assets';

// Real apps pass file URLs; data: URLs keep this example self-contained.
const level = 'data:application/json,{"title":"Level 1"}';
const queue = new AssetQueue({concurrency: 4, retries: 2, retryDelay: 250});
queue.addJSON<{title: string}>('config', level, {onSuccess: (config) => console.log(config.title)});
queue.addBinary('terrain', 'data:application/octet-stream;base64,AAECAw==');
queue.add('sprites', async ({signal, progress}) => {   // any typed task: the loader gets the abort signal
  const response = await fetch(level, {signal});
  progress(0.5);
  return response.json();
});
queue.on('progress', ({fraction, finished, total}) => console.log(`${finished}/${total}`, fraction));
const {ok, done, failed} = await queue.run(AbortSignal.timeout(30_000)); // never rejects for a task
if (!ok) await queue.retryFailed();

const assets = new AssetRegistry<string>({
  loadURL: async (url) => (await fetch(url)).text(),
  onMissing: (key, reason) => 'data:text/plain,placeholder', // an unknown key or a failed load becomes this, once
});
assets.fromJSON({greeting: 'data:text/plain,Hello', config: {url: level, type: 'json'}});
assets.subscribe('greeting', (text) => console.log('greeting is now', text));
await assets.load('greeting');
await assets.swap('greeting', 'data:text/plain,Hallo'); // subscribers see the new value; `dispose` gets the old one
console.log(assets.toJSON());                    // the URL definitions, for saving
```

- `AssetQueue({concurrency = 4, retries = 0, retryDelay = 250, fetch})`: `add(name, load, {retries, weight, onSuccess, onError})` and the helpers `addText`, `addJSON`, `addBinary` (progress from `Content-Length`) and `addImage`. Names are unique. A failing task is attempted again `retries` times with `retryDelay * 2^(n-1)` ms between attempts. `run(signal)` resolves with `{done, failed, cancelled, ok}` and never rejects for a task; aborting `signal` cancels what is running and what is pending. Events (`on` returns the unsubscribe function): `success` and `error` per task, `progress` (`{fraction, finished, total, task}`, weighted by `weight`) and `finish`. `retryFailed()` sets the failed and cancelled tasks back to pending and runs them.
- `AssetRegistry({loadURL, dispose, onMissing})`: `define(key, urlOrFunction, type)`, `fromJSON(map)` and `toJSON()`, `load(key, signal)` (one load shared by every caller; the value is kept), `get`, `has`, `keys`, `subscribe(key, callback)` (called with the value now if loaded, and after every load, reload and swap: assign the value to a material's texture slot there and every material that uses the key follows a swap), `swap(key, source)`, `reload(key)`, `unload(key)` (drops the value, keeps the definition), `loadMap(objectOrURLOrBlob, {signal, fetch, allowedURLs, baseURL, maxBytes = 1 MiB})` (a JSON asset map from an object, a URL or a `File`; the shape is checked and a bad entry throws a coded `TypeError`; each entry resolves against the map's own URL, or `baseURL` for an object or file, and must stay in that directory or under `allowedURLs`, as in the glTF loaders; `data:` entries pass; a redirect out of the directory is refused; `fetch` is the same injectable fetch the loaders take, also the registry's default for URLs), `remove(key)` and `dispose()`. `swap` cancels a load in flight, loads the new source at once when the key is loaded or watched (otherwise the next `load` does), then calls `dispose` on the old value and `subscribe`rs with the new one. `onMissing(key, 'undefined' | 'failed', error)` may return a replacement source; the registry tries it once, and `load` rejects when it returns nothing. Without `loadURL` the registry fetches a URL and reads it as `type`: `'json'`, `'text'`, else bytes.
- Reference counts, preload groups and templates are in the optional `@margoengine/scene/asset-pools` entry below, so a registry that only defines, loads and swaps keys does not carry them.

## Asset pools (`@margoengine/scene/asset-pools`)

`AssetPool` is an `AssetRegistry` (everything above works the same on it) that also counts references, preloads groups and builds templates. Import it from `margoengine/scene/asset-pools`; `AssetRegistry` and `AssetQueue` stay in `scene/assets` (the pool entry re-exports their types, not the classes). `acquire(key, signal?)` is `load` plus one reference, `release(key)` gives one back and at 0 disposes the value (the `dispose` option, else its `Symbol.dispose`) and unloads it, keeping the definition; `refCount(key)`. `defineGroup(name, keys)`, `preload(name, {signal, onProgress, concurrency, retries, retryDelay})` (an `AssetQueue` underneath: it resolves with `{done, failed, cancelled, ok}`, each loaded key holds one reference, a repeat call finishes only what is missing) and `releaseGroup(name)`. `defineTemplate(name, build, {needs, ownsRoot})` and `instantiate(name, overrides?, signal?)`: `build({assets, signal, instantiate})` makes the prototype tree once (after acquiring `needs`), and each instance is a `cloneSubtree` copy that shares geometry and materials; `overrides` is `{name, position, rotation, scale, visible, parent, material, userData, apply}`, applied to the copy only. `releaseTemplate(name)` disposes the prototype tree (unless `ownsRoot: false`) and releases `needs`; `removeTemplate(name)` also forgets it. Core keeps a geometry's GPU data while any mesh uses it, so instances outlive the prototype and the asset. `AssetPool(options)` takes the registry's options. A release past 0, an unknown key, group or template, and a template that reaches itself throw coded errors ([help](https://margoengine.com/errors#scene-registry)). Hide a prototype you do not want drawn (`root.visible = false`): instances copy `visible`.

```ts
import {box, Engine, PbrMaterial} from '@margoengine/core';
import {AssetPool} from 'margoengine/scene/asset-pools';

const engine = await Engine.create(document.querySelector('canvas')!);
const registry = new AssetPool<{size: number}>();
registry.define('crate-size', () => ({size: 1}));
registry.defineGroup('level', ['crate-size']);
registry.defineTemplate('crate', ({assets}) => {
  const root = engine.createMesh().setGeometry(box(assets['crate-size'].size, 1, 1)).setMaterial(new PbrMaterial({color: '#a0703c'}));
  root.visible = false; // the prototype itself is not drawn
  return root;
}, {needs: ['crate-size']});

await registry.preload('level', {onProgress: ({finished, total}) => console.log(`${finished}/${total}`)});
const one = await registry.instantiate('crate', {position: [0, 0, 0], visible: true});
const two = await registry.instantiate('crate', {position: [2, 0, 0], visible: true, material: new PbrMaterial({color: '#c03030'})});
console.log(registry.refCount('crate-size')); // 2: the group and the template
two.dispose();
registry.releaseTemplate('crate'); // `one` keeps drawing: it still uses the shared geometry
registry.releaseGroup('level'); // 0 references: the asset is disposed
engine.start();
```
- Sources: reference counting, Collins, "A method for overlapping and erasure of lists", Communications of the ACM 1960 (https://doi.org/10.1145/367487.367501); the asset-manager pattern with counted handles in Gregory, *Game Engine Architecture* (3rd ed., 2018), chapter 7, "Resources and the file system"; ECMAScript explicit resource management (`Symbol.dispose`, https://github.com/tc39/proposal-explicit-resource-management).
- Not here: the visual loading screen (`@margoengine/ui` draws one from `progress`) and loading engine objects (use `loadContainer` above, or pass `(url, signal) => loadGLTF(...)` as a task).

## Typed events (`@margoengine/scene/emitter`)

`Emitter<Events>` is a small typed event emitter that follows the conventions of the web platform: `AbortSignal` and `once` on subscription, an unsubscribe function, `for await` over events, and `Symbol.dispose`. Use it for your own events; the existing `SceneEvents`, `AssetQueue.on` and tag sets are unchanged.

```ts
import {Emitter} from 'margoengine/scene/emitter';

type Events = {hit: {target: string; damage: number}; reset: undefined};
const events = new Emitter<Events>({onError: (error, type) => console.error('listener failed on', type, error)});

const stop = new AbortController();
events.on('hit', ({target, damage}) => console.log(target, damage), {signal: stop.signal});
events.once('reset', () => console.log('first reset only'));

const feed = events.events('hit', {capacity: 8, signal: stop.signal}); // async iterator
const reading = (async () => {
  for await (const hit of feed) console.log('queued', hit.target);
})();

events.emit('hit', {target: 'crate', damage: 3});
events.emit('reset', undefined);
console.log(feed.dropped); // 0: events lost to a full buffer
stop.abort(); // removes the listener and ends the iterator
await reading;
events.dispose(); // or `using events = new Emitter<Events>()`
```

- `on(type, fn, {signal, once})` returns an idempotent unsubscribe function; `once(type, fn, {signal})`, `off(type, fn)`, `emit(type, event)` (returns how many listeners ran) and `listenerCount(type?)`.
- Listeners run synchronously in subscription order. A listener added during an emit first sees the next event; one removed during an emit is not called.
- A listener that throws does not stop the others. The error goes to `onError(error, type)` from the constructor; without it the error is rethrown in a microtask so it is never lost.
- `events(type, {signal, capacity = 64})` returns an async iterator of the events emitted after the call. Events wait in a buffer of `capacity`; when it is full the oldest unread event is dropped and counted in `iterator.dropped` (a reader that keeps up never loses one). `return()` (also from `break` in `for await`), the signal and `dispose` end it: a pending `next()` resolves as done and unread events are discarded. `iterator.closed` says whether it ended.
- `dispose()` / `Symbol.dispose` removes every listener and ends every iterator; the emitter stays usable.
- Errors: a listener that is not a function and a capacity that is not an integer of 1 or more throw coded errors ([help](https://margoengine.com/errors#scene-emitter)).

Sources: the observer pattern (Gamma, Helm, Johnson, Vlissides, *Design Patterns*, 1994); the WHATWG DOM Standard, "Interface EventTarget" and "AbortSignal" (https://dom.spec.whatwg.org/); ECMAScript 2018 async iteration, `AsyncIterator` and `for await...of` (https://tc39.es/ecma262/#sec-asynciterator-interface); explicit resource management, `Symbol.dispose` (https://github.com/tc39/proposal-explicit-resource-management).

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
