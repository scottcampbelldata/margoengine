import test from 'node:test';
import assert from 'node:assert/strict';
import { Material, Texture, createMesh } from '../dist/index.js';
import { Engine, TransformStore } from '../../core/dist/extension.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';

const mapSlots = [
  'clearcoatMap',
  'clearcoatRoughnessMap',
  'clearcoatNormalMap',
  'transmissionMap',
  'sheenColorMap',
  'sheenRoughnessMap',
  'specularIntensityMap',
  'specularColorMap',
  'iridescenceMap',
  'iridescenceThicknessMap',
  'anisotropyMap',
  'thicknessMap',
];
const texture = () =>
  new Texture({ data: new Uint8Array([255, 255, 255, 255]), width: 1, height: 1 }, { mipmaps: false });
const triangle = { positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], normals: [0, 0, 1, 0, 0, 1, 0, 0, 1] };

test('each physical map reserves its lobe, stays live and accepts independent UV1 transforms', () => {
  for (const slot of mapSlots) {
    const t = texture(),
      m = new Material({ [slot]: t });
    assert.ok(m.physical, slot + ' must establish physical shading');
    assert.equal(m[slot], t);
    assert.equal(m.clearcoat, 0);
    m.setUVTransform({ texCoord: 1, offset: [0.25, 0.5] }, slot);
    const k = mapSlots.indexOf(slot) + 5;
    assert.deepEqual(
      m.uvt.slice(k * 8, k * 8 + 8).map((v) => v || 0),
      [1, 0, 0.25, 1, 0, 1, 0.5, 0],
    );
    m[slot] = null;
    assert.equal(m[slot], null);
    assert.ok(m.physical);
    assert.throws(() => new Material({ [slot]: {} }), /Texture/);
    assert.throws(() => new Material({ shading: 'basic', [slot]: t }), /standard/);
  }
  assert.equal(new Material().uvt.length, 40);
  assert.equal(new Material({ thicknessMap: texture() }).transmissive, true);
  assert.equal(new Material({ transmissionMap: texture() }).transmissive, true);
});

test('physical map scalar controls remain live and validate their ranges', () => {
  const m = new Material({
    clearcoatNormalScale: -2,
    anisotropy: 0.6,
    anisotropyRotation: 0.7,
    iridescence: 0.8,
    iridescenceIOR: 1.4,
    iridescenceThicknessRange: [120, 350],
  });
  assert.equal(m.clearcoatNormalScale, -2);
  assert.equal(m.anisotropy, 0.6);
  assert.equal(m.anisotropyRotation, 0.7);
  assert.equal(m.iridescence, 0.8);
  assert.equal(m.iridescenceIOR, 1.4);
  assert.deepEqual(m.iridescenceThicknessRange, [120, 350]);
  m.anisotropyRotation = -1;
  assert.ok(Math.abs(m.physical[17] - Math.cos(-1)) < 1e-9);
  m.iridescenceThicknessRange = [0, 500];
  assert.deepEqual(m.physical.slice(14, 16), [0, 500]);
  for (const [key, value] of Object.entries({
    clearcoatNormalScale: NaN,
    anisotropy: 2,
    anisotropyRotation: Infinity,
    iridescence: -1,
    iridescenceIOR: 0.5,
    iridescenceThicknessRange: [400, 100],
  })) {
    assert.throws(() => new Material({ [key]: value }), RangeError, key);
  }
  assert.throws(() => {
    new Material({ clearcoat: 1 }).anisotropy = 1;
  }, /construction/);
  assert.throws(() => {
    new Material({ clearcoat: 1 }).anisotropyMap = texture();
  }, /construction/);
  assert.throws(() => {
    new Material({ clearcoat: 1 }).iridescenceMap = texture();
  }, /construction/);
  const live = new Material({ clearcoat: 1, uvTransform: { texCoord: 1, offset: [0.2, 0.3] } });
  live.clearcoatMap = texture();
  assert.equal(live.uvt.length, 136);
  assert.deepEqual(live.uvt.slice(40, 48), live.uvt.slice(0, 8));
});

test('sparse map bindings share views by color role and release owned uniforms after the last mesh', async () => {
  const h = optionalGPU(),
    device = h.engine.gpu,
    store = await TransformStore.create(32);
  device.limits.maxTextureDimension2D = 4096;
  const create = device.createTexture;
  device.createTexture = (d) => {
    const t = create(d);
    t.createView = (v) => ({ texture: t, ...v });
    return t;
  };
  const engine = new Engine(
    { width: 128, height: 96, clientWidth: 128, clientHeight: 96 },
    store,
    { backend: 'webgpu', gpu: device, add() {}, remove() {}, render() {}, dispose() {} },
    { position: [0, 0, 4], target: [0, 0, 0] },
    null,
  );
  try {
    const t = texture(),
      m = new Material({ map: t, clearcoatMap: t, sheenColorMap: t, anisotropyMap: t });
    const a = createMesh(engine, triangle, m),
      b = createMesh(engine, triangle, m);
    assert.equal(a.primitives[0].material.shading.replacesTextures, true);
    const entries = m.bindings(device, engine);
    assert.equal(entries.filter((e) => e.binding >= 201 && e.binding < 240).length, 2);
    assert.equal(entries.filter((e) => e.binding >= 240).length, 1);
    const buffer = entries.find((e) => e.binding === 200).resource.buffer;
    assert.equal(m.bindings(device, engine).find((e) => e.binding === 200).resource.buffer, buffer);
    assert.equal(buffer.size, 560);
    a.dispose();
    assert.equal(buffer.destroyed, false);
    b.dispose();
    assert.equal(buffer.destroyed, true);
    const view = t.bind(device, true)[0];
    assert.equal(view.texture.destroyed, false, 'caller owns textures');
    t.dispose();
  } finally {
    engine.dispose();
    h.cleanup();
  }
});

test('pending anisotropy images use an exact neutral direction independently of white data maps', () => {
  const h = optionalGPU(),
    device = h.engine.gpu,
    writes = [];
  device.queue.writeTexture = (_, data) => writes.push([...data]);
  const t = new Texture({ width: 0, height: 0 }, { mipmaps: false });
  try {
    const m = new Material({ anisotropy: 0.7, anisotropyMap: t, clearcoatMap: t });
    const entries = m.bindings(device);
    assert.equal(entries.filter((e) => e.binding >= 201 && e.binding < 240).length, 2);
    assert.ok(writes.some((v) => v.join() === [0x3c00, 0x3800, 0x3c00, 0x3c00].join()));
  } finally {
    h.cleanup();
  }
});
