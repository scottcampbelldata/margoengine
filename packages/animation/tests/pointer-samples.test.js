// KHR_animation_pointer on files: Khronos's AnimatedColorsCube sample (glTF-Sample-Assets, CC0; pointer channel on the
// base colour plus ordinary translation and rotation channels) and the demo's own pointer-cube.gltf (base colour,
// emissive and node translation by pointer). Sampled values are compared with the files' own keyframes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Animation } from '../dist/index.js';
import { pointerChannels } from '../dist/pointer.js';
import { parseGLTFAsync } from '@margoengine/gltf-pro';
import { loadedPBREngine } from '../../../tests/support/loaded-pbr-fixtures.js';

const near = (actual, expected, epsilon = 1e-5) => {
  assert.equal(actual.length, expected.length, `${[...actual]} vs ${expected}`);
  for (let i = 0; i < expected.length; i++)
    assert.ok(Math.abs(actual[i] - expected[i]) <= epsilon, `[${i}] ${actual[i]} != ${expected[i]}`);
};
const asset = (name) => new URL(`../../../examples/assets/${name}`, import.meta.url);
async function load(t, glb) {
  const engine = await loadedPBREngine();
  engine.gpu.queue.copyExternalImageToTexture = () => {};
  engine.gpu.queue.submit = () => {};
  t.after(() => engine.dispose());
  return parseGLTFAsync(engine, glb, {});
}
/** The JSON chunk and the binary chunk of a GLB. */
function chunks(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    jsonLength = view.getUint32(12, true),
    json = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jsonLength))),
    binLength = view.getUint32(20 + jsonLength, true);
  return { json, bin: bytes.subarray(28 + jsonLength, 28 + jsonLength + binLength) };
}
/** Float accessor `index` of a GLB as an array. */
function floats({ json, bin }, index) {
  const accessor = json.accessors[index],
    view = json.bufferViews[accessor.bufferView],
    width = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[accessor.type],
    start = bin.byteOffset + (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  return Array.from(new Float32Array(bin.buffer.slice(start, start + accessor.count * width * 4)));
}
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

test('AnimatedColorsCube: the pointer base colour follows the file keys, the TRS channels play alongside', async (t) => {
  const bytes = new Uint8Array(readFileSync(asset('khronos-samples/AnimatedColorsCube.glb'))),
    file = chunks(bytes),
    [clip] = file.json.animations,
    colour = clip.channels.find((c) => c.target.path === 'pointer'),
    sampler = clip.samplers[colour.sampler],
    times = floats(file, sampler.input),
    values = floats(file, sampler.output);
  assert.equal(colour.target.extensions.KHR_animation_pointer.pointer, '/materials/0/pbrMetallicRoughness/baseColorFactor');
  const model = await load(t, bytes),
    animation = new Animation(model, { loop: false, pointers: pointerChannels });
  assert.deepEqual(animation.warnings, []);
  const longest = Math.max(...clip.samplers.map((each) => floats(file, each.input).at(-1)));
  near([animation.clips[0].duration], [longest], 1e-6);
  const material = model.primitives[0].material;
  for (let k = 0; k < times.length; k++) {
    animation.seek(times[k]);
    near(material.base, values.slice(k * 4, k * 4 + 4), 1e-5);
    // Halfway to the next key: LINEAR blends the two keys.
    if (k + 1 < times.length) {
      animation.seek((times[k] + times[k + 1]) / 2);
      near(
        material.base,
        values.slice(k * 4, k * 4 + 4).map((v, i) => (v + values[(k + 1) * 4 + i]) / 2),
        1e-5,
      );
    }
  }
  // Without pointerChannels the colour channel is skipped and named, and the ordinary channels still play.
  const plain = new Animation(await load(t, bytes), { loop: false });
  assert.equal(plain.warnings.length, 1);
  assert.match(plain.warnings[0], /baseColorFactor.*pass pointers from @margoengine\/animation\/pointer/);
});

test("the demo's pointer-cube.gltf: base colour, emissive and translation at the keys and between them", async (t) => {
  const gltf = JSON.parse(readFileSync(asset('animation-formats/pointer-cube.gltf'), 'utf8')),
    model = await load(t, packGLB(gltf)),
    animation = new Animation(model, { loop: false, pointers: pointerChannels });
  assert.deepEqual(animation.warnings, []);
  const material = model.primitives[0].material,
    node = model.nodes[0];
  animation.seek(0.5);
  near(material.base, [0.95, 0.75, 0.1, 1]);
  near(material.emission.slice(0, 3), [0.6, 0.4, 0]);
  near([node.position.x, node.position.y, node.position.z], [0, 1.1, 0]);
  animation.seek(0.75);
  near(material.base, [0.55, 0.675, 0.525, 1]);
  near([node.position.y], [0.8]);
});
