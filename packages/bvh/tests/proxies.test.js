// Pick proxies: objects drawn without triangles (an @margoengine/lod imposter level) hit through their bounding sphere.
// A structural plugin stands in for LODSystem here; packages/lod/test covers the real one.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine, TransformStore, box } from '../../core/dist/extension.js';
import { Raycaster, setMeshLayers, engineProxies } from '../dist/index.js';

async function world() {
  const engine = new Engine(
    { width: 128, height: 96, clientWidth: 128, clientHeight: 96 },
    await TransformStore.create(64),
    { backend: 'webgpu', gpu: null, add() {}, remove() {}, render() {}, dispose() {} },
    { position: [0, 0, 10], target: [0, 0, 0] },
    null,
  );
  const list = [],
    plugin = { name: 'proxies', setup() {}, pickProxies: () => list };
  engine.use(plugin);
  return { engine, list };
}

test('a ray hits a proxy on its bounding sphere under the anchor transform, flagged approximate', async () => {
  const { engine, list } = await world(),
    anchor = engine.createMesh().setPosition([1, 2, -3]).setScale([2, 1, 1]);
  const model = { root: engine.createMesh(), primitives: [] };
  list.push({ anchor, sphere: [0.5, 0, 0, 1], model });
  assert.deepEqual(engineProxies(engine), list);
  // World ellipsoid: centre (2, 2, -3), semi-axes 2, 1, 1. Along -Z through its centre the entry is z = -2.
  const raycaster = new Raycaster([2, 2, 5], [0, 0, -1]),
    hits = raycaster.intersectEngine(engine),
    [hit] = hits;
  assert.equal(hit.mesh, anchor);
  assert.equal(hit.model, model);
  assert.equal(hit.approximate, true);
  assert.equal(hit.faceIndex, -1);
  assert.ok(Math.abs(hit.distance - 7) < 1e-9 && Math.abs(hit.point[2] + 2) < 1e-9 && hit.frontFace, `${hit.distance}`);
  assert.ok(Math.abs(hit.normal[2] - 1) < 1e-9 && hits.length === 1, 'one hit per proxy: the entry');
  assert.deepEqual(
    hit.localPoint.map((v) => Math.round(v * 1e9) / 1e9),
    [0.5, 0, 1],
  );
  // Along X the ellipsoid is twice as wide: entry at x = 0 from the left.
  raycaster.set([-10, 2, -3], [1, 0, 0]);
  const [side] = raycaster.intersectEngine(engine);
  assert.ok(Math.abs(side.point[0]) < 1e-9 && Math.abs(side.normal[0] + 1) < 1e-9, `${side.point}`);
  raycaster.set([2, 3.01, 5], [0, 0, -1]);
  assert.equal(raycaster.intersectEngine(engine).length, 0, 'just above the ellipsoid misses');
  raycaster.set([2, 2, -3], [0, 0, -1]);
  const [inside] = raycaster.intersectEngine(engine);
  assert.ok(inside.distance === 1 && !inside.frontFace, 'a ray starting inside reports the exit');
  raycaster.set([2, 2, 5], [0, 0, -1]);
  raycaster.far = 6;
  assert.equal(raycaster.intersectEngine(engine).length, 0, 'far');
  raycaster.far = Infinity;
});

test('proxies follow visibility, layers, filters, liveness, object lists and nearest-first ordering with real meshes', async () => {
  const { engine, list } = await world(),
    parent = engine.createMesh(),
    anchor = engine.createMesh(parent).setPosition([0, 0, -5]),
    model = { root: engine.createMesh(), primitives: [] };
  list.push({ anchor, sphere: [0, 0, 0, 1], model: null });
  const front = engine
      .createMesh()
      .setGeometry(box(1, 1, 1))
      .setPosition([0, 0, 0]),
    raycaster = new Raycaster([0, 0, 10], [0, 0, -1]);
  let hits = raycaster.intersectEngine(engine);
  assert.equal(hits[0].mesh, front);
  assert.ok(!hits[0].approximate, 'real geometry stays triangle accurate');
  assert.equal(hits.filter((h) => h.approximate).length, 1, 'proxy after the box');
  raycaster.firstHitOnly = true;
  hits = raycaster.intersectEngine(engine);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].mesh, front);
  front.setPosition([0, 0, -20]);
  hits = raycaster.intersectEngine(engine);
  assert.equal(hits[0].mesh, anchor, 'proxy in front wins');
  assert.ok(Math.abs(hits[0].distance - 14) < 1e-9);
  raycaster.firstHitOnly = false;
  parent.visible = false;
  assert.ok(!raycaster.intersectEngine(engine).some((h) => h.approximate), 'hidden parent');
  parent.visible = true;
  setMeshLayers(anchor, 2);
  raycaster.layers = 1;
  assert.ok(!raycaster.intersectEngine(engine).some((h) => h.approximate), 'anchor layers');
  raycaster.layers = 0xffffffff;
  raycaster.filter = (mesh) => mesh !== anchor;
  assert.ok(!raycaster.intersectEngine(engine).some((h) => h.approximate), 'filter');
  raycaster.filter = null;
  assert.ok(
    !raycaster.intersectObjects(engine, [front]).some((h) => h.approximate),
    'objects without the anchor skip the proxy',
  );
  assert.equal(raycaster.intersectObjects(engine, [anchor]).length, 1, 'the anchor selects its proxy');
  assert.equal(raycaster.intersectMeshes(engine, [anchor])[0].mesh, anchor);
  list[0] = { anchor, sphere: [0, 0, 0, 1], model };
  const [byModel] = raycaster.intersectObjects(engine, [model]);
  assert.ok(byModel.approximate && byModel.model === model, 'the LOD model selects its proxy');
  anchor.dispose();
  assert.ok(!raycaster.intersectEngine(engine).some((h) => h.approximate), 'disposed anchor');
});
