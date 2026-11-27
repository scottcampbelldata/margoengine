// curveFlow() without a GPU: the plugin it builds, its live uniforms, fit, setFlow and its checks.
// curve-flow-browser.mjs checks the GPU bend against CurveFlow.deform on WebGPU and the WebGL2 layer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { CatmullRomCurve3 } from '../../geometry/dist/index.js';
import { CurveFlow } from '../../geometry/dist/flow.js';
import { curveFlow } from '../dist/curve-flow.js';

const track = new CatmullRomCurve3([
  [0, 0, 0],
  [5, 2, 0],
  [10, 0, 4],
]);
const link = /margoengine\.com\/errors#curve-flow/;

test('curveFlow builds a vertex plugin with the frame texture and live offset and scale', () => {
  const flow = new CurveFlow(track, { segments: 32 }),
    plugin = curveFlow(flow, { offset: 2 });
  assert.equal(plugin.pluginName, 'curveflow');
  assert.match(plugin.code.vertex, /textureLoad|curveflowFrame/);
  assert.equal(plugin.uniforms.offset, 2);
  assert.equal(plugin.uniforms.scale, 1);
  assert.equal(plugin.uniforms.segments, 32);
  assert.ok(Math.abs(plugin.uniforms.length - flow.length) < 1e-4);
  const frames = plugin.textures.frames;
  assert.equal(frames.width, 33);
  assert.equal(frames.height, 4);
  // Row 1 holds the tangents: frame 0's tangent is the curve's first tangent.
  const data = frames.source.data,
    t = flow.getFrame(0).tangent;
  for (let k = 0; k < 3; k++) assert.ok(Math.abs(data[33 * 4 + k] - t[k]) < 1e-6);
  plugin.uniforms.offset = 5;
  assert.equal(plugin.uniforms.offset, 5);
  plugin.dispose();
});

test('fit maps the extent onto the whole curve as CurveFlow.deform fit does', () => {
  const flow = new CurveFlow(track),
    plugin = curveFlow(flow, { fit: [-1, 3], scale: 2, offset: 0.5 }),
    stretch = flow.length / 4;
  assert.ok(Math.abs(plugin.uniforms.scale - 2 * stretch) < 1e-4);
  assert.ok(Math.abs(plugin.uniforms.offset - (0.5 + stretch * 2)) < 1e-4);
  plugin.dispose();
});

test('the axis picks the components along, up and side', () => {
  const flow = new CurveFlow(track);
  assert.match(curveFlow(flow, { axis: 'z' }).code.vertex, /position\.z\*curveflow\.scale/);
  assert.match(curveFlow(flow, { axis: 'y', name: 'rail' }).code.vertex, /position\.y\*rail\.scale/);
});

test('setFlow rewrites the same texture when the frame count matches, else swaps it', () => {
  const a = new CurveFlow(track, { segments: 16 }),
    b = new CurveFlow(new CatmullRomCurve3([[0, 0, 0], [0, 6, 0]]), { segments: 16, closed: false }),
    c = new CurveFlow(track, { segments: 40, closed: true }),
    plugin = curveFlow(a),
    first = plugin.textures.frames;
  plugin.setFlow(b);
  assert.equal(plugin.textures.frames, first);
  assert.ok(Math.abs(plugin.uniforms.length - b.length) < 1e-4);
  plugin.setFlow(c);
  assert.notEqual(plugin.textures.frames, first);
  assert.equal(plugin.uniforms.segments, 40);
  assert.equal(plugin.uniforms.closed, 1);
  plugin.dispose();
});

test('invalid input is refused with the fix and the help link', () => {
  const flow = new CurveFlow(track);
  assert.throws(() => curveFlow({}), (e) => e instanceof TypeError && link.test(e.message));
  assert.throws(() => curveFlow(flow, { axis: 'w' }), (e) => e instanceof TypeError && link.test(e.message));
  assert.throws(() => curveFlow(flow, { scale: 0 }), (e) => e instanceof RangeError && link.test(e.message));
  assert.throws(() => curveFlow(flow, { offset: NaN }), (e) => e instanceof RangeError && link.test(e.message));
  assert.throws(() => curveFlow(flow, { fit: [2, 2] }), (e) => e instanceof RangeError && link.test(e.message));
  assert.throws(
    () => curveFlow(new CurveFlow(track, { segments: 9000 })),
    (e) => e instanceof RangeError && /8192 frames/.test(e.message),
  );
  assert.throws(() => curveFlow(flow, { name: 'f' }), TypeError);
});
