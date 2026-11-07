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
(RFC 7386: objects merge, other values replace, `null` removes a key); `null` for a whole entity removes it and its
children. Prefabs may contain instances of other prefabs (ids like `cart/load/lid`), without cycles, up to 32
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
saved options; without one the save is refused before anything changes.

`restoreScene` is all or nothing. It checks the whole save, loads the models out of sight and builds every mesh, and
only then applies plugin state, camera and lighting and removes what the scene held. A model that fails to load, a
throw from `onEntity` or a plugin, or an abort leaves the running scene as it was, and `signal` stops it. `filter`
keeps a mesh and all under it out of a capture and out of what a restore removes, such as your UI; `clear: false` adds
to the scene. `components(mesh)` adds your own data, and `onEntity(mesh, entity, get)` reads it back. Other options:
`scene`, `version`, `meta`, `migrations`, `modelURL` for a model not loaded from a URL, `load` and `clone`.

Geometry is written into the save, so a large static mesh is better as a glTF model, which saves as a URL.

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
browsers and Node 18+); `decodeSave(bytes)` reads either. Storage adapters share one interface, `read`, `write`,
`delete` and `keys`, each async with `{signal}`:

| Adapter | Where | Atomic write |
| --- | --- | --- |
| `memoryStorage()` | a Map (tests, servers, undo snapshots) | yes |
| `webStorage(storage = localStorage, prefix = 'margo-save:')` | Web Storage, base64; about 5 MB per origin | one `setItem` |
| `indexedDBStorage({database, store, factory})` | IndexedDB, binary, large | one transaction |
| `fileStorage(directory)` from `margoengine/save/node` | one file per key | temporary file renamed into place |

A full Web Storage or a failed transaction throws `MargoError` `'failed'` and keeps the previous save; a missing
API throws `'unsupported'`. `saveGame` never writes an invalid document.

Apache-2.0. Optional, tree-shakable package. Only `/engine` uses core, as an optional peer, with `@margoengine/gltf-pro` and `@margoengine/animation` loaded when a save holds a model.

Build and unit tests: npm test --workspace @margoengine/save. Real GPU, models and IndexedDB: npm run test:gpu --workspace @margoengine/save
