import test from 'node:test';
import assert from 'node:assert/strict';
import { Clustered } from '../dist/index.js';
import { ProjectorLights, MAX_PROJECTOR_IMAGES } from '../dist/projector.js';
import { wgsl } from '../../core/src/shaders.ts';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';
import { projectorColor, image } from './projector-reference.js';

// Line-for-line mirror of the WGSL clusterProjector, reading the words ProjectorLights uploads.
function mirror(words, index, light, position) {
  const f = new Float32Array(words.buffer),
    dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
    cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
    norm = (a) => a.map((v) => v / Math.hypot(...a));
  const at = 68 + index * 4,
    id = words[at];
  if (index >= words[0] || id === 0) return [1, 1, 1];
  const [o, width, height, srgb] = words.subarray(4 + (id - 1) * 4, 8 + (id - 1) * 4),
    dir = light.direction,
    up = Math.abs(dir[1]) > 0.99 ? [0, 0, 1] : [0, 1, 0],
    minus = dir.map((v) => -v),
    x = norm(cross(up, minus)),
    y = cross(minus, x),
    rel = position.map((v, k) => v - light.position[k]),
    w = dot(rel, dir);
  if (w <= 0) return [0, 0, 0];
  const c = Math.cos(light.outerAngle),
    stored = f[at + 1],
    fy = 1 / (stored > 0 ? stored : Math.sqrt(1 - c * c) / c),
    fx = fy / f[at + 2],
    uv = [((dot(rel, x) * fx) / w) * 0.5 + 0.5, ((dot(rel, y) * fy) / w) * -0.5 + 0.5];
  if (uv.some((v) => v < 0 || v > 1)) return [0, 0, 0];
  const texel = (tx, ty) => {
    const px = Math.min(width - 1, Math.max(0, tx)),
      py = Math.min(height - 1, Math.max(0, ty)),
      word = words[68 + o + py * width + px],
      bytes = [0, 8, 16, 24].map((s) => ((word >>> s) & 255) / 255),
      rgb = bytes.slice(0, 3).map((v) => (!srgb ? v : v > 0.04045 ? ((v + 0.055) / 1.055) ** 2.4 : v / 12.92));
    return rgb.map((v) => v * bytes[3]);
  };
  const t = [uv[0] * width - 0.5, uv[1] * height - 0.5],
    i = t.map(Math.floor),
    fr = t.map((v, k) => v - i[k]),
    mix = (p, q, a) => p.map((v, k) => v + (q[k] - v) * a);
  return mix(
    mix(texel(i[0], i[1]), texel(i[0] + 1, i[1]), fr[0]),
    mix(texel(i[0], i[1] + 1), texel(i[0] + 1, i[1] + 1), fr[0]),
    fr[1],
  );
}
const checker = image(4, 2, (x, y) => [x * 80, y * 200, 255 - x * 60, x === 3 ? 128 : 255]);

test('projector UVs are the local shadow map camera: the shader mirror matches localShadowMatrix within 1e-5', () => {
  const lights = [
      { position: [0, 3, 0], direction: [0.2, -1, 0.1], outerAngle: 0.6 },
      { position: [1, 1, -2], direction: [0, 0.999, 0.02], outerAngle: 0.9 }, // near vertical: up is +z
      { position: [-1, 2, 1], direction: [1, -0.5, -0.3], outerAngle: 0.3 },
    ].map((l) => ({ ...l, direction: l.direction.map((v) => v / Math.hypot(...l.direction)) })),
    entries = [
      checker,
      { image: checker, colorSpace: 'linear', angle: 0.4, aspect: 2 },
      { image: checker, angle: 0.2 },
    ],
    p = new ProjectorLights({ lights: { setLights() {} } });
  p.setProjectors(entries);
  assert.deepEqual(Array.from(p['words'].subarray(0, 2)), [3, 2], 'two images: the same pixels in two colour spaces');
  let worst = 0,
    inside = 0;
  for (let k = 0; k < lights.length; k++)
    for (let i = 0; i < 300; i++) {
      const l = lights[k],
        s = i / 300,
        point = l.position.map((v, j) => v + l.direction[j] * 2 + Math.sin(i * (j + 1.3)) * 1.2 * s);
      const want = projectorColor(l, point, entries[k].image ? entries[k] : { image: entries[k] }),
        got = mirror(p['words'], k, l, point);
      if (want.some((v) => v > 0)) inside++;
      worst = Math.max(worst, ...got.map((v, j) => Math.abs(v - want[j])));
    }
  assert.ok(inside > 300, `only ${inside} points inside the images`);
  assert.ok(worst < 1e-5, `shader math vs localShadowMatrix: ${worst}`);
  assert.deepEqual(mirror(p['words'], 0, lights[0], [0, 4, 0]), [0, 0, 0], 'behind the light');
  assert.deepEqual(mirror(p['words'], 5, lights[0], [0, 0, 0]), [1, 1, 1], 'past the entries');
});

test('ProjectorLights validates every entry before changing anything', () => {
  const p = new ProjectorLights({ lights: { setLights() {} } });
  p.setProjectors([checker]);
  const before = p['words'].slice();
  for (const bad of [
    [{ width: 2, height: 2, data: new Uint8Array(15) }],
    [{ width: 0, height: 2, data: new Uint8Array(0) }],
    [{ width: 1.5, height: 2, data: new Uint8Array(12) }],
    [{ width: 1, height: 1, data: [1, 2, 3, 4] }],
    [{ image: checker, colorSpace: 'p3' }],
    [{ image: checker, angle: Math.PI / 2 }],
    [{ image: checker, aspect: 0 }],
    [7],
  ])
    assert.throws(() => p.setProjectors(bad), /[Pp]rojector/);
  const many = Array.from({ length: MAX_PROJECTOR_IMAGES + 1 }, () => image(1, 1, () => [1, 1, 1, 1]));
  assert.throws(() => p.setProjectors(many), RangeError);
  assert.deepEqual(p['words'], before);
});

test('ProjectorLights add clusterProjector, binding 143 and one buffer only while a spot has an image', () => {
  const h = optionalGPU(),
    lights = new Clustered({ grid: [2, 2, 2] });
  lights.setLights([{ position: [0, 2, 1], range: 6, direction: [0, -1, 0], outerAngle: 0.5 }]);
  h.engine.use(lights);
  const frame = () => {
    h.context.shader = wgsl;
    h.context.bindings.length = 0;
    h.engine.frameGraph.execute(h.context);
    return { shader: h.context.shader, bindings: h.context.bindings.map((b) => b.binding) };
  };
  try {
    const plain = frame(),
      buffers = h.counts.buffers;
    const projectors = new ProjectorLights({ lights });
    h.engine.use(projectors);
    projectors.setProjectors([null]);
    assert.deepEqual(frame(), plain, 'attached, no images');
    assert.equal(h.counts.buffers, buffers);
    projectors.setProjectors([checker]);
    const lit = frame();
    assert.match(lit.shader, /@binding\(143\) var<storage,read> clusterProjectorData/);
    assert.ok(lit.shader.includes('*cone*clusterProjector(index,light,position)'));
    assert.deepEqual(lit.bindings, [...plain.bindings, 143]);
    const buffer = projectors.bindings()[0].resource.buffer;
    assert.equal(new Uint32Array(buffer.data)[0], 1);
    projectors.setProjectors([]);
    assert.deepEqual(frame(), plain, 'emptied');
    projectors.dispose();
    assert.ok(buffer.destroyed);
    assert.equal(lights.projector, undefined);
  } finally {
    lights.dispose();
  }
  assert.ok(h.resources.every((resource) => resource.destroyed));
});
