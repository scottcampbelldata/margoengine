/** Seeded primitive Boolean stress tests. All public lengths below are millimetres; API calls use metres. */
import { pathToFileURL } from 'node:url';
import { model, inspectBody, failure, runCases, workerMain } from './common.mjs';

export const KINDS = ['box', 'cylinder', 'sphere', 'torus', 'extrude', 'revolve'];
export const SCALES_MM = [1e-3, 1e-2, 1e-1, 1, 10, 100, 1000, 10000];
const OPS = ['subtract', 'union', 'intersect'];
const MM = 1e-3;
const add = (a, b) => a.map((v, k) => v + b[k]);
const mul = (a, s) => a.map((v) => v * s);
const norm = (a) => Math.hypot(...a);
const identity = { angle: 0, axis: [1, 2, 3], translation: [0, 0, 0] };

/** Repeatable PRNG; every generated coordinate is recoverable from the case JSON. */
export function rng(seed) {
  let x = seed >>> 0;
  return () => {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    return x / 4294967296;
  };
}

function rotate(p, angle = 0, axis = [1, 2, 3]) {
  const n = norm(axis),
    [x, y, z] = axis.map((v) => v / n),
    [a, b, c] = p;
  const co = Math.cos(angle),
    si = Math.sin(angle),
    d = (x * a + y * b + z * c) * (1 - co);
  return [
    a * co + (y * c - z * b) * si + x * d,
    b * co + (z * a - x * c) * si + y * d,
    c * co + (x * b - y * a) * si + z * d,
  ];
}

/** Construct through transformed frames/profiles, without modifying kernel objects in place. */
export function primitive(
  kind,
  name,
  sizeMm,
  { center = [0, 0, 0], angle = 0, jitterMm = 0, seed = 1, motion = identity, factor = 1 } = {},
) {
  const s = sizeMm * MM * factor,
    j = jitterMm * MM,
    random = rng(seed);
  const localDirection = (p) => rotate(p, angle, [0.3, 0.7, 1]);
  const direction = (p) => rotate(localDirection(p), motion.angle, motion.axis);
  const point = (p) =>
    add(rotate(add(localDirection(p), mul(center, MM)), motion.angle, motion.axis), mul(motion.translation, MM));
  const frame = (p) => model.frameOf(point(p), direction([0, 0, 1]), direction([1, 0, 0]));
  let body, volume;
  if (kind === 'box') {
    body = model.box(name, [s, s, s], frame([-s / 2, -s / 2, -s / 2]));
    volume = s ** 3;
  } else if (kind === 'cylinder') {
    body = model.cylinder(name, s / 2, s, frame([0, 0, -s / 2]));
    volume = (Math.PI * s ** 3) / 4;
  } else if (kind === 'sphere') {
    body = model.sphere(name, s / 2, frame([0, 0, 0]));
    volume = (Math.PI * s ** 3) / 6;
  } else if (kind === 'torus') {
    body = model.torus(name, 0.32 * s, 0.18 * s, frame([0, 0, 0]));
    volume = 2 * Math.PI ** 2 * 0.32 * 0.18 ** 2 * s ** 3;
  } else if (kind === 'extrude') {
    const flat = [
      [-0.5, -0.4],
      [0.5, -0.4],
      [0.4, 0.4],
      [-0.4, 0.4],
    ].map(([x, y]) => [x * s + (random() - 0.5) * j, y * s + (random() - 0.5) * j, -s / 2]);
    const p = flat.map(point);
    body = model.extrude(
      name,
      {
        name: `${name}/profile`,
        start: p[0],
        normal: direction([0, 0, 1]),
        segments: [...p.slice(1), p[0]].map((to, k) => ({ kind: 'line', name: `edge${k}`, to })),
      },
      mul(direction([0, 0, 1]), s),
    );
    volume =
      (Math.abs(
        flat.reduce((v, p, k) => v + p[0] * flat[(k + 1) % flat.length][1] - p[1] * flat[(k + 1) % flat.length][0], 0),
      ) *
        s) /
      2;
  } else if (kind === 'revolve') {
    // A conical ring: four planar/conical/cylindrical faces, and a genuine through hole.
    const p = [
      [0.2, 0, -0.5],
      [0.5, 0, -0.5],
      [0.4, 0, 0.5],
      [0.2, 0, 0.5],
    ].map((p) => point(mul(p, s)));
    body = model.revolve(
      name,
      {
        name: `${name}/profile`,
        start: p[0],
        normal: direction([0, 1, 0]),
        segments: [...p.slice(1), p[0]].map((to, k) => ({ kind: 'line', name: `edge${k}`, to })),
      },
      { origin: point([0, 0, 0]), direction: direction([0, 0, 1]) },
    );
    volume = Math.PI * s ** 3 * ((0.25 + 0.2 + 0.16) / 3 - 0.04);
  } else throw new TypeError(`Unknown primitive ${kind}; choose ${KINDS.join(', ')}`);
  return { body, volume };
}

/** Match boolean.ts's model-size tolerance, including translations. */
function touchMm(...bodies) {
  let size = 1e-6;
  for (const b of bodies) {
    for (const v of b.vertices) size = Math.max(size, norm(v.point));
    for (const { surface: s } of b.faces)
      if (s.frame && (s.radius !== undefined || s.major !== undefined))
        size = Math.max(size, norm(s.frame.origin) + (s.radius ?? s.major + s.minor));
  }
  return (size * 1e-6) / MM;
}

function pair(c, motion = identity) {
  if (motion !== identity) {
    // Resolve tolerance-sensitive placement once, then move exactly that geometry.
    const base = pair(c);
    const a = primitive(c.a, 'a', c.scaleMm, { motion, jitterMm: c.profileJitterMm ?? 0, seed: c.seed ?? 1 });
    const b = primitive(c.b, 'b', c.scaleMm, {
      center: base.shift,
      angle: c.angleRad ?? 0,
      motion,
      jitterMm: c.profileJitterMm ?? 0,
      seed: (c.seed ?? 1) + 1,
    });
    return { a, b, shift: base.shift, touchMm: touchMm(a.body, b.body) };
  }
  const s = c.scaleMm,
    r = rng(c.seed ?? 1);
  const jitter = c.jitterMm ? [0, 1, 2].map(() => (r() * 2 - 1) * c.jitterMm) : [0, 0, 0];
  let shift =
    c.scenario === 'overlap'
      ? [0.31 * s, 0.13 * s, 0.09 * s]
      : c.scenario === 'coincident'
        ? [0, 0, 0]
        : c.scenario === 'disjoint'
          ? [2.1 * s, 0, 0]
          : [s + (c.offsetMm ?? 0), 0, 0];
  shift = add(shift, jitter);
  const makeA = () => primitive(c.a, 'a', s, { motion, jitterMm: c.profileJitterMm ?? 0, seed: c.seed ?? 1 });
  const makeB = () =>
    primitive(c.b, 'b', s, {
      center: shift,
      angle: c.angleRad ?? 0,
      motion,
      jitterMm: c.profileJitterMm ?? 0,
      seed: (c.seed ?? 1) + 1,
    });
  let a = makeA(),
    b = makeB();
  if (c.pastToleranceNm !== undefined) {
    // Three fixed-point iterations account for tolerance depending on the second solid's translated coordinates.
    for (let k = 0; k < 3; k++) {
      shift = [s + (c.side ?? 1) * (touchMm(a.body, b.body) + c.pastToleranceNm * 1e-6), 0, 0];
      b = makeB();
    }
  }
  return { a, b, shift, touchMm: touchMm(a.body, b.body) };
}

function worstStatus(observations, issues) {
  for (const status of ['hang', 'crash', 'invalid', 'wrong'])
    if (observations.some((x) => x.status === status)) return status;
  if (issues.length) return 'wrong';
  return observations.some((x) => x.status === 'refused') ? 'refused' : 'passed';
}

function mass(body) {
  return body.faces.length
    ? model.massProperties(body)
    : { volume: 0, area: 0, centroid: [0, 0, 0], inertia: [0, 0, 0, 0, 0, 0] };
}

async function observe(label, make, expectedVolume, observations) {
  const started = performance.now();
  try {
    if (process.argv.some((a) => a.startsWith('--case='))) process.stderr.write(`make ${label}\n`);
    const body = make();
    const made = performance.now();
    if (process.argv.some((a) => a.startsWith('--case='))) process.stderr.write(`inspect ${label}\n`);
    const diagnostics = await inspectBody(body, { label, expectedVolume });
    const row = { label, ...diagnostics, operationMs: made - started, oracleMs: performance.now() - made };
    observations.push(row);
    if (process.argv.some((a) => a.startsWith('--case=')))
      process.stderr.write(
        `done ${JSON.stringify({ label, status: row.status, volume: row.volume, coverage: row.coverage })}\n`,
      );
    return { body, mass: diagnostics.mass ?? mass(body), diagnostics: row };
  } catch (error) {
    observations.push({ label, ...failure(error), operationMs: performance.now() - started });
    return null;
  }
}

function difference(label, expected, actual, scale, tolerance, issues) {
  const residual = Math.abs(actual - expected) / Math.max(Math.abs(scale), 1e-30);
  if (!Number.isFinite(residual) || residual > tolerance)
    issues.push({ oracle: label, expected, actual, relativeResidual: residual, tolerance });
  return residual;
}

function compareMass(label, expected, actual, volumeScale, lengthScale, issues, tolerance = 5e-7, motion) {
  const v = difference(
    `${label}:volume`,
    expected.volume,
    actual.volume,
    Math.abs(expected.volume) || volumeScale,
    Math.min(1e-9, tolerance),
    issues,
  );
  difference(`${label}:area`, expected.area, actual.area, Math.max(expected.area, lengthScale ** 2), tolerance, issues);
  if (Math.abs(expected.volume) > volumeScale * 1e-10 && Math.abs(actual.volume) > volumeScale * 1e-10) {
    const centroid = motion
      ? add(rotate(expected.centroid, motion.angle, motion.axis), mul(motion.translation, MM))
      : expected.centroid;
    for (let k = 0; k < 3; k++)
      difference(`${label}:centroid[${k}]`, centroid[k], actual.centroid[k], lengthScale, tolerance * 5, issues);
  }
  // Rotation leaves the trace of the centroidal inertia invariant.
  difference(
    `${label}:inertia-trace`,
    expected.inertia.slice(0, 3).reduce((a, b) => a + b, 0),
    actual.inertia.slice(0, 3).reduce((a, b) => a + b, 0),
    volumeScale * lengthScale ** 2,
    tolerance * 5,
    issues,
  );
  return v;
}

function topologyFingerprint(body) {
  return JSON.stringify({
    shells: body.shells.length,
    faces: body.faces.map((f) => [
      f.name,
      f.surface.kind,
      f.sense,
      f.loops.map((l) => l.coedges.map((e) => [e.edge.name, e.forward])),
    ]),
    vertices: body.vertices.map((v) => [v.name, v.point]),
    edges: body.edges.map((e) => [e.name, e.curve.kind, e.start.name, e.end.name, e.sameSense]),
  });
}

async function booleanCase(c) {
  const observations = [],
    issues = [],
    p = pair(c),
    originals = {};
  const inputA = await observe('input:a', () => p.a.body, p.a.volume, observations);
  const inputB = await observe('input:b', () => p.b.body, p.b.volume, observations);
  if (!inputA || !inputB) return { ...c, status: worstStatus(observations, issues), observations, issues };
  const scale = Math.abs(inputA.mass.volume) + Math.abs(inputB.mass.volume),
    length = c.scaleMm * MM;
  const expected = {};
  if (
    c.a === 'box' &&
    c.b === 'box' &&
    !c.angleRad &&
    (c.scenario !== 'contact' || Math.abs(p.shift[0] - c.scaleMm) > p.touchMm * 2)
  ) {
    const intersection = p.shift.reduce((v, x) => v * Math.max(0, length - Math.abs(x * MM)), 1);
    expected.subtract = length ** 3 - intersection;
    expected.union = 2 * length ** 3 - intersection;
    expected.intersect = intersection;
  }
  if (
    c.a === 'sphere' &&
    c.b === 'sphere' &&
    (c.scenario !== 'contact' || Math.abs(p.shift[0] - c.scaleMm) > p.touchMm * 2)
  ) {
    const radius = length / 2,
      distance = norm(mul(p.shift, MM));
    const intersection =
      distance >= length ? 0 : (Math.PI * (4 * radius + distance) * (2 * radius - distance) ** 2) / 12;
    expected.subtract = p.a.volume - intersection;
    expected.union = p.a.volume + p.b.volume - intersection;
    expected.intersect = intersection;
  }
  for (const op of OPS)
    originals[op] = await observe(
      `normal:${op}`,
      () => model.boolean(op, op, p.a.body, p.b.body),
      expected[op],
      observations,
    );
  if (originals.subtract && originals.intersect)
    difference(
      'subtract+intersect=A',
      inputA.mass.volume,
      originals.subtract.mass.volume + originals.intersect.mass.volume,
      inputA.mass.volume,
      1e-9,
      issues,
    );
  if (originals.union && originals.intersect)
    difference(
      'union+intersect=A+B',
      inputA.mass.volume + inputB.mass.volume,
      originals.union.mass.volume + originals.intersect.mass.volume,
      scale,
      1e-9,
      issues,
    );
  const reverseSubtract = await observe(
    'swapped:subtract',
    () => model.boolean('subtract', 'subtract', p.b.body, p.a.body),
    undefined,
    observations,
  );
  if (reverseSubtract && originals.intersect)
    difference(
      'reverse-subtract+intersect=B',
      inputB.mass.volume,
      reverseSubtract.mass.volume + originals.intersect.mass.volume,
      inputB.mass.volume,
      1e-9,
      issues,
    );
  const motion = {
    angle: 0.371,
    axis: [1, 2, -0.7],
    translation: [0.23 * c.scaleMm, -0.17 * c.scaleMm, 0.11 * c.scaleMm],
  };
  let moved;
  try {
    moved = pair(c, motion);
  } catch (error) {
    observations.push({ label: 'motion:inputs', ...failure(error) });
  }
  for (const op of OPS) {
    const primary = originals[op];
    if (!primary) continue;
    const repeat = await observe(
      `repeat:${op}`,
      () => {
        const p = pair(c);
        return model.boolean(op, op, p.a.body, p.b.body);
      },
      expected[op],
      observations,
    );
    if (repeat) {
      compareMass(`determinism:${op}`, primary.mass, repeat.mass, scale, length, issues, 2e-12);
      if (topologyFingerprint(primary.body) !== topologyFingerprint(repeat.body))
        issues.push({
          oracle: `determinism:${op}:topology`,
          expected: 'byte-identical topology and coordinates',
          actual: 'different topology/coordinate fingerprint',
        });
    } else
      issues.push({
        oracle: `determinism:${op}`,
        expected: 'same outcome on repeated input',
        actual: observations.at(-1),
      });
    if (op !== 'subtract') {
      const swapped = await observe(
        `swapped:${op}`,
        () => model.boolean(op, op, p.b.body, p.a.body),
        expected[op],
        observations,
      );
      if (swapped) compareMass(`operand-order:${op}`, primary.mass, swapped.mass, scale, length, issues);
      else
        issues.push({ oracle: `operand-order:${op}`, expected: 'same accepted result', actual: observations.at(-1) });
    }
    if (moved) {
      const transformed = await observe(
        `motion:${op}`,
        () => model.boolean(op, op, moved.a.body, moved.b.body),
        expected[op],
        observations,
      );
      if (transformed)
        compareMass(`rigid-motion:${op}`, primary.mass, transformed.mass, scale, length, issues, 5e-7, motion);
      else
        issues.push({
          oracle: `rigid-motion:${op}`,
          expected: 'same accepted result after common rigid motion',
          actual: observations.at(-1),
        });
    }
  }
  return {
    ...c,
    status: worstStatus(observations, issues),
    actualOffsetMm: p.shift[0] - c.scaleMm,
    actualTouchMm: p.touchMm,
    observations,
    issues,
    coverage: {
      booleanCalls: observations.filter((o) =>
        /^(normal|repeat|swapped|motion):(subtract|union|intersect)$/.test(o.label),
      ).length,
      successfulBodies: observations.filter((o) => o.mass).length,
      identities:
        Number(Boolean(originals.subtract && originals.intersect)) +
        Number(Boolean(originals.union && originals.intersect)) +
        Number(Boolean(reverseSubtract && originals.intersect)),
      deterministicComparisons: OPS.filter(
        (op) => originals[op] && observations.some((o) => o.label === `repeat:${op}` && o.mass),
      ).length,
      rigidMotionComparisons: OPS.filter(
        (op) => originals[op] && observations.some((o) => o.label === `motion:${op}` && o.mass),
      ).length,
    },
  };
}

async function chainCase(c) {
  const observations = [],
    issues = [],
    random = rng(c.seed),
    s = c.scaleMm;
  const steps = Array.from({ length: c.length }, (_, k) => ({
    kind: KINDS[Math.floor(random() * KINDS.length)],
    op: OPS[k % OPS.length],
    center: [(random() - 0.5) * s, (random() - 0.5) * s, (random() - 0.5) * s],
    factor: 0.35 + random() * 0.65,
    angle: (random() - 0.5) * 1e-3,
  }));
  const motion = { angle: 0.371, axis: [1, 2, -0.7], translation: [0.23 * s, -0.17 * s, 0.11 * s] };
  async function run(label, transform) {
    let current = await observe(
      `${label}:initial`,
      () => primitive('box', 'chain-base', s, { motion: transform }).body,
      (s * MM) ** 3,
      observations,
    );
    for (let k = 0; k < steps.length && current; k++) {
      const step = steps[k],
        previous = current;
      const tool = await observe(
        `${label}:tool:${k}`,
        () => primitive(step.kind, `tool${k}`, s, { ...step, motion: transform }).body,
        undefined,
        observations,
      );
      if (!tool) return null;
      current = await observe(
        `${label}:${k}:${step.op}`,
        () => model.boolean(`step${k}`, step.op, previous.body, tool.body),
        undefined,
        observations,
      );
      if (current) {
        const v = current.mass.volume,
          a = previous.mass.volume,
          b = tool.mass.volume,
          tolerance = Math.max(a + b, 1e-30) * 1e-9;
        if (
          v < -tolerance ||
          (step.op !== 'union' && v > a + tolerance) ||
          (step.op === 'intersect' && v > b + tolerance) ||
          (step.op === 'union' && (v < Math.max(a, b) - tolerance || v > a + b + tolerance))
        )
          issues.push({ oracle: `${label}:${k}:volume-bounds`, operation: step.op, expected: { a, b }, actual: v });
      }
    }
    return current;
  }
  const original = await run('normal', identity),
    repeat = await run('repeat', identity),
    moved = await run('motion', motion);
  const scale = (s * MM) ** 3;
  if (original && repeat) {
    compareMass('chain:determinism', original.mass, repeat.mass, scale, s * MM, issues, 2e-12);
    if (topologyFingerprint(original.body) !== topologyFingerprint(repeat.body))
      issues.push({
        oracle: 'chain:determinism:topology',
        expected: 'identical topology and coordinates',
        actual: 'different fingerprint',
      });
  }
  if (original && moved)
    compareMass('chain:rigid-motion', original.mass, moved.mass, scale, s * MM, issues, 5e-7, motion);
  return {
    ...c,
    status: worstStatus(observations, issues),
    steps,
    observations,
    issues,
    coverage: {
      attemptedChainSteps: observations.filter((o) => /^(normal|repeat|motion):\d+:/.test(o.label)).length,
      successfulBodies: observations.filter((o) => o.mass).length,
    },
  };
}

/** Execute one isolated case. The common runner supplies the hard 60 second process bound. */
export async function executeCase(c) {
  try {
    return c.suite === 'D' ? await chainCase(c) : await booleanCase(c);
  } catch (error) {
    return { ...c, ...failure(error) };
  }
}

function caseId(c) {
  return [
    c.suite,
    c.a && `${c.a}-${c.b}`,
    `s${c.scaleMm}`,
    c.scenario,
    c.offsetMm !== undefined && `d${c.offsetMm}`,
    c.pastToleranceNm !== undefined && `past${c.side ?? 1}x${c.pastToleranceNm}nm`,
    c.angleRad !== undefined && `r${c.angleRad}`,
    c.jitterMm !== undefined && `j${c.jitterMm}`,
    c.seed !== undefined && `seed${c.seed}`,
    c.length !== undefined && `length${c.length}`,
  ]
    .filter((x) => x !== false && x !== undefined)
    .join('/');
}

/** Staged is a covering design; full expands the documented Cartesian matrix explicitly. */
export function cases({ matrix = 'staged', suite } = {}) {
  const out = [],
    seen = new Set(),
    push = (c) => {
      c.id = caseId(c);
      if (!seen.has(c.id)) {
        seen.add(c.id);
        out.push(c);
      }
    };
  for (const a of KINDS) for (const b of KINDS) push({ suite: 'A', a, b, scaleMm: 1, scenario: 'overlap' });
  if (matrix !== 'smoke') {
    for (const scaleMm of SCALES_MM) for (const a of KINDS) push({ suite: 'A', a, b: a, scaleMm, scenario: 'overlap' });
    const offsets = [-1e-9, 1e-9, -1e-7, 1e-7, -1e-6, 1e-6, -1e-5, 1e-5];
    for (let i = 0; i < KINDS.length; i++) {
      const a = KINDS[i],
        b = KINDS[(i + 1) % KINDS.length];
      for (const offsetMm of [...offsets, -1e-3, 1e-3])
        push({ suite: 'A', a, b, scaleMm: 1, scenario: 'contact', offsetMm });
      for (const pastToleranceNm of [30, 50, 100])
        for (const side of [-1, 1]) push({ suite: 'A', a, b, scaleMm: 1, scenario: 'contact', pastToleranceNm, side });
      for (const angleRad of [1e-9, 1e-7, 1e-5, 1e-3])
        push({
          suite: 'B',
          a,
          b,
          scaleMm: 1,
          scenario: 'overlap',
          angleRad,
          jitterMm: 1e-7,
          profileJitterMm: 1e-7,
          seed: 0x6d617267 + i,
        });
      for (const jitterMm of [1e-9, 1e-7, 1e-6, 1e-5])
        push({
          suite: 'B',
          a,
          b: a,
          scaleMm: 1,
          scenario: 'overlap',
          angleRad: 1e-7,
          jitterMm,
          profileJitterMm: jitterMm,
          seed: 0x73747273 + i,
        });
    }
    for (const seed of [1, 42, 0x6d617267, 0xdeadbeef])
      for (const scaleMm of [1e-3, 1, 10000]) push({ suite: 'D', scaleMm, length: 6, seed });
    if (matrix === 'full') {
      for (const scaleMm of SCALES_MM)
        for (const a of KINDS)
          for (const b of KINDS) {
            for (const scenario of ['overlap', 'coincident', 'disjoint']) push({ suite: 'A', a, b, scaleMm, scenario });
            for (const offsetMm of [...offsets, -scaleMm * 1e-3, scaleMm * 1e-3])
              push({ suite: 'A', a, b, scaleMm, scenario: 'contact', offsetMm });
            for (const pastToleranceNm of [30, 50, 100])
              for (const side of [-1, 1])
                push({ suite: 'A', a, b, scaleMm, scenario: 'contact', pastToleranceNm, side });
            for (const angleRad of [1e-9, 1e-7, 1e-5, 1e-3])
              for (const jitterMm of [1e-9, 1e-7, 1e-6, 1e-5])
                push({
                  suite: 'B',
                  a,
                  b,
                  scaleMm,
                  scenario: 'overlap',
                  angleRad,
                  jitterMm,
                  profileJitterMm: jitterMm,
                  seed: 0x6d617267,
                });
          }
      for (let seed = 0; seed < 32; seed++)
        for (const scaleMm of SCALES_MM) push({ suite: 'D', scaleMm, length: 8, seed });
    }
  }
  return suite ? out.filter((c) => suite.split(',').includes(c.suite)) : out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!(await workerMain(executeCase))) {
    const option = (name, fallback) =>
      process.argv.find((x) => x.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
    let selected = cases({ matrix: option('matrix', 'staged'), suite: option('suite') });
    const match = option('match');
    if (match) selected = selected.filter((c) => c.id.includes(match));
    selected = selected.slice(
      Number(option('offset', 0)),
      Number(option('offset', 0)) + Number(option('limit', selected.length)),
    );
    if (process.argv.includes('--list')) console.log(JSON.stringify(selected, null, 2));
    else
      await runCases(selected, new URL(import.meta.url), {
        output: option('output', 'test-results/brep-stress/primitives.jsonl'),
        workers: Math.min(3, Number(option('workers', 3))),
        timeoutMs: 60000,
      });
  }
}
