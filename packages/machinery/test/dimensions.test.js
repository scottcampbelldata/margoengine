// Dimension callouts on a mock device: screen-pixel layout through real core cameras (perspective and @margoengine/cameras
// orthographic), measured values, visibility and lifecycle. Labels are not rasterized here (no canvas in Node).
import test from 'node:test';
import assert from 'node:assert/strict';
import {Camera} from '../../core/dist/extension.js';
import {CameraProjection} from '../../cameras/dist/index.js';
import {Font} from '../../text/dist/index.js';
import {Dimensions} from '../dist/dimensions.js';
import {optionalGPU} from '../../../tests/support/optional-gpu.js';

const W = 640, H = 480;
function world(view = {position: [0, 0, 10], target: [0, 0, 0]}) {
  const h = optionalGPU(), device = h.engine.gpu, camera = new Camera();
  globalThis.GPUShaderStage = {VERTEX: 1, FRAGMENT: 2};
  Object.assign(device.limits, {maxTextureArrayLayers: 256, maxTextureDimension2D: 8192});
  device.createBindGroupLayout = d => d; device.createPipelineLayout = d => d; device.queue.writeTexture = () => {};
  Object.assign(camera, view); camera.update(W / H, true);
  Object.assign(h.engine, {canvas: {clientWidth: W, clientHeight: H}, camera});
  Object.assign(h.context, {camera, width: W * 2, height: H * 2});
  // A FontFace that never finishes loading: texts are laid out but not rasterized.
  const font = new Font({face: {family: 'Test', weight: 'normal', style: 'normal', status: 'loading', load: () => new Promise(() => {})}});
  const dims = new Dimensions({font, decimals: 2}); h.engine.use(dims);
  const pixel = p => {const m = camera.matrix, w = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15]; return [((m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12]) / w * 0.5 + 0.5) * W, (0.5 - (m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13]) / w * 0.5) * H];};
  const segments = () => {const line = dims.lines.lines.values().next().value, out = []; for (let i = 0; i < line.count; i += 2) out.push([pixel(line.points.subarray(i * 4, i * 4 + 3)), pixel(line.points.subarray(i * 4 + 4, i * 4 + 7))]); return out;};
  const frame = () => {camera.update(W / H, true); h.frame();};
  return {h, camera, dims, pixel, segments, frame};
}
const near = (a, b, tolerance = 1e-3) => Math.abs(a - b) <= tolerance;
const length = ([a, b]) => Math.hypot(b[0] - a[0], b[1] - a[1]);
/** Pixel lengths of a label's em along its x and y axes. */
const em = (w, text) => {const m = text.matrix, o = [m[12], m[13], m[14]], p = w.pixel(o); return [0, 4].map(c => Math.hypot(...w.pixel([o[0] + m[c], o[1] + m[c + 1], o[2] + m[c + 2]]).map((v, k) => v - p[k])));};

test('linear dimensions keep pixel sizes at any orthographic zoom and in perspective, and read machinery anchors', () => {
  const w = world(), {dims, camera} = w;
  const spec = dims.add({a: {point: [-1, 0, 0]}, b: {point: [1, 0, 0]}});
  assert.equal(dims.label(spec), '2000.00 mm'); assert.equal(dims.value(spec), 2000);
  const check = label => {
    w.frame();
    const all = w.segments(), [a, b] = [[-1, 0, 0], [1, 0, 0]].map(w.pixel), text = dims.text.texts.values().next().value;
    assert.equal(all.length, 2 + 1 + 4, label + ': two extension lines, the dimension line, two two-stroke arrowheads');
    const [extA, extB, line] = all;
    assert.ok(near(line[0][0], a[0]) && near(line[0][1], a[1] - 24) && near(line[1][0], b[0]) && near(line[1][1], b[1] - 24), label + ': dimension line 24 px above the anchors');
    assert.ok(near(extA[0][1], a[1] - 3) && near(extA[1][1], a[1] - 30) && near(extB[0][0], b[0]), label + ': extension lines from a 3 px gap to 6 px past the line');
    for (const arrow of all.slice(3)) assert.ok(near(length(arrow), Math.hypot(10, 3.5)), label + ': arrowhead strokes 10 px long');
    const [x, y] = em(w, text); assert.ok(near(x, 14, 1e-2) && near(y, 14, 1e-2), label + `: 14 px label em, got ${x}, ${y}`);
    assert.ok(text.visible && text.text === '2000.00 mm' && text.anchorY === 'bottom');
    return Math.hypot(text.matrix[0], text.matrix[1], text.matrix[2]);
  };
  const perspective = check('perspective');
  camera.position = [0, 0, 20]; check('perspective, farther');
  const projection = new CameraProjection({mode: 'orthographic', height: 4}); projection.attach(camera);
  const zoom1 = check('orthographic');
  projection.zoom = 4; const zoom4 = check('orthographic zoom 4');
  assert.ok(near(zoom1 / zoom4, 4, 1e-4), 'world label size shrinks with zoom, pixel size stays');
  assert.ok(perspective > 0);
  // A still camera uploads nothing new; a moving anchor does.
  const line = dims.lines.lines.values().next().value, version = line.version; w.frame(); w.frame(); assert.equal(line.version, version);
  spec.b.point[0] = 2; w.frame(); assert.notEqual(line.version, version); assert.equal(dims.label(spec), '3000.00 mm');
});

test('short spans put arrows outside; vertical spans read bottom to top; offsets accept EngineeringAnnotations vectors', () => {
  const w = world(), {dims} = w;
  dims.add({a: {point: [0, 0, 0]}, b: {point: [0.01, 0, 0]}, offset: [0, 30]}); w.frame();
  const [, , line] = w.segments(), a = w.pixel([0, 0, 0]);
  assert.ok(near(line[0][1], a[1] + 30), 'pixel offset vector'); assert.ok(length(line) > 39, 'the dimension line runs past both arrows');
  dims.clear(); const up = dims.add({a: {point: [0, -1, 0]}, b: {point: [0, 1, 0]}, label: 'H'}); w.frame();
  const text = dims.text.texts.values().next().value, m = text.matrix, o = w.pixel([m[12], m[13], m[14]]), x = w.pixel([m[12] + m[0], m[13] + m[1], m[14] + m[2]]);
  assert.ok(x[1] < o[1] && near(x[0], o[0], 1e-3), 'vertical label reads upwards'); assert.equal(text.text, 'H'); assert.equal(dims.label(up), 'H');
});

test('angle and radius dimensions, hidden parts and lifecycle', () => {
  const w = world(), {dims, h} = w;
  const angle = dims.add({kind: 'angle', vertex: {point: [0, 0, 0]}, a: {point: [2, 0, 0]}, b: {point: [0, 2, 0]}, radius: 50});
  assert.equal(dims.label(angle), '90.00°');
  w.frame();
  const v = w.pixel([0, 0, 0]), arc = w.segments();
  const arcPoints = arc.slice(0, -4).flat().map(p => Math.hypot(p[0] - v[0], p[1] - v[1]));
  assert.ok(arcPoints.every(r => near(r, 50, 1e-2)), 'arc 50 px around the vertex');
  assert.ok(arc.slice(-4).every(s => near(length(s), Math.hypot(10, 3.5))), 'arrowheads at both arc ends');
  dims.remove(angle);
  const part = h.engine.meshes; const node = {id: 3, check() {}, matrix: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 1])}; part.set(3, node);
  const radius = dims.add({kind: 'radius', center: {node, point: [0, 0, 0]}, a: {node, point: [0, 0.5, 0]}});
  const diameter = dims.add({kind: 'radius', center: {point: [0, 0, 0]}, a: {point: [0.25, 0, 0]}, diameter: true});
  assert.equal(dims.label(radius), 'R500.00 mm'); assert.equal(dims.label(diameter), 'Ø500.00 mm');
  w.frame(); const [leader] = w.segments(); const c = w.pixel([1, 0, 0]), p = w.pixel([1, 0.5, 0]);
  assert.ok(near(leader[0][0], c[0]) && near(leader[1][1], p[1]), 'leader from the attached node centre to the circle');
  h.engine.store.hidden[3] = 1; w.frame();
  const texts = [...dims.text.texts]; assert.deepEqual(texts.map(t => t.visible), [false, true], 'a hidden part hides its dimension');
  assert.throws(() => dims.add({a: {point: [0, 0, 0]}, b: {point: [NaN, 0, 0]}}), /anchor/);
  assert.throws(() => dims.add({kind: 'angle', vertex: {point: [0, 0, 0]}, a: {point: [1, 0, 0]}, b: {point: [0, 1, 0]}, radius: -1}), /radius/);
  assert.throws(() => new Dimensions({unit: 'ft'}), /options/);
  assert.ok(h.engine.hasPlugin('dimensions:lines') && h.engine.hasPlugin('dimensions:text'));
  dims.dispose();
  assert.ok(!h.engine.hasPlugin('dimensions') && !h.engine.hasPlugin('dimensions:lines') && !h.engine.hasPlugin('dimensions:text'));
  assert.ok(h.resources.every(r => r.destroyed), 'every buffer and atlas freed');
});
