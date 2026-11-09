import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, preview } from 'vite';
import { launchBrowser } from '../../../scripts/lib/browser.mjs';
import { closeAll } from '../../../scripts/support/shutdown.mjs';

const dir = await mkdtemp(join(tmpdir(), 'margo-poisson-'));
let browser, server;
try {
  await writeFile(
    join(dir, 'index.html'),
    '<!doctype html><title>Poisson backend values</title><script type="module" src="/main.js"></script>',
  );
  await writeFile(
    join(dir, 'main.js'),
    `import {createPoissonSampler} from '@margoengine/procedural/poisson';
     import {createDungeonGenerator} from '@margoengine/procedural/dungeon';
     import {createTreeGenerator} from '@margoengine/procedural/trees';
     import {createSdfModeler} from '@margoengine/procedural/sdf';
     import {createBuildingGenerator} from '@margoengine/procedural/buildings';
     window.makeSampler = createPoissonSampler; window.makeDungeon = createDungeonGenerator;
     window.makeTree = createTreeGenerator; window.makeSdf = createSdfModeler; window.makeBuilding = createBuildingGenerator;`,
  );
  await build({
    root: dir,
    base: '/sampling/',
    configFile: false,
    logLevel: 'error',
    resolve: {
      alias: {
        '@margoengine/procedural/poisson': fileURLToPath(new URL('../dist/poisson.js', import.meta.url)),
        '@margoengine/procedural/dungeon': fileURLToPath(new URL('../dist/dungeon.js', import.meta.url)),
        '@margoengine/procedural/trees': fileURLToPath(new URL('../dist/trees.js', import.meta.url)),
        '@margoengine/procedural/sdf': fileURLToPath(new URL('../dist/sdf.js', import.meta.url)),
        '@margoengine/procedural/buildings': fileURLToPath(new URL('../dist/buildings.js', import.meta.url)),
      },
    },
    build: { outDir: join(dir, 'dist') },
  });
  server = await preview({
    root: dir,
    base: '/sampling/',
    configFile: false,
    logLevel: 'error',
    build: { outDir: join(dir, 'dist') },
    preview: { host: '127.0.0.1', port: 0 },
  });
  browser = await launchBrowser();
  const page = await browser.newPage(),
    errors = [],
    wasmRequests = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('request', (r) => {
    if (/\.wasm(?:\?|$)/.test(r.url())) wasmRequests.push(r.url());
  });
  await page.goto(server.resolvedUrls.local[0]);
  await page.waitForFunction(() => typeof window.makeSampler === 'function');
  assert.equal(wasmRequests.length, 0, 'importing the entry downloads no Wasm');
  const result = await page.evaluate(async () => {
    const output = [];
    for (const route of ['webgpu', 'webgl2']) {
      const canvas = document.createElement('canvas');
      let device, gl;
      if (route === 'webgpu') {
        device = await (await navigator.gpu.requestAdapter()).requestDevice();
        device.pushErrorScope('validation');
        canvas.getContext('webgpu').configure({ device, format: navigator.gpu.getPreferredCanvasFormat() });
      } else {
        gl = canvas.getContext('webgl2');
        if (!gl) throw new Error('WebGL2 context missing');
      }
      const sampler = await window.makeSampler();
      const dungeon = await window.makeDungeon();
      const trees = await window.makeTree();
      const sdf = await window.makeSdf();
      const buildings = await window.makeBuilding();
      const buildingOptions = { width: 12, depth: 8, floorHeights: [3, 4], bayWidth: 3, roof: 'gable', roofHeight: 2 };
      const building = buildings.generate(buildingOptions);
      const sdfShape = { type: 'box', halfSize: [0.7, 0.6, 0.5] };
      const sdfMesh = sdf.mesh(sdfShape, { resolution: 17 });
      const treeOptions = { seed: 7, attractionCount: 64, maxNodes: 256, maxIterations: 64 };
      const tree = trees.generate(treeOptions);
      const dungeonOptions = { width: 32, height: 24, maxRooms: 12, seed: 7 };
      const layout = dungeon.generate(dungeonOptions);
      const options = { radius: 0.2, attempts: 5000, seed: 39 };
      const a = sampler.rectangle([-2, -2, 2, 2], options);
      const surface = sampler.surface(new Float32Array([0, 0, 0, 2, 0, 0, 0, 2, 0]), options);
      if (device) {
        const error = await device.popErrorScope();
        if (error) throw error;
        device.destroy();
        await device.lost;
      } else {
        const lost = new Promise((resolve) => canvas.addEventListener('webglcontextlost', resolve, { once: true }));
        gl.getExtension('WEBGL_lose_context').loseContext();
        await lost;
        if (!gl.isContextLost()) throw new Error('Context loss was not observed');
      }
      const after = sampler.rectangle([-2, -2, 2, 2], options);
      const dungeonAfter = dungeon.generate(dungeonOptions);
      const treeAfter = trees.generate(treeOptions);
      const sdfAfter = sdf.mesh(sdfShape, { resolution: 17 });
      const buildingAfter = buildings.generate(buildingOptions);
      buildings.dispose();
      buildings[Symbol.dispose]();
      let buildingDisposed = false;
      try {
        buildings.generate();
      } catch (e) {
        buildingDisposed = e.code === 'disposed';
      }
      if (!buildingDisposed) throw new Error('Disposed building generator accepted work');
      sdf.dispose();
      sdf.dispose();
      let sdfDisposed = false;
      try {
        sdf.mesh();
      } catch (e) {
        sdfDisposed = e.code === 'disposed';
      }
      if (!sdfDisposed) throw new Error('Disposed SDF modeler accepted work');
      trees.dispose();
      trees.dispose();
      let treeDisposed = false;
      try {
        trees.generate();
      } catch (e) {
        treeDisposed = e.code === 'disposed' && e.message.includes('https://margoengine.com/errors#procedural');
      }
      if (!treeDisposed) throw new Error('Disposed tree generator accepted work');
      dungeon.dispose();
      dungeon.dispose();
      let dungeonDisposed = false;
      try {
        dungeon.generate();
      } catch (e) {
        dungeonDisposed = e.code === 'disposed';
      }
      if (!dungeonDisposed) throw new Error('Disposed dungeon generator accepted work');
      sampler.dispose();
      sampler.dispose();
      let disposed = false;
      try {
        sampler.rectangle([-2, -2, 2, 2], options);
      } catch (e) {
        disposed = e.code === 'disposed';
      }
      if (!disposed) throw new Error('Disposed sampler accepted work');
      output.push({
        route,
        building: {
          positions: [...building.positions],
          indices: [...building.indices],
          materials: [...building.materials],
          bays: [...building.bays],
        },
        buildingAfter: [...buildingAfter.positions],
        sdf: { positions: [...sdfMesh.positions], indices: [...sdfMesh.indices] },
        sdfAfter: { positions: [...sdfAfter.positions], indices: [...sdfAfter.indices] },
        points: [...a.positions],
        surface: [...surface.positions],
        after: [...after.positions],
        dungeon: { cells: [...layout.cells], rooms: layout.rooms, corridors: layout.corridors },
        dungeonAfter: [...dungeonAfter.cells],
        tree: {
          positions: [...tree.positions],
          parents: [...tree.parents],
          remainingAttractions: tree.remainingAttractions,
        },
        treeAfter: {
          positions: [...treeAfter.positions],
          parents: [...treeAfter.parents],
          remainingAttractions: treeAfter.remainingAttractions,
        },
      });
    }
    return output;
  });
  assert.equal(new Set(wasmRequests).size, 5, 'one independent lazy asset per feature');
  assert.deepEqual(result[0].building, result[1].building);
  for (const r of result) {
    assert.deepEqual(r.building.positions, r.buildingAfter);
    assert.equal(r.building.bays.length / 8, 28);
    assert.equal(r.building.materials.filter((v) => v === 1).length, 56);
    const ys = r.building.positions.filter((_, i) => i % 3 === 1);
    assert.equal(Math.min(...ys), 0);
    assert.equal(Math.max(...ys), 9);
    let volume = 0;
    for (let i = 0; i < r.building.indices.length; i += 3) {
      const [a, b, c] = r.building.indices.slice(i, i + 3).map((v) => r.building.positions.slice(v * 3, v * 3 + 3));
      volume +=
        (a[0] * (b[1] * c[2] - b[2] * c[1]) + a[1] * (b[2] * c[0] - b[0] * c[2]) + a[2] * (b[0] * c[1] - b[1] * c[0])) /
        6;
    }
    assert.ok(Math.abs(volume - 768) < 1e-8, 'browser shell volume matches rectangle plus gable');
  }
  assert.deepEqual(result[0].sdf, result[1].sdf);
  assert.deepEqual(result[0].points, result[1].points);
  assert.deepEqual(result[0].dungeon, result[1].dungeon);
  assert.deepEqual(result[0].tree, result[1].tree);
  for (const r of result) {
    assert.deepEqual(r.sdf, r.sdfAfter);
    assert.ok(r.sdf.indices.length > 100);
    assert.ok(r.sdf.positions.every(Number.isFinite));
    for (const x of [-0.7, 0.7])
      for (const y of [-0.6, 0.6])
        for (const z of [-0.5, 0.5]) {
          let nearest = Infinity;
          for (let i = 0; i < r.sdf.positions.length; i += 3)
            nearest = Math.min(
              nearest,
              Math.hypot(r.sdf.positions[i] - x, r.sdf.positions[i + 1] - y, r.sdf.positions[i + 2] - z),
            );
          assert.ok(nearest < 1e-9);
        }
    assert.deepEqual(r.treeAfter, r.tree);
    const { positions, parents } = r.tree;
    assert.ok(parents.length > 20 && parents.length <= 256);
    assert.equal(positions.length, parents.length * 3);
    assert.equal(parents[0], -1);
    assert.deepEqual(positions.slice(0, 3), [0, 0, 0]);
    assert.ok(positions.every(Number.isFinite));
    const branches = new Uint32Array(parents.length);
    for (let i = 1; i < parents.length; i++) {
      assert.ok(Number.isInteger(parents[i]) && parents[i] >= 0 && parents[i] < i);
      branches[parents[i]]++;
      let squaredLength = 0;
      for (let k = 0; k < 3; k++) squaredLength += (positions[i * 3 + k] - positions[parents[i] * 3 + k]) ** 2;
      assert.ok(Math.abs(Math.sqrt(squaredLength) - 0.2) < 1e-8);
    }
    assert.ok(branches.some((n) => n > 1));
    const { cells, rooms, corridors } = r.dungeon;
    assert.deepEqual(r.dungeonAfter, cells);
    assert.ok(rooms.length > 1);
    assert.equal(corridors.length, rooms.length - 1);
    assert.ok(cells.every((v) => v === 0 || v === 1));
    const seen = new Set([cells.indexOf(1)]),
      queue = [...seen];
    for (let i = 0; i < queue.length; i++)
      for (const next of [queue[i] - 1, queue[i] + 1, queue[i] - 32, queue[i] + 32])
        if (next >= 0 && next < cells.length && cells[next] && !seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
    assert.equal(
      seen.size,
      cells.reduce((a, b) => a + b, 0),
    );
    for (let y = 0; y < 24; y++)
      for (let x = 0; x < 32; x++) if (!x || !y || x === 31 || y === 23) assert.equal(cells[y * 32 + x], 0);
    assert.deepEqual(r.after, r.points);
    assert.ok(r.points.length > 300);
    for (const [p, d] of [
      [r.points, 2],
      [r.surface, 3],
    ])
      for (let i = 0; i < p.length; i += d) {
        if (d === 3) {
          assert.equal(p[i + 2], 0);
          assert.ok(p[i] >= 0 && p[i + 1] >= 0 && p[i] + p[i + 1] <= 2);
        }
        for (let j = 0; j < i; j += d) {
          let squared = 0;
          for (let k = 0; k < d; k++) squared += (p[i + k] - p[j + k]) ** 2;
          assert.ok(squared >= 0.2 ** 2);
        }
      }
  }
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      routes: result.map((r) => r.route),
      points: result[0].points.length / 2,
      surfacePoints: result[0].surface.length / 3,
      dungeonRooms: result[0].dungeon.rooms.length,
      treeNodes: result[0].tree.parents.length,
      sdfVertices: result[0].sdf.positions.length / 3,
      lazyWasm: true,
      deviceLossIndependent: true,
      errors,
    }),
  );
} finally {
  await closeAll({ browser, servers: [server] });
  await rm(dir, { recursive: true, force: true });
}
