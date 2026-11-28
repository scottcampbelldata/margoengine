// curveFlow() without a GPU: the plugin it builds, its live uniforms, fit, setFlow and its checks.
// curve-flow-browser.mjs checks the GPU bend against CurveFlow.deform on WebGPU and the WebGL2 layer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { CatmullRomCurve3 } from '../../geometry/dist/index.js';
import { CurveFlow } from '../../geometry/dist/flow.js';
import { curveFlow } from '../dist/curve-flow.js';
import { instancedCurveFlow } from '../dist/instanced-curve-flow.js';

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
    b = new CurveFlow(
      new CatmullRomCurve3([
        [0, 0, 0],
        [0, 6, 0],
      ]),
      { segments: 16, closed: false },
    ),
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
  assert.throws(
    () => curveFlow({}),
    (e) => e instanceof TypeError && link.test(e.message),
  );
  assert.throws(
    () => curveFlow(flow, { axis: 'w' }),
    (e) => e instanceof TypeError && link.test(e.message),
  );
  assert.throws(
    () => curveFlow(flow, { scale: 0 }),
    (e) => e instanceof RangeError && link.test(e.message),
  );
  assert.throws(
    () => curveFlow(flow, { offset: NaN }),
    (e) => e instanceof RangeError && link.test(e.message),
  );
  assert.throws(
    () => curveFlow(flow, { fit: [2, 2] }),
    (e) => e instanceof RangeError && link.test(e.message),
  );
  assert.throws(
    () => curveFlow(new CurveFlow(track, { segments: 9000 })),
    (e) => e instanceof RangeError && /8192 frames/.test(e.message),
  );
  assert.throws(() => curveFlow(flow, { name: 'f' }), TypeError);
});

test('instancedCurveFlow packs every curve into one texture with its length, segments and wrap', () => {
  const a = new CurveFlow(track, { segments: 8 }),
    b = new CurveFlow(
      new CatmullRomCurve3([
        [0, 0, 0],
        [0, 6, 0],
      ]),
      { segments: 20, closed: true },
    ),
    plugin = instancedCurveFlow([a, b], 10),
    frames = plugin.textures.frames,
    data = frames.source.data;
  assert.equal(plugin.curveCount, 2);
  assert.equal(frames.width, 21);
  assert.equal(frames.height, 8);
  const texel = (row, i) => Array.from(data.subarray((row * 21 + i) * 4, (row * 21 + i) * 4 + 4));
  for (const [c, flow] of [a, b].entries()) {
    const table = flow.frameTable();
    for (let row = 0; row < 4; row++)
      for (let i = 0; i < flow.frameCount; i++) {
        const at = i * 16 + row * 4;
        assert.deepEqual(texel(c * 4 + row, i).slice(0, 3), Array.from(table.subarray(at, at + 3)));
      }
    assert.equal(texel(c * 4, 0)[3], Math.fround(flow.length));
    assert.equal(texel(c * 4 + 1, 0)[3], flow.frameCount - 1);
    assert.equal(texel(c * 4 + 2, 0)[3], flow.closed ? 1 : 0);
    assert.equal(plugin.curveLength(c), flow.length);
  }
  const wrapped = instancedCurveFlow([a], 1, { wrap: true });
  assert.equal(wrapped.textures.frames.source.data[2 * 9 * 4 + 3], 1);
  wrapped.dispose();
  plugin.dispose();
});

test('instancedCurveFlow rows hold each curve and place, and setFlow replaces one curve', () => {
  const a = new CurveFlow(track, { segments: 16 }),
    b = new CurveFlow(track, { segments: 16, closed: true }),
    plugin = instancedCurveFlow([a, b], 3, { offset: 1, progress: 0.25, scale: 2 }),
    rows = plugin.instanceAttributes;
  assert.equal(plugin.pluginName, 'curveflow');
  assert.equal(rows.capacity, 3);
  assert.deepEqual({ ...plugin.uniforms }, { offset: 1, progress: 0.25, scale: 2 });
  plugin.setCurve(2, 1);
  plugin.setOffset(2, 4);
  plugin.setProgress(2, 0.5);
  assert.deepEqual([rows.get('curve', 2), rows.get('offset', 2), rows.get('progress', 2)], [1, 4, 0.5]);
  const first = plugin.textures.frames,
    // The second curve's four rows of 17 texels.
    other = Array.from(first.source.data.subarray(4 * 17 * 4, 8 * 17 * 4));
  // As many frames or fewer: the same texture, the other curve untouched.
  const short = new CurveFlow(
    new CatmullRomCurve3([
      [0, 0, 0],
      [0, 3, 0],
    ]),
    { segments: 4 },
  );
  plugin.setFlow(0, short);
  assert.equal(plugin.textures.frames, first);
  assert.equal(first.source.data[17 * 4 + 3], 4);
  assert.deepEqual(Array.from(first.source.data.subarray(4 * 17 * 4, 8 * 17 * 4)), other);
  assert.equal(plugin.curveLength(0), short.length);
  // More frames: a wider texture that still holds the other curve.
  plugin.setFlow(0, new CurveFlow(track, { segments: 40 }));
  const wide = plugin.textures.frames;
  assert.notEqual(wide, first);
  assert.equal(wide.width, 41);
  for (let row = 0; row < 4; row++) {
    const at = (4 + row) * 41 * 4;
    assert.deepEqual(
      Array.from(wide.source.data.subarray(at, at + 17 * 4)),
      other.slice(row * 17 * 4, (row + 1) * 17 * 4),
    );
  }
  assert.match(plugin.code.vertex, /clamp\(i32\(floor\(curveflow_curve\+0\.5\)\),0,1\)/);
  plugin.dispose();
  assert.throws(() => rows.set('offset', 0, 1), /disposed/i);
});

test('instancedCurveFlow refuses invalid input with the fix and the help link', () => {
  const flow = new CurveFlow(track),
    refused = (make, kind) => assert.throws(make, (e) => e instanceof kind && link.test(e.message));
  refused(() => instancedCurveFlow([], 4), RangeError);
  refused(() => instancedCurveFlow(flow, 4), RangeError);
  refused(() => instancedCurveFlow(new Array(2049).fill(flow), 4), RangeError);
  refused(() => instancedCurveFlow([{}], 4), TypeError);
  refused(() => instancedCurveFlow([flow], 4, { axis: 'w' }), TypeError);
  refused(() => instancedCurveFlow([flow], 4, { scale: 0 }), RangeError);
  refused(() => instancedCurveFlow([flow], 4, { progress: NaN }), RangeError);
  refused(() => instancedCurveFlow([flow], 4, { fit: [1, 1] }), RangeError);
  assert.throws(() => instancedCurveFlow([flow], 0), RangeError);
  const plugin = instancedCurveFlow([flow], 2);
  for (const curve of [-1, 1, 0.5]) refused(() => plugin.setCurve(0, curve), RangeError);
  refused(() => plugin.setFlow(1, flow), RangeError);
  refused(() => plugin.setFlow(0, {}), TypeError);
  assert.throws(() => plugin.setOffset(2, 0), RangeError);
  assert.throws(() => plugin.setProgress(0, Infinity), TypeError);
  plugin.dispose();
});
