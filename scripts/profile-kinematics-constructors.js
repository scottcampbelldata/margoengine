import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeHeapSnapshot } from 'node:v8';
import {
  AvoidanceSolver,
  CapsuleVolume,
  SphereVolume,
  SolveStatus,
} from '../packages/kinematics-constraints/dist/index.js';

process.chdir(fileURLToPath(new URL('..', import.meta.url)));
const argument = (name, fallback) =>
  process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const count = Number(argument('solves', '10000')),
  warmup = Number(argument('warmup', '10000'));
assert.ok(Number.isSafeInteger(count) && count > 0 && Number.isSafeInteger(warmup) && warmup > 0);
const colliderCount = Number(argument('colliders', '1'));
assert.ok(
  colliderCount === 1 || colliderCount === 4,
  'colliders must be 1 (comparable baseline) or 4 (two spheres and two capsules)',
);
const label = argument('label', '');
assert.ok(!label || /^[a-z0-9-]+$/.test(label), 'label must contain lowercase letters, numbers or hyphens');
const prefix = resolve(`test-results/kinematics-constructors${label ? '-' + label : ''}`);
mkdirSync(resolve('test-results'), { recursive: true });

function createFixture() {
  const root = new Float32Array([0.48, 1.25, 0]),
    raw = new Float32Array([0.9, 0.7, 0.14]);
  const hand = new Float32Array(raw),
    elbow = new Float32Array(3),
    statuses = new Uint32Array(4);
  const upper = 0.55,
    lower = 0.52;
  const volume = new CapsuleVolume({ start: [0, 0.45, 0], end: [0, 1.2, 0], radius: 0.32 });
  const volumes = [volume];
  if (colliderCount === 4)
    volumes.push(
      new SphereVolume({ center: [-0.5, 0.9, 0], radius: 0.12 }),
      new CapsuleVolume({ start: [-0.55, 0.45, -0.1], end: [-0.55, 1.15, -0.1], radius: 0.1 }),
      new SphereVolume({ center: [0.05, 1.45, -0.25], radius: 0.12 }),
    );
  const solver = new AvoidanceSolver(volumes, {
    minClearance: 0.008,
    complianceMargin: 0.003,
    targetRadius: 0.055,
    damping: 0.12,
    maxIterations: 24,
  });
  const options = { swivelSpeedLimit: Math.PI, reachMargin: 0.015, foldMargin: 0.015, searchBudget: 128 };
  function length3(x, y, z) {
    return Math.sqrt(x * x + y * y + z * z);
  }
  function evaluateElbow(shoulder, target, angle, out) {
    let ax = target[0] - shoulder[0],
      ay = target[1] - shoulder[1],
      az = target[2] - shoulder[2];
    const distance = length3(ax, ay, az);
    ax /= distance;
    ay /= distance;
    az /= distance;
    let bx = ay * ax,
      by = -1 + ay * ay,
      bz = ay * az;
    let length = length3(bx, by, bz);
    if (length < 1e-6) {
      bx = -az * ax;
      by = -az * ay;
      bz = 1 - az * az;
      length = length3(bx, by, bz);
    }
    bx /= length;
    by /= length;
    bz /= length;
    const cx = ay * bz - az * by,
      cy = az * bx - ax * bz,
      cz = ax * by - ay * bx;
    const along = (upper * upper + distance * distance - lower * lower) / (2 * distance);
    const height = Math.sqrt(Math.max(0, upper * upper - along * along)),
      cosine = Math.cos(angle),
      sine = Math.sin(angle);
    out[0] = shoulder[0] + ax * along + height * (bx * cosine + cx * sine);
    out[1] = shoulder[1] + ay * along + height * (by * cosine + cy * sine);
    out[2] = shoulder[2] + az * along + height * (bz * cosine + cz * sine);
  }
  let frame = 0,
    checksum = 0;
  function solverBatch(iterations) {
    for (let i = 0; i < iterations; i++) {
      const time = frame++ * 0.007;
      raw[0] = 0.5 + 0.4 * Math.cos(time);
      raw[1] = 0.8 + 0.2 * Math.sin(time);
      raw[2] = 0.14;
      const result = solver.solve(root, hand, raw, upper, lower, 0.065, 0.055, 1 / 60, evaluateElbow, options);
      statuses[result.status]++;
      if (result.status === SolveStatus.Success && result.resolved) {
        hand.set(result.target);
        elbow.set(result.elbow);
      }
      checksum += hand[0] + elbow[1];
    }
  }
  function controlBatch(iterations) {
    for (let i = 0; i < iterations; i++) {
      const time = frame++ * 0.007;
      raw[0] = 0.5 + 0.4 * Math.cos(time);
      raw[1] = 0.8 + 0.2 * Math.sin(time);
      raw[2] = 0.14;
      evaluateElbow(root, raw, 0, elbow);
      hand.set(raw);
      checksum += hand[0] + elbow[1];
    }
  }
  return {
    solverBatch,
    controlBatch,
    resetCounters() {
      statuses.fill(0);
    },
    snapshot() {
      return { statuses: [...statuses], checksum };
    },
  };
}

const worker = argument('worker', '');
if (worker) {
  assert.equal(typeof global.gc, 'function', 'Worker requires --expose-gc');
  const fixture = createFixture();
  fixture.solverBatch(warmup);
  fixture.controlBatch(warmup);
  fixture.resetCounters();
  const run = worker === 'control' ? fixture.controlBatch : fixture.solverBatch;
  global.gc();
  if (worker === 'snapshot') {
    writeHeapSnapshot(`${prefix}-before.heapsnapshot`);
    run(count);
    writeHeapSnapshot(`${prefix}-after.heapsnapshot`);
    writeFileSync(
      `${prefix}-${worker}-runtime.json`,
      JSON.stringify({ node: process.version, v8: process.versions.v8, ...fixture.snapshot() }),
    );
  } else {
    // Timing brackets only the warmed loop. The final forced major GC
    // classifies dead objects; it is excluded from natural collection counts.
    const startMs = performance.now();
    run(count);
    const endMs = performance.now();
    global.gc();
    writeFileSync(
      `${prefix}-${worker}-runtime.json`,
      JSON.stringify({ node: process.version, v8: process.versions.v8, startMs, endMs, ...fixture.snapshot() }),
    );
  }
} else {
  const script = fileURLToPath(import.meta.url);
  const runtimeExecutable = argument('node', process.execPath);
  const availableFlags = spawnSync(runtimeExecutable, ['--v8-options'], { encoding: 'utf8', windowsHide: true });
  assert.ok(
    availableFlags.status === 0 &&
      /--track-gc-object-stats\b/.test(availableFlags.stdout) &&
      /--trace-gc-object-stats\b/.test(availableFlags.stdout),
    'This Node/V8 runtime lacks GC object census flags. Run with a supporting Node build (validated on Node24), or pass --node=<executable>.',
  );
  const packageSHA256 = createHash('sha256')
    .update(readFileSync('packages/kinematics-constraints/dist/index.js'))
    .digest('hex');
  const flags = [
    '--expose-gc',
    '--trace-gc',
    '--trace-gc-object-stats',
    '--track-gc-object-stats',
    '--min-semi-space-size=256',
    '--max-semi-space-size=256',
  ];
  function capture(mode) {
    const child = spawnSync(
      runtimeExecutable,
      [
        ...flags,
        script,
        `--worker=${mode}`,
        `--solves=${count}`,
        `--warmup=${warmup}`,
        `--label=${label}`,
        `--colliders=${colliderCount}`,
      ],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true },
    );
    const rawPath = `${prefix}-${mode}.gc.log`;
    writeFileSync(rawPath, child.stdout + '\n' + child.stderr);
    assert.equal(child.status, 0, `GC worker failed; inspect ${rawPath}`);
    const lines = child.stdout.split(/\r?\n/);
    const records = lines.filter((line) => line.startsWith('{')).map((line) => JSON.parse(line));
    const id = Math.max(...records.map((record) => record.id));
    const types = records
      .filter((record) => record.id === id && record.type === 'instance_type_data' && record.key === 'dead')
      .map((record) => ({ type: record.instance_type_name, count: record.count, bytes: record.overall }))
      .sort((a, b) => b.bytes - a.bytes);
    const runtime = JSON.parse(readFileSync(`${prefix}-${mode}-runtime.json`, 'utf8'));
    return {
      runtime,
      rawPath,
      naturalGCMessagesInMeasuredLoop: lines.filter((line) => {
        const time = Number(line.match(/\s(\d+) ms:/)?.[1]);
        return /Scavenge|Mark-Compact|Mark-sweep/.test(line) && time > runtime.startMs && time < runtime.endMs;
      }),
      types,
    };
  }
  const control = capture('control'),
    solver = capture('solver');
  const baseline = new Map(control.types.map((type) => [type.type, type]));
  const delta = solver.types
    .map((type) => ({
      type: type.type,
      solverCount: type.count,
      solverBytes: type.bytes,
      controlCount: baseline.get(type.type)?.count ?? 0,
      controlBytes: baseline.get(type.type)?.bytes ?? 0,
      countDelta: type.count - (baseline.get(type.type)?.count ?? 0),
      bytesDelta: type.bytes - (baseline.get(type.type)?.bytes ?? 0),
    }))
    .sort((a, b) => b.bytesDelta - a.bytesDelta);
  assert.equal(
    createHash('sha256').update(readFileSync('packages/kinematics-constraints/dist/index.js')).digest('hex'),
    packageSHA256,
    'Package dist changed during the constructor capture; rerun against one stable build.',
  );
  const report = {
    runtime: { node: solver.runtime.node, v8: solver.runtime.v8, executable: runtimeExecutable },
    packageSHA256,
    solves: count,
    warmupSolves: warmup,
    colliderCount,
    colliderKinds: colliderCount === 1 ? { capsules: 1, spheres: 0 } : { capsules: 2, spheres: 2 },
    flags,
    control,
    solver,
    topDeadTypeDeltas: delta.filter((type) => type.bytesDelta > 0).slice(0, 20),
    retainedConstructors: null,
    interpretation: [
      'GC object stats enumerate actual V8 instance types and sizes. Internal HEAP_NUMBER_TYPE and FIXED_ARRAY_TYPE are not JavaScript constructor names.',
      'Dead-object counts describe unreachable objects found at the forced major GC after the loop. They include runtime and harness work; the matched control subtraction is attribution evidence, not per-object call stacks.',
      'The control runs the same target math, one analytical IK callback, and persistent pose copies per iteration, without the constraint solver. Extra solver candidate callbacks are part of the measured solver-workload difference.',
      'Large young-generation flags reduce intervening scavenges. Any natural collection messages inside the measured loop are reported; collected objects from an earlier GC are absent from the final dead-object table.',
      'Heap snapshots force GC. Their constructor difference counts only retained live objects and cannot count discarded transient arrays or boxed numbers.',
      'Counts are specific to this warmed Node/V8 runtime, package hash, fixture, and JIT state; they are not an allocation guarantee for Chromium or every input.',
    ],
  };
  // Publish the exact dead-type result immediately, before optional snapshots.
  writeFileSync(`${prefix}.json`, JSON.stringify(report, null, 2));
  console.log(
    JSON.stringify({
      runtime: report.runtime,
      packageSHA256: report.packageSHA256,
      solves: count,
      colliderCount,
      topDeadTypeDeltas: report.topDeadTypeDeltas.slice(0, 3),
      naturalGCs: {
        solver: solver.naturalGCMessagesInMeasuredLoop.length,
        control: control.naturalGCMessagesInMeasuredLoop.length,
      },
    }),
  );
  if (!process.argv.includes('--skip-snapshots')) {
    const child = spawnSync(
      runtimeExecutable,
      [
        '--expose-gc',
        script,
        '--worker=snapshot',
        `--solves=${count}`,
        `--warmup=${warmup}`,
        `--label=${label}`,
        `--colliders=${colliderCount}`,
      ],
      { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, windowsHide: true },
    );
    assert.equal(child.status, 0, child.stderr);
    function constructors(path) {
      const snapshot = JSON.parse(readFileSync(path, 'utf8'));
      const fields = snapshot.snapshot.meta.node_fields,
        width = fields.length,
        types = snapshot.snapshot.meta.node_types[0];
      const typeOffset = fields.indexOf('type'),
        nameOffset = fields.indexOf('name'),
        sizeOffset = fields.indexOf('self_size');
      const result = new Map();
      for (let i = 0; i < snapshot.nodes.length; i += width) {
        const type = types[snapshot.nodes[i + typeOffset]];
        if (type !== 'object' && type !== 'array' && type !== 'number') continue;
        const name = snapshot.strings[snapshot.nodes[i + nameOffset]],
          key = `${type}:${name}`;
        const item = result.get(key) ?? { type, constructorOrInternalName: name, count: 0, bytes: 0 };
        item.count++;
        item.bytes += snapshot.nodes[i + sizeOffset];
        result.set(key, item);
      }
      return result;
    }
    const before = constructors(`${prefix}-before.heapsnapshot`),
      after = constructors(`${prefix}-after.heapsnapshot`);
    const selectedNames = [
      'Array',
      'Object',
      'Float32Array',
      'Float64Array',
      'Uint32Array',
      AvoidanceSolver.name,
      CapsuleVolume.name,
      SphereVolume.name,
    ];
    report.retainedConstructors = {
      beforePath: `${prefix}-before.heapsnapshot`,
      afterPath: `${prefix}-after.heapsnapshot`,
      exportedConstructorNames: {
        AvoidanceSolver: AvoidanceSolver.name,
        CapsuleVolume: CapsuleVolume.name,
        SphereVolume: SphereVolume.name,
      },
      selectedLiveCounts: selectedNames.map((name) => ({
        constructor: name,
        beforeCount: before.get(`object:${name}`)?.count ?? 0,
        beforeBytes: before.get(`object:${name}`)?.bytes ?? 0,
        afterCount: after.get(`object:${name}`)?.count ?? 0,
        afterBytes: after.get(`object:${name}`)?.bytes ?? 0,
      })),
      deltas: [...new Set([...before.keys(), ...after.keys()])]
        .map((key) => ({
          type: after.get(key)?.type ?? before.get(key).type,
          constructorOrInternalName:
            after.get(key)?.constructorOrInternalName ?? before.get(key).constructorOrInternalName,
          countDelta: (after.get(key)?.count ?? 0) - (before.get(key)?.count ?? 0),
          bytesDelta: (after.get(key)?.bytes ?? 0) - (before.get(key)?.bytes ?? 0),
          beforeCount: before.get(key)?.count ?? 0,
          afterCount: after.get(key)?.count ?? 0,
        }))
        .filter((type) => type.countDelta || type.bytesDelta)
        .sort((a, b) => b.bytesDelta - a.bytesDelta),
    };
    writeFileSync(`${prefix}.json`, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ retainedConstructorDeltas: report.retainedConstructors.deltas.slice(0, 12) }));
  }
}
