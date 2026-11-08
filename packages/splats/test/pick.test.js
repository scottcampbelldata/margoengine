// SplatPicking (./pick) without a GPU: the recorded pick pass, the frame it projects with, hits and the stand-in mesh.
// test/gpu/check.mjs proves the picks on a real GPU, against meshes, with engine.pick, picking.pick and pickMany.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Camera } from '@margoengine/core';
import { Splats } from '../dist/index.js';
import { SplatPicking, splatPickShader } from '../dist/pick.js';
import { project } from '../src/shader.ts';
import { mockGPU } from '../../../examples/package-benchmarks/proofs/gpu-recorder.js';

function rig(count = 3) {
  const gpu = mockGPU(),
    cloud = Splats.reserve(count),
    camera = new Camera({ position: [0, 0, 8], target: [0, 0, 0] }),
    view = gpu.device.createTexture({ size: [3, 3], format: 'r32uint' }).createView(),
    meshes = [],
    engine = {
      backend: 'webgpu',
      gpu: gpu.device,
      removePlugin() {},
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
  gpu.record(() => cloud.setup(engine));
  cloud['engine'] = engine;
  const overlays = new Set(),
    host = {
      addOverlay(overlay) {
        overlays.add(overlay);
        return () => overlays.delete(overlay);
      },
    },
    pick = (overlay, firstId = 7, rect = [0, 0, 64, 32]) =>
      gpu.record(() =>
        overlay.drawPick({
          encoder: gpu.encoder,
          color: view,
          depth: view,
          matrix: camera.matrix,
          camera,
          rect,
          firstId,
        }),
      );
  return { gpu, cloud, camera, host, overlays, pick, meshes };
}
const draws = (log) => log.filter((e) => e[0] === 'pass.draw');
const pipelines = (log) => log.filter((e) => e[0] === 'renderPipeline').map((e) => e[2]);
const writes = (log) => log.filter((e) => e[0] === 'writeBuffer');
const floats = (hex) => new Float32Array(new Uint8Array(Buffer.from(hex, 'hex')).buffer);

test('the projection is one function the colour pass and the pick share', () => {
  assert.match(project, /fn projectSplat\(index:u32\)->Projected/);
  assert.match(project, /let projected=projectSplat\(index\);\n {2}ellipses\[index\]=projected\.ellipse;keys\[index\]=vec2u\(projected\.key,index\);/);
  assert.equal(project.split('evaluated[index]=vec4f(color(index),world.w);').length, 2, 'the fog edit still finds its line');
  assert.match(splatPickShader, /fn projectSplat\(index:u32\)->Projected/);
  assert.doesNotMatch(splatPickShader, /read_write/, 'a vertex shader reads storage only');
  assert.match(splatPickShader, /let alpha=min\(0\.99,i\.opacity\*exp\(power\)\);if\(alpha<max\(pick\.threshold,1\.0\/255\)\)\{discard;\}return pick\.first\+i\.splat;/);
});

test('a pick draws every splat once into the tile, and hits map back to splats', () => {
  const { cloud, host, overlays, pick, meshes } = rig(),
    picking = SplatPicking.attach(host, cloud);
  assert.equal(overlays.size, 1);
  assert.equal(meshes.length, 1, 'one stand-in mesh');
  assert.equal(picking.threshold, 0.1, 'the brush default');
  const log = pick(picking, 9),
    [pipeline] = pipelines(log);
  assert.equal(pipeline.fragment.targets[0].format, 'r32uint');
  assert.equal(pipeline.primitive.topology, 'triangle-strip');
  assert.equal(pipeline.depthStencil.format, 'depth32float');
  assert.equal(pipeline.depthStencil.depthCompare, 'greater-equal');
  assert.equal(pipeline.depthStencil.depthWriteEnabled, true);
  assert.deepEqual(
    draws(log).map((e) => e.slice(1, 3)),
    [[4, 3]],
    'four corners for each of the 3 splats',
  );
  const [frame, params] = writes(log).map((e) => e[3]),
    f = floats(frame),
    n = new Uint32Array(f.buffer);
  assert.deepEqual([...f.subarray(36, 38)], [3, 3], 'a 3 x 3 target');
  assert.ok(Math.abs(f[38] - 32 / (2 * Math.tan(Math.PI / 6))) < 1e-3, `focal length of the view's height: ${f[38]}`);
  assert.equal(f[43], 0, 'perspective');
  assert.deepEqual([...n.subarray(44, 48)], [3, 0, 0, 0]);
  const p = new DataView(new Uint8Array(Buffer.from(params, 'hex')).buffer);
  assert.ok(Math.abs(p.getFloat32(0, true) - 0.1) < 1e-7);
  assert.equal(p.getUint32(4, true), 9, 'IDs from firstId');
  const hit = picking.pickHit(2);
  assert.equal(hit.splats, cloud);
  assert.equal(hit.splat, 2);
  assert.equal(hit.mesh, meshes[0]);
  assert.equal(picking.splatsOf(hit.mesh), cloud);
  assert.equal(picking.splatsOf({}), null);
  assert.equal(picking.splatsOf(null), null);
  assert.equal(picking.pickHit(3), null, 'past the cloud');
  assert.equal(picking.pickHit(-1), null);
  assert.equal(pipelines(pick(picking)).length, 0, 'the pipeline is made once');
});

test('antialias and the threshold reach the pick; an orthographic camera uses its own pixel scale', () => {
  const { cloud, camera, host, pick } = rig(1),
    picking = SplatPicking.attach(host, cloud, { threshold: 0.5 });
  cloud.antialias = true;
  picking.threshold = 0.25;
  // An orthographic clip matrix: 2 / 10 world units across x, 2 / 5 across y, depth 0.1 to 100.
  camera.matrix.set([0.2, 0, 0, 0, 0, 0.4, 0, 0, 0, 0, 0.01, 0, 0, 0, 0.1, 1]);
  const [frame, params] = writes(pick(picking, 0, [0, 0, 100, 50])).map((e) => e[3]),
    f = floats(frame);
  assert.equal(f[43], 1, 'orthographic');
  assert.ok(Math.abs(f[38] - 10) < 1e-5 && Math.abs(f[39] - 10) < 1e-5, `pixels per world unit: ${f[38]}, ${f[39]}`);
  assert.equal(new Uint32Array(f.buffer)[46], 1, 'antialiased opacity');
  assert.ok(Math.abs(floats(params)[0] - 0.25) < 1e-7);
});

test('thresholds outside 0 to 1, an unattached cloud and a disposed one are handled', () => {
  const { cloud, host, overlays, pick, meshes } = rig();
  assert.throws(() => SplatPicking.attach(host, cloud, { threshold: 1.5 }), RangeError);
  assert.throws(() => SplatPicking.attach(host, cloud, { threshold: Number.NaN }), RangeError);
  assert.throws(() => SplatPicking.attach(host, Splats.reserve(1)), (e) => e.code === 'state');
  assert.equal(meshes.length, 0, 'a refused attach leaves no mesh');
  const picking = SplatPicking.attach(host, cloud);
  assert.throws(() => (picking.threshold = -0.1), RangeError);
  cloud.dispose();
  assert.equal(draws(pick(picking)).length, 0, 'a disposed cloud draws nothing');
  picking.dispose();
  assert.equal(meshes.length, 0, 'dispose frees the stand-in');
  assert.equal(overlays.size, 0, 'and leaves Picking');
  picking[Symbol.dispose]();
});
