import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseUSDA, loadUSDZ } from '../dist/index.js';
import { parseUSDInWorker, loadUSDZInWorker } from '../dist/worker.js';
import { runParseWorker } from '../../../tests/support/parse-worker.js';
import { headless, headlessModels } from '../../../tests/support/pbr-snapshot.js';

// KB-OWN-USDZ1: a model made by an async usdz load (create, loadUSDZ, parseUSDInWorker, loadUSDZInWorker) is built
// after the load's awaits, when another scene may be active. A load started in a second scene's setup must still
// build its model in that scene, as the gltf loaders do (KB-OWN-GLTF1).
const text = async () =>
  (await readFile(new URL('./fixtures/triangle.usda', import.meta.url))).toString('utf8').replace(/\r\n/g, '\n');
const dataURL = (value) => `data:application/octet-stream;base64,${Buffer.from(value).toString('base64')}`;
// Stored (method 0) one-entry ZIP: a .usdz whose root layer is `name`.
async function usdz(name, data) {
  const { crc32 } = await import('@margoengine/loaders');
  const filename = Buffer.from(name),
    header = Buffer.alloc(30),
    central = Buffer.alloc(46),
    end = Buffer.alloc(22);
  header.writeUInt32LE(0x04034b50);
  header.writeUInt32LE(crc32(data), 14);
  header.writeUInt32LE(data.length, 18);
  header.writeUInt32LE(data.length, 22);
  header.writeUInt16LE(filename.length, 26);
  central.writeUInt32LE(0x02014b50);
  central.writeUInt32LE(crc32(data), 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(filename.length, 28);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + filename.length, 12);
  end.writeUInt32LE(header.length + filename.length + data.length, 16);
  return Buffer.concat([header, filename, data, central, filename, end]);
}
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
// A record of the scenes `created` hooks saw: an extension that adds a plugin must add it to the load's scene.
const watcher = (engine, seen) => ({
  name: 'scene-watch',
  created: (_, model) => {
    const probe = { name: 'scene-watch:probe', setup() {} };
    engine.use(probe);
    seen.push(engine.sceneOf(probe));
    engine.removePlugin(probe.name);
    assert.ok(model);
  },
});
// Node has no Worker: this one runs the built worker in-process and answers on a later task, as a browser does.
async function withWorker(run) {
  const location = Object.getOwnPropertyDescriptor(globalThis, 'location'),
    previous = globalThis.Worker;
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
  Object.defineProperty(globalThis, 'location', { value: { href: 'http://localhost/' }, configurable: true });
  try {
    return await run();
  } finally {
    globalThis.Worker = previous;
    if (location) Object.defineProperty(globalThis, 'location', location);
    else delete globalThis.location;
  }
}

test('USDAsset.create started in a second scene builds the model there', () =>
  withEngine(async (engine) => {
    const asset = parseUSDA(await text()),
      { scene, started } = inSecondScene(engine, () => asset.create(engine)),
      model = await started;
    landed(engine, scene, model);
    model.destroy();
  }));

test("USDAsset.create runs its extensions' created hooks in the scene it started in", () =>
  withEngine(async (engine) => {
    const seen = [],
      asset = parseUSDA(await text(), { extensions: [watcher(engine, seen)] }),
      { scene, started } = inSecondScene(engine, () => asset.create(engine)),
      model = await started;
    landed(engine, scene, model);
    assert.equal(seen.length, 1);
    assert.ok(seen[0] === scene, 'the created hook ran in another scene');
    model.destroy();
  }));

test('a USDAsset.create started outside any setup stays in the default scene', () =>
  withEngine(async (engine) => {
    const model = await parseUSDA(await text()).create(engine);
    inside(model.root, engine.scene, 'the root');
    assert.ok(engine.sceneOf(model) === engine.scene);
    model.destroy();
  }));

test('loadUSDZ started in a second scene builds the model there', () =>
  withEngine(async (engine) => {
    const url = dataURL(await usdz('triangle.usda', Buffer.from(await text()))),
      { scene, started } = inSecondScene(engine, () => loadUSDZ(engine, url)),
      model = await started;
    landed(engine, scene, model);
    model.destroy();
  }));

test('parseUSDInWorker and loadUSDZInWorker without Workers build in the scene they started in', () =>
  withEngine(async (engine) => {
    const source = await text(),
      url = dataURL(await usdz('triangle.usda', Buffer.from(source)));
    for (const start of [() => parseUSDInWorker(engine, source), () => loadUSDZInWorker(engine, url)]) {
      const { scene, started } = inSecondScene(engine, start),
        model = await started;
      landed(engine, scene, model);
      model.destroy();
    }
  }));

test('parseUSDInWorker and loadUSDZInWorker with a worker build in the scene they started in', () =>
  withEngine((engine) =>
    withWorker(async () => {
      const source = await text(),
        bytes = await usdz('triangle.usda', Buffer.from(source)),
        url = dataURL(bytes),
        starts = [
          () => parseUSDInWorker(engine, source),
          () => loadUSDZInWorker(engine, url),
          // A custom fetch downloads on this thread and parses in the worker.
          () => loadUSDZInWorker(engine, 'http://localhost/a.usdz', { fetch: async () => new Response(bytes) }),
        ];
      for (const start of starts) {
        const { scene, started } = inSecondScene(engine, start),
          model = await started;
        landed(engine, scene, model);
        model.destroy();
      }
    }),
  ));

test('a USDAsset.create whose scene is disposed while it runs rejects and leaves the default scene empty', () =>
  withEngine(async (engine) => {
    const asset = parseUSDA(await text()),
      { scene, started } = inSecondScene(engine, () => asset.create(engine));
    scene.dispose();
    await assert.rejects(started, TypeError);
    assert.equal(engine.scene.meshes.size, 0, 'meshes landed in the default scene');
    assert.equal(engine.scene.plugins.size, 0, 'a plugin landed in the default scene');
  }));
