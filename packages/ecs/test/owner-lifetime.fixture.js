import { ownedByEngine } from '../../../tests/support/owner-shell.js';

const fail = (message) => {
  throw new Error(`OWNER_LIFETIME: ${message}`);
};

export async function fixtures(load = (entry) => import(entry)) {
  const { World } = await load('../dist/index.js');
  const { MeshBridge, transformSchema } = await load('../dist/engine.js');
  const { ReactiveQuery } = await load('../dist/reactive.js');
  const { serveParallelSystems, ParallelSchedule, SharedWorld } = await load('../dist/parallel.js');
  // A stand-in worker answers each dispatch on the next task and terminates asynchronously, as a real host may; the
  // real Worker is run by packages/ecs/test/parallel.test.js. A schedule's stop() removes the worker listeners after a
  // microtask, so these entries prove the harness waits for an asynchronous disposal. SharedArrayBuffer exists only
  // where the page is cross-origin isolated, which the browser owner page is not: there these entries do not apply.
  const standIn = () =>
    Object.assign(new EventTarget(), {
      terminated: false,
      postMessage(message) {
        setTimeout(
          () =>
            this.dispatchEvent(
              Object.assign(new Event('message'), { data: { tag: message.tag, id: message.id, ok: true } }),
            ),
          0,
        );
      },
      terminate() {
        return new Promise((resolve) =>
          setTimeout(() => {
            this.terminated = true;
            resolve();
          }, 5),
        );
      },
    });
  const schedule = async (factory) => {
    const world = new SharedWorld(4),
      position = world.component({ x: Float32Array }),
      made = [];
    position.add(world.create(), { x: 1 });
    const plan = new ParallelSchedule(
      world,
      { position },
      { workers: 2, workerFactory: () => (made[made.length] = standIn()) },
    );
    plan.add({ name: 'a', module: 'https://example.invalid/a.js', reads: ['position'] });
    plan.add({ name: 'b', module: 'https://example.invalid/b.js', reads: ['position'] });
    await plan.update(1 / 60);
    if (made.length !== 2) fail('a parallel update starts one worker per concurrent system');
    const stopped = () => {
      if (made.some((w) => !w.terminated)) fail('a stopped parallel schedule leaves a worker running');
    };
    return factory(plan, stopped);
  };
  const parallel =
    typeof SharedArrayBuffer === 'function'
      ? [
          {
            name: 'ParallelSchedule',
            create: ({ scene }) =>
              schedule((plan, stopped) => ownedByEngine(scene, 'ParallelSchedule', () => plan.stop().then(stopped))),
          },
          {
            // `await using` disposes through Symbol.asyncDispose only.
            name: 'ParallelSchedule.asyncDispose',
            create: ({ scene }) =>
              schedule((plan, stopped) => {
                const owned = ownedByEngine(scene, 'ParallelSchedule.asyncDispose', () =>
                  plan[Symbol.asyncDispose]().then(stopped),
                );
                return { plugin: owned.plugin, [Symbol.asyncDispose]: () => owned.dispose() };
              }),
          },
        ]
      : [];
  return [
    ...parallel,
    {
      // The bridge watches its component through the component's observer list and holds the meshes it links.
      name: 'MeshBridge',
      create({ engine, scene }) {
        const world = new World(8),
          transform = world.component(transformSchema);
        const bridge = new MeshBridge(transform);
        const mesh = engine.createMesh();
        bridge.link(world.create(), mesh);
        if (transform.observers.length !== 1) fail('a mesh bridge registers one observer on its component');
        return ownedByEngine(
          scene,
          'MeshBridge',
          () => {
            bridge.stop();
            if (transform.observers.length !== 0) fail('a stopped mesh bridge leaves its observer on the component');
          },
          { cleanup: () => mesh.dispose() },
        );
      },
    },
    {
      name: 'MeshBridge.disposeMeshes',
      create({ engine, scene }) {
        const world = new World(8),
          transform = world.component(transformSchema);
        const bridge = new MeshBridge(transform, { disposeMeshes: true });
        const entity = world.create(),
          mesh = engine.createMesh();
        bridge.link(entity, mesh);
        return ownedByEngine(
          scene,
          'MeshBridge.disposeMeshes',
          () => {
            bridge.stop();
            if (transform.observers.length !== 0) fail('a stopped mesh bridge leaves its observer on the component');
          },
          { cleanup: () => mesh.dispose() },
        );
      },
    },
    {
      // A query watches every required and excluded component, and holds its subscribers.
      name: 'ReactiveQuery',
      create({ scene }) {
        const world = new World(8),
          a = world.tag(),
          b = world.tag();
        const entity = world.create();
        a.add(entity);
        const query = new ReactiveQuery(world, { with: [a], without: [b] });
        const seen = [];
        query.subscribe({ onEnter: (e) => seen.push(e) }, { initial: true });
        if (seen.length !== 1 || a.observers.length !== 1 || b.observers.length !== 1)
          fail('a reactive query observes its components');
        return ownedByEngine(scene, 'ReactiveQuery', () => {
          query.stop();
          if (a.observers.length !== 0 || b.observers.length !== 0)
            fail('a stopped reactive query leaves observers on its components');
        });
      },
    },
    {
      // The worker side of the parallel scheduler listens on a worker endpoint until its cleanup function runs.
      name: 'serveParallelSystems',
      create({ scene }) {
        const endpoint = Object.assign(new EventTarget(), { postMessage() {} });
        const stop = serveParallelSystems(endpoint);
        return ownedByEngine(scene, 'serveParallelSystems', stop);
      },
    },
  ];
}
