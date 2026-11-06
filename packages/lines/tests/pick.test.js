import test from 'node:test';
import assert from 'node:assert/strict';
import { Line } from '../dist/index.js';
import { LinePicking, linePickShader } from '../dist/pick.js';
import { Picking } from '../../selection/dist/index.js';
import { rig } from './gpu-rig.js';

test('the pick shader writes segment IDs, keeps the clipping cut and drops colour', () => {
  const code = linePickShader();
  assert.match(code, /@location\(4\) @interpolate\(flat\) segment:u32/);
  assert.match(code, /o\.segment=ii;/);
  assert.match(code, /return pickBase\.x\+i\.segment;/);
  assert.match(code, /clipBehind/);
  assert.doesNotMatch(code, /fn encode/);
});

test('Picking takes 8 overlays and reuses a removed slot', () => {
  const picking = new Picking(),
    overlay = { drawPick() {}, pickHit: () => null },
    removers = Array.from({ length: 8 }, () => picking.addOverlay({ ...overlay }));
  assert.throws(() => picking.addOverlay({ ...overlay }), RangeError);
  removers[3]();
  removers[3]();
  assert.doesNotThrow(() => picking.addOverlay({ ...overlay }));
  assert.throws(() => picking.addOverlay({ ...overlay }), RangeError);
});

function host() {
  const added = [];
  return {
    added,
    addOverlay(overlay) {
      added.push(overlay);
      return () => added.splice(added.indexOf(overlay), 1);
    },
  };
}

test('a pick draws depth-tested lines first, then onTop ones, with IDs per segment and hits back from them', () => {
  const { gpu, lines } = rig(),
    meshes = [],
    engine = {
      canvas: { clientWidth: 64, width: 64 },
      createMesh: () => {
        const mesh = { dispose() {} };
        meshes.push(mesh);
        return mesh;
      },
    };
  lines['engine'] = engine;
  const plain = lines.add(new Line({ positions: [0, 0, 0, 1, 0, 0, 2, 0, 0] })),
    top = lines.add(new Line({ positions: [0, 1, 0, 1, 1, 0], onTop: true })),
    second = lines.add(new Line({ positions: [0, 2, 0, 1, 2, 0, 1, 3, 0, 2, 3, 0] })),
    server = host(),
    picking = LinePicking.attach(server, lines),
    view = gpu.device.createTexture({ size: [3, 3], format: 'r32uint' }).createView(),
    camera = { matrix: new Float32Array(16).fill(1), fov: 60 },
    log = gpu.record(() =>
      picking.drawPick({
        encoder: gpu.encoder,
        color: view,
        depth: view,
        matrix: new Float32Array(16),
        camera,
        rect: [0, 0, 64, 64],
        firstId: 1000,
      }),
    );
  const pipelines = log.filter((e) => e[0] === 'renderPipeline').map((e) => e[2]);
  assert.deepEqual(
    pipelines.map((p) => [p.depthStencil.depthCompare, p.depthStencil.depthWriteEnabled]),
    [
      ['greater-equal', true],
      ['always', true],
    ],
  );
  assert.deepEqual(
    log.filter((e) => e[0] === 'pass.draw').map((e) => e[2]),
    [2, 3, 1],
  );
  const pass = log.find((e) => e[0] === 'beginRenderPass')[1];
  assert.equal(pass.colorAttachments[0].loadOp, 'load', 'the meshes stay in the tile');
  assert.equal(pass.depthStencilAttachment.depthLoadOp, 'load');
  assert.deepEqual(
    log.filter((e) => e[0] === 'pass.setBindGroup' && e[1] === 2).map((e) => e[3]),
    [[0], [256], [512]],
  );
  assert.equal(meshes.length, 3, 'one stand-in per line, made at attach');
  assert.deepEqual({ ...picking.pickHit(0), mesh: 0 }, { mesh: 0, line: plain, segment: 0 });
  assert.equal(picking.pickHit(1).segment, 1);
  assert.equal(picking.pickHit(2).line, second);
  assert.equal(picking.pickHit(4).segment, 2);
  assert.equal(picking.pickHit(5).line, top, 'onTop lines take the last IDs');
  assert.equal(picking.lineOf(picking.pickHit(5).mesh), top);
  assert.equal(picking.lineOf({}), null);
  assert.equal(picking.lineOf(null), null);
  picking.dispose();
  assert.equal(server.added.length, 0);
  assert.equal(picking.pickHit(0), null);
});

test('stand-ins are made outside picks, as lines join, and go when lines leave', () => {
  const { gpu, lines } = rig();
  let disposed = 0,
    made = 0;
  lines['engine'] = {
    canvas: { clientWidth: 64, width: 64 },
    createMesh: () => {
      made++;
      return { dispose: () => disposed++ };
    },
  };
  const line = lines.add(new Line({ positions: [0, 0, 0, 1, 0, 0] })),
    picking = LinePicking.attach(host(), lines),
    view = gpu.device.createTexture({ size: [3, 3], format: 'r32uint' }).createView(),
    context = {
      encoder: gpu.encoder,
      color: view,
      depth: view,
      matrix: new Float32Array(16),
      camera: { matrix: new Float32Array(16).fill(1), fov: 60 },
      rect: [0, 0, 64, 64],
      firstId: 0,
    };
  assert.equal(made, 1);
  const late = lines.add(new Line({ positions: [0, 0, 0, 1, 0, 0] }));
  assert.equal(made, 2);
  lines.remove(late);
  assert.equal(disposed, 1);
  picking.drawPick(context);
  assert.equal(made, 2, 'a pick makes no mesh: that would void its own answer');
  const standIn = picking.pickHit(0).mesh;
  lines.remove(line);
  picking.drawPick(context);
  assert.equal(disposed, 2);
  assert.equal(picking.lineOf(standIn), null);
  assert.equal(picking.pickHit(0), null, 'no lines, no hits');
});
