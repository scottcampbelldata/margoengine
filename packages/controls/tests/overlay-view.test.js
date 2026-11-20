import test from 'node:test';
import assert from 'node:assert/strict';
import { box } from '@margoengine/core';
import { Engine, TransformStore } from '@margoengine/core/extension';
import { BoxGizmo } from '../dist/box-gizmo.js';
import { FakeElement, close } from './control-fakes.js';

class Canvas extends FakeElement {
  width = 800;
  height = 600;
}
// A WebGL2 stand-in that records every call; constants read back as their own names.
const fakeGL = () => {
  const calls = [];
  const gl = new Proxy(
    {},
    {
      get(_, name) {
        if (typeof name !== 'string') return undefined;
        if (/^[A-Z_0-9]+$/.test(name)) return name;
        return (...args) => {
          calls.push([name, ...args]);
          if (name === 'getShaderParameter' || name === 'getProgramParameter') return true;
          if (name === 'isEnabled' || name === 'isContextLost') return false;
          return {};
        };
      },
    },
  );
  return { gl, calls };
};
async function rig() {
  const el = new Canvas(),
    engine = new Engine(
      el,
      await TransformStore.create(32),
      { backend: 'webgpu', add() {}, remove() {}, render() {}, dispose() {} },
      { position: [5, 4, 8], target: [0, 0, 0] },
      null,
    );
  const mesh = engine.createMesh().setGeometry(box()),
    gizmo = new BoxGizmo(engine).attach(mesh);
  engine.render();
  return { engine, gizmo };
}
const frame = (gl, engine, view) => ({
  backend: 'webgl2',
  gl,
  delta: 0,
  width: 800,
  height: 600,
  camera: engine.camera,
  view,
  draw() {},
});

test('WebGL2 overlay draws into the view rectangle and its scissor, flipped to a bottom-left origin', async () => {
  const { engine, gizmo } = await rig();
  const { gl, calls } = fakeGL();
  gizmo.draw(
    frame(gl, engine, {
      id: 'v',
      camera: engine.camera,
      viewport: [400, 100, 300, 200],
      scissor: [410, 110, 100, 50],
      index: 0,
      count: 1,
    }),
  );
  assert.deepEqual(
    calls.find((c) => c[0] === 'viewport'),
    ['viewport', 400, 300, 300, 200],
  );
  assert.deepEqual(
    calls.find((c) => c[0] === 'scissor'),
    ['scissor', 410, 440, 100, 50],
  );
  const draw = calls.findIndex((c) => c[0] === 'drawArrays'),
    on = calls.findIndex((c) => c[0] === 'enable' && c[1] === 'SCISSOR_TEST'),
    off = calls.findIndex((c) => c[0] === 'disable' && c[1] === 'SCISSOR_TEST');
  assert.ok(on >= 0 && on < draw && off > draw, 'scissor test on for the draw only');
  const plain = fakeGL();
  gizmo.draw(frame(plain.gl, engine, undefined));
  assert.deepEqual(
    plain.calls.find((c) => c[0] === 'viewport'),
    ['viewport', 0, 0, 800, 600],
  );
  assert.equal(
    plain.calls.find((c) => c[0] === 'scissor'),
    undefined,
  );
  gizmo.dispose();
  engine.dispose();
});

test('BoxGizmo tessellates its lines for the view size, so a half-width view keeps 1.5 px edges', async () => {
  const { engine, gizmo } = await rig();
  const { gl, calls } = fakeGL();
  gizmo.draw(frame(gl, engine, { id: 'v', camera: engine.camera, viewport: [400, 0, 400, 600], index: 0, count: 1 }));
  const data = calls.find((c) => c[0] === 'bufferData')[2];
  // A line quad's first two corners are the segment end offset both ways: their distance in view pixels is the width.
  let thinnest = Infinity;
  for (let t = 0; t < data.length; t += 24) {
    const [ax, ay, az, aw] = data.subarray(t, t + 4),
      [bx, by, bz, bw] = data.subarray(t + 8, t + 12);
    if (az !== bz || aw !== bw) continue;
    const d = Math.hypot(((ax - bx) / aw) * 200, ((ay - by) / aw) * 300);
    if (d > 1e-6) thinnest = Math.min(thinnest, d);
  }
  close(thinnest, 1.5, 1e-3);
  gizmo.dispose();
  engine.dispose();
});
