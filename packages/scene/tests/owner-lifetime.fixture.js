// Owner/lifetime fixture for @margoengine/scene. The package's objects are not engine plugins, and none of them touch the
// GPU. What it holds is on the engine and its meshes: SceneEvents wraps `createMesh`, `remove` and every mesh's `setParent`
// on the engine instance and listens on the app's AbortSignal; a TagSet is an EventTarget whose listeners (and signal
// subscriptions) belong to the app; a TransformWriter keeps the ids of a fixed mesh list; a clone shares its source's
// geometry and material. After disposal every wrapper must be gone, every listener released, the engine's own methods
// back as core made them, and the app's signal must outlive the object. extendMeshes() is not an entry: it is a one-off,
// idempotent patch of the shared mesh prototype that holds no handle, listener, timer or resource. The graph and index
// functions (children, parent, traverse, attach, localToWorld ...) are the 'hierarchy' entry's single owner (the meshes),
// which the scene or engine disposal releases.
import { box } from '../../core/dist/index.js';
import { ownedByEngine, lifetimeFault } from '../../../tests/support/owner-shell.js';

export async function fixtures(load = (entry) => import(entry)) {
  const { children, parent, traverse, userData, getWorldPosition } = await load('../dist/index.js');
  const { attach, find, findByName, removeFromParent, traverseVisible, localToWorld } = await load('../dist/graph.js');
  const { TransformWriter } = await load('../dist/bulk.js');
  const { cloneSubtree } = await load('../dist/clone.js');
  const { SceneEvents, tags, findByTag } = await load('../dist/tags.js');
  const { extendMeshes } = await load('../dist/mesh.js');
  extendMeshes();
  return [
    {
      // Wrappers on the engine instance and on each watched mesh, one listener on the app's signal. The same engine takes a
      // second observer once the first is gone, and the app's signal is left alone.
      name: 'SceneEvents',
      create({ engine, scene }) {
        const controller = new AbortController(),
          seen = [];
        const events = SceneEvents.attach(engine);
        const off = events.on('added', (event) => seen.push(event.type), { signal: controller.signal });
        const probe = scene.createMesh();
        if (seen.length !== 1) lifetimeFault('an attached observer reports a mesh made in the scene');
        let released = false;
        return ownedByEngine(
          scene,
          'SceneEvents',
          () => {
            released = true;
            events.dispose();
            off();
          },
          {
            cleanup() {
              probe.dispose();
            },
            check({ phase }) {
              if (phase !== 'disposed' || !released) return;
              if (Object.hasOwn(engine, 'createMesh') || Object.hasOwn(engine, 'remove'))
                lifetimeFault('a disposed observer leaves its wrappers on the engine');
              if (controller.signal.aborted) lifetimeFault('an observer aborts the app signal');
              // When the engine or the scene itself was disposed there is nothing left to make a mesh in.
              let probe2;
              try {
                probe2 = scene.createMesh();
              } catch {
                return;
              }
              const before = seen.length;
              probe2.dispose();
              if (seen.length !== before) lifetimeFault('a disposed observer still reports meshes');
              SceneEvents.attach(engine).dispose();
            },
          },
        );
      },
    },
    {
      name: 'SceneEvents.constructor',
      create({ engine, scene }) {
        const events = new SceneEvents(engine);
        const mesh = scene.createMesh();
        let removed = 0;
        events.on('removed', () => removed++, { mesh, once: true });
        mesh.dispose();
        if (removed !== 1) lifetimeFault('a once listener reports its mesh removal');
        return ownedByEngine(scene, 'SceneEvents.constructor', () => events.dispose());
      },
    },
    {
      // A TagSet listens for tag changes; its listener on a signal goes with the abort.
      name: 'tags',
      create({ scene }) {
        const controller = new AbortController(),
          mesh = scene.createMesh().setPosition([1, 2, 3]);
        const set = tags(mesh);
        const changes = [];
        const callback = () => changes.push(set.list().join());
        set.addEventListener('change', callback, { signal: controller.signal });
        set.add('a', 'b');
        if (changes.length !== 1 || findByTag(scene, 'a').length !== 1)
          lifetimeFault('a tag change is reported and found');
        return ownedByEngine(
          scene,
          'tags',
          () => {
            controller.abort();
            mesh.dispose();
          },
          {
            check({ phase }) {
              if (phase !== 'disposed') return;
              if (!controller.signal.aborted) lifetimeFault('the app aborts its own signal on release');
              if (changes.length !== 1) lifetimeFault('an aborted signal ends its tag listener');
            },
          },
        );
      },
    },
    {
      // The writer keeps the mesh ids; once a mesh is gone a write throws and changes nothing.
      name: 'TransformWriter',
      create({ scene }) {
        const meshes = [0, 1, 2].map(() => scene.createMesh()),
          writer = new TransformWriter(meshes);
        writer.write({ positions: new Float32Array([1, 0, 0, 0, 2, 0, 0, 0, 3]) });
        if (meshes[2].position.z !== 3) lifetimeFault('the writer writes the meshes it was given');
        let released = false;
        return ownedByEngine(
          scene,
          'TransformWriter',
          () => {
            released = true;
            for (const mesh of meshes) mesh.dispose();
          },
          {
            check({ phase }) {
              if (phase !== 'disposed' || !released) return;
              let threw = false;
              try {
                writer.write({ positions: new Float32Array(9) });
              } catch {
                threw = true;
              }
              if (!threw) lifetimeFault('a writer over disposed meshes refuses to write');
            },
          },
        );
      },
    },
    {
      // A clone shares its source's geometry and material: both go, and neither takes what the other holds with it.
      name: 'cloneSubtree',
      create({ scene }) {
        const root = scene.createMesh().setGeometry(box(1, 1, 1)),
          leaf = scene.createMesh(root).setGeometry(root.geometry);
        userData(leaf, { tag: 'leaf' });
        const copy = cloneSubtree(root);
        if (children(copy).length !== 1 || userData(children(copy)[0]).tag !== 'leaf')
          lifetimeFault('a clone copies the subtree');
        const copied = children(copy);
        return ownedByEngine(scene, 'cloneSubtree', () => {
          // Disposing a mesh detaches its children, it does not dispose them: the clone's own are the owner's to release.
          for (const mesh of copied) mesh.dispose();
          copy.dispose();
          leaf.dispose();
          root.dispose();
        });
      },
    },
    {
      name: 'hierarchy',
      create({ scene }) {
        const a = scene.createMesh().setPosition([1, 0, 0]),
          b = scene.createMesh(a).setPosition([0, 2, 0]),
          c = scene.createMesh();
        b.name = 'child';
        attach(c, b);
        if (parent(b) !== c || children(a).length !== 0) lifetimeFault('attach moves a mesh under its new parent');
        removeFromParent(b);
        attach(a, b);
        const seen = [];
        traverse(a, (mesh) => seen.push(mesh));
        traverseVisible(scene, () => {});
        if (seen.length !== 2 || findByName(scene, 'child') !== b || find(scene, () => true).length !== 3)
          lifetimeFault('a walk reaches every live mesh of the scene');
        const local = localToWorld(b, [0, 0, 0]);
        if (local[0] !== 1 || local[1] !== 2 || getWorldPosition(b)[1] !== 2)
          lifetimeFault('world positions follow the parent');
        return ownedByEngine(
          scene,
          'hierarchy',
          () => {
            for (const mesh of [b, a, c]) mesh.dispose();
          },
          {
            check({ phase }) {
              if (phase !== 'disposed') return;
              let threw = false;
              try {
                parent(b);
              } catch {
                threw = true;
              }
              if (!threw) lifetimeFault('a disposed mesh refuses a hierarchy query');
            },
          },
        );
      },
    },
  ];
}
