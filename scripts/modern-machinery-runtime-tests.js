import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build, preview } from 'vite';
import { openBrowser } from './browser.js';
const root = resolve('test-results/machinery-runtime-consumer');
await mkdir(root, { recursive: true });
await writeFile(
  resolve(root, 'index.html'),
  '<canvas style="width:160px;height:120px"></canvas><script type="module" src="./main.js"></script>',
);
await writeFile(
  resolve(root, 'main.js'),
  `import {Engine,Geometry,box} from '@margoengine/core';import {webglRenderer} from '@margoengine/webgl';import {parseCADAsync,loadCAD,SectionPlanes,EngineeringAnnotations,SurfacePhysics,Kinematics,TelemetryChannel,AssemblyBVH,measureClearance,worldAnchor} from '@margoengine/machinery';
window.api={Engine,webglRenderer,box,parseCADAsync,loadCAD,Geometry,SectionPlanes,EngineeringAnnotations,SurfacePhysics,Kinematics,TelemetryChannel,AssemblyBVH,measureClearance,worldAnchor};window.ready=Engine.create(document.querySelector('canvas'),{backend:'webgpu',capacity:32}).then(e=>window.engine=e);`,
);
const browser = await openBrowser({ startPath: '/test-results/machinery-runtime-consumer/index.html' }),
  { page, hardware } = browser;
let server, starter;
const errors = [],
  requests = [];
page.on('pageerror', (error) => errors.push(error.message));
page.on('request', (r) => requests.push(r.url()));
const step = await readFile('node_modules/occt-import-js/test/testfiles/cube-10x10mm/Cube 10x10.stp', 'utf8'),
  iges = await readFile('node_modules/occt-import-js/test/testfiles/cube-10x10mm/Cube 10x10.igs', 'utf8');
const importCAD = async (input, format) =>
  page.evaluate(
    async ({ input, format }) => {
      await window.ready;
      const data = new TextEncoder().encode(input).buffer,
        progress = [],
        bound = [],
        hidden = [],
        model = await window.api.parseCADAsync(window.engine, data, format, {
          onProgress: (p) => {
            progress.push(p);
            if (p > 50 && p < 100) {
              bound.push(window.engine.meshes.size);
              hidden.push([...window.engine.meshes.values()].filter((m) => !m.geometry).every((m) => !m.visible));
            }
          },
        }),
        g = model.meshes[0].geometry;
      window.engine.render();
      await window.engine.gpu.queue.onSubmittedWorkDone();
      const result = {
        detached: data.byteLength === 0,
        meshes: model.meshes.length,
        vertices: g.vertices.length / 6,
        triangles: g.indices.length / 3,
        bounds: [...g.bounds],
        boundDuringProgress: bound.some((n) => n > 0),
        hiddenUntilReady: hidden.length > 0 && hidden.every(Boolean) && model.root.visible,
        packed: g instanceof window.api.Geometry,
        progress,
        shared: model.meshes.length < 2 || model.meshes[0].geometry === model.meshes[1].geometry,
      };
      model.dispose();
      return result;
    },
    { input, format },
  );
const obj = 'v 0 0 0\nv 1 0 0\nv 0 1 0\ng first\nf 1 2 3\ng repeat\nf 1 2 3';
const stl =
  'solid fixture\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid fixture';
const checks = [];
try {
  await page.waitForFunction(() => window.ready);
  for (const [format, input] of [
    ['stl', stl],
    ['obj', obj],
    ['step', step],
    ['iges', iges],
  ]) {
    const result = await importCAD(input, format);
    assert.ok(
      result.detached && result.packed && result.shared && result.boundDuringProgress && result.hiddenUntilReady,
      JSON.stringify({ format, ...result }),
    );
    assert.equal(result.progress[0], 0);
    assert.equal(result.progress.at(-1), 100);
    assert.ok(result.progress.every((p, i) => i === 0 || p > result.progress[i - 1]));
    if (format === 'step' || format === 'iges')
      assert.ok(result.bounds[3] < 0.02, 'B-Rep units were not converted to meters');
    checks.push({ format, ...result });
    if (format === 'obj')
      assert.ok(
        requests.every((url) => !url.includes('occt-import-js')),
        'STL/OBJ downloaded OCCT',
      );
  }
  const streaming = await page.evaluate(async () => {
    const count = 100_000,
      data = new ArrayBuffer(84 + count * 50),
      v = new DataView(data);
    v.setUint32(80, count, true);
    for (let f = 0; f < count; f++) {
      v.setFloat32(84 + f * 50 + 24, 1, true);
      v.setFloat32(84 + f * 50 + 40, 1, true);
    }
    let frames = 0,
      running = true;
    const advance = () => {
      if (running) {
        frames++;
        requestAnimationFrame(advance);
      }
    };
    requestAnimationFrame(advance);
    const progress = [],
      model = await window.api.parseCADAsync(window.engine, data, 'stl', { onProgress: (p) => progress.push(p) });
    running = false;
    const triangles = model.meshes[0].geometry.indices.length / 3;
    model.dispose();
    return { frames, triangles, progress, detached: data.byteLength === 0 };
  });
  assert.ok(streaming.frames >= 2 && streaming.detached);
  assert.equal(streaming.triangles, 100_000);
  assert.ok(streaming.progress.length >= 10);
  checks.push({ name: '5 MB STL parses and optimizes while animation frames continue', ...streaming });
  const surface = await page.evaluate(async () => {
    const e = window.engine,
      { SurfacePhysics, box } = window.api,
      results = [];
    for (const direction of [1, -1]) {
      const motor = e.createMesh(),
        gate = e.createMesh(),
        left = e.createMesh().setGeometry(box()),
        right = e.createMesh().setGeometry(left.geometry).setPosition([1.1, 0, 0]),
        carriers = [{ node: motor, velocity: [direction * 2, 0, 0] }, { node: gate }],
        s = await SurfacePhysics.create(
          [
            { node: left, carrier: direction > 0 ? 0 : 1, lane: 0, axis: [1, 0, 0], halfLength: 0.5, friction: 1 },
            { node: right, carrier: direction > 0 ? 1 : 0, lane: 0, axis: [1, 0, 0], halfLength: 0.5, friction: 1 },
          ],
          carriers,
          { gravity: 10 },
        );
      e.use(s);
      const memory = s.data.buffer,
        obstacle = direction > 0 ? right : left,
        position = obstacle.position.x;
      let bounded = true;
      for (let i = 0; i < 30; i++) {
        e.render({ delta: 0.1 });
        bounded &&= right.position.x - left.position.x >= 1 - 1e-5 && obstacle.position.x === position;
      }
      carriers[0].velocity = [-direction * 2, 0, 0];
      e.render({ delta: 0.1 });
      results.push({
        direction,
        bounded,
        reversed: right.position.x - left.position.x >= 1 - 1e-5,
        stable: memory === s.data.buffer,
      });
      e.removePlugin(s.name);
      for (const node of [left, right, motor, gate]) node.dispose();
    }
    await e.gpu.queue.onSubmittedWorkDone();
    return results;
  });
  assert.ok(surface.every((r) => r.bounded && r.reversed && r.stable));
  checks.push({
    name: 'Browser Wasm surface transport respects gates and reversal in both directions',
    results: surface,
  });
  const telemetry = await page.evaluate(async () => {
    const e = window.engine,
      { Kinematics, TelemetryChannel } = window.api,
      node = e.createMesh(),
      k = new Kinematics([{ node, axis: 'z', min: -1, max: 1, velocity: 0.1 }]);
    e.use(k);
    const rejected = [],
      t = await TelemetryChannel.create(k, { delay: 100, onError: (error) => rejected.push(error.message) });
    e.use(t);
    const frame = (timestamp, value) => {
      const data = new ArrayBuffer(12),
        v = new DataView(data);
      v.setUint32(0, timestamp, true);
      v.setUint16(4, 1, true);
      v.setUint16(6, 0, true);
      v.setFloat32(8, value, true);
      return data;
    };
    t.push(frame(1000, 0), 100);
    t.push(frame(1100, 0.1), 200);
    t.sample(250);
    const midpoint = k.value(0),
      duplicate = !t.push(frame(1100, 0.8), 205);
    t.sample(10_000);
    const held = k.value(0),
      socket = new EventTarget();
    t.connect(socket);
    socket.dispatchEvent(new MessageEvent('message', { data: frame(10, 0.3) }));
    socket.dispatchEvent(new MessageEvent('message', { data: frame(20, NaN) }));
    t.sample();
    const sensor = k.value(0);
    e.render({ delta: 0.5 });
    const controlled = k.value(0);
    e.removePlugin(t.name);
    e.render({ delta: 0.5 });
    const resumed = k.value(0);
    e.removePlugin(k.name);
    node.dispose();
    return { midpoint, duplicate, held, sensor, controlled, resumed, rejected: rejected.length };
  });
  assert.ok(
    Math.abs(telemetry.midpoint - 0.0375) < 1e-5 &&
      telemetry.duplicate &&
      Math.abs(telemetry.held - 0.1) < 1e-5 &&
      Math.abs(telemetry.sensor - 0.3) < 1e-5 &&
      telemetry.rejected === 1 &&
      telemetry.sensor === telemetry.controlled &&
      Math.abs(telemetry.resumed - 0.35) < 1e-5,
  );
  checks.push({
    name: 'Browser binary telemetry interpolates, holds stale input, rejects NaN and restores autonomous motion',
    ...telemetry,
  });
  const spatial = await page.evaluate(async () => {
    const e = window.engine,
      { box, AssemblyBVH, measureClearance, worldAnchor } = window.api,
      a = e.createMesh().setGeometry(box()).setScale([-1, 1, 1]),
      b = e
        .createMesh()
        .setGeometry(a.geometry)
        .setPosition([3, 0, 0])
        .setRotation([0, 0, Math.PI / 4]);
    e.render();
    const index = await AssemblyBVH.create([a, b]),
      hit = index.raycast([0.49, 0.49, 4], [0, 0, -2]),
      snap = worldAnchor(index.snap(hit, { maxDistance: 0.02 })),
      distance = measureClearance(a, b).distance;
    a.visible = false;
    e.render();
    index.rebuild();
    const hidden = index.raycast([0, 0, 4], [0, 0, -1]) === null;
    a.visible = true;
    a.setPosition([0, 2, 0]);
    e.render();
    index.rebuild();
    const moved = index.raycast([0, 2, 4], [0, 0, -1])?.node === a;
    index.dispose();
    a.dispose();
    b.dispose();
    return { hit: hit.node === a, hitDistance: hit.distance, snap, distance, hidden, moved };
  });
  assert.ok(
    spatial.hit &&
      Math.abs(spatial.hitDistance - 3.5) < 1e-5 &&
      spatial.snap.every((v, i) => Math.abs(v - [0.5, 0.5, 0.5][i]) < 1e-5) &&
      Math.abs(spatial.distance - (2.5 - Math.SQRT1_2)) < 1e-5 &&
      spatial.hidden &&
      spatial.moved,
  );
  checks.push({
    name: 'Browser Wasm BVH handles mirrored picking, snapping, visibility, moved meshes and rotated OBB clearance',
    ...spatial,
  });
  const annotation = await page.evaluate(() => {
    const e = window.engine;
    e.use(
      new window.api.EngineeringAnnotations({
        dimensions: [{ a: { point: [-0.5, -0.5, 0] }, b: { point: [0.5, 0.5, 0] } }],
      }),
    );
    e.render();
    const p = [
        ...document
          .querySelector('svg[data-margoengine-annotations] path')
          .getAttribute('d')
          .matchAll(/[-+]?\d*\.?\d+(?:e[-+]?\d+)?/gi),
      ].map((m) => Number(m[0])),
      dot = (p[2] - p[0]) * (p[4] - p[2]) + (p[3] - p[1]) * (p[5] - p[3]);
    e.removePlugin('engineering-annotations');
    return { dot };
  });
  assert.ok(Math.abs(annotation.dot) < 1e-7);
  checks.push({ name: 'Dimension offset is perpendicular to its projected line', ...annotation });
  const failures = await page.evaluate(async () => {
    const e = window.engine,
      api = window.api,
      before = e.meshes.size,
      controller = new AbortController(),
      input = new TextEncoder().encode('v 0 0 0\nf 1 2 3').buffer;
    let malformed = false,
      aborted = false,
      callback = false;
    try {
      await api.parseCADAsync(e, input, 'obj');
    } catch {
      malformed = true;
    }
    const pending = api.parseCADAsync(e, new TextEncoder().encode('solid fixture\nendsolid fixture').buffer, 'stl', {
      signal: controller.signal,
    });
    controller.abort();
    try {
      await pending;
    } catch (error) {
      aborted = error.name === 'AbortError';
    }
    try {
      await api.parseCADAsync(e, new TextEncoder().encode('v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3').buffer, 'obj', {
        onProgress: () => {
          throw new Error('Progress failed');
        },
      });
    } catch (error) {
      callback = error.message === 'Progress failed';
    }
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return { malformed, aborted, callback, before, after: e.meshes.size };
  });
  assert.ok(failures.malformed && failures.aborted && failures.callback);
  assert.equal(failures.before, failures.after);
  checks.push({ name: 'Worker failures and cancellation leave no meshes', ...failures });
  const capacity = await page.evaluate(async (obj) => {
    const e = await window.api.Engine.create(document.createElement('canvas'), {
      backend: 'webgl2',
      fallback: window.api.webglRenderer,
      capacity: 2,
    });
    let streamed = false,
      failed = false;
    try {
      await window.api.parseCADAsync(e, new TextEncoder().encode(obj).buffer, 'obj', {
        onProgress: () => {
          if (e.meshes.size === 2) streamed = true;
        },
      });
    } catch (error) {
      failed = /capacity/.test(error.message);
    }
    const remaining = e.meshes.size;
    e.dispose();
    return { streamed, failed, remaining };
  }, obj);
  assert.ok(capacity.streamed && capacity.failed);
  assert.equal(capacity.remaining, 0);
  checks.push({ name: 'Late binding failure rolls back previously streamed meshes', ...capacity });
  await page.evaluate(() => window.engine.dispose());
  await build({
    root,
    configFile: false,
    logLevel: 'warn',
    build: { outDir: resolve(root, 'dist'), emptyOutDir: true, target: 'es2022', assetsInlineLimit: 0 },
  });
  server = await preview({
    root,
    configFile: false,
    logLevel: 'error',
    preview: { host: '127.0.0.1', port: 5194, strictPort: true },
  });
  await page.goto('http://127.0.0.1:5194');
  for (const [format, input] of [
    ['obj', obj],
    ['step', step],
    ['iges', iges],
  ]) {
    const result = await importCAD(input, format);
    assert.ok(result.detached && result.packed && result.shared);
    checks.push({ name: 'Production asset URLs', format, ...result });
  }
  await build({
    root: resolve('examples/vite'),
    configFile: false,
    logLevel: 'warn',
    build: { outDir: resolve(root, 'starter-dist'), emptyOutDir: true, target: 'es2022' },
  });
  starter = await preview({
    root: resolve('examples/vite'),
    configFile: false,
    logLevel: 'error',
    build: { outDir: resolve(root, 'starter-dist') },
    preview: { host: '127.0.0.1', port: 5195, strictPort: true },
  });
  await page.goto('http://127.0.0.1:5195');
  await page.waitForFunction(() => document.querySelector('.badge')?.textContent?.includes('webgpu'));
  await page.getByText('Domain tools', { exact: true }).click();
  for (const [name, input] of [
    ['cube.stp', step],
    ['cube.igs', iges],
    ['parts.obj', obj],
    ['part.stl', stl],
  ]) {
    await page
      .getByLabel('Import STL, OBJ, STEP or IGES')
      .setInputFiles({ name, mimeType: 'application/octet-stream', buffer: Buffer.from(input) });
    await page.getByRole('status').filter({ hasText: /^CAD:/ }).waitFor();
    checks.push({
      name: 'Production starter file picker',
      file: name,
      status: await page.locator('.status').textContent(),
    });
  }
  await page
    .getByLabel('Import STL, OBJ, STEP or IGES')
    .setInputFiles({ name: 'invalid.obj', mimeType: 'text/plain', buffer: Buffer.from('v 0 0 0\nf 1 2 3') });
  await page.getByRole('status').filter({ hasText: 'Error:' }).waitFor();
  assert.equal(await page.locator('vite-error-overlay').count(), 0);
  checks.push({ name: 'Starter reports malformed import errors' });
  assert.deepEqual(errors, []);
  await writeFile('test-results/modern-machinery-runtime-browser.json', JSON.stringify({ hardware, checks }, null, 2));
  console.log(JSON.stringify({ hardware, checks }, null, 2));
} finally {
  await starter?.httpServer.close();
  await server?.httpServer.close();
  await browser.close();
}
