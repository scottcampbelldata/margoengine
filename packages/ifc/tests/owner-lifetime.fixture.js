// Owner/lifetime fixture for @margoengine/ifc. The package makes no engine objects: an app parses a file and builds its
// own meshes from the result, so each entry hangs one parse off the engine (owner-shell.js) and the disposal is the
// app abandoning it. parseIFC runs on a recording web-ifc API (the caller owns the real one, and its Wasm is the
// peer's): every model it opens must be closed and every geometry it reads deleted, on success, on a limit and on an
// abort. parseIFCInWorker runs on a recording Worker, in place for the call only (the real worker needs the app's
// served web-ifc script, which tests/worker.test.js drives in process): the worker must be terminated, the deadline
// cleared and the app's signal, which outlives the parse, left with no listener, whether the reply comes, never comes
// or the app aborts. createIFCScene (/scene) does make engine objects: instanced meshes, BatchedMesh plugins and
// their materials, with a ghost overlay that grows the translucent batch after creation; disposing the scene must leave none of them.
import { ownedByEngine, lifetimeFault, watchTimers } from '../../../tests/support/owner-shell.js';

const header = new TextEncoder().encode(
  "ISO-10303-21;\nHEADER;\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;\n",
);
const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
// One product with one triangle, read through the web-ifc calls parseIFC makes.
function recordingAPI() {
  const open = new Set(),
    geometries = new Set();
  let next = 0;
  const api = {
    OpenModel() {
      open.add(++next);
      return next;
    },
    IsModelOpen: (model) => open.has(model),
    CloseModel(model) {
      open.delete(model);
    },
    GetModelSchema: () => 'IFC4',
    GetLine: () => ({ GlobalId: { value: '0abc' }, Name: { value: 'Wall' } }),
    GetLineType: () => 1,
    GetNameFromTypeCode: () => 'IFCWALL',
    // Two products for streamIFCMeshes, one chunk each with `chunk: 1`.
    GetLineIDsWithType: (model, type) => {
      const ids = type === 4208778838 ? [7, 8] : [];
      return { size: () => ids.length, get: (i) => ids[i] };
    },
    GetFlatMesh: (model, expressID) => ({
      expressID,
      geometries: {
        size: () => 1,
        get: () => ({ geometryExpressID: 9, flatTransformation: identity, color: { x: 0.5, y: 0.5, z: 0.5, w: 1 } }),
      },
    }),
    StreamAllMeshes(model, callback) {
      api.onStream?.();
      callback({
        expressID: 7,
        geometries: {
          size: () => 1,
          get: () => ({ geometryExpressID: 9, flatTransformation: identity, color: { x: 0.5, y: 0.5, z: 0.5, w: 1 } }),
        },
      });
    },
    GetGeometry() {
      const geometry = {
        GetVertexData: () => 0,
        GetVertexDataSize: () => 18,
        GetIndexData: () => 0,
        GetIndexDataSize: () => 3,
        delete() {
          geometries.delete(geometry);
        },
      };
      geometries.add(geometry);
      return geometry;
    },
    GetVertexArray: () => new Float32Array([0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 1]),
    GetIndexArray: () => new Uint32Array([0, 1, 2]),
  };
  const released = (what) => {
    if (!next) lifetimeFault(`${what} never opened a model`);
    if (open.size) lifetimeFault(`${what} leaves ${open.size} web-ifc model(s) open`);
    if (geometries.size) lifetimeFault(`${what} leaves ${geometries.size} web-ifc geometry object(s) undeleted`);
  };
  return { api, released };
}
// A Worker that answers as the IFC worker does, or never (web-ifc stuck in its Wasm), and records termination.
function recordingWorker(reply) {
  const made = [];
  class Worker {
    terminated = false;
    onmessage = null;
    constructor() {
      made.push(this);
    }
    postMessage() {
      if (reply) queueMicrotask(() => this.onmessage?.({ data: reply }));
    }
    terminate() {
      this.terminated = true;
    }
  }
  const construct = (start) => {
    const had = Object.getOwnPropertyDescriptor(globalThis, 'Worker');
    Object.defineProperty(globalThis, 'Worker', { configurable: true, writable: true, value: Worker });
    try {
      return start();
    } finally {
      if (had) Object.defineProperty(globalThis, 'Worker', had);
      else delete globalThis.Worker;
    }
  };
  const released = (what) => {
    if (!made.length) lifetimeFault(`${what} never started a worker`);
    if (made.some((w) => !w.terminated)) lifetimeFault(`${what} leaves a parser worker running`);
  };
  return { construct, released };
}
const result = {
  kind: 'mesh',
  positions: new Float32Array(9),
  indices: new Uint32Array([0, 1, 2]),
  groups: [],
  products: [],
  schema: 'IFC4',
};

export async function fixtures(load = (entry) => import(entry)) {
  const { parseIFC } = await load('../dist/index.js');
  const { parseIFCInWorker } = await load('../dist/worker.js');
  const { createIFCScene, streamIFCMeshes } = await load('../dist/scene.js');
  const { IFCSectionView } = await load('../dist/section.js');
  const { streamIFCInWorker } = await load('../dist/worker.js');
  const shell = (name, run) => ({
    name,
    async create({ scene }) {
      const done = await run();
      return ownedByEngine(scene, name, done.release ?? (() => {}), {
        check: ({ phase }) => phase === 'disposed' && done.check(),
      });
    },
  });
  const parse = (name, options = () => ({}), expect) =>
    shell(name, async () => {
      const { api, released } = recordingAPI();
      try {
        parseIFC(api, header, options(api));
      } catch (error) {
        if (!expect?.(error)) throw error;
      }
      return { check: () => released(name) };
    });
  const worker = (name, { reply, timeoutMs, abort = false, expect }) =>
    shell(name, async () => {
      const { construct, released } = recordingWorker(reply),
        timers = watchTimers(),
        app = new AbortController();
      const pending = timers.scope(() =>
        construct(() =>
          parseIFCInWorker(header.slice(), {
            webIfc: 'https://app.test/web-ifc-api-iife.js',
            timeoutMs,
            signal: app.signal,
          }),
        ),
      );
      const settled = pending.then(
        () => undefined,
        (error) => {
          if (!expect?.(error)) throw error;
        },
      );
      // The app abandons the parse when it disposes what it hung it on.
      const release = abort
        ? () => {
            app.abort();
            return settled;
          }
        : undefined;
      if (!abort) await settled;
      return {
        release,
        check: () => {
          released(name);
          timers.expectNone(name);
        },
      };
    });
  const code = (c) => (error) => error?.name === 'LoaderError' && error.code === c;
  const quad = {
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
    indices: new Uint32Array([0, 1, 2, 2, 1, 3]),
  };
  const at = (x) => Float64Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, 0, 0, 1]);
  const gpuScene = {
    name: 'createIFCScene',
    warmUp: "materials' 1x1 default textures, made once per device",
    async create({ engine, scene }) {
      const ifc = createIFCScene(engine, {
        schema: 'IFC4',
        origin: [0, 0, 0],
        geometries: new Map([
          [1, quad],
          [2, quad],
        ]),
        placements: [
          { element: 1, geometry: 1, matrix: at(0), color: [1, 0, 0, 1] },
          { element: 2, geometry: 1, matrix: at(2), color: [0, 1, 0, 1] },
          { element: 3, geometry: 2, matrix: at(4), color: [0, 0, 1, 1] },
          { element: 4, geometry: 2, matrix: at(6), color: [1, 1, 0, 0.5] },
        ],
      });
      // The ghosts join the translucent batch, which grows by replacing it: the replaced and the new mesh both count.
      const created = ifc.meshes;
      ifc.setGhosted([1, 3], true);
      const meshes = [...new Set([...created, ...ifc.meshes])],
        plugins = [...scene.plugins.keys()].filter((n) => n.startsWith('batched-mesh:'));
      if (meshes.length < 4 || !plugins.length)
        throw new Error('OWNER_FIXTURE: createIFCScene made no instanced mesh, batch or overlay');
      return ownedByEngine(scene, 'createIFCScene', () => ifc.dispose(), {
        check({ phase }) {
          if (phase !== 'disposed') return;
          if (meshes.some((m) => m.root.engine.meshes.get(m.root.id) === m.root))
            lifetimeFault('a disposed IFC scene leaves meshes in the scene');
          if (plugins.some((n) => scene.plugins.has(n)))
            lifetimeFault('a disposed IFC scene leaves BatchedMesh plugins attached');
        },
      });
    },
  };
  // /section: the cap batch (a BatchedMesh plugin) and its material are the view's, the edge line goes into the app's
  // Lines plugin; disposing the view (before the scene) must detach the batch and take the line back out.
  const box = {
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1]),
    // Shared corners, so each normal points out of its corner.
    normals: new Float32Array(
      [-1, -1, -1, 1, -1, -1, 1, 1, -1, -1, 1, -1, -1, -1, 1, 1, -1, 1, 1, 1, 1, -1, 1, 1].map((v) => v / Math.sqrt(3)),
    ),
    indices: new Uint32Array([
      0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7,
    ]),
  };
  const sectionView = {
    name: 'IFCSectionView',
    warmUp: "materials' 1x1 default textures, made once per device",
    async create({ engine, scene }) {
      const ifc = createIFCScene(engine, {
        schema: 'IFC4',
        origin: [0, 0, 0],
        geometries: new Map([[1, box]]),
        placements: [{ element: 1, geometry: 1, matrix: at(0), color: [1, 0, 0, 1] }],
      });
      ifc.clippingPlanes = [[0, -1, 0, 0.5]];
      const before = new Set(scene.plugins.keys()),
        drawn = new Set();
      class Line {
        constructor(o) {
          this.options = o;
        }
      }
      const lines = { add: (l) => (drawn.add(l), l), remove: (l) => drawn.delete(l) };
      const view = new IFCSectionView(engine, ifc, { edges: { lines, Line } });
      const plugins = [...scene.plugins.keys()].filter((n) => !before.has(n)),
        caps = view.meshes;
      if (!plugins.length || !caps.length || !drawn.size)
        throw new Error('OWNER_FIXTURE: IFCSectionView made no cap batch or edge line');
      return ownedByEngine(
        scene,
        'IFCSectionView',
        () => {
          view.dispose();
          ifc.dispose();
        },
        {
          check({ phase }) {
            if (phase !== 'disposed') return;
            if (plugins.some((n) => scene.plugins.has(n)))
              lifetimeFault('a disposed section view leaves its cap batch attached');
            if (drawn.size) lifetimeFault('a disposed section view leaves its cut edges in the Lines plugin');
          },
        },
      );
    },
  };
  // Streamed: chunks join the scene's group and batch, which grow by replacing their meshes; every mesh and batch the
  // scene ever made, replaced ones included, must be gone once it is disposed.
  const streamedScene = {
    name: 'createIFCScene streamed',
    warmUp: gpuScene.warmUp,
    async create({ engine, scene }) {
      const made = new Set(),
        plugins = new Set(),
        note = (ifc) => {
          for (const m of ifc.meshes) made.add(m);
          for (const n of scene.plugins.keys()) if (n.startsWith('batched-mesh:')) plugins.add(n);
          return ifc;
        };
      const ifc = note(
        createIFCScene(engine, {
          schema: 'IFC4',
          origin: [0, 0, 0],
          geometries: new Map([[1, quad]]),
          placements: [{ element: 1, geometry: 1, matrix: at(0), color: [1, 0, 0, 1] }],
        }),
      );
      for (let i = 0; i < 6; i++)
        note(
          ifc.add({
            geometries: new Map([[10 + i, quad]]),
            placements: [
              { element: 2 + i, geometry: 1, matrix: at(2 + i), color: [0, 1, 0, 1] },
              { element: 20 + i, geometry: 10 + i, matrix: at(2 + i), color: [0, 0, 1, 1] },
            ],
          }),
        );
      if (made.size < 4) throw new Error('OWNER_FIXTURE: streamed chunks never grew a group or batch');
      return ownedByEngine(scene, 'createIFCScene streamed', () => ifc.dispose(), {
        check({ phase }) {
          if (phase !== 'disposed') return;
          if ([...made].some((m) => m.root.engine.meshes.get(m.root.id) === m.root))
            lifetimeFault('a streamed IFC scene leaves meshes in the scene');
          if ([...plugins].some((n) => scene.plugins.has(n)))
            lifetimeFault('a streamed IFC scene leaves BatchedMesh plugins attached');
        },
      });
    },
  };
  // streamIFCMeshes aborted after its first chunk: every geometry it read is deleted and the app's model closes.
  const streamAborted = shell('streamIFCMeshes aborted', async () => {
    const { api, released } = recordingAPI(),
      app = new AbortController();
    const { openIFC } = await load('../dist/index.js');
    const model = openIFC(api, header);
    try {
      for await (const chunk of streamIFCMeshes(model, { chunk: 1, signal: app.signal }))
        if (chunk.loaded === 1) app.abort();
      throw new Error('OWNER_FIXTURE: the aborted stream finished');
    } catch (error) {
      if (!code('aborted')(error)) throw error;
    } finally {
      model.close();
    }
    return { check: () => released('streamIFCMeshes aborted') };
  });
  // streamIFCInWorker abandoned mid-stream: its worker sent one chunk; the app's abort terminates it, clears its timer
  // and removes the listener from the app's signal.
  const streamWorker = shell('streamIFCInWorker abandoned', async () => {
    const chunk = { schema: 'IFC4', origin: [0, 0, 0], geometries: new Map(), placements: [], loaded: 1, total: 2 };
    const { construct, released } = recordingWorker({ chunk }),
      timers = watchTimers(),
      app = new AbortController();
    const stream = streamIFCInWorker(header.slice(), {
      webIfc: 'https://app.test/web-ifc-api-iife.js',
      signal: app.signal,
    });
    const first = await timers.scope(() => construct(() => stream.next()));
    if (first.value?.loaded !== 1) throw new Error('OWNER_FIXTURE: no chunk from the stream worker');
    const pending = stream.next().then(
      () => undefined,
      (error) => {
        if (error?.name !== 'AbortError') throw error;
      },
    );
    return {
      release: () => {
        app.abort();
        return pending;
      },
      check: () => {
        released('streamIFCInWorker abandoned');
        timers.expectNone('streamIFCInWorker abandoned');
      },
    };
  });
  return [
    gpuScene,
    sectionView,
    streamedScene,
    streamAborted,
    streamWorker,
    parse('parseIFC'),
    parse('parseIFC over a limit', () => ({ maxTriangles: 0 }), code('limit')),
    // The app aborts while web-ifc streams the meshes, after the model is open.
    parse(
      'parseIFC aborted',
      (api) => {
        const app = new AbortController();
        api.onStream = () => app.abort();
        return { signal: app.signal };
      },
      code('aborted'),
    ),
    worker('parseIFCInWorker', { reply: { result } }),
    worker('parseIFCInWorker past its deadline', { timeoutMs: 20, expect: code('limit') }),
    worker('parseIFCInWorker abandoned', { abort: true, expect: (e) => e?.name === 'AbortError' }),
  ];
}
