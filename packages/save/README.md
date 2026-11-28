# @margoengine/save

Import `margoengine/save` from the `margoengine` package, or `@margoengine/save` from this package alone; the two are the same module. Neither is on npm yet: the [Install](../../README.md#install) section lists the two routes that work today (run in a clone, or install local tarballs).

Save games, scene files and prefabs: a versioned JSON document of entities with stable ids, components and
references; prefab definitions with instances, overrides and nesting; a tested migration registry for schema
changes; validation that names every problem and its fix; loading into your world that is all or nothing; optional
gzip; and storage adapters for memory, localStorage, IndexedDB and files behind one promise-based interface with
AbortSignal.

```ts
import { Migrations, loadGame, memoryStorage, saveGame, type SaveDocument } from 'margoengine/save';

const level: SaveDocument = {
  format: 'margo-save',
  version: 2,
  meta: { title: 'Chapter 1', playTime: 754 },
  prefabs: {
    door: {
      entities: [
        { id: 'frame', components: { mesh: 'door.glb', locked: false } },
        { id: 'handle', parent: 'frame', components: { opens: { $ref: 'frame' } } },
      ],
    },
  },
  entities: [
    { id: 'player', transform: { position: [0, 0, 0] }, components: { health: { hp: 80, max: 100 }, target: { $ref: 'gate' } } },
    { id: 'gate', prefab: 'door', transform: { position: [0, 0, -8] }, components: { locked: true } },
  ],
};

const storage = memoryStorage(); // or webStorage(), indexedDBStorage(), fileStorage('./saves') from margoengine/save/node
await saveGame(storage, 'slot-1', level); // validated, gzipped where CompressionStream exists, written in one step

const migrations = new Migrations(2).register(1, (old) => ({ ...old, version: 2 }));
const loaded = await loadGame(storage, 'slot-1', { migrations }); // decoded, migrated, validated; null when empty
```

`indexedDBStorage()` keeps one database connection open while the storage is in use. Call `await storage.close()` (or declare it with `using`) when you are done with saving; it is safe to call twice, and the next call opens the database again.

## The document

`{format: 'margo-save', version, entities, prefabs?, meta?}`. `version` is your schema version. Each entity has a
stable `id`, and optionally a `name`, a `parent` (an id), a local `transform` (`position`, unit-quaternion
`rotation`, `scale`) and `components`: any JSON by component name. A reference to another entity is
`{"$ref": "id"}` anywhere inside a component; references, parents and prefab overrides all use ids, so a save
survives reordering and stays diffable.

## Prefabs

A prefab is a list of entities with ids local to it; its `root` (default the first) becomes the instance. An entity
with `prefab: 'door'` expands to the prefab's entities: the root merged into the instance (the instance's own
components, name, transform and parent win), and the others as `gate/handle`, `gate/...`, with their parents and
local references re-pointed at the copies. `overrides` change the copies by prefab-local id as JSON Merge Patches
(RFC 7386: objects merge, other values replace, `null` removes a key), and a `parent` or `$ref` inside an override
names a prefab-local id, like the override's key; `null` for a whole entity removes it and its children. Prefabs may contain instances of other prefabs (ids like `cart/load/lid`), without cycles, up to 32
deep.

```ts
import { expandSave, parseSave } from 'margoengine/save';

const flat = expandSave(parseSave({
  format: 'margo-save',
  version: 1,
  prefabs: { crate: { entities: [{ id: 'box', components: { mass: 2 } }, { id: 'lid', parent: 'box', components: {} }] } },
  entities: [{ id: 'c1', prefab: 'crate', overrides: { lid: { components: { colour: 'red' } } } }],
}));
// [{ id: 'c1', components: { mass: 2 }, ... }, { id: 'c1/lid', parent: 'c1', components: { colour: 'red' }, ... }]
```

## Loading into a world, all or nothing

```ts
import { loadWorld, type WorldAdapter } from 'margoengine/save';

const scene = new Map<string, { id: string; components: Record<string, unknown> }>();
const adapter: WorldAdapter<{ id: string; components: Record<string, unknown> }> = {
  create: (entity) => ({ id: entity.id, components: entity.components }), // build off-screen
  commit: (handles) => {
    scene.clear();
    for (const [id, object] of handles) scene.set(id, object); // swap the new world in
  },
  destroy: () => {}, // undo one create
};
loadWorld({ format: 'margo-save', version: 1, entities: [{ id: 'a' }, { id: 'b', parent: 'a' }] }, adapter);
```

`loadWorld(document, adapter, {migrations, components, signal})` validates, migrates and expands everything before
building anything, then calls `create` for every entity (parents first), `link` for every entity once all exist
(with `resolve(id)` for references) and `commit` once. If any step throws or the signal aborts, it calls `destroy` for
everything built, latest first, and throws `MargoError` `'failed'` with the cause: a bad file never leaves a
half-loaded world.

For an `@margoengine/ecs` World, `saveEcs(world, components)` writes the entities that hold the named components and
`ecsAdapter(world, components)` loads them back; a value that does not fit a field (a fraction in an `Int32Array`
field) undoes the whole load.

```ts
import { World } from 'margoengine/ecs';
import { ecsAdapter, loadWorld, saveEcs } from 'margoengine/save';

const world = new World(1024);
const position = world.component({ x: Float32Array, y: Float32Array });
position.add(world.create(), { x: 3, y: 4 });
const snapshot = saveEcs(world, { position });
const copy = new World(1024);
const copyPosition = copy.component({ x: Float32Array, y: Float32Array });
loadWorld(snapshot, ecsAdapter(copy, { position: copyPosition }));
```

## Saving a running scene

`@margoengine/save/engine` needs no mapping. `captureScene(engine)` reads the scene as it stands and gives a save
document; `restoreScene(engine, document)` puts it back.

```ts
import { Engine, box } from 'margoengine/core';
import { loadGame, memoryStorage, saveGame } from 'margoengine/save';
import { captureScene, restoreScene } from 'margoengine/save/engine';

const engine = await Engine.create(document.createElement('canvas'));
const crate = engine.createMesh().setGeometry(box()).setPosition([0, 1, 0]);
crate.name = 'crate';

const storage = memoryStorage();
await saveGame(storage, 'slot-1', captureScene(engine, { meta: { title: 'Chapter 1' } }));

crate.setPosition([5, 0, 0]);
const { meshes, meta } = await restoreScene(engine, await loadGame(storage, 'slot-1'));
console.log(meshes.get('crate')?.position.y, meta.title); // 1 'Chapter 1'
```

What it saves:

| Part | Saved as |
| --- | --- |
| A mesh | Its name, parent, local transform, geometry, material, `visible` and `receiveShadow`. Meshes that share a geometry or a material share one again. |
| A glTF model | Its URL (`model.asset.baseURL`), the material variant, and only the nodes that differ from the file. A mesh hanging from a node stays on that node. A URL used twice loads once, and the rest are `cloneModel` copies. |
| The view | The camera, the scene's lighting and its background. `camera: false` leaves the camera alone. |
| A plugin | Its own `saveState()` and `loadState(state)` when it has them, else its JSON `options` and every property with both a getter and a setter. |

A mesh's id is its name, or its name with a number when two share one, and it stays the same across saves (`meshId`).

Plugins keep much of their state in public fields, which the default cannot tell from private ones, so name those,
or write the two functions:

```ts
import { Engine } from 'margoengine/core';
import { captureScene, restoreScene } from 'margoengine/save/engine';

const engine = await Engine.create(document.createElement('canvas'));
const weather = { name: 'weather', rain: 0.5, setup() {} };
const score = { name: 'score', points: 12, setup() {} };
engine.use(weather).use(score);

const plugins = {
  weather: { properties: ['rain'] }, // these fields, in place of the default
  score: { save: (p: typeof score) => p.points, load: (p: typeof score, state: unknown) => void (p.points = state as number) },
  debugOverlay: null, // leave this one out
};
const saved = captureScene(engine, { plugins, onSkip: (plugin) => console.warn('nothing saved for', plugin.name) });
weather.rain = 0;
await restoreScene(engine, saved, { plugins });
console.log(weather.rain); // 0.5
```

A plugin in the save and not in the scene needs `type` in its binding (`{ type: Sky }`), which attaches it with the
saved options; without one the save is refused before anything changes. So is a damaged `meta.engine`: a camera the
engine would refuse each frame (fov outside 0 to 180, near at 0 or below, far not past near, position at the target,
up along the view), lighting arrays of another length than the scene's, or a background that is not a string or null.

With `scene`, factories receive the real engine inside that scene's setup scope, so `use`, `createMesh`, lighting
and passes belong to the target scene. State callbacks and rollback run in the same scope. A factory that throws
after attaching plugins has those registrations removed in reverse order. Rollback checks instance identity and
preserves a later replacement. Factories must dispose their own resources; binding callbacks must undo their own
effects beyond the saved plugin state.

```ts
import { Engine, type EngineKernel } from 'margoengine/core';
import { captureScene, restoreScene } from 'margoengine/save/engine';

const engine = await Engine.create(document.createElement('canvas'));
const scene = engine.createScene('restored');
const type = {
  attach(host: EngineKernel) {
    const plugin = { name: 'score', points: 0, setup() {} };
    host.use(plugin);
    return plugin;
  },
};
type.attach(engine).points = 12;
const plugins = { score: { type, properties: ['points'] } };
const saved = captureScene(engine, { plugins });
await restoreScene(engine, saved, { scene, plugins });
console.log(engine.sceneOf(scene.plugins.get('score')!) === scene); // true
engine.dispose();
```

`restoreScene` is all or nothing. It checks the whole save, loads the models out of sight and builds every mesh, and
only then applies plugin state, camera and lighting and removes what the scene held. A model that fails to load, a
throw from `onEntity` or a plugin, or an abort leaves the running scene as it was, and `signal` stops it. `filter`
keeps a mesh and all under it out of a capture and out of what a restore removes, such as your UI; `clear: false` adds
to the scene. `components(mesh)` adds your own data, and `onEntity(mesh, entity, get)` reads it back. Other options:
`scene`, `version`, `meta`, `migrations`, `modelURL` for a model not loaded from a URL, `load` and `clone`.

Geometry is written into the save, so a large static mesh is better as a glTF model, which saves as a URL.

### Animation, lights and shadows (`@margoengine/save/scene-state`)

`captureScene` saves meshes, models, the view and plugins. `captureSceneState(bindings)` adds what plays on top of
them: animation players, light lists and shadow settings, each under a stable id you choose. It writes plain JSON and
no GPU objects; `restoreSceneState(state, bindings)` puts the values back onto objects you have already loaded and
bound under the same ids.

| Binding | What fits | Saved |
| --- | --- | --- |
| `animations` | anything with `captureState()` and `restoreState(state)`: `Animation`, `AnimationMixer` (`@margoengine/animation`), `AnimatorGraph` (`@margoengine/animator`) | the player's own state: clip times, blend parameters, weights, masks, fades and triggers |
| `lights` | anything with `list` and `setLights(list)`: `Clustered`, `DirectionalLights`, `AreaLights` and the other `@margoengine/clustered` light sets | every light in `list`, with its per-light shadow settings |
| `shadows` | a mutable settings object, such as `Shadows.options` (`@margoengine/shadows`) | its own properties |

```ts
import { captureSceneState, restoreSceneState } from 'margoengine/save/scene-state';

// Stand-ins with the same shape as an Animation, a Clustered light set and Shadows.options.
let walk = { clip: 'walk', time: 1.25, weight: 1 };
const hero = { captureState: () => ({ ...walk }), restoreState: (s: typeof walk) => void (walk = { ...s }) };
let list = [{ type: 'point', position: [0, 2, 0], intensity: 40, castShadow: true }];
const lamps = { get list() { return list; }, setLights: (l: typeof list) => void (list = l.map((x) => ({ ...x }))) };
const sun: Record<string, number> = { mapSize: 2048, cascades: 3, bias: 0.0005 };
const bindings = { animations: { hero }, lights: { lamps }, shadows: { sun } };

const state = captureSceneState(bindings);
const text = JSON.stringify(state); // { version: 1, animations: { hero: ... }, lights: { lamps: [...] }, shadows: { sun: ... } }

walk.time = 9;
list = [];
sun.mapSize = 512;
sun.extra = 1;
restoreSceneState(JSON.parse(text), bindings);
console.log(walk.time, list.length, sun.mapSize, 'extra' in sun); // 1.25 1 2048 false

// All or nothing: a binding that throws undoes the ones applied before it.
let failOnce = true;
const flaky = { list: [], setLights: () => { if (failOnce) { failOnce = false; throw new Error('lost'); } } };
walk.time = 3;
try {
  restoreSceneState(state, { ...bindings, lights: { lamps: flaky } });
} catch (e) {
  console.log((e as Error).message, walk.time); // 'lost' 3: the animation was put back
}
try {
  restoreSceneState(state, { lights: { lamps }, shadows: { sun } });
} catch (e) {
  console.log((e as Error).message); // "Missing animations binding 'hero'; load and bind that object before restoring"
}
```

- Every id in the state needs its binding (an own property of `bindings.animations`, `lights` or `shadows`), or the
  restore throws a `MargoError` with code `'state'` before anything changes. Bindings the state does not name are left
  alone, so a newer scene can bind more than an older save holds.
- Values must be JSON: finite numbers, strings, booleans, `null`, arrays, typed arrays (saved as arrays) and plain
  objects. A function, `Map`, class instance, `NaN`, infinity or a cycle throws on capture, so a callback or GPU
  resource never lands in a save; bind its portable settings instead. Keys such as `__proto__` and `constructor`
  round-trip as ordinary keys and never change an object's prototype.
- A shadow restore replaces the settings object's own properties: keys the save does not hold are removed, and the
  object keeps its identity and prototype. A light restore calls `setLights` with the saved list.
- Restore applies every animation, then every light set, then every shadow setting, each in the order of the state. If one throws, those
  already applied are put back to what they held before the call, last first, and the error is rethrown; if putting
  one back throws too, you get an `AggregateError` with every failure. A state whose `version` is not 1 throws.

### Materials (`@margoengine/save/materials`)

`captureMaterials(materials, options)` saves named materials as a `MaterialLibrary`: each material's kind, every factor,
its maps with their samplers and per-slot UV sets, render state and shader parameters. A texture or other object used
by several materials is saved once and shared again on restore. `restoreMaterials(library, options)` builds new
materials and textures; put them on the loaded scene's meshes.

```ts
import { PbrMaterial, Texture } from 'margoengine/materials';
import { captureMaterials, restoreMaterials } from 'margoengine/save/materials';

const pixels = new Texture({ width: 2, height: 2, data: new Uint8Array(16).fill(200) });
const red = new PbrMaterial({ color: [1, 0, 0, 1], roughness: 0.4, map: pixels });
const blue = new PbrMaterial({ color: [0, 0, 1, 1], map: pixels });

const library = await captureMaterials({ red, blue });
const text = JSON.stringify(library); // plain JSON: { version: 1, materials: { red, blue }, objects: [...] }

const restored = await restoreMaterials(JSON.parse(text), { expect: { red: PbrMaterial, blue: PbrMaterial } });
const { red: red2, blue: blue2 } = restored; // both typed PbrMaterial, no cast
console.log(red2 instanceof PbrMaterial, red2.roughness); // true 0.4
console.log(red2.map === blue2.map); // true: still one texture
```

- `expect` names the class each material must be. The result is typed by it, and the restore checks it: a name that is
  missing or of another class throws a `MargoError` with code `'state'` and disposes everything the restore made.
  Without `expect` the result is `Record<string, object>`, one entry per saved name.

- Texture pixels are embedded by default. `textureURL(texture)` returns a URL (or a list of six for a cube) to save
  in their place; restore downloads it with `fetch` (default the global one) within `limits`, the download and decode
  caps, which only the restore's caller sets, never the file.
- A value of a type no codec knows, such as a callback or your own resource, throws a `MargoError` with code `'state'`.
  `externalKey(value)` names it instead, and on restore `resolveExternal(key, { signal })` hands back your object.
- `codecs` adds your own `MaterialValueCodec`s (`type`, `test`, `capture`, `restore`). Shader materials
  (`@margoengine/shader`) load their codecs only when the library holds one, so a save without them never downloads
  the shader package; `loadCodecs` replaces that loader.
- `signal` stops a capture or restore. A restore that fails or is aborted disposes every material and texture it had
  made.

## Change recorder (`@margoengine/save/delta`)

`diffSave(base, edited)` is what a user changed in a loaded scene, as a small JSON delta; `applyDelta(base, delta)` puts it back on the base. Changed entities are JSON Merge Patches (RFC 7386, as prefab overrides already are), added entities are whole, removed ones are ids, and `meta` is patched too. Keep the delta instead of the whole document: it stays valid while the shipped base changes elsewhere, and it is a few lines of JSON.

```ts
import {diffSave, applyDelta, SaveRecorder} from 'margoengine/save/delta';

const door = {id: 'door', transform: {position: [1, 0, 0] as const}, components: {hinge: {angle: 0}}};
const base = {format: 'margo-save' as const, version: 1, entities: [door, {id: 'crate'}]};
// The player opened the door and smashed the crate.
const edited = {...base, entities: [{...door, components: {hinge: {angle: 90}}}]};

const delta = diffSave(base, edited);
console.log(JSON.stringify(delta.changed), delta.removed); // {"door":{"components":{"hinge":{"angle":90}}}} ["crate"]
console.log(applyDelta(base, JSON.parse(JSON.stringify(delta))).entities.length); // 1

const recorder = new SaveRecorder(base); // measures from its base; commit(current) moves the base forward
console.log(recorder.changes(edited).removed);
```

- `diffSave(base, edited)`: entities are matched by id; reordering the list is not recorded. A merge patch cannot store `null` (it means remove), so a changed value holding `null` throws a `TypeError` naming its path. Duplicate ids throw.
- `applyDelta(base, delta, {validate = true, components, strictComponents})`: pure; throws a `TypeError` when the delta removes or changes an id the base lacks, adds one it has, was made for another `version`, or (with `validate`) leaves an invalid document, which `parseSave` names.
- `SaveRecorder(base)`: `changes(current)`, `commit(current)`, `apply(delta)` and `base`. `isEmptyDelta(delta)` tells a no-op.
- A delta is made from the document shape (`captureScene(engine)` of `@margoengine/save/engine` makes it), not by watching the running scene: take the current document with the engine's save functions, then diff it.

## Save slots

`@margoengine/save/slots` puts a load screen over any storage. A slot holds a save, a small record of what it is and a
thumbnail, and `list()` reads the records alone, so a load screen opens without reading one save.

```ts
import { memoryStorage, type SaveDocument } from 'margoengine/save';
import { SaveSlots } from 'margoengine/save/slots';

const game = (title: string): SaveDocument => ({ format: 'margo-save', version: 1, meta: { title }, entities: [] });

const slots = new SaveSlots(memoryStorage()); // or indexedDBStorage(), fileStorage('./saves')
await slots.save('slot-1', game('Chapter 2'), { playTime: 754, meta: { level: 3 } });
for (let i = 0; i < 5; i++) await slots.autosave(game(`Autosave ${i}`)); // a ring of 3, oldest first

for (const slot of await slots.list()) console.log(slot.id, slot.title, new Date(slot.savedAt), slot.meta);

const newest = await slots.latest(); // what a Continue button loads, autosaves included
const loaded = newest && (await slots.load(newest.id)); // as loadGame: pass migrations here
console.log(loaded?.meta?.title); // Autosave 4
```

For a thumbnail, take the canvas right after a frame, in the same task: a WebGPU canvas keeps its picture only until the
frame is shown. `slots.thumbnail(id)` gives it back as a Blob.

```ts
import { Engine, box } from 'margoengine/core';
import { memoryStorage } from 'margoengine/save';
import { captureScene } from 'margoengine/save/engine';
import { SaveSlots, captureThumbnail } from 'margoengine/save/slots';

const engine = await Engine.create(document.createElement('canvas'));
engine.createMesh().setGeometry(box());
const slots = new SaveSlots(memoryStorage());

engine.render();
const thumbnail = await captureThumbnail(engine.canvas, { width: 320 }); // WebP where the browser has it, else PNG
await slots.save('slot-1', captureScene(engine, { meta: { title: 'Chapter 2' } }), { thumbnail });

const picture = await slots.thumbnail('slot-1');
if (picture) document.body.append(Object.assign(new Image(), { src: URL.createObjectURL(picture) }));
```

`autosaveEvery(milliseconds, capture, { onError })` runs the ring on a timer: `capture` returns the document, or null
to skip a turn in a menu or a cutscene, and the result has `stop()` and works with `using`. An autosave never touches a
player's slot, and `auto-` ids are refused in `save` and as the target of `copy`.

| Option | Default | What it does |
| --- | --- | --- |
| `namespace` | `'slot'` | Keeps profiles apart in one storage. |
| `autosaves` | `3` | How many autosaves take turns. |
| `now` | `Date.now` | The clock for `savedAt`. |
| `compress`, `validate` | as `saveGame` | Passed to each save. |

Also `info(id)`, `copy(from, to)` and `delete(id)`. Writes run one at a time, in call order, and every call takes
`signal`.

A slot's files carry a generation in their keys, and writing its record is the one step that switches to them. A failed
write or a crash before that leaves the old slot whole, with some unused files that the next save clears. A record that
cannot be read shows in `list()` with `damaged: true`, and `save` or `delete` replaces it.

## Safe writes

`safeStorage` from `@margoengine/save/safe` wraps any storage so a failed or torn write never loses the last good save,
and damage is found on read. Each key keeps two copies, `key~a` and `key~b`, each with a generation and a CRC-32. A write
only ever goes over the copy that is not the newest good one, and is read back to check it. A read gives the newest good
copy. Generations are 64-bit: a write at the last one, 2^64 - 1, rejects with MargoError `'failed'` before any copy
changes, and `check` rejects a generation above 2^53 - 1 that a number cannot hold exactly (`read` still loads it).

```ts
import { loadGame, memoryStorage, saveGame, type SaveDocument } from 'margoengine/save';
import { safeStorage } from 'margoengine/save/safe';

const disk = memoryStorage(); // or indexedDBStorage(), fileStorage('./saves')
const storage = safeStorage(disk, { onRecover: ({ key, reason }) => console.warn(key, 'fell back:', reason) });
const game = (title: string): SaveDocument => ({ format: 'margo-save', version: 1, meta: { title }, entities: [] });

await saveGame(storage, 'slot-1', game('older'));
await saveGame(storage, 'slot-1', game('newer'));

await disk.write('slot-1~b', new Uint8Array(10)); // what a torn write leaves
const save = await loadGame(storage, 'slot-1');
console.log(save?.meta?.title); // older
console.log(await storage.check('slot-1')); // { ok: true, good: 1, bad: 1, generation: 1 }
```

The result is a storage like any other, so `SaveSlots` runs over it. With both copies bad a read rejects with `MargoError`
`'failed'`; `check(key)` reports without changing anything, and the next write goes over the bad copy.

| Option | Default | What it does |
| --- | --- | --- |
| `verify` | `true` | Reads each write back and compares it; a mismatch rejects, and the last good save stands. |
| `legacy` | `false` | Reads a save from before this wrapper, stored plainly under `key`, unchecked. The next write moves it over. Off, such a save is refused. |
| `onRecover` | none | Called with `{key, copy, reason}` when a read passes over a bad copy. |

A write costs two reads, a write and a read back, and a key takes twice the room. The CRC finds accidents; it is no
signature, and someone editing a save can make a matching one.

## Signed saves

`signedStorage` from `@margoengine/save/signed` is `safeStorage` with an HMAC-SHA-256 tag on every copy, so an edited save
is refused instead of read. The tag covers the copy, its physical key and its generation. Pass a secret key of at least 32 random
bytes, or an HMAC-SHA-256 `CryptoKey` of 256 bits or more with `sign` and `verify` usages; the key is never saved. A forged or torn
newest copy goes to `onRecover` and the older signed copy is read. With no signed copy left a read rejects with `MargoError`
`'failed'`. WebCrypto is `crypto.subtle` unless you pass `options.subtle`; without it the call throws `'unsupported'`. Unsigned
legacy data is never accepted.

```ts
import { loadGame, memoryStorage, saveGame, type SaveDocument } from 'margoengine/save';
import { signedStorage } from 'margoengine/save/signed';

const disk = memoryStorage();
const key = crypto.getRandomValues(new Uint8Array(32)); // keep this secret outside the save, and the same between runs
const storage = signedStorage(disk, key, { onRecover: ({ key, reason }) => console.warn(key, 'fell back:', reason) });
const game = (title: string): SaveDocument => ({ format: 'margo-save', version: 1, meta: { title }, entities: [] });

await saveGame(storage, 'slot-1', game('older'));
await saveGame(storage, 'slot-1', game('newer'));

const copy = (await disk.read('slot-1~a')) ?? (await disk.read('slot-1~b'));
console.log(copy !== null); // true: the signed frame is on disk
await disk.write('slot-1~b', new Uint8Array(40)); // someone's edit, with no valid tag
const save = await loadGame(storage, 'slot-1');
console.log(save?.meta?.title); // older: the edited copy fails its tag
```

A non-extractable `CryptoKey` keeps the secret out of reach of page script, and `check` reports on both copies without
changing anything. A wrong key reads every copy as bad, the same as an edit; a key that is too short throws a `TypeError`
at once. A raw key is copied when the storage is made, so changing your array later does not change it.

```ts
import { loadGame, memoryStorage, saveGame } from 'margoengine/save';
import { signedStorage } from 'margoengine/save/signed';

const hmac = await crypto.subtle.generateKey({ name: 'HMAC', hash: 'SHA-256', length: 256 }, false, ['sign', 'verify']);
const disk = memoryStorage();
const keyed = signedStorage(disk, hmac);
await saveGame(keyed, 'slot-1', { format: 'margo-save', version: 1, entities: [] });
console.log(await keyed.check('slot-1')); // { ok: true, good: 1, bad: 0, generation: 1 }

const wrongKey = signedStorage(disk, crypto.getRandomValues(new Uint8Array(32)));
console.log(await wrongKey.check('slot-1')); // { ok: false, good: 0, bad: 2, generation: 0 }
await loadGame(wrongKey, 'slot-1').catch((error) => console.log(error.code)); // failed
```

Signing proves a save was written with your key; it does not encrypt it, and it cannot tell a copy from an older one
written under the same key and slot (a player can put back an old signed file). Anyone with the key in the page can sign.

## Browser file storage

`opfsStorage` from `@margoengine/save/opfs` keeps each save as one file in the origin private file system, with no size
limit of Web Storage and no database to open. A write goes to a temporary stream whose close swaps it into place, so a
failed or aborted write keeps the previous file. Operations on one key run in call order for one adapter; two tabs or
adapters on one key are last-close-wins. An abort is checked after each step and before the close, the point of no
return. Pass `namespace` to pick the directory (default `'margo-saves'`) or `directory` to give a handle you opened, as a
worker does. A browser without OPFS throws `MargoError` `'unsupported'`; a file with a damaged frame throws `'failed'`;
a key over 175 UTF-8 bytes is a `RangeError`.

```ts
import { loadGame, saveGame, type SaveDocument } from 'margoengine/save';
import { opfsStorage } from 'margoengine/save/opfs';

const storage = opfsStorage({ namespace: 'readme-saves' });
const game: SaveDocument = { format: 'margo-save', version: 1, meta: { title: 'OPFS' }, entities: [] };
await saveGame(storage, 'slot-1', game);
console.log((await loadGame(storage, 'slot-1'))?.meta?.title); // OPFS
console.log(await storage.keys()); // ['slot-1']
await storage.delete('slot-1');
```

Wrap it in `safeStorage` or `signedStorage` for two copies and tamper checks.

The adapter stores any bytes, not only save documents, and an empty save is a real save: each file is the bytes after a
5-byte header, so a committed empty write reads back as an empty `Uint8Array`, while a file left empty by a first write
that never closed (a tab closed mid-write) reads as `null` and is not in `keys()`. Keys may be any well-formed Unicode up
to 175 UTF-8 bytes; each is stored under a base64url file name, so `keys()` returns them as written, sorted.

```ts
import { opfsStorage } from 'margoengine/save/opfs';

const files = opfsStorage({ namespace: 'readme-binary' });
await files.write('thumbnail', new Uint8Array([137, 80, 78, 71]));
await files.write('empty', new Uint8Array(0));
console.log(await files.read('thumbnail'), (await files.read('empty'))?.length, await files.read('missing'));
// Uint8Array(4) [137, 80, 78, 71] 0 null

const late = new AbortController();
late.abort(new Error('player quit'));
await files.write('thumbnail', new Uint8Array([0]), { signal: late.signal }).catch((error) => console.log(error.message));
// player quit: aborted before the close, so the old file stays
console.log((await files.read('thumbnail'))?.length, await files.keys()); // 4 ['empty', 'thumbnail']
for (const key of await files.keys()) await files.delete(key);
```


## Cloud saves

`remoteStorage` from `@margoengine/save/remote` keeps saves on an HTTP server: GET, PUT and DELETE on
`${url}/${encodeURIComponent(key)}`, and GET on `url` for a JSON array of keys. A read remembers the key's ETag and a
write sends it as `If-Match`, so the server finds a save another device made in between, and `conflict` says what happens
then. `remoteHandler` is the other half: a server over any storage, as a function from a `Request` to a `Response`.

```ts
import { memoryStorage } from 'margoengine/save';
import { remoteHandler, remoteStorage } from 'margoengine/save/remote';

const server = remoteHandler(memoryStorage(), { base: '/saves' });
const fetch = async (input: RequestInfo | URL, init?: RequestInit) => server(new Request(input, init)); // or the network
const url = 'https://game.example/saves';
const bytes = (text: string) => new TextEncoder().encode(text);

const phone = remoteStorage({ url, fetch });
const laptop = remoteStorage({ url, fetch });
await phone.write('slot-1', bytes('level 1'));
await laptop.read('slot-1');
await phone.write('slot-1', bytes('level 2'));

await laptop.write('slot-1', bytes('level 1, with a side quest')).catch((error) => console.log(error.code)); // 'state'

const merging = remoteStorage({
  url,
  fetch,
  conflict: ({ local, remote }) => (remote && remote.length > (local?.length ?? 0) ? remote : local), // keeps the longer
});
await merging.write('slot-1', bytes('level 2 and more'));
console.log(new TextDecoder().decode((await phone.read('slot-1'))!)); // level 2 and more
```

| `conflict` | When the server's save is not the one this client last saw |
| --- | --- |
| `'error'` (default) | The write rejects with `MargoError` `'state'` and nothing changes. Read the key, then save again. |
| `'local'` | This write goes over it. |
| `'remote'` | The server's stays, and this write is dropped. |
| a function | Gets `{key, local, remote}` and returns the bytes to keep, or null for none. `local` is null for a delete and `remote` for a save deleted elsewhere. |

| Option | Default | What it does |
| --- | --- | --- |
| `url` | none | The folder of saves. |
| `fetch` | `globalThis.fetch` | How requests go out. |
| `headers` | none | Sent with each request. A function runs for each attempt, for a token that expires. |
| `timeout` | `30000` | Milliseconds for one attempt. |
| `retries` | `3` | Further attempts after a network failure, a timeout, a 408, a 429 or a 5xx, waiting as `Retry-After` says, up to a minute; longer, the call fails. |

A write that lost its answer and tried again gets a 412 from its own earlier write; the bytes on the server are then the
same, and it counts as done. A device that has never read a key cannot write over it: read first on a new device.

On Node, the handler needs a few lines around it:

```ts
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { fileStorage } from 'margoengine/save/node';
import { remoteHandler, remoteStorage } from 'margoengine/save/remote';

const handle = remoteHandler(fileStorage('./cloud-saves'), {
  base: '/saves',
  origin: 'https://game.example', // the page's origin, for CORS; leave it out for the same origin
  authorize: (request) => request.headers.get('authorization') === 'Bearer secret', // yours to write
});
const server = createServer(async (request, response) => {
  const body = request.method === 'PUT' ? { body: Readable.toWeb(request) as ReadableStream, duplex: 'half' } : {};
  const answer = await handle(new Request(`http://${request.headers.host}${request.url}`, { method: request.method, headers: request.headers as HeadersInit, ...body } as RequestInit));
  response.writeHead(answer.status, Object.fromEntries(answer.headers));
  response.end(Buffer.from(await answer.arrayBuffer()));
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

const { port } = server.address() as { port: number };
const storage = remoteStorage({ url: `http://127.0.0.1:${port}/saves`, headers: { authorization: 'Bearer secret' } });
await storage.write('slot-1', new Uint8Array([1, 2, 3]));
console.log(await storage.keys()); // ['slot-1']
await storage.delete('slot-1');
server.close();
```

With no `authorize`, anyone who reaches the handler can read and write every save, so a public server needs it. Other
options: `allowHeaders` for CORS and `maxBytes`, default 64 MiB, which a body is read only up to, sent with a length or
without one. Any other server works when it sends strong ETags and
honours `If-Match` and `If-None-Match`, and `keys()` needs its JSON list. Apache with mod_dav was tested: it sends no ETag
with a PUT, so a GET follows, and for about a second after a change it gives a weak tag, so a second write inside that
second is refused.

`safeStorage(remoteStorage(...))` and `SaveSlots` run over it.

## Validation and migrations

`validateSave(document, {components, strictComponents})` never throws and lists every problem with its path and fix
(`entities[3].parent: 'door' is not an entity of this document`): shape, duplicate ids, parent cycles, references,
unknown or cyclic prefabs, overrides of entities a prefab does not have, non-JSON values, and your component checks
(`components: {health: (v) => typeof v === 'object' ? null : 'must be {hp, max}'}`). `parseSave` returns a fresh
copy or throws a `TypeError` naming the first problem.

`new Migrations(latest).register(from, step)` holds one step per version; `migrate(document)` runs them in order on
a deep copy and checks each step returns the next version. A missing step, a step that throws or returns the wrong
version is `MargoError` `'failed'` naming it; a save newer than the game is a `RangeError`.

## Bytes and storage

`encodeSave(document, {compress, signal})` gives UTF-8 JSON, gzipped with `compress: true` (CompressionStream, in
browsers and Node 18+); `decodeSave(bytes, {signal, maxBytes})` reads either, and stops gzip data that decompresses past
`maxBytes` (default 268435456, 256 MiB) with a RangeError, so a small hostile file cannot fill memory. Storage adapters
share one interface, `read`, `write`,
`delete` and `keys`, each async with `{signal}`:

| Adapter | Where | Atomic write |
| --- | --- | --- |
| `memoryStorage()` | a Map (tests, servers, undo snapshots) | yes |
| `webStorage(storage = localStorage, prefix = 'margo-save:')` | Web Storage, base64; about 5 MB per origin | one `setItem` |
| `indexedDBStorage({database, store, factory})` | IndexedDB, binary, large; several stores in one database each get theirs (the database is opened one version up to add a store, and a connection closes when another needs a newer version) | one transaction |
| `opfsStorage({namespace, directory})` from `margoengine/save/opfs` | the origin private file system, one file per key | temporary stream swapped in on close |
| `fileStorage(directory, {maxBytes})` from `margoengine/save/node` | one file per key | temporary file, made exclusively, renamed into place; a read refuses a file past `maxBytes` (default 256 MiB) from its size, before reading it; one writer per folder; `keys()` lists only file names it writes; on Windows a save another program has open cannot be replaced, so the write rejects and the old save stands |

A full Web Storage or a failed transaction throws `MargoError` `'failed'` and keeps the previous save; a missing
API throws `'unsupported'`. `saveGame` never writes an invalid document.

Apache-2.0. Optional, tree-shakable package. Only `/engine` uses core, as an optional peer (`/slots`, `/safe` and `/remote` need none of them), with `@margoengine/gltf/pbr` and `@margoengine/animation` loaded when a save holds a model.

Build and unit tests: npm test --workspace @margoengine/save. Real GPU, models, thumbnails, IndexedDB and cross-origin fetch: npm run test:gpu --workspace @margoengine/save

### Scene of the result

`restoreScene`'s default model loader loads each model into the `scene` being restored, not into whichever scene is active when the load finishes. An abort or a failure leaves nothing in either scene.
