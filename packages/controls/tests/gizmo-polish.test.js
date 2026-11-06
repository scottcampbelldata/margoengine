import test from 'node:test';
import assert from 'node:assert/strict';
import { box } from '@margoengine/core';
import { Engine as Runtime, TransformStore } from '@margoengine/core/extension';
import { TransformControls, buildDelta } from '../dist/index.js';
import { FakeElement, close, closeVec, pointer } from './control-fakes.js';

class Canvas extends FakeElement {
  width = 800;
  height = 600;
  getContext() {
    return null;
  }
}
async function rig(position = [6, 4, 6], given = {}) {
  const options = { flipAxes: true, ...given };
  const canvas = new Canvas(),
    store = await TransformStore.create(32),
    renderer = { backend: 'webgpu', add() {}, remove() {}, render() {}, dispose() {} },
    engine = new Runtime(canvas, store, renderer, { position, target: [0, 0, 0] }, null),
    mesh = engine.createMesh().setGeometry(box()),
    gizmo = new TransformControls(engine, options);
  gizmo.attach(mesh);
  engine.render();
  return { canvas, engine, mesh, gizmo };
}
function pixel(cam, p) {
  const m = cam.matrix,
    x = m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
    y = m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
    w = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15];
  return [((x / w + 1) / 2) * 800, ((1 - y / w) / 2) * 600];
}
const handle = (gizmo, name) => gizmo.handles().find((h) => h.name === name);
const tip = (gizmo, name) => handle(gizmo, name).pick.b;

test('flip: arrows point to the camera side of each axis, and flipAxes false (the default) keeps them positive', async () => {
  const { engine, gizmo } = await rig();
  assert.equal(new TransformControls(engine).flipAxes, false);
  assert.deepEqual(gizmo.frame().flip, [1, 1, 1]);
  assert.ok(tip(gizmo, 'X')[0] > 0 && tip(gizmo, 'Z')[2] > 0);
  engine.camera.position = [-6, -4, -6];
  engine.render();
  assert.deepEqual(gizmo.frame().flip, [-1, -1, -1]);
  for (const [name, i] of [
    ['X', 0],
    ['Y', 1],
    ['Z', 2],
  ])
    assert.ok(tip(gizmo, name)[i] < 0, `${name} faces the camera`);
  // The grab follows what is drawn: the point on the negative side picks X, its mirror does not.
  const size = gizmo.frame().size;
  assert.equal(gizmo.pick(...pixel(engine.camera, [-0.7 * size, 0, 0])), 'X');
  assert.notEqual(gizmo.pick(...pixel(engine.camera, [0.7 * size, 0, 0])), 'X');
  gizmo.flipAxes = false;
  assert.equal(gizmo.frame().flip, undefined);
  assert.ok(tip(gizmo, 'X')[0] > 0);
  gizmo.dispose();
  engine.dispose();
});

test('flip: plane squares and scale handles flip too, rings do not', async () => {
  const { engine, gizmo } = await rig([-6, 4, -6]);
  const quad = handle(gizmo, 'XZ').prims[0].points;
  assert.ok(
    quad.every((p) => p[0] < 0 && p[2] < 0),
    'the XZ square sits in the camera quadrant',
  );
  gizmo.setMode('scale');
  assert.ok(tip(gizmo, 'X')[0] < 0, 'scale handle');
  gizmo.setMode('rotate');
  assert.deepEqual(gizmo.handles().map((h) => h.name).slice(0, 3), ['X', 'Y', 'Z']);
  gizmo.dispose();
  engine.dispose();
});

test('flip: a side view does not flicker, and the arrows hold still during a drag', async () => {
  const { canvas, engine, mesh, gizmo } = await rig([-6, 4, 6]);
  assert.deepEqual(gizmo.frame().flip, [-1, 1, 1]);
  // Slightly past side-on: inside the margin the last choice stands, beyond it the arrow turns.
  engine.camera.position = [0.2, 4, 6];
  engine.render();
  assert.equal(gizmo.frame().flip[0], -1, 'within the margin');
  engine.camera.position = [2, 4, 6];
  engine.render();
  assert.equal(gizmo.frame().flip[0], 1, 'past the margin');
  engine.camera.position = [-6, 4, 6];
  engine.render();
  const size = gizmo.frame().size,
    from = pixel(engine.camera, [-0.7 * size, 0, 0]),
    to = pixel(engine.camera, [-0.7 * size - 1, 0, 0]);
  pointer(canvas, 'pointerdown', ...from);
  assert.equal(gizmo.dragging, true);
  engine.camera.position = [6, 4, 6];
  engine.render();
  assert.equal(gizmo.frame().flip[0], -1, 'held during the drag');
  engine.camera.position = [-6, 4, 6];
  engine.render();
  pointer(canvas, 'pointermove', ...to);
  pointer(canvas, 'pointerup', ...to);
  close(mesh.position.x, -1, 1e-4, 'the flipped arrow drags the same way the pointer goes');
  close(mesh.position.y, 0, 1e-9);
  close(mesh.position.z, 0, 1e-9);
  gizmo.dispose();
  engine.dispose();
});

test('flip: dragging a flipped scale handle outward grows the object', async () => {
  const { canvas, engine, mesh, gizmo } = await rig([-6, 4, -6], { mode: 'scale' });
  const s = gizmo.frame().size,
    from = pixel(engine.camera, [-0.9 * s, 0, 0]),
    to = pixel(engine.camera, [-1.8 * s, 0, 0]);
  pointer(canvas, 'pointerdown', ...from);
  pointer(canvas, 'pointermove', ...to);
  pointer(canvas, 'pointerup', ...to);
  close(mesh.scale.x, 2, 1e-3, 'twice as far along the arrow is twice the scale');
  close(mesh.scale.y, 1, 1e-9);
  gizmo.dispose();
  engine.dispose();
});

test('delta: a move draws a line from the start to where the object is, and only during the drag', async () => {
  const { canvas, engine, gizmo } = await rig([0, 0, 10]);
  assert.equal(gizmo.showDelta, true);
  assert.equal(gizmo.frame().delta, null);
  assert.deepEqual(buildDelta(gizmo.frame()), []);
  const s = gizmo.frame().size,
    from = pixel(engine.camera, [0.7 * s, 0, 0]),
    to = pixel(engine.camera, [0.7 * s + 1, 0, 0]);
  pointer(canvas, 'pointerdown', ...from);
  assert.deepEqual(buildDelta(gizmo.frame()), [], 'nothing moved yet');
  pointer(canvas, 'pointermove', ...to);
  engine.render();
  const frame = gizmo.frame();
  closeVec(frame.delta.from, [0, 0, 0], 1e-9);
  closeVec(frame.delta.to, [1, 0, 0], 1e-4);
  const [line, marker] = buildDelta(frame);
  assert.equal(line.kind, 'lines');
  closeVec(line.points[1], frame.origin, 0);
  assert.equal(marker.kind, 'triangles');
  assert.ok(marker.points.every((p) => Math.hypot(...p) < s), 'the marker stays at the start');
  gizmo.showDelta = false;
  assert.equal(gizmo.frame().delta, null);
  gizmo.showDelta = true;
  pointer(canvas, 'pointerup', ...to);
  assert.equal(gizmo.frame().delta, null);
  gizmo.dispose();
  engine.dispose();
});

test('delta: a turn sweeps an arc that ends under the pointer, follows the snap and stops at a full turn', async () => {
  const { canvas, engine, gizmo } = await rig([0, 0, 10], { mode: 'rotate' });
  const s = gizmo.frame().size,
    on = (a) => pixel(engine.camera, [Math.cos(a) * s, Math.sin(a) * s, 0]);
  pointer(canvas, 'pointerdown', ...on(0.6));
  assert.equal(gizmo.axis, 'Z');
  pointer(canvas, 'pointermove', ...on(1.6));
  let d = gizmo.frame().delta;
  assert.equal(d.kind, 'arc');
  closeVec(d.axis, [0, 0, 1], 0);
  closeVec(d.spoke, [Math.cos(0.6), Math.sin(0.6), 0], 1e-4);
  close(d.angle, 1, 1e-4);
  const [fan, lines] = buildDelta(gizmo.frame());
  assert.equal(fan.kind, 'triangles');
  closeVec(lines.points[3], [Math.cos(1.6) * s, Math.sin(1.6) * s, 0], 1e-3, 'second spoke ends at the pointer');
  gizmo.rotationSnap = 0.25;
  pointer(canvas, 'pointermove', ...on(1.7));
  close(gizmo.frame().delta.angle, 1, 1e-9, 'snapped');
  gizmo.rotationSnap = null;
  for (let a = 1.6; a < 8.6; a += 0.5) pointer(canvas, 'pointermove', ...on(a));
  d = gizmo.frame();
  assert.ok(d.delta.angle > 2 * Math.PI);
  const sweep = buildDelta(d)[0];
  assert.ok(sweep.points.length <= 3 * 64, 'at most one full turn of fan');
  pointer(canvas, 'pointerup', ...on(8.5));
  gizmo.dispose();
  engine.dispose();
});

test('delta: the view ring, an edge-on ring, axis and plane scale, and no line for uniform scale or a free turn', async () => {
  let { canvas, engine, gizmo } = await rig([0, 0, 10], { mode: 'rotate' });
  const s = gizmo.frame().size,
    view = (a) => pixel(engine.camera, [Math.cos(a) * 1.25 * s, Math.sin(a) * 1.25 * s, 0]);
  pointer(canvas, 'pointerdown', ...view(0.2));
  assert.equal(gizmo.axis, 'E');
  pointer(canvas, 'pointermove', ...view(1.2));
  const d = gizmo.frame().delta;
  assert.equal(d.view, true);
  close(d.angle, 1, 1e-4);
  const end = buildDelta(gizmo.frame())[1].points[3];
  closeVec(end, [Math.cos(1.2) * 1.25 * s, Math.sin(1.2) * 1.25 * s, 0], 1e-3, 'the arc ends under the pointer');
  pointer(canvas, 'pointerup', ...view(1.2));
  // The free disc has no single axis to sweep about.
  pointer(canvas, 'pointerdown', ...pixel(engine.camera, [0.4 * s, 0.1 * s, 0]));
  assert.equal(gizmo.axis, 'XYZE');
  pointer(canvas, 'pointermove', ...pixel(engine.camera, [0.5 * s, 0.1 * s, 0]));
  assert.equal(gizmo.frame().delta, null);
  pointer(canvas, 'pointerup', 400, 300);
  // Seen edge-on, the Y ring falls back to a screen drag and still has a spoke.
  gizmo.dispose();
  engine.dispose();

  ({ canvas, engine, gizmo } = await rig([0, 0, 10], { mode: 'rotate', showZ: false }));
  const r = gizmo.frame().size,
    grab = pixel(engine.camera, [r, 0, 0]);
  pointer(canvas, 'pointerdown', ...grab);
  assert.equal(gizmo.axis, 'Y');
  pointer(canvas, 'pointermove', grab[0] - 30, grab[1]);
  const edge = gizmo.frame().delta;
  assert.ok(edge && Math.abs(edge.angle) > 0);
  close(Math.hypot(...edge.spoke), 1, 1e-9);
  pointer(canvas, 'pointerup', grab[0] - 30, grab[1]);
  gizmo.dispose();
  engine.dispose();

  ({ canvas, engine, gizmo } = await rig([0, 0, 10], { mode: 'scale' }));
  const q = gizmo.frame().size,
    from = pixel(engine.camera, [0.7 * q, 0, 0]);
  pointer(canvas, 'pointerdown', ...from);
  pointer(canvas, 'pointermove', from[0] + 40, from[1] + 25);
  const line = gizmo.frame().delta;
  assert.equal(line.kind, 'line');
  close(line.to[1], 0, 1e-9, 'an axis scale stays on its axis');
  assert.ok(line.to[0] > line.from[0]);
  pointer(canvas, 'pointerup', from[0] + 40, from[1] + 25);
  const centre = pixel(engine.camera, [0, 0, 0]);
  pointer(canvas, 'pointerdown', ...centre);
  assert.equal(gizmo.axis, 'XYZ');
  pointer(canvas, 'pointermove', centre[0] + 30, centre[1]);
  assert.equal(gizmo.frame().delta, null, 'a uniform scale has no line');
  pointer(canvas, 'pointerup', centre[0] + 30, centre[1]);
  gizmo.dispose();
  engine.dispose();
});

test('occlude: off by default; on, WebGPU tests read-only scene depth and WebGL2 keeps the depth test without writing', async () => {
  const { engine, gizmo } = await rig();
  assert.equal(gizmo.occlude, false);
  assert.equal((await rig([0, 0, 10], { occlude: true })).gizmo.occlude, true);
  globalThis.GPUBufferUsage ??= { VERTEX: 32, COPY_DST: 8 };
  const pipelines = [],
    passes = [],
    context = {
      backend: 'webgpu',
      width: 8,
      height: 8,
      format: 'bgra8unorm',
      color: {},
      depth: { name: 'scene depth' },
      descriptor: { multisample: { count: 4 }, depthStencil: { format: 'depth24plus' } },
      device: {
        createShaderModule: () => ({}),
        createRenderPipeline: (d) => (pipelines.push(d), {}),
        createBuffer: () => ({ destroy() {} }),
        queue: { writeBuffer() {} },
      },
      encoder: {
        beginRenderPass: (d) => (
          passes.push(d),
          { setPipeline() {}, setVertexBuffer() {}, draw() {}, end() {}, setViewport() {}, setScissorRect() {} }
        ),
      },
    },
    vertices = new Float32Array(24);
  gizmo.overlay.draw(context, vertices);
  gizmo.overlay.draw(context, vertices, true);
  gizmo.overlay.draw(context, vertices, true);
  assert.equal(pipelines.length, 2, 'one pipeline per mode');
  assert.equal(pipelines[0].depthStencil, undefined);
  assert.equal(passes[0].depthStencilAttachment, undefined);
  assert.deepEqual(pipelines[1].depthStencil, {
    format: 'depth24plus',
    depthWriteEnabled: false,
    depthCompare: 'greater-equal',
  });
  assert.equal(passes[1].depthStencilAttachment.view, context.depth);
  assert.equal(passes[1].depthStencilAttachment.depthReadOnly, true);

  const calls = [],
    gl = new Proxy(
      {
        DEPTH_TEST: 'DEPTH_TEST',
        getShaderParameter: () => true,
        getProgramParameter: () => true,
        createProgram: () => ({}),
        createShader: () => ({}),
        createVertexArray: () => ({}),
        createBuffer: () => ({}),
        isContextLost: () => false,
      },
      {
        get(target, name) {
          return name in target ? target[name] : (...args) => calls.push([name, ...args]);
        },
      },
    ),
    glContext = { backend: 'webgl2', gl, width: 8, height: 8 },
    named = (name) => calls.filter((c) => c[0] === name);
  gizmo.overlay.draw(glContext, vertices);
  assert.deepEqual(named('disable')[0], ['disable', 'DEPTH_TEST']);
  assert.equal(named('depthMask').at(-1)[1], true);
  calls.length = 0;
  gizmo.overlay.draw(glContext, vertices, true);
  assert.ok(!named('disable').some((c) => c[1] === 'DEPTH_TEST'), 'the depth test stays on');
  assert.deepEqual(
    named('depthMask').map((c) => c[1]),
    [false, true],
    'no depth writes, then restored',
  );
  gizmo.dispose();
  engine.dispose();
});
