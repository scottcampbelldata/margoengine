// examples/assets/animation-formats/pointer-all.gltf (written by generate.mjs there) animates every pointer target
// @margoengine/animation/pointer plays, with STEP, LINEAR and CUBICSPLINE samplers. Each channel's live value is
// compared with a sample computed here from the file's own keys, at key times and between keys.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Animation } from '../dist/index.js';
import { pointerChannels } from '../dist/pointer.js';
import { parseGLTFAsync } from '@margoengine/gltf-pro';
import { loadedPBREngine } from '../../../tests/support/loaded-pbr-fixtures.js';

const file = (name) =>
  JSON.parse(readFileSync(new URL(`../../../examples/assets/animation-formats/${name}`, import.meta.url), 'utf8'));
/** A .gltf with an embedded data-URI buffer, packed as a GLB. */
function packGLB(gltf) {
  const data = Buffer.from(gltf.buffers[0].uri.split(',')[1], 'base64'),
    doc = { ...gltf, buffers: [{ byteLength: data.length }] },
    json = new TextEncoder().encode(JSON.stringify(doc).padEnd(Math.ceil(JSON.stringify(doc).length / 4) * 4, ' ')),
    bin = new Uint8Array(Math.ceil(data.length / 4) * 4);
  bin.set(data);
  const glb = new Uint8Array(28 + json.length + bin.length),
    view = new DataView(glb.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, glb.length, true);
  view.setUint32(12, json.length, true);
  view.setUint32(16, 0x4e4f534a, true);
  glb.set(json, 20);
  view.setUint32(20 + json.length, bin.length, true);
  view.setUint32(24 + json.length, 0x004e4942, true);
  glb.set(bin, 28 + json.length);
  return glb;
}
/** Accessor `index` of the file as numbers (float or unsigned byte). */
function values(gltf, index) {
  const data = Buffer.from(gltf.buffers[0].uri.split(',')[1], 'base64'),
    accessor = gltf.accessors[index],
    view = gltf.bufferViews[accessor.bufferView],
    width = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[accessor.type],
    start = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0),
    bytes = data.buffer.slice(data.byteOffset + start, data.byteOffset + start + view.byteLength);
  return Array.from(accessor.componentType === 5121 ? new Uint8Array(bytes) : new Float32Array(bytes)).slice(
    0,
    accessor.count * width,
  );
}
/** The glTF 2.0 sampler rules, written independently of the library: STEP, LINEAR (quaternions slerp), CUBICSPLINE. */
function reference(gltf, sampler, width, time, quaternion) {
  const times = values(gltf, sampler.input),
    output = values(gltf, sampler.output),
    cubic = sampler.interpolation === 'CUBICSPLINE',
    stride = cubic ? 3 * width : width,
    value = (k) => output.slice(k * stride + (cubic ? width : 0), k * stride + (cubic ? width : 0) + width);
  if (time <= times[0]) return value(0);
  const last = times.length - 1;
  if (time >= times[last]) return value(last);
  let k = 0;
  while (times[k + 1] <= time) k++;
  const span = times[k + 1] - times[k],
    t = (time - times[k]) / span;
  if (t === 0 || sampler.interpolation === 'STEP') return value(k);
  const a = value(k),
    b = value(k + 1);
  if (cubic) {
    const out = output.slice(k * stride + 2 * width, k * stride + 3 * width),
      into = output.slice((k + 1) * stride, (k + 1) * stride + width);
    return a.map(
      (p, c) =>
        (2 * t ** 3 - 3 * t ** 2 + 1) * p +
        (t ** 3 - 2 * t ** 2 + t) * span * out[c] +
        (-2 * t ** 3 + 3 * t ** 2) * b[c] +
        (t ** 3 - t ** 2) * span * into[c],
    );
  }
  if (!quaternion) return a.map((p, c) => p + (b[c] - p) * t);
  let dot = a.reduce((sum, p, c) => sum + p * b[c], 0);
  const sign = dot < 0 ? -1 : 1;
  dot = Math.abs(dot);
  const angle = Math.acos(Math.min(1, dot)),
    x = Math.sin((1 - t) * angle) / Math.sin(angle),
    y = (Math.sin(t * angle) / Math.sin(angle)) * sign;
  return a.map((p, c) => p * x + b[c] * y);
}
const near = (actual, expected, label) => {
  assert.equal(actual.length, expected.length, label);
  for (let i = 0; i < expected.length; i++)
    assert.ok(
      Math.abs(actual[i] - expected[i]) <= 1e-5 * Math.max(1, Math.abs(expected[i])),
      `${label} [${i}] ${actual[i]} != ${expected[i]}`,
    );
};
async function load(t, gltf) {
  const engine = await loadedPBREngine();
  engine.gpu.queue.copyExternalImageToTexture = () => {};
  engine.gpu.queue.submit = () => {};
  engine.gpu.createCommandEncoder = () => ({
    beginRenderPass: () => ({ setPipeline() {}, setBindGroup() {}, draw() {}, end() {} }),
    finish: () => ({}),
  });
  const bitmap = globalThis.createImageBitmap;
  globalThis.createImageBitmap = async (source) => {
    const view = new DataView(await source.arrayBuffer());
    return { width: view.getUint32(16), height: view.getUint32(20), close() {} };
  };
  t.after(() => {
    engine.dispose();
    if (bitmap === undefined) delete globalThis.createImageBitmap;
    else globalThis.createImageBitmap = bitmap;
  });
  return parseGLTFAsync(engine, packGLB(gltf), {});
}

test('pointer-all.gltf: every supported pointer follows the file keys at and between keys for each interpolation', async (t) => {
  const gltf = file('pointer-all.gltf'),
    model = await load(t, gltf),
    animation = new Animation(model, { loop: false, pointers: pointerChannels }),
    [clip] = gltf.animations;
  assert.equal(animation.clips[0].duration, 2);
  assert.equal(animation.warnings.length, 1);
  assert.match(animation.warnings[0], /pointer \/nodes\/0\/extras\/blink targets application-defined extras; skipped/);
  const material = model.primitives.find((p) => p.nodeIndex === 0).material,
    [light] = model.lights,
    [eye, top] = model.cameras,
    node = model.nodes[0],
    transforms = node.engine.store.transforms,
    weight = (index) => [model.primitives.find((p) => p.nodeIndex === index).weights[0]],
    transform = () => material.maps[0].extensions.KHR_texture_transform,
    m = '/materials/0',
    tt = `${m}/pbrMetallicRoughness/baseColorTexture/extensions/KHR_texture_transform`,
    l = '/extensions/KHR_lights_punctual/lights/0';
  // Emissive factor and strength meet in one live value: emission = factor x strength.
  const live = {
    [`${m}/pbrMetallicRoughness/baseColorFactor`]: () => material.base,
    [`${m}/pbrMetallicRoughness/metallicFactor`]: () => [material.factors[1]],
    [`${m}/pbrMetallicRoughness/roughnessFactor`]: () => [material.factors[0]],
    [`${m}/normalTexture/scale`]: () => [material.factors[2]],
    [`${m}/occlusionTexture/strength`]: () => [material.factors[3]],
    [`${m}/alphaCutoff`]: () => [material.settings[1]],
    [`${m}/emissiveFactor`]: (time) =>
      material.emission.map(
        (e) => e / sample(`${m}/extensions/KHR_materials_emissive_strength/emissiveStrength`, time)[0],
      ),
    [`${m}/extensions/KHR_materials_emissive_strength/emissiveStrength`]: (time) => {
      const factor = sample(`${m}/emissiveFactor`, time),
        c = factor.findIndex((v) => v !== 0);
      return c < 0
        ? sample(`${m}/extensions/KHR_materials_emissive_strength/emissiveStrength`, time)
        : [material.emission[c] / factor[c]];
    },
    [`${tt}/offset`]: () => transform().offset,
    [`${tt}/scale`]: () => transform().scale,
    [`${tt}/rotation`]: () => [transform().rotation],
    [`${l}/color`]: () => light.color,
    [`${l}/intensity`]: () => [light.intensity],
    [`${l}/range`]: () => [light.range],
    [`${l}/spot/innerConeAngle`]: () => [light.innerConeAngle],
    [`${l}/spot/outerConeAngle`]: () => [light.outerConeAngle],
    '/cameras/0/perspective/yfov': () => [eye.perspective.yfov],
    '/cameras/0/perspective/znear': () => [eye.perspective.znear],
    '/cameras/0/perspective/zfar': () => [eye.perspective.zfar],
    '/cameras/0/perspective/aspectRatio': () => [eye.perspective.aspectRatio],
    '/cameras/1/orthographic/xmag': () => [top.orthographic.xmag],
    '/cameras/1/orthographic/ymag': () => [top.orthographic.ymag],
    '/cameras/1/orthographic/znear': () => [top.orthographic.znear],
    '/cameras/1/orthographic/zfar': () => [top.orthographic.zfar],
    '/nodes/0/translation': () => [node.position.x, node.position.y, node.position.z],
    '/nodes/0/rotation': () => [
      transforms.qx[node.id],
      transforms.qy[node.id],
      transforms.qz[node.id],
      transforms.qw[node.id],
    ],
    '/nodes/0/scale': () => [node.scale.x, node.scale.y, node.scale.z],
    '/nodes/0/weights': () => weight(0),
    '/meshes/0/weights': () => weight(1), // node 0 animates its own weights, so the mesh's drive node 1
    '/nodes/0/extensions/KHR_node_visibility/visible': () => [+node.visible],
  };
  const channels = new Map(
      clip.channels.map((c) => [c.target.extensions.KHR_animation_pointer.pointer, clip.samplers[c.sampler]]),
    ),
    sample = (pointer, time) => {
      const sampler = channels.get(pointer),
        width = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[gltf.accessors[sampler.output].type];
      return reference(
        gltf,
        channels.get(pointer),
        width,
        time,
        pointer.endsWith('/rotation') && pointer.startsWith('/nodes'),
      );
    };
  // Every channel but the skipped extras one is checked, and all three interpolations occur.
  assert.deepEqual([...channels.keys()].filter((p) => !p.includes('/extras/')).sort(), Object.keys(live).sort());
  assert.deepEqual(
    new Set([...channels.values()].map((s) => s.interpolation)),
    new Set(['STEP', 'LINEAR', 'CUBICSPLINE']),
  );
  const before = structuredClone(model.asset.doc);
  for (const time of [0, 0.25, 0.5, 1, 1.3, 1.75, 2]) {
    animation.seek(time);
    for (const pointer of Object.keys(live))
      near(live[pointer](time), sample(pointer, time), `${pointer} at ${time} s`);
    // The texture transform reaches the uniform rows too: offset * rotation * scale.
    const r = transform().rotation,
      [sx, sy] = transform().scale,
      [ox, oy] = transform().offset;
    near(
      material.uvt.slice(0, 8),
      [Math.cos(r) * sx, Math.sin(r) * sy, ox, 0, -Math.sin(r) * sx, Math.cos(r) * sy, oy, 0],
      `uvt at ${time} s`,
    );
  }
  assert.deepEqual(model.asset.doc, before, 'the asset document is never written');
  animation.dispose();
});

test('pointer-invalid.gltf: a pointer at a property animations may not change throws with the pointer entry', async (t) => {
  const gltf = file('pointer-invalid.gltf'),
    model = await load(t, gltf);
  assert.equal(
    gltf.animations[0].channels.at(-1).target.extensions.KHR_animation_pointer.pointer,
    '/materials/0/alphaMode',
  );
  assert.throws(() => new Animation(model, { pointers: pointerChannels }), {
    name: 'TypeError',
    message:
      /pointer \/materials\/0\/alphaMode is not an animatable glTF property; point at a property animations may change/,
  });
  // Without the pointer entry the file still plays its ordinary channels and lists every pointer as not played.
  const plain = new Animation(model);
  assert.equal(plain.warnings.length, gltf.animations[0].channels.length);
  plain.dispose();
});

test('two clips and two players of one model write the same owned texture transform, camera and emissive state', async (t) => {
  const gltf = file('pointer-all.gltf');
  gltf.animations.push({ ...structuredClone(gltf.animations[0]), name: 'again' });
  const model = await load(t, gltf),
    first = new Animation(model, { loop: false, pointers: pointerChannels }),
    second = new Animation(model, { loop: false, pointers: pointerChannels }),
    material = model.primitives.find((p) => p.nodeIndex === 0).material;
  first.play(1).seek(0.5);
  second.play(0).seek(1);
  first.seek(0.25); // clip 1 again, after clip 0 bound
  const offset = material.maps[0].extensions.KHR_texture_transform.offset;
  assert.ok(Math.abs(offset[0] - 0.125) < 1e-6 && Math.abs(offset[1] - 0.0625) < 1e-6, `${offset}`);
  assert.ok(Math.abs(model.cameras[0].perspective.yfov - 0.7) < 1e-6);
  // Emission = factor (0.25, 0.125, 0) x strength 1.5 at 0.25 s.
  assert.ok(Math.abs(material.emission[0] - 0.375) < 1e-6 && Math.abs(material.emission[1] - 0.1875) < 1e-6);
  first.dispose();
  second.dispose();
});
