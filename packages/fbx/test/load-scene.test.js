import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadFBX } from '../dist/index.js';
import { parseFBXInWorker, loadFBXInWorker } from '../dist/worker.js';
import { runParseWorker } from '../../../tests/support/parse-worker.js';
import { headless, headlessModels } from '../../../tests/support/pbr-snapshot.js';
import { ascii, grid } from './fixtures.js';

// KB-OWN-FBX1: loadFBX and the worker loaders build their model after the download, the lazy import or the worker
// reply, when another scene may be active. A load started in a second scene's setup must build its model in that
// scene, as parseFBX does (KB-OWN-ASYNC1, test/scene.test.js).
const bytes = () => new TextEncoder().encode(ascii(grid(1)));
const files = async () => new Response(bytes());
let scenes = 0;
/** Runs `start` inside a second scene's setup, which is where an app starts a load for that scene. */
function inSecondScene(engine, start) {
  const scene = engine.createScene('b' + scenes++);
  let started;
  scene.use({ name: 'loader', setup: () => (started = start()) });
  return { scene, started };
}
// A failed assertion on scenes would print the whole engine; compare identity and name the scene instead.
const inside = (mesh, scene, what) =>
  assert.ok(mesh.scene === scene, `${what} is in scene ${mesh.scene.name}, not ${scene.name}`);
const landed = (engine, scene, model) => {
  inside(model.root, scene, 'the root');
  for (const node of model.nodes) inside(node, scene, 'a node');
  assert.ok(engine.sceneOf(model) === scene, 'the model plugin is not in the second scene');
  assert.equal(engine.scene.meshes.size, 0, 'meshes landed in the default scene');
  assert.equal(engine.scene.plugins.size, 0, 'a plugin landed in the default scene');
};
const withEngine = (run) =>
  headlessModels(async () => {
    const engine = await headless();
    try {
      return await run(engine);
    } finally {
      engine.dispose();
    }
  });
// Node has no Worker: this one runs the built worker in-process and answers on a later task, as a browser does. The
// worker's own download goes to `fetch`, which serves the fixture file.
async function withWorker(run) {
  const location = Object.getOwnPropertyDescriptor(globalThis, 'location'),
    previous = { Worker: globalThis.Worker, fetch: globalThis.fetch };
  globalThis.Worker = class {
    constructor(url) {
      this.path = fileURLToPath(new URL(url.pathname, url));
    }
    postMessage(message) {
      runParseWorker(this.path, message).then(
        (result) => setTimeout(() => this.onmessage?.({ data: { result } })),
        (error) => setTimeout(() => this.onerror?.({ message: error.message })),
      );
    }
    terminate() {}
  };
  globalThis.fetch = files;
  Object.defineProperty(globalThis, 'location', { value: { href: 'http://localhost/' }, configurable: true });
  try {
    return await run();
  } finally {
    Object.assign(globalThis, previous);
    if (location) Object.defineProperty(globalThis, 'location', location);
    else delete globalThis.location;
  }
}
async function each(engine, starts) {
  for (const start of starts) {
    const { scene, started } = inSecondScene(engine, start),
      model = await started;
    landed(engine, scene, model);
    model.dispose();
  }
}

test('loadFBX started in a second scene builds the model there', () =>
  withEngine((engine) => each(engine, [() => loadFBX(engine, 'https://assets.example/grid.fbx', { fetch: files })])));

test('a loadFBX started outside any setup stays in the default scene', () =>
  withEngine(async (engine) => {
    const model = await loadFBX(engine, 'https://assets.example/grid.fbx', { fetch: files });
    inside(model.root, engine.scene, 'the root');
    assert.ok(engine.sceneOf(model) === engine.scene);
    model.dispose();
  }));

test('parseFBXInWorker and loadFBXInWorker without Workers build in the scene they started in', () =>
  withEngine((engine) =>
    each(engine, [
      () => parseFBXInWorker(engine, bytes()),
      () => loadFBXInWorker(engine, 'https://assets.example/grid.fbx', { fetch: files }),
    ]),
  ));

test('parseFBXInWorker and loadFBXInWorker with a worker build in the scene they started in', () =>
  withEngine((engine) =>
    withWorker(() =>
      each(engine, [
        () => parseFBXInWorker(engine, bytes()),
        () => loadFBXInWorker(engine, 'http://localhost/grid.fbx'),
      ]),
    ),
  ));
