import test from 'node:test';
import assert from 'node:assert/strict';
import { Clustered } from '../dist/index.js';
import { AreaLights } from '../dist/area.js';
import { AreaLightTextures, MAX_AREA_TEXTURES, areaTextureChain, areaTextureLevels } from '../dist/area-texture.js';
import { wgsl } from '../../core/src/shaders.ts';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';

const image = (width, height, fn) => {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data.set(fn(x, y), (y * width + x) * 4);
  return { width, height, data };
};
const half = (bits) => {
  const s = bits & 0x8000 ? -1 : 1,
    e = (bits >> 10) & 31,
    m = bits & 1023;
  return e === 0 ? s * m * 2 ** -24 : e === 31 ? (m ? NaN : s * Infinity) : s * (1 + m / 1024) * 2 ** (e - 15);
};
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
  add = (a, b) => a.map((v, k) => v + b[k]),
  sub = (a, b) => a.map((v, k) => v - b[k]),
  scale = (a, s) => a.map((v) => v * s),
  unit = (p) => scale(p, 1 / Math.sqrt(Math.max(dot(p, p), 1e-20))),
  mul = (m, v) => [0, 1, 2].map((r) => m[r][0] * v[0] + m[r][1] * v[1] + m[r][2] * v[2]),
  mix = (p, q, a) => p.map((v, k) => v + (q[k] - v) * a);

// Line-for-line mirror of the WGSL clusterAreaTexture, reading the words AreaLightTextures uploads. m is row-major.
function mirror(words, j, m, c, r, u, side) {
  if (j >= words[0]) return { color: [1, 1, 1] };
  const id = words[68 + j];
  if (id === 0) return { color: [1, 1, 1] };
  const image = words.subarray(4 + (id - 1) * 4, 8 + (id - 1) * 4),
    top = image[3] - 1,
    C = mul(m, c),
    R = mul(m, r),
    U = mul(m, u),
    N = cross(R, U),
    nn = dot(N, N);
  let uv = [0.5, 0.5],
    lod = top;
  if (nn > 1e-30) {
    const p = [sub(sub(C, R), U), add(sub(C, R), U), add(add(C, R), U), sub(add(C, R), U)].map(unit),
      edge = (a, b) => {
        const n = cross(a, b),
          t = Math.max(...n.map(Math.abs));
        if (t <= 0) return [0, 0, 0];
        const k = scale(n, 1 / t),
          s = Math.hypot(...k);
        return scale(k, (Math.atan2(t * s, dot(a, b)) * 0.15915494) / s);
      },
      f = scale([0, 1, 2, 3].map((i) => edge(p[i], p[(i + 1) % 4])).reduce(add), side),
      h = dot(C, N),
      fd = dot(f, N);
    let q = scale(N, h / nn);
    if (fd * h > 0) q = scale(f, h / fd);
    const rel = sub(q, C);
    uv = [dot(cross(rel, U), N) / nn / 2 + 0.5, 0.5 - dot(cross(R, rel), N) / nn / 2].map((v) =>
      Math.min(1, Math.max(0, v)),
    );
    const nl = Math.sqrt(nn),
      span = ((2 * Math.sqrt(Math.SQRT2 - 1) * Math.abs(h)) / nl / (2 * Math.sqrt(nl))) * Math.max(image[1], image[2]);
    lod = Math.min(top, Math.max(0, Math.log2(Math.max(span, 1))));
  }
  const level = (k) => {
    let o = image[0],
      w = image[1],
      hh = image[2];
    for (let i = 0; i < k; i++) {
      o += w * hh * 2;
      w = Math.max(w >> 1, 1);
      hh = Math.max(hh >> 1, 1);
    }
    return [o, w, hh];
  };
  const texel = ([o, w, hh], x, y) => {
    const px = Math.min(w - 1, Math.max(0, x)),
      py = Math.min(hh - 1, Math.max(0, y)),
      at = 68 + o + (py * w + px) * 2;
    return [half(words[at] & 0xffff), half(words[at] >>> 16), half(words[at + 1] & 0xffff)];
  };
  const bilinear = (k) => {
    const l = level(k),
      t = [uv[0] * l[1] - 0.5, uv[1] * l[2] - 0.5],
      i = t.map(Math.floor),
      fr = t.map((v, n) => v - i[n]);
    return mix(
      mix(texel(l, i[0], i[1]), texel(l, i[0] + 1, i[1]), fr[0]),
      mix(texel(l, i[0], i[1] + 1), texel(l, i[0] + 1, i[1] + 1), fr[0]),
      fr[1],
    );
  };
  const k = Math.floor(lod),
    a = bilinear(k);
  return { uv, lod, color: k >= top ? a : mix(a, bilinear(k + 1), lod - k) };
}
const identity = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];
// A light 2 x 1 facing -z (down onto a floor at z = 0 in this frame): right +x, up -y (r x u is -z, its front).
const overhead = (receiver, height = 1) => ({
  c: sub([0, 0, height], receiver),
  r: [1, 0, 0],
  u: [0, -0.5, 0],
});

test('the level chain halves each side, box-filters by area and keeps the mean of the image', () => {
  assert.equal(areaTextureLevels(1, 1), 1);
  assert.equal(areaTextureLevels(8, 3), 4);
  assert.equal(areaTextureLevels(5, 7), 3);
  const img = image(5, 3, (x, y) => [x * 50, y * 100, (x * y * 30) % 256, x === 4 ? 0 : 255]),
    chain = areaTextureChain(img, false),
    mean = (level) =>
      [0, 1, 2].map((k) => level.filter((_, i) => i % 3 === k).reduce((a, b) => a + b) / (level.length / 3));
  assert.deepEqual(
    chain.map((l) => l.length / 3),
    [15, 2, 1],
  );
  const want = mean(chain[0]);
  for (const level of chain)
    mean(level).forEach((v, k) => assert.ok(Math.abs(v - want[k]) < 1e-6, `${v} vs ${want[k]}`));
  // Alpha premultiplies: the transparent last column emits nothing.
  assert.deepEqual([...chain[0].subarray(12, 15)], [0, 0, 0]);
  // sRGB decode: byte 128 is 0.2158605 linear (IEC 61966-2-1).
  const grey = areaTextureChain(image(1, 1, () => [128, 128, 128, 255]))[0];
  assert.ok(Math.abs(grey[0] - 0.2158605) < 1e-6);
});

test('a one-colour image scales the light by that colour everywhere, under every lobe', () => {
  const t = new AreaLightTextures({ area: { setLights() {} } }),
    flat = image(7, 5, () => [255, 128, 64, 255]);
  t.setTextures([null, { image: flat, colorSpace: 'linear' }]);
  const words = t['words'];
  assert.deepEqual(mirror(words, 0, identity, [0, 0, 1], [1, 0, 0], [0, 1, 0], 1).color, [1, 1, 1], 'no entry');
  assert.deepEqual(mirror(words, 2, identity, [0, 0, 1], [1, 0, 0], [0, 1, 0], 1).color, [1, 1, 1], 'past the entries');
  const want = [1, 128 / 255, 64 / 255];
  let worst = 0;
  for (let i = 0; i < 200; i++) {
    const s = Math.sin(i * 1.7),
      m = [
        [1 + 0.5 * s, 0, 0.3 * Math.cos(i)],
        [0, 1, 0],
        [0.2 * s, 0, 0.4 + Math.abs(s)],
      ],
      { color } = mirror(
        words,
        1,
        m,
        [s * 2, Math.cos(i) * 2, 0.3 + (i % 7)],
        [0.5 + (i % 3), 0.1, 0],
        [0, 0.4, 0.2 * s],
        1,
      );
    worst = Math.max(worst, ...color.map((v, k) => Math.abs(v - want[k])));
  }
  // Half floats keep 11 significant bits: a relative error of at most 2^-11.
  assert.ok(worst <= 2 ** -11, `one-colour image off by ${worst}`);
});

test('the lookup lands under the lobe: the centre right below, the near side off centre, coarser levels further away', () => {
  const t = new AreaLightTextures({ area: { setLights() {} } }),
    // Left half red, right half green, 64 x 32 (7 levels).
    split = image(64, 32, (x) => (x < 32 ? [255, 0, 0, 255] : [0, 255, 0, 255]));
  t.setTextures([{ image: split, colorSpace: 'linear' }]);
  const words = t['words'],
    look = (receiver, height) => {
      const { c, r, u } = overhead(receiver, height);
      return mirror(words, 0, identity, c, r, u, 1);
    };
  const centre = look([0, 0, 0], 1);
  assert.ok(Math.abs(centre.uv[0] - 0.5) < 1e-6 && Math.abs(centre.uv[1] - 0.5) < 1e-6, `centre ${centre.uv}`);
  const right = look([0.6, 0, 0], 1),
    left = look([-0.6, 0, 0], 1),
    up = look([0, -0.3, 0], 1);
  assert.ok(right.uv[0] > 0.6 && left.uv[0] < 0.4, `x ${right.uv[0]} ${left.uv[0]}`);
  // The cosine-weighted direction leans from the foot of the perpendicular (uv x 0.8) toward the light's centre: the
  // vector form factor's ray, not the fallback, picked the point.
  assert.ok(right.uv[0] < 0.79, `form factor ray ${right.uv[0]}`);
  assert.ok(Math.abs(right.uv[0] - 0.5 - (0.5 - left.uv[0])) < 1e-6, 'mirror symmetric');
  assert.ok(up.uv[1] < 0.5, 'up on the light is up in the image (rows run top to bottom)');
  assert.ok(right.color[1] > right.color[0] && left.color[0] > left.color[1], 'green on the right, red on the left');
  // Closer to the plane the footprint shrinks: finer levels; far away the mean (top level, 0.5 0.5).
  const near = look([0.6, 0, 0], 0.05),
    far = look([0.6, 0, 0], 50);
  assert.ok(near.lod < right.lod && right.lod < far.lod, `lod ${near.lod} ${right.lod} ${far.lod}`);
  assert.equal(far.lod, 6);
  far.color.slice(0, 2).forEach((v) => assert.ok(Math.abs(v - 0.5) < 2 ** -11));
  // A sharp lobe (a large stretch of the cosine space) reads finer levels than the cosine itself.
  const { c, r, u } = overhead([0.6, 0, 0], 1),
    sharp = mirror(
      words,
      0,
      [
        [8, 0, 0],
        [0, 8, 0],
        [0, 0, 1],
      ],
      c,
      r,
      u,
      1,
    );
  assert.ok(sharp.lod < right.lod, `sharp ${sharp.lod} vs cosine ${right.lod}`);
});

test('AreaLightTextures validates every entry before changing anything', () => {
  const t = new AreaLightTextures({ area: { setLights() {} } }),
    ok = image(2, 2, () => [1, 2, 3, 4]);
  t.setTextures([ok]);
  const before = t['words'].slice();
  for (const bad of [
    [{ width: 2, height: 2, data: new Uint8Array(15) }],
    [{ width: 0, height: 2, data: new Uint8Array(0) }],
    [{ width: 1.5, height: 2, data: new Uint8Array(12) }],
    [{ width: 1, height: 1, data: [1, 2, 3, 4] }],
    [{ width: 2048, height: 1, data: new Uint8Array(8192) }],
    [{ image: ok, colorSpace: 'p3' }],
    [7],
    new Array(65).fill(null),
  ])
    assert.throws(() => t.setTextures(bad), /[Aa]rea texture/);
  const many = Array.from({ length: MAX_AREA_TEXTURES + 1 }, () => image(1, 1, () => [1, 1, 1, 1]));
  assert.throws(() => t.setTextures(many), RangeError);
  assert.deepEqual(t['words'], before);
  assert.throws(() => new AreaLightTextures({}), TypeError);
});

test('AreaLightTextures add clusterAreaTexture, binding 153 and one buffer only while an area light has an image', () => {
  const h = optionalGPU(),
    lights = new Clustered({ grid: [2, 2, 2] }),
    area = new AreaLights({ lights });
  h.engine.use(lights);
  h.engine.use(area);
  area.setLights([{ position: [0, 3, 0], direction: [0, -1, 0], width: 2, height: 1 }]);
  const frame = () => {
    h.context.shader = wgsl;
    h.context.bindings.length = 0;
    h.engine.frameGraph.execute(h.context);
    return { shader: h.context.shader, bindings: h.context.bindings.map((b) => b.binding) };
  };
  try {
    const plain = frame(),
      buffers = h.counts.buffers;
    const textures = new AreaLightTextures({ area });
    h.engine.use(textures);
    textures.setTextures([null]);
    assert.deepEqual(frame(), plain, 'attached, no images');
    assert.equal(h.counts.buffers, buffers);
    textures.setTextures([image(4, 4, (x) => [x * 60, 0, 0, 255])]);
    const lit = frame();
    assert.match(lit.shader, /@binding\(153\) var<storage,read> areaTextureData/);
    assert.ok(lit.shader.includes('light.color.rgb*clusterAreaTexture(j,lobe,c,r,u,side)*max(side*areaIntegral(lobe'));
    assert.ok(
      lit.shader.includes('light.color.rgb*clusterAreaTexture(j,local,c,r,u,side)*max(side*areaIntegral(local'),
    );
    assert.deepEqual(lit.bindings, [...plain.bindings, 153]);
    assert.equal(area.bindings(), area.bindings(), 'joined bindings are cached');
    const buffer = textures.bindings()[0].resource.buffer;
    assert.equal(new Uint32Array(buffer.data)[0], 1);
    textures.setTextures([]);
    assert.deepEqual(frame(), plain, 'emptied');
    textures.setTextures([image(1, 1, () => [9, 9, 9, 255])]);
    assert.notDeepEqual(frame(), plain);
    textures.dispose();
    assert.ok(buffer.destroyed);
    assert.equal(area.texture, undefined);
    assert.deepEqual(frame(), plain, 'disposed');
  } finally {
    area.dispose();
    lights.dispose();
  }
  assert.ok(h.resources.every((resource) => resource.destroyed));
});
