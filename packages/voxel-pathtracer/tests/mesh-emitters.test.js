// FG-17-EMITTERS: moving and deforming mesh emitters are sampled at the path's own time. The light packet gives them
// close-pose records; the sampler runs here on the CPU (the WGSL the tracer compiles) against a float64 mirror built
// from the API's transforms and positions, never from the packet's derived rows. Images are checked in
// mesh-emitters-browser.mjs.
import assert from 'node:assert/strict';
import test from 'node:test';
import { MeshPathTracer, triangleMeshes } from '../dist/mesh.js';
import { ComposedVoxelPathTracer } from '../dist/compose.js';
import { meshPBR } from '../dist/mesh-pbr.js';
import { checkWGSL } from '@margoengine/webgl2-compat/wgsl';
import { runComputeOnCPU } from '@margoengine/webgl2-compat/compute';
import { fakeEngine, simpleScene } from './support.js';

const QUAD = [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0];
const OPEN = [-2, -1, 3, 3, 0, 2, 1, 4, 1, -1, 2, 0];
const INDICES = [0, 1, 2, 0, 2, 3];
const EMIT = { id: 1, type: 'emit', color: [1, 0.5, 0.25], emission: 2 };

// Column-major 4x4 from a unit quaternion [x,y,z,w], scale and translation, as the API takes transforms.
function trs(q, s, t) {
  const [x, y, z, w] = q;
  const r = [
    [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
    [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
    [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
  ];
  return [0, 1, 2].flatMap((c) => [r[0][c] * s[c], r[1][c] * s[c], r[2][c] * s[c], 0]).concat([...t, 1]);
}
const axisAngle = (axis, angle) => {
  const l = Math.hypot(...axis);
  return [...axis.map((a) => (a / l) * Math.sin(angle / 2)), Math.cos(angle / 2)];
};
function slerp(a, b, t) {
  let d = a.reduce((s, v, i) => s + v * b[i], 0);
  const q = d < 0 ? b.map((v) => -v) : b;
  d = Math.abs(d);
  const angle = Math.acos(Math.min(1, d)),
    k = 1 / Math.sin(angle);
  return a.map((v, i) => v * Math.sin((1 - t) * angle) * k + q[i] * Math.sin(t * angle) * k);
}
const rows = (m) => [0, 1, 2].map((a) => [m[a], m[4 + a], m[8 + a], m[12 + a]]);
const lerp = (a, b, t) => a.map((v, i) => v * (1 - t) + b[i] * t);
const apply = (r, p) => r.map((row) => row[0] * p[0] + row[1] * p[1] + row[2] * p[2] + row[3]);
const sub = (a, b) => a.map((v, i) => v - b[i]);
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const det = (r) =>
  r[0][0] * (r[1][1] * r[2][2] - r[1][2] * r[2][1]) -
  r[0][1] * (r[1][0] * r[2][2] - r[1][2] * r[2][0]) +
  r[0][2] * (r[1][0] * r[2][1] - r[1][1] * r[2][0]);

// The tracer's random numbers (shaders.ts rand), so the mirror takes the same pick and barycentrics.
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 747796405) + 2891336453) >>> 0;
    const w = Math.imul(((s >>> ((s >>> 28) + 4)) ^ s) >>> 0, 277803737) >>> 0;
    return (((w >>> 22) ^ w) >>> 8) * 5.960464477539063e-8;
  };
}

const T0 = trs(axisAngle([0.3, 0.2, 1], -0.4), [1.5, 0.75, 2], [-1, 0.5, 3]);
const T1 = trs(axisAngle([0.3, 0.2, 1], 1.4), [0.5, 1.25, 1], [2, -1, 4]);
const MATRIX_OPEN = [2, 0.3, 0, 0, -0.2, 1, 0.1, 0, 0, 0, 1.5, 0, 4, 1, 2, 1];
const MATRIX_CLOSE = [1, 0, 0, 0, 0, 1, 0, 0, 0.4, 0, 1, 0, -2, 0, 3, 1];
const CASES = {
  matrix: {
    instance: { transform: MATRIX_CLOSE, previousTransform: MATRIX_OPEN },
    world: (t) => lerp(rows(MATRIX_OPEN).flat(), rows(MATRIX_CLOSE).flat(), t),
  },
  trs: {
    instance: { transform: T1, previousTransform: T0, motionInterpolation: 'trs' },
    world: (t) =>
      rows(
        trs(
          slerp(axisAngle([0.3, 0.2, 1], -0.4), axisAngle([0.3, 0.2, 1], 1.4), t),
          lerp([1.5, 0.75, 2], [0.5, 1.25, 1], t),
          lerp([-1, 0.5, 3], [2, -1, 4], t),
        ),
      ).flat(),
  },
  deforming: { instance: { transform: MATRIX_OPEN }, open: OPEN, world: () => rows(MATRIX_OPEN).flat() },
  'deforming and moving': {
    instance: { transform: MATRIX_CLOSE, previousTransform: MATRIX_OPEN },
    open: OPEN,
    world: (t) => lerp(rows(MATRIX_OPEN).flat(), rows(MATRIX_CLOSE).flat(), t),
  },
};
const scene = (c, material = EMIT) => ({
  ...simpleScene(),
  materials: [material],
  meshes: [
    {
      id: 'quad',
      material: 1,
      positions: new Float32Array(QUAD),
      indices: new Uint32Array(INDICES),
      ...(c.open && { previousPositions: new Float32Array(c.open) }),
    },
  ],
  meshInstances: [{ id: 'q', mesh: 'quad', ...c.instance }],
});
const creators = [
  ['MeshPathTracer', (e, s) => MeshPathTracer.create(e, { scene: s, shutter: 1, denoise: false })],
  [
    'composed',
    (e, s) => ComposedVoxelPathTracer.create(e, { scene: s, features: [triangleMeshes()], shutter: 1, denoise: false }),
  ],
  [
    'mesh-pbr',
    (e, s) =>
      ComposedVoxelPathTracer.create(e, {
        scene: {
          ...s,
          pbrMaterials: [{ id: 1, emissiveFactor: [1, 0.5, 0.25], emissiveStrength: 2, doubleSided: true }],
        },
        features: [meshPBR()],
        shutter: 1,
        denoise: false,
      }),
  ],
];
async function prepare(create, s) {
  const h = fakeEngine(),
    codes = [],
    make = h.device.createShaderModule.bind(h.device);
  h.device.createShaderModule = (d) => {
    codes.push(d.code);
    return make(d);
  };
  const t = await create(h.engine, s);
  await t.ready;
  h.frame();
  const packed = h.device.buffers
    .map((b) => new Uint32Array(b.data))
    .findLast((w) => w[2] > 0 && w[w[2] + 9] === 0x4d494e53);
  return { t, codes, packed, words: packed.slice(packed[2]) };
}
function probe(ctx, body) {
  const source = ctx.codes.find((s) => s.includes('fn sampleMeshEmitter('));
  checkWGSL(source);
  const out = new Float32Array(32);
  runComputeOnCPU({
    source:
      source +
      `\n@group(3) @binding(0) var<storage,read_write> probe:array<vec4f>;\n@compute @workgroup_size(1) fn emitters_probe(){${body}}`,
    entryPoint: 'emitters_probe',
    workgroups: [1],
    workBudget: 2_000_000,
    buffers: new Map([
      ['0:3', ctx.packed],
      ['0:1', new Float32Array(8192)],
      ['0:4', new Float32Array(4)],
      ['3:0', out],
    ]),
  });
  return out;
}
const f32 = (w, at) => new Float32Array(w.buffer, w.byteOffset + at * 4, 1)[0];

test('moving and deforming emitters get close-pose light records whose picks sum to one', async () => {
  for (const [label, c] of Object.entries(CASES))
    for (const [name, create] of creators) {
      const ctx = await prepare(create, scene(c));
      try {
        const w = ctx.words,
          header = w[12],
          records = w[header + 1];
        assert.equal(w[header], 2, `${label} ${name}: two light records`);
        assert.notEqual(w[w[5] + 30], 0, `${label} ${name}: a light lookup`);
        assert.ok(f32(w, records + 20) > 0 && f32(w, records + 24 + 20) > 0);
        assert.equal(f32(w, records + 24 + 3), 1, 'the cdf ends at 1');
        // Close-pose world area of the unit square under the close transform.
        const close = rows(c.instance.transform);
        const area = Math.hypot(
          ...cross(
            close.map((r) => r[0]),
            close.map((r) => r[1]),
          ),
        );
        assert.ok(
          Math.abs(f32(w, records + 7) + f32(w, records + 24 + 7) - area) < 1e-5 * area,
          `${label} ${name}: close area`,
        );
      } finally {
        ctx.t.dispose();
      }
    }
});

test('a light point at the path time matches a float64 mirror of the moving face, and its hit weight', async () => {
  const o = [0.3, 0.2, -6];
  for (const [label, c] of Object.entries(CASES))
    for (const [name, create] of creators) {
      const ctx = await prepare(create, scene(c));
      try {
        const w = ctx.words,
          header = w[12],
          records = w[header + 1];
        for (const time of [0, 0.37, 0.81])
          for (const seed of [7, 1234, 99991]) {
            const out = probe(
              ctx,
              `motion=${time.toFixed(2)};rng=${seed}u;let o=vec3f(${o.join(',')});let ls=sampleMeshEmitter(o);
probe[0]=vec4f(ls.p,ls.pdfA);probe[1]=vec4f(ls.n,select(0.0,1.0,ls.moving));probe[2]=vec4f(ls.radiance,0);
let v=ls.p-o;let dist=sqrt(dot(v,v));let wi=v/dist;var h:Hit;h.t=1e30;h.inst=NONE;meshClosest(o,wi,0u,NONE,&h);
probe[3]=vec4f(h.t,select(0.0,1.0,h.inst==TRIANGLE),meshEmitterWeight(h,wi,1.0),dist);`,
            );
            const random = rng(seed),
              pick = random(),
              root = Math.sqrt(random()),
              u = random();
            let k = 0;
            while (k < 1 && f32(w, records + k * 24 + 3) <= pick) k++;
            const r = records + k * 24,
              tri = w[r + 16],
              head = w[r + 17],
              ordinal = (tri - head - w[head + 1]) / 16;
            // The face's object corners from the API's arrays: the BLAS reorders faces, its record names the input face.
            const corners = [0, 1, 2].map((v) => [0, 1, 2].map((a) => f32(w, tri + v * 4 + a)));
            const index = corners.map(
              (p) =>
                QUAD.findIndex(
                  (_, i) => i % 3 === 0 && QUAD[i] === p[0] && QUAD[i + 1] === p[1] && QUAD[i + 2] === p[2],
                ) / 3,
            );
            assert.ok(index.every((i) => i >= 0) && ordinal >= 0, 'face corners name input vertices');
            const object = index.map((i) => {
              const close = QUAD.slice(i * 3, i * 3 + 3);
              return c.open && time < 1 ? lerp(c.open.slice(i * 3, i * 3 + 3), close, time) : close;
            });
            const world = c.world(time),
              m = [world.slice(0, 4), world.slice(4, 8), world.slice(8, 12)];
            const p = object.map((q) => apply(m, q));
            const n = cross(sub(p[1], p[0]), sub(p[2], p[0])),
              length = Math.hypot(...n),
              area = length / 2;
            const bary = [1 - root, root * (1 - u), root * u],
              point = [0, 1, 2].map((a) => p[0][a] * bary[0] + p[1][a] * bary[1] + p[2][a] * bary[2]);
            const at = `${label} ${name} t=${time} seed=${seed}`;
            const scale = 1 + Math.hypot(...point);
            for (let a = 0; a < 3; a++)
              assert.ok(
                Math.abs(out[a] - point[a]) < 2e-5 * scale,
                `${at}: point ${[...out.slice(0, 3)]} against ${point}`,
              );
            const pmf = f32(w, r + 20);
            assert.ok(
              Math.abs(out[3] - pmf / area) < 1e-4 * (pmf / area),
              `${at}: pdfA ${out[3]} against ${pmf / area}`,
            );
            const normal = n.map((v) => (v / length) * Math.sign(det(m)));
            assert.ok(normal.reduce((s, v, a) => s + v * out[4 + a], 0) > 1 - 1e-5, `${at}: normal`);
            assert.equal(out[7], time < 1 ? 1 : 0, `${at}: moving branch`);
            // The PBR emitter's radiance comes from the packet (double-sided): the proposal resolves it on the moving face.
            if (name === 'mesh-pbr') assert.deepEqual([...out.slice(8, 11)], [2, 1, 0.5], `${at}: radiance`);
            // The path hit on the same face at the same time weighs it with the same pdf: w = 1 / (1 + lp^2).
            const cosine = Math.abs(normal.reduce((s, v, a) => s + (v * (point[a] - o[a])) / out[15], 0)),
              lp = ((pmf / area) * out[15] * out[15]) / cosine;
            assert.equal(out[13], 1, `${at}: the ray toward the point finds the face`);
            assert.ok(Math.abs(out[12] - out[15]) < 1e-4 * out[15], `${at}: at the point's distance`);
            assert.ok(
              Math.abs(out[14] - 1 / (1 + lp * lp)) < 1e-4,
              `${at}: hit weight ${out[14]} against ${1 / (1 + lp * lp)}`,
            );
          }
      } finally {
        ctx.t.dispose();
      }
    }
});

test('a scene with previous fields equal to the current ones packs the same light table', async () => {
  const still = { instance: { transform: MATRIX_CLOSE } };
  for (const [name, create] of creators) {
    const a = await prepare(create, scene(still)),
      b = await prepare(
        create,
        scene({ instance: { transform: MATRIX_CLOSE, previousTransform: MATRIX_CLOSE }, open: QUAD }),
      );
    try {
      const table = (ctx) => {
        const w = ctx.words,
          header = w[12];
        return [...w.slice(w[header + 1], w[header + 1] + w[header] * 24)];
      };
      assert.deepEqual(table(b), table(a), name);
    } finally {
      a.t.dispose();
      b.t.dispose();
    }
  }
});

test('the emitter proposal adds exactly one model-transform call site', async () => {
  for (const [name, create] of creators) {
    const ctx = await prepare(create, scene(CASES.trs));
    try {
      const source = ctx.codes.find((s) => s.includes('fn sampleMeshEmitter('));
      const calls = source.split('meshLocal(').length - 1 - (source.split('fn meshLocal(').length - 1);
      assert.equal(calls, 2, `${name}: meshClosest and sampleMeshEmitter`);
      assert.doesNotMatch(source, /meshLightRecord|meshLightBary|meshSampleRadiance/);
    } finally {
      ctx.t.dispose();
    }
  }
});
