import test from 'node:test';
import assert from 'node:assert/strict';
import { Camera } from '@margoengine/core';
import { PointCloud, PointsPlugin } from '../dist/index.js';
import { PointPicking, pointPickShader } from '../dist/pick.js';
import { mockGPU, passes } from '../../../examples/package-benchmarks/proofs/gpu-recorder.js';

function rig() {
  const gpu = mockGPU(),
    plugin = new PointsPlugin(),
    camera = new Camera({ position: [0, 0, 8], target: [0, 0, 0] }),
    view = gpu.device.createTexture({ size: [64, 64], format: 'rgba8unorm' }).createView(),
    meshes = [],
    engine = {
      backend: 'webgpu',
      gpu: gpu.device,
      createMesh() {
        const mesh = {
          dispose() {
            meshes.splice(meshes.indexOf(mesh), 1);
          },
        };
        meshes.push(mesh);
        return mesh;
      },
    };
  camera.update(1, true);
  gpu.record(() => plugin.setup(engine));
  const run = passes(plugin),
    frame = () =>
      gpu.record(() =>
        run({
          backend: 'webgpu',
          device: gpu.device,
          encoder: gpu.encoder,
          camera,
          width: 64,
          height: 64,
          format: 'rgba8unorm',
          color: view,
          depth: view,
          descriptor: { depthStencil: { format: 'depth24plus' }, multisample: { count: 1 } },
        }),
      );
  const overlays = new Set(),
    host = {
      addOverlay(overlay) {
        overlays.add(overlay);
        return () => overlays.delete(overlay);
      },
    },
    pick = (overlay, firstId = 7) =>
      gpu.record(() =>
        overlay.drawPick({
          encoder: gpu.encoder,
          color: view,
          depth: view,
          matrix: camera.matrix,
          camera,
          rect: [0, 0, 64, 64],
          firstId,
        }),
      );
  return { gpu, plugin, frame, host, overlays, pick, meshes };
}
const draws = (log) => log.filter((e) => e[0] === 'pass.draw');
const pipelines = (log) => log.filter((e) => e[0] === 'renderPipeline').map((e) => e[2]);

test('the pick shader carries the slot and keeps every cut of the drawn point', () => {
  const code = pointPickShader();
  assert.match(code, /out\.slot=slot;/);
  assert.match(code, /let s=surface\(i\);\n {2}if\(s\.color\.a<=0\.0\)\{discard;\}\n {2}return pickBase\.x\+i\.slot;/);
  assert.match(code, /SpherePick\(pickBase\.x\+i\.slot,sphereDepth\(i,s\.nz\)\)/);
});

test('a pick draws what the view drew, with an ID range per cloud, and hits map back to points', () => {
  const { plugin, frame, host, pick, overlays, meshes } = rig(),
    a = plugin.add(new PointCloud({ positions: [0, 0, 0, 1, 0, 0, 0, 1, 0] })),
    b = plugin.add(new PointCloud({ positions: [0, 0, 1, 1, 1, 1], reorder: true }));
  plugin['engine'] = plugin['engine'] ?? {};
  const overlay = PointPicking.attach(host, plugin);
  assert.equal(overlays.size, 1);
  assert.equal(meshes.length, 2, 'a stand-in per cloud');
  frame();
  const log = pick(overlay),
    [pipeline] = pipelines(log);
  assert.equal(pipeline.fragment.targets[0].format, 'r32uint');
  assert.equal(pipeline.depthStencil.format, 'depth32float');
  assert.equal(pipeline.depthStencil.depthCompare, 'greater-equal');
  assert.equal(pipeline.depthStencil.depthWriteEnabled, true);
  assert.equal(draws(log).length, 2);
  const first = overlay.pickHit(1);
  assert.equal(first.cloud, a);
  assert.equal(first.point, a.blocks.order[1]);
  assert.deepEqual(
    [...first.position],
    [...a.positions.slice(first.point * 3, first.point * 3 + 3)],
  );
  const second = overlay.pickHit(4);
  assert.equal(second.cloud, b);
  assert.equal(second.point, 1, 'a reordered cloud reads slots directly');
  assert.equal(overlay.cloudOf(first.mesh), a);
  assert.equal(overlay.cloudOf({}), null);
  assert.equal(overlay.cloudOf(null), null);
  assert.equal(pipelines(pick(overlay)).length, 0, 'pipelines are made once');
});

test('the model matrix moves hit positions; a followed mesh answers for its cloud', () => {
  const { plugin, frame, host, pick } = rig(),
    cloud = plugin.add(new PointCloud({ positions: [0.5, 0.25, 0] }));
  cloud.matrix[12] = 1;
  const overlay = PointPicking.attach(host, plugin);
  frame();
  pick(overlay);
  assert.deepEqual([...overlay.pickHit(0).position], [1.5, 0.25, 0]);
});

test('clouds that come and go keep their stand-ins in step; dispose leaves nothing behind', () => {
  const { plugin, host, overlays, meshes } = rig(),
    overlay = PointPicking.attach(host, plugin),
    cloud = plugin.add(new PointCloud({ positions: [0, 0, 0] }));
  assert.equal(meshes.length, 1);
  plugin.remove(cloud);
  assert.equal(meshes.length, 0);
  plugin.add(cloud);
  overlay.dispose();
  assert.equal(meshes.length, 0);
  assert.equal(overlays.size, 0);
  assert.equal(plugin['watchers'].size, 0);
});

test('a view with nothing drawn draws nothing, and an unattached plugin is refused', () => {
  const { plugin, host, pick } = rig();
  plugin.add(new PointCloud({ positions: [0, 0, 0] }));
  const overlay = PointPicking.attach(host, plugin);
  assert.equal(draws(pick(overlay)).length, 0);
  assert.equal(overlay.pickHit(0), null);
  assert.throws(
    () => PointPicking.attach(host, new PointsPlugin()),
    (e) => e.code === 'state',
  );
});

test('sphere shading and depthTest false choose their pipelines', () => {
  const { plugin, frame, host, pick } = rig();
  plugin.add(new PointCloud({ positions: [0, 0, 0], material: { shading: 'sphere' } }));
  plugin.add(new PointCloud({ positions: [0, 1, 0], material: { depthTest: false } }));
  const overlay = PointPicking.attach(host, plugin);
  frame();
  const [sphere, top] = pipelines(pick(overlay));
  assert.equal(sphere.fragment.entryPoint, 'pickSphere');
  assert.equal(top.depthStencil.depthCompare, 'always');
});
