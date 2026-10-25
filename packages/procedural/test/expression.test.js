// Voxel expressions (language version 1): Margo Voxel Studio's own tests, its presets and a generated corpus whose
// digests its interpreter (src/editor/voxel-program.ts at Studio 4ec10f5) produced, plus the exact hash and noise.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  compileVoxelExpression,
  runVoxelExpression,
  validateVoxelExpressionInput,
  voxelHash,
  voxelNoise,
  VoxelExpressionError,
  VOXEL_EXPRESSION_FUNCTIONS,
  VOXEL_EXPRESSION_LIMITS,
  VOXEL_EXPRESSION_VARIABLES,
  VOXEL_EXPRESSION_VERSION,
} from '../dist/expression.js';

const input = (source, values = [1, 2, 3]) => ({ source, size: [values.length, 1, 1], voxels: new Uint8Array(values) });
const run = (value) => Array.from(runVoxelExpression(value).voxels);
// Studio's saved presets, verbatim.
const PRESETS = [
  {
    id: 'sphere',
    source: 'sphere(x-(sx-1)/2, y-(sy-1)/2, z-(sz-1)/2, min(sx,sy,sz)*radius) <= 0 ? tone : 0',
    parameters: { radius: 0.38, tone: 12 },
  },
  {
    id: 'noise',
    source: 'noise(x*frequency,y*frequency,z*frequency) > threshold ? tone : 0',
    parameters: { frequency: 0.4, threshold: 0.5, tone: 24 },
  },
  { id: 'recolor', source: 'color == from ? to : color', parameters: { from: 1, to: 255 } },
];

test('Studio: exact palette slot identity and Y-up dense ordering', () => {
  assert.deepEqual(run({ ...input('color == 2 ? shade : color'), parameters: { shade: 255 } }), [1, 255, 3]);
  assert.deepEqual(
    run({ source: '1+x+2*z+4*y', size: [2, 2, 2], voxels: new Uint8Array(8) }),
    [1, 2, 3, 4, 5, 6, 7, 8],
  );
});

test('Studio: iterations read the preceding iteration and prev reads the fixed prior frame', () => {
  const source = input('voxel(x-1,y,z)'),
    before = source.voxels.slice();
  assert.deepEqual(run({ ...source, iterations: 2 }), [0, 0, 1]);
  assert.deepEqual(source.voxels, before);
  const previous = new Uint8Array([9, 8, 7]);
  assert.deepEqual(
    run({ ...input('iteration == 0 ? prev(x,y,z) : voxel(x-1,y,z)'), previous, iterations: 2 }),
    [0, 9, 8],
  );
  assert.deepEqual(Array.from(previous), [9, 8, 7]);
  assert.deepEqual(run(input('prev(x,y,z)')), [0, 0, 0]);
});

test('Studio: precedence, lazy && || and ternary branches, comments and clocks', () => {
  assert.deepEqual(run(input('1+2*3 == 7 && !false ? 2**3**2 % 255 : 1/0')), [2, 2, 2]);
  assert.deepEqual(run(input('true || sqrt(-1) ? 5 : 0')), [5, 5, 5]);
  assert.deepEqual(run(input('false && 1/0 ? 5 : 6')), [6, 6, 6]);
  assert.deepEqual(
    run({ ...input('// own expression\n frame + iteration + tint'), frame: 7, parameters: { tint: 2 }, iterations: 2 }),
    [10, 10, 10],
  );
  // Unary binds tighter than **: -2**2 is (-2)**2.
  assert.deepEqual(run(input('-2**2')), [4, 4, 4]);
});

test('Studio: sphere, noise and recolor presets are deterministic and seeded', () => {
  const sphere = PRESETS[0],
    result = runVoxelExpression({
      source: sphere.source,
      size: [5, 5, 5],
      voxels: new Uint8Array(125),
      parameters: sphere.parameters,
    });
  assert.ok(result.voxels.some((value) => value > 0));
  assert.ok(result.voxels.some((value) => value === 0));
  const noise = { ...PRESETS[1], size: [8, 2, 8], voxels: new Uint8Array(128), seed: 42 };
  const a = runVoxelExpression(noise),
    b = runVoxelExpression(noise),
    c = runVoxelExpression({ ...noise, seed: 43 });
  assert.deepEqual(a.voxels, b.voxels);
  assert.notDeepEqual(a.voxels, c.voxels);
  assert.deepEqual(run(input('box(x,0,0,1,1,1)<=0 && sphere(x,0,0,1)<=0 ? 8 : 0')), [8, 8, 0]);
});

test('Studio: malformed syntax and host access fail with line and column, without evaluation', () => {
  for (const source of [
    'globalThis',
    'constructor',
    'color; alert(1)',
    'voxel.constructor(1)',
    'new Function(1)',
    'sin()',
    'voxel(0,0)',
    'unbound + 1',
  ])
    assert.throws(() => compileVoxelExpression(source), VoxelExpressionError, source);
  try {
    compileVoxelExpression('color +\n @');
    assert.fail('expected parser failure');
  } catch (error) {
    assert.ok(error instanceof VoxelExpressionError);
    assert.equal(error.code, 'syntax');
    assert.equal(error.line, 2);
    assert.equal(error.column, 2);
    assert.equal(error.detail, 'Unexpected character "@".');
  }
  for (const source of ['1.5', '256', '-1', '1/0', 'sqrt(-1)', 'voxel(.5,0,0)'])
    assert.throws(
      () => runVoxelExpression(input(source)),
      (error) =>
        error instanceof VoxelExpressionError &&
        error.code === 'evaluation' &&
        /integer|palette|finite|zero|coordinate/i.test(error.message),
      source,
    );
});

test('Studio: source, AST, parameter, iteration, allocation and work budgets fail before output allocation', () => {
  assert.throws(() => compileVoxelExpression('x'.repeat(8193)), /8192/);
  assert.throws(
    () => compileVoxelExpression('('.repeat(70) + 'color' + ')'.repeat(70)),
    (e) => e.code === 'limit',
  );
  assert.throws(() => validateVoxelExpressionInput({ ...input('color'), iterations: 33 }), RangeError);
  assert.throws(() => validateVoxelExpressionInput({ ...input('color'), parameters: { x: 3 } }), /reserved/);
  assert.throws(() => validateVoxelExpressionInput({ ...input('color'), parameters: { tone: Infinity } }), /finite/);
  assert.throws(() => validateVoxelExpressionInput({ ...input('color'), previous: new Uint8Array(1) }), /previous/);
  assert.throws(() => validateVoxelExpressionInput({ ...input('color'), size: [1024, 1024, 1024] }), /cell limit/);
  assert.throws(
    () =>
      validateVoxelExpressionInput({
        source: 'color',
        size: [1024, 128, 128],
        voxels: new Uint8Array(16_777_216),
        iterations: 5,
      }),
    /work budget/,
  );
  const controller = new AbortController();
  controller.abort();
  assert.throws(() => runVoxelExpression(input('color'), controller.signal), { name: 'AbortError' });
});

test('an abort during evaluation stops within 1,024 cells and leaves the input untouched', () => {
  const voxels = new Uint8Array(4096).fill(3);
  let checks = 0;
  // Checked once up front, then at cells 0, 1024, 2048 and 3072.
  const signal = {
    throwIfAborted() {
      if (++checks === 3) throw new DOMException('stopped', 'AbortError');
    },
  };
  assert.throws(() => runVoxelExpression({ source: 'voxel(x, y, z) + 1', size: [16, 16, 16], voxels }, signal), {
    name: 'AbortError',
  });
  assert.equal(checks, 3);
  assert.ok(voxels.every((value) => value === 3));
});

test('version 1 surface: variables, functions with arity and cost, frozen limits', () => {
  assert.equal(VOXEL_EXPRESSION_VERSION, 1);
  assert.ok(Object.isFrozen(VOXEL_EXPRESSION_LIMITS));
  assert.equal(VOXEL_EXPRESSION_LIMITS.work, 64 * 1024 * 1024);
  assert.deepEqual(VOXEL_EXPRESSION_VARIABLES.slice(0, 7), ['x', 'y', 'z', 'sx', 'sy', 'sz', 'color']);
  const noise = VOXEL_EXPRESSION_FUNCTIONS.find((fn) => fn.name === 'noise');
  assert.deepEqual(noise, { name: 'noise', min: 3, max: 3, cost: 32 });
  assert.equal(VOXEL_EXPRESSION_FUNCTIONS.length, 22);
  const program = compileVoxelExpression('noise(x, y, z) > 0.5 ? 1 : 0');
  assert.equal(program.nodeCount, 9);
  assert.equal(program.workPerCell, 9 + 31);
});

test('an Object.prototype name is never an operator: refused at compile time', () => {
  // Studio's parser looked operators up on a plain object, so `x toString 1` parsed and failed only when run.
  for (const source of ['x toString 1', 'true || (1 constructor 2)', 'e __proto__ 1', 'y valueOf 2'])
    assert.throws(
      () => compileVoxelExpression(source),
      (error) => error.code === 'syntax',
      source,
    );
});

test('voxelHash and voxelNoise match the language contract exactly', () => {
  // Values from Studio's hash()/noise() for the same arguments.
  assert.deepEqual(
    HASHES,
    HASH_POINTS.map(([x, y, z, seed]) => voxelHash(x, y, z, seed)),
  );
  assert.deepEqual(
    NOISES,
    NOISE_POINTS.map(([x, y, z, seed]) => voxelNoise(x, y, z, seed)),
  );
  for (const [x, y, z, seed] of HASH_POINTS.slice(0, 4))
    assert.equal(voxelNoise(x, y, z, seed), voxelHash(x, y, z, seed));
  assert.deepEqual(
    run({ ...input('floor(hash(x, 0, 0) * 255)'), seed: 9 }),
    [0, 1, 2].map((x) => Math.floor(voxelHash(x, 0, 0, 9) * 255)),
  );
});
const HASH_POINTS = [
  [0, 0, 0, 0],
  [1, 2, 3, 42],
  [-7, 11, 1024, 4294967295],
  [123456789, -987654, 5, 7],
  [2.9, -0.5, 1e20, 3],
];
const NOISE_POINTS = [
  [0.5, 0.25, 0.75, 0],
  [10.1, -3.3, 7.7, 42],
  [-1e5, 2e5 + 0.5, 0.001, 4294967295],
];
const HASHES = [0, 0.511749128464551, 0.6670703805673566, 0.05783794914787588, 0.6594352418695193];
const NOISES = [0.2619162564956701, 0.29841918393808475, 0.2759299746922424];

function corpus() {
  let seed = 20261020;
  const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32,
    int = (n) => Math.floor(random() * n),
    pick = (list) => list[int(list.length)],
    variables = [
      'x',
      'y',
      'z',
      'sx',
      'sy',
      'sz',
      'color',
      'frame',
      'iteration',
      'seed',
      'pi',
      'e',
      'true',
      'false',
      'tone',
      'k',
    ],
    functions = {
      abs: 1,
      floor: 1,
      ceil: 1,
      round: 1,
      sqrt: 1,
      sin: 1,
      cos: 1,
      tan: 1,
      pow: 2,
      min: 3,
      max: 2,
      clamp: 3,
      mix: 3,
      smoothstep: 3,
      length: 3,
      sphere: 4,
      box: 6,
      torus: 5,
      hash: 3,
      noise: 3,
    },
    operators = ['+', '-', '*', '/', '%', '**', '<', '>', '<=', '>=', '==', '!=', '&&', '||'];
  const expression = (depth) => {
    const roll = random();
    if (depth > 4 || roll < 0.25)
      return random() < 0.5 ? pick(variables) : pick(['0', '1', '2', '0.5', '.25', '1e1', '255', '7']);
    if (roll < 0.35) return pick(['-', '!', '+']) + expression(depth + 1);
    if (roll < 0.6) return `(${expression(depth + 1)} ${pick(operators)} ${expression(depth + 1)})`;
    if (roll < 0.7) return `${expression(depth + 1)} ? ${expression(depth + 1)} : ${expression(depth + 1)}`;
    if (roll < 0.8)
      return `${pick(['voxel', 'prev'])}(${pick(['x', 'x-1', 'floor(x/2)'])}, ${pick(['y', 'y-1'])}, ${pick(['z', 'z+1', 'sz-1-z'])})`;
    const [name, arity] = pick(Object.entries(functions));
    return `${name}(${Array.from({ length: arity }, () => expression(depth + 1)).join(', ')})`;
  };
  const cases = [];
  for (let t = 0; t < 400; t++) {
    const size = [1 + int(6), 1 + int(5), 1 + int(6)],
      cells = size[0] * size[1] * size[2],
      body = expression(0),
      source = pick([
        `abs(floor(${body})) % 256`,
        `(${body}) > 0.5 ? tone : color`,
        `clamp(round((${body})*10), 0, 255)`,
        body,
      ]),
      value = {
        source,
        size,
        voxels: Uint8Array.from({ length: cells }, () => (random() < 0.5 ? 0 : int(256))),
        parameters: { tone: 1 + int(255), k: random() * 4 - 2 },
        seed: int(2 ** 32),
        frame: int(100),
        iterations: 1 + int(3),
      };
    if (random() < 0.5) value.previous = Uint8Array.from({ length: cells }, () => int(256));
    cases.push(value);
  }
  for (const preset of PRESETS)
    for (const seed of [0, 42, 4294967295])
      for (const size of [
        [5, 5, 5],
        [16, 4, 9],
        [1, 1, 1],
        [24, 12, 24],
      ]) {
        const cells = size[0] * size[1] * size[2];
        cases.push({ ...preset, seed, size, voxels: Uint8Array.from({ length: cells }, (_, i) => (i * 7) % 256) });
      }
  return cases;
}

test("Studio's presets and a generated corpus give its interpreter's exact results and error locations", () => {
  const hash = createHash('sha256');
  let evaluated = 0;
  for (const value of corpus()) {
    try {
      const result = runVoxelExpression(value);
      evaluated++;
      hash.update(result.voxels);
    } catch (error) {
      hash.update(error.line === undefined ? 'refused\n' : `${error.line}:${error.column}:${error.detail}\n`);
    }
  }
  assert.equal(evaluated, CORPUS_EVALUATED);
  assert.equal(hash.digest('hex'), CORPUS_SHA256);
});
const CORPUS_EVALUATED = 367;
const CORPUS_SHA256 = 'a538316065e1c6e1305ce5bfa1453d433a252100dd9e95c4721ba2059c9abfb3';
