// Animation layers and cubic curves: real Maya files against the frames Maya wrote, then each blend mode by its definition.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { convertFBX } from '../dist/index.js';
import { animationLayers, eulerDegrees } from '../dist/layers.js';
import { assertFrame, farthest, posed } from './frame-truth.js';
import { readGLB } from './native-scene-helper.js';
import { runParseWorker } from '../../../tests/support/parse-worker.js';

// The FBX orders name the axes in the order they apply, so the first is the rightmost factor.
const ORDERS = ['XYZ', 'XZY', 'YZX', 'YXZ', 'ZXY', 'ZYX'];
function rotationEuler(degrees, order) {
  const product = (a, b) => {
    const out = new Array(16).fill(0);
    for (let c = 0; c < 4; c++)
      for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) out[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
    return out;
  };
  let out = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  for (const axis of ORDERS[order]) {
    const angle = (degrees['XYZ'.indexOf(axis)] * Math.PI) / 180,
      c = Math.cos(angle),
      s = Math.sin(angle),
      m =
        axis === 'X'
          ? [1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1]
          : axis === 'Y'
            ? [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1]
            : [c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    out = product(m, out);
  }
  return out;
}

const real = (name) => readFileSync(new URL(`./fixtures/real/${name}`, import.meta.url)),
  extensions = [animationLayers],
  TICKS = 46186158000,
  encode = (text) => new TextEncoder().encode(text);

test('real Maya file: three layers, mixed accumulation and rotation orders match the frame Maya wrote', async () => {
  const file = real('maya_anim_layers_over_acc_orders_7500_binary.fbx'),
    buffer = await convertFBX(file, { extensions });
  // The OBJ has six decimals in centimetres, and baking may leave 1e-5 m on a transform and 1e-4 rad over a 15 cm arm:
  // 0.001 + 0.0015 cm, per the two nodes that can sit above a vertex here.
  assertFrame(buffer, 18 / 24, real('maya_anim_layers_over_acc_orders_18.obj').toString(), 0.005, 'frame 18');
  await assert.rejects(convertFBX(file), /layer blending|cubic animation/i);
});

test('real Maya text file: slopes and weights are Float32 bits, and the node holds the stored pose before the first key', async () => {
  const file = real('maya_anim_layers_7500_ascii.fbx'),
    still = new TextDecoder('latin1').decode(file).replaceAll('AnimationStack:', 'AnimationStackOff:'),
    pose = posed(await convertFBX(encode(still)), 0),
    moving = await convertFBX(file, { extensions });
  assert.ok(farthest(posed(moving, 0), pose) < 1e-6);
  // Read as numbers, the slopes are a billion a second and the curve leaves any sane range.
  const size = Math.max(...posed(moving, 0.5).flat().map(Math.abs));
  assert.ok(size < 1, String(size));
});

// The curves of Maya's own interpolation test: linear, constant, constant next and weighted cubic keys on one axis.
function track(buffer) {
  const { doc, accessor } = readGLB(buffer),
    animation = doc.animations[0],
    channel = animation.channels.find((c) => c.target.path === 'translation'),
    sampler = animation.samplers[channel.sampler],
    times = accessor(sampler.input),
    values = accessor(sampler.output),
    at = (time) => {
      let i = 0;
      while (i + 1 < times.length && times[i + 1] <= time) i++;
      if (i + 1 === times.length) return values[i * 3];
      const alpha = (time - times[i]) / (times[i + 1] - times[i]);
      return values[i * 3] + (values[i * 3 + 3] - values[i * 3]) * alpha;
    };
  return { times, values, at };
}

test('real Maya interpolation file: every key is hit, and a constant key holds up to the next', async () => {
  const { at, times } = track(await convertFBX(real('maya_interpolation_modes_7500_binary.fbx'), { extensions })),
    keys = [
      [1924423250, -8.653366088867188],
      [21168655750, -6.490575790405273],
      [40412888250, -6.11319637298584],
      [69279237000, -3.958113193511963],
      [88523469500, -5.90597677230835],
      [101994432250, -5.118542671203613],
    ],
    // Maya's translation is in centimetres, the GLB's in metres.
    close = (time, value) => assert.ok(Math.abs(at(time) * 100 - value) < 1e-3, `${time}: ${at(time) * 100} ${value}`);
  for (const [tick, value] of keys) close(tick / TICKS + 1e-7, value);
  assert.ok(times.length > keys.length, 'cubic spans are refined');
});

const layerFile = (layers, extra = '') => {
  const nodes = layers
    .map(
      (layer, i) => `
  AnimationLayer: ${100 + i}, "AnimLayer::L${i}", "" { Properties70: {${layer.props ?? ''}} }
  AnimationCurveNode: ${200 + i}, "AnimCurveNode::T", "" { }
  AnimationCurve: ${300 + i}, "AnimCurve::", "" {
   KeyTime: *2 { a: 0,${TICKS} }
   KeyValueFloat: *2 { a: ${layer.values.join(',')} }
   KeyAttrFlags: *1 { a: 4 }
   KeyAttrDataFloat: *4 { a: 0,0,0,0 }
   KeyAttrRefCount: *1 { a: 2 }
  }`,
    )
    .join('');
  const links = layers
    .map(
      (_, i) => `
 C: "OO",${100 + i},50
 C: "OO",${200 + i},${100 + i}
 C: "OP",${200 + i},1,"Lcl Translation"
 C: "OP",${300 + i},${200 + i},"d|X"`,
    )
    .join('');
  return encode(`; FBX 7.4.0 project file
FBXHeaderExtension: { FBXVersion: 7400 }
Objects: {
 Geometry: 10, "Geometry::G", "Mesh" {
  Vertices: *9 { a: 0,0,0,1,0,0,0,1,0 }
  PolygonVertexIndex: *3 { a: 0,1,-3 }
 }
 Model: 1, "Model::M", "Mesh" { Properties70: { P: "Lcl Translation", "Lcl Translation", "", "A", 3,0,0 } }
 AnimationStack: 50, "AnimStack::Take", "" { }${nodes}${extra}
}
Connections: {
 C: "OO",1,0
 C: "OO",10,1${links}
}
`);
};

// The bottom layer runs 10 to 20 on X; the upper one holds 4.
async function blended(upper, bottom = { values: [10, 20] }, extra) {
  const { at } = track(await convertFBX(layerFile([bottom, upper], extra), { extensions }));
  return [at(0), at(0.5), at(1)];
}
const P = (name, value) => `P: "${name}", "enum", "", "", ${value}\n`,
  weight = (w) => `P: "Weight", "Number", "", "A", ${w}\n`,
  same = (actual, expected) => actual.forEach((v, i) => assert.ok(Math.abs(v - expected[i]) < 1e-5, `${actual}`));

test('each blend mode is what the FBX SDK reference says of it', async () => {
  const values = [4, 4];
  // Additive adds the weighted value.
  same(await blended({ values, props: P('BlendMode', 0) + weight(50) }), [12, 17, 22]);
  // Override at a weight scales the layer's value and hides what is below.
  same(await blended({ values, props: P('BlendMode', 1) + weight(50) }), [2, 2, 2]);
  same(await blended({ values, props: P('BlendMode', 1) + weight(100) }), [4, 4, 4]);
  // Passthrough lets the rest of the weight through.
  same(await blended({ values, props: P('BlendMode', 2) + weight(50) }), [7, 9.5, 12]);
  // Mute and solo.
  same(await blended({ values, props: P('BlendMode', 1) + P('Mute', 1) }), [10, 15, 20]);
  same(await blended({ values, props: P('BlendMode', 1) }, { values: [10, 20], props: P('Solo', 1) }), [10, 15, 20]);
});

test('a curve on Weight moves the blend, and a layer with an unknown mode is refused', async () => {
  const extra = `
  AnimationCurveNode: 400, "AnimCurveNode::W", "" { }
  AnimationCurve: 401, "AnimCurve::", "" {
   KeyTime: *2 { a: 0,${TICKS} }
   KeyValueFloat: *2 { a: 0,100 }
   KeyAttrFlags: *1 { a: 4 }
   KeyAttrDataFloat: *4 { a: 0,0,0,0 }
   KeyAttrRefCount: *1 { a: 2 }
  }`,
    bytes = layerFile([{ values: [10, 20] }, { values: [4, 4], props: P('BlendMode', 2) }], extra);
  const text = new TextDecoder().decode(bytes).replace(
    'C: "OO",1,0',
    'C: "OO",1,0\n C: "OP",400,101,"Weight"\n C: "OP",401,400,"d|Weight"',
  );
  const { at } = track(await convertFBX(encode(text), { extensions }));
  same([at(0), at(0.5), at(1)], [10, 9.5, 4]);
  await assert.rejects(
    convertFBX(layerFile([{ values: [1, 2] }, { values: [1, 2], props: P('BlendMode', 7) }]), { extensions }),
    /layer mode 7/,
  );
});

test('a constant key is two keys one Float32 apart, so a glTF player jumps where the file does', async () => {
  const file = new TextDecoder()
      .decode(layerFile([{ values: [10, 20] }]))
      .replace('KeyAttrFlags: *1 { a: 4 }', 'KeyAttrFlags: *1 { a: 2 }'),
    { times, values } = track(await convertFBX(encode(file), { extensions }));
  assert.equal(times.length, 3);
  assert.equal(values[3], 10);
  assert.equal(values[6], 20);
  assert.ok(times[2] - times[1] < 1e-6 && times[2] - times[1] > 0);
});

test('an Euler angle read back from a quaternion gives the same rotation in all six orders, and at gimbal lock', () => {
  const quaternion = (m) => {
    const t = m[0] + m[5] + m[10];
    if (t > 0) {
      const s = Math.sqrt(t + 1) * 2;
      return [(m[6] - m[9]) / s, (m[8] - m[2]) / s, (m[1] - m[4]) / s, s / 4];
    }
    if (m[0] > m[5] && m[0] > m[10]) {
      const s = Math.sqrt(1 + m[0] - m[5] - m[10]) * 2;
      return [s / 4, (m[4] + m[1]) / s, (m[8] + m[2]) / s, (m[6] - m[9]) / s];
    }
    if (m[5] > m[10]) {
      const s = Math.sqrt(1 + m[5] - m[0] - m[10]) * 2;
      return [(m[4] + m[1]) / s, s / 4, (m[9] + m[6]) / s, (m[8] - m[2]) / s];
    }
    const s = Math.sqrt(1 + m[10] - m[0] - m[5]) * 2;
    return [(m[8] + m[2]) / s, (m[9] + m[6]) / s, s / 4, (m[1] - m[4]) / s];
  };
  for (let order = 0; order < 6; order++)
    for (const angles of [
      [10, 20, 30],
      [-120, 40, 170],
      [90, 90, 0],
      [0, 90, 45],
      [30, -90, 60],
      [45, 0, 90],
    ]) {
      const m = rotationEuler(angles, order),
        back = rotationEuler(eulerDegrees(quaternion(m), order), order);
      // Double precision through a square root and three atan2: 1e-9 is a million times the rounding.
      m.forEach((v, i) => assert.ok(Math.abs(v - back[i]) < 1e-9, `order ${order}, ${angles}`));
    }
});

test('a long mocap clip fits: samples are charged as work, which holds nothing', async () => {
  // 40,000 keys of rotation that never lie on a line: well past the 100,000 samples and 16,384 reservations of before.
  const count = 40_000,
    times = Array.from({ length: count }, (_, i) => Math.round((i * TICKS) / 30)),
    values = times.map((_, i) => 40 * Math.sin(i * 0.7));
  const source = new TextDecoder()
    .decode(layerFile([{ values: [0, 0] }]))
    .replace('"Lcl Translation"', '"Lcl Rotation"')
    .replace(`KeyTime: *2 { a: 0,${TICKS} }`, `KeyTime: *${count} { a: ${times.join(',')} }`)
    .replace('KeyValueFloat: *2 { a: 0,0 }', `KeyValueFloat: *${count} { a: ${values.join(',')} }`)
    .replace('KeyAttrRefCount: *1 { a: 2 }', `KeyAttrRefCount: *1 { a: ${count} }`);
  const { doc } = readGLB(await convertFBX(encode(source), { extensions }));
  assert.ok(doc.accessors[doc.animations[0].samplers[0].input].count >= count);
});

test('the worker holds the entry by name', async () => {
  const input = new Uint8Array(layerFile([{ values: [10, 20] }, { values: [4, 4] }])).buffer,
    prepared = await runParseWorker(new URL('../dist/workers/fbx.js', import.meta.url), {
      input,
      resourcePath: 'https://example.test/',
      extensions: ['layers'],
    });
  assert.equal(prepared.doc.animations.length, 1);
});
