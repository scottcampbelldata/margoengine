import { PbrMaterial, box } from '../../core/dist/index.js';
import { fakeIndexedDB } from './fakes.js';
import { lifetimeFault, ownedByEngine, watchTimers } from '../../../tests/support/owner-shell.js';

export async function fixtures(load = (entry) => import(entry)) {
  const { memoryStorage, indexedDBStorage } = await load('../dist/index.js');
  const { SaveSlots } = await load('../dist/slots.js');
  const { captureScene, restoreScene } = await load('../dist/engine.js');
  const document = {
    format: 'margo-save',
    version: 2,
    meta: { title: 'owner' },
    entities: [{ id: 'player', components: { name: 'owner' } }],
  };
  const autosave = (name, withSignal) => ({
    name,
    create({ scene }) {
      // The app's signal outlives the timer: its abort listener goes with the timer, and the next tick is cleared.
      const controller = new AbortController(),
        timers = watchTimers();
      const slots = new SaveSlots(memoryStorage());
      const timer = timers.scope(() =>
        slots.autosaveEvery(60_000, () => document, withSignal ? { signal: controller.signal } : {}),
      );
      if (!timers.pending.size) lifetimeFault('an autosave timer arms its first tick');
      return ownedByEngine(scene, name, () => timers.scope(() => timer.stop()), {
        cleanup: () => timers.expectNone('a stopped autosave timer'),
      });
    },
  });
  return [
    autosave('SaveSlots.autosaveEvery', false),
    autosave('SaveSlots.autosaveEvery.signal', true),
    {
      // The database connection is the storage's to release: nothing else can close it.
      name: 'indexedDBStorage',
      async create({ scene }) {
        const idb = fakeIndexedDB(),
          connections = [],
          open = idb.open.bind(idb);
        idb.open = (...args) => {
          const request = open(...args);
          let result;
          Object.defineProperty(request, 'result', {
            get: () => result,
            set: (db) => {
              result = db;
              connections.push(db);
            },
          });
          return request;
        };
        const live = (db) => {
          try {
            db.transaction('saves', 'readonly');
            return true;
          } catch {
            return false;
          }
        };
        const storage = indexedDBStorage({ factory: idb });
        await storage.write('slot-1', new Uint8Array([1]));
        if (!connections.length || !live(connections.at(-1)))
          lifetimeFault('indexedDBStorage holds a connection after a write');
        return ownedByEngine(scene, 'indexedDBStorage', () => storage.close(), {
          async cleanup() {
            await storage.close();
            if (connections.some(live)) lifetimeFault('a closed indexedDBStorage leaves its database connection open');
          },
        });
      },
    },
    {
      // restore builds meshes in the engine: the app owns them, and releasing them must leave the engine as it was.
      name: 'restoreScene',
      async create({ engine, scene }) {
        const source = scene
          .createMesh()
          .setGeometry(box(1, 1, 1))
          .setMaterial(new PbrMaterial());
        const saved = captureScene(engine, { scene });
        source.dispose();
        const before = engine.meshes.size;
        const restored = await restoreScene(engine, saved, { scene });
        if (!restored.meshes.size) lifetimeFault('restoreScene makes the saved meshes');
        return ownedByEngine(scene, 'restoreScene', () => {
          for (const mesh of [...restored.meshes.values()].reverse())
            if (engine.meshes.get(mesh.id) === mesh) mesh.dispose();
          for (const model of restored.models.values()) model.dispose();
          if (engine.meshes.size > before)
            lifetimeFault('disposing what restoreScene made leaves meshes in the engine');
        });
      },
    },
  ];
}
