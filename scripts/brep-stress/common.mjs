// Stress-test support only. The instrumented build is never shipped.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as kernel from '@margoengine/brep';

export const model = kernel.model;
export { kernel };
export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const date =
  process.env.BREP_STRESS_DATE ??
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
export const outputRoot = path.join(root, 'test-results/brep-stress', date);
mkdirSync(outputRoot, { recursive: true });

export function failure(error) {
  const name = error?.name ?? 'Error',
    message = String(error?.message ?? error);
  const runtime =
    /cannot (?:read|set) propert|is not (?:a function|iterable)|maximum call stack|out of memory|undefined is not/i.test(
      message,
    );
  const typed = ['RangeError', 'TypeError', 'MargoError'].includes(name);
  return {
    status: typed && !runtime ? 'refused' : 'crash',
    error: { name, message, stack: error?.stack },
    signature: `${name}: ${message}`,
  };
}

export function summarizeBody(body) {
  const mass = model.massProperties(body);
  return {
    volume: mass.volume,
    mass,
    faces: body.faces.length,
    edges: body.edges.length,
    vertices: body.vertices.length,
    shells: body.shells.length,
  };
}

function meshMeasure(meshes) {
  let volume = 0,
    area = 0,
    open = 0,
    triangles = 0;
  const failures = [];
  for (const mesh of meshes) {
    const p = mesh.positions,
      t = mesh.indices,
      ids = new Map(),
      directed = new Map();
    const weld = (i) => {
      const key = `${p[3 * i]},${p[3 * i + 1]},${p[3 * i + 2]}`;
      if (!ids.has(key)) ids.set(key, ids.size);
      return ids.get(key);
    };
    // Recenter before the scalar triple product to avoid cancellation at large placements.
    const c = [p[0] || 0, p[1] || 0, p[2] || 0];
    for (let k = 0; k < t.length; k += 3) {
      const q = [t[k], t[k + 1], t[k + 2]].map((i) => [p[3 * i] - c[0], p[3 * i + 1] - c[1], p[3 * i + 2] - c[2]]);
      const [a, b, d] = q;
      volume +=
        (a[0] * (b[1] * d[2] - b[2] * d[1]) + a[1] * (b[2] * d[0] - b[0] * d[2]) + a[2] * (b[0] * d[1] - b[1] * d[0])) /
        6;
      const u = b.map((v, j) => v - a[j]),
        v = d.map((w, j) => w - a[j]);
      area += Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]) / 2;
      const w = [t[k], t[k + 1], t[k + 2]].map(weld);
      for (const [x, y] of [
        [w[0], w[1]],
        [w[1], w[2]],
        [w[2], w[0]],
      ]) {
        if (x === y) continue;
        const key = `${x},${y}`;
        directed.set(key, (directed.get(key) ?? 0) + 1);
      }
    }
    for (const [key, n] of directed) {
      const [x, y] = key.split(',');
      if (n !== 1 || directed.get(`${y},${x}`) !== 1) open++;
    }
    triangles += t.length / 3;
    failures.push(...(mesh.failures ?? []));
  }
  return { volume, area, open, triangles, failures };
}

export function inspectBody(body, { expectedVolume, label = body.name } = {}) {
  const issues = [],
    coverage = {},
    result = { label, status: 'passed', issues, problems: issues, coverage };
  const issue = (oracle, message, actual, expected) => issues.push({ oracle, message, actual, expected });
  let stage = 'validate';
  const mark = (next) => {
    stage = next;
    if (process.env.BREP_STRESS_TRACE) console.error(`stage:${next}:${label}`);
  };
  try {
    const valid = model.validateBody(body);
    coverage.validate = true;
    if (valid.length) issue('validate', 'validateBody reports problems', valid, []);
    mark('check');
    const checked = model.checkBody(body);
    coverage.check = true;
    if (checked.length) issue('check', 'checkBody reports problems', checked, []);
    mark('mass');
    Object.assign(result, summarizeBody(body));
    coverage.mass = true;
    const mass = result.mass;
    if (![mass.volume, mass.area, ...mass.centroid, ...mass.inertia].every(Number.isFinite))
      issue('finite', 'mass properties are not finite', mass, 'finite');
    if (body.faces.length && body.kind === 'solid' && mass.volume <= 0)
      issue('mass', 'nonempty solid has nonpositive volume', mass.volume, 'positive');
    if (
      expectedVolume !== undefined &&
      Math.abs(mass.volume - expectedVolume) > 1e-9 * Math.max(Math.abs(expectedVolume), Number.MIN_VALUE)
    )
      issue('closed-form', 'volume differs from closed form', mass.volume, expectedVolume);
    // An empty intersection has no geometric boundary to mesh or put in STEP.
    // Its zero mass and valid topology are still checked above.
    if (!body.faces.length && mass.volume === 0) {
      coverage.emptyBoundary = true;
      coverage.export = false;
      coverage.roundtrip = false;
      coverage.mesh = false;
      result.skippedBoundaryReason = 'empty result';
      result.status = issues.length ? 'wrong' : 'passed';
      return result;
    }
    mark('export');
    const step = model.bodiesToSTEP([body]);
    coverage.export = true;
    const hash = createHash('sha256').update(step).digest('hex');
    result.stepHash = hash;
    const exportsDir = path.join(outputRoot, 'exports');
    mkdirSync(exportsDir, { recursive: true });
    const stepFile = path.join(exportsDir, `${hash}.step`);
    if (!existsSync(stepFile)) writeFileSync(stepFile, step);
    result.exportFile = path.relative(root, stepFile).replaceAll('\\', '/');
    mark('roundtrip');
    const imported = model.bodiesFromSTEP(kernel.parseSTEP(step));
    const bs = imported.bodies.filter(Boolean),
      volume = bs.reduce((s, b) => s + model.massProperties(b).volume, 0);
    result.roundtrip = { volume, bodies: bs.length, problems: imported.problems };
    coverage.roundtrip = true;
    if (imported.problems.length) issue('roundtrip-import', 'STEP reimport reports problems', imported.problems, []);
    if (Math.abs(volume - mass.volume) > 1e-9 * Math.max(Math.abs(mass.volume), Number.MIN_VALUE))
      issue('roundtrip-volume', 'STEP roundtrip changes volume', volume, mass.volume);
    mark('mesh');
    const length = Math.max(Math.sqrt(Math.abs(mass.area)), 1e-9),
      deflection = length * 1e-4;
    const mesh = meshMeasure(model.meshBodies([body], { deflection, angle: 0.15 }).meshes);
    result.mesh = { ...mesh, deflection };
    coverage.mesh = true;
    if (mesh.failures.length) issue('mesh-faces', 'mesh has failed faces', mesh.failures, []);
    if (body.kind === 'solid' && mesh.open)
      issue('mesh-open', 'solid mesh has open or multiply used directed edges', mesh.open, 0);
    const bound = 2 * Math.abs(mass.area) * deflection;
    if (Math.abs(mesh.volume - mass.volume) > bound)
      issue('mesh-volume', 'mesh volume exceeds area times chord error bound', mesh.volume, {
        volume: mass.volume,
        bound,
      });
  } catch (error) {
    const f = failure(error);
    result.oracleError = { stage, ...f };
    issue(`oracle-${stage}`, f.signature, f.error, 'oracle completes');
    result.status = f.status === 'crash' ? 'crash' : 'invalid';
  }
  if (result.status === 'passed' && issues.length) {
    const structural = issues.some((i) =>
      ['validate', 'check', 'mesh-open', 'mesh-faces', 'roundtrip-import'].includes(i.oracle),
    );
    result.status = structural ? 'invalid' : 'wrong';
  }
  return result;
}

export function workerMain(executeCase) {
  const arg = process.argv.find((a) => a.startsWith('--case='));
  if (!arg) return false;
  const c = JSON.parse(Buffer.from(arg.slice(7), 'base64').toString('utf8'));
  Promise.resolve()
    .then(() => executeCase(c))
    .then(
      (result) => console.log(JSON.stringify({ ...c, ...result })),
      (error) => console.log(JSON.stringify({ ...c, ...failure(error) })),
    );
  return true;
}

export async function runCases(
  cases,
  workerUrl,
  { output = path.join(outputRoot, 'results.jsonl'), workers = 3, timeoutMs = 60000, resume = true } = {},
) {
  mkdirSync(path.dirname(output), { recursive: true });
  const rows = [],
    seen = new Set();
  if (resume && existsSync(output))
    for (const line of readFileSync(output, 'utf8').split('\n').filter(Boolean)) {
      const r = JSON.parse(line);
      rows.push(r);
      seen.add(r.id);
    }
  const pending = cases.filter((c) => !seen.has(c.id));
  let next = 0,
    done = 0;
  const filename =
    workerUrl instanceof URL || String(workerUrl).startsWith('file:') ? fileURLToPath(workerUrl) : workerUrl;
  async function lane() {
    while (next < pending.length) {
      const c = pending[next++];
      const row = await new Promise((resolve) => {
        const start = performance.now();
        const child = spawn(
          process.execPath,
          [filename, `--case=${Buffer.from(JSON.stringify(c)).toString('base64')}`],
          { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
        );
        let stdout = '',
          stderr = '',
          timedOut = false;
        child.stdout.on('data', (d) => {
          stdout += d;
        });
        child.stderr.on('data', (d) => {
          stderr = (stderr + d).slice(-16000);
        });
        const timer = setTimeout(() => {
          timedOut = true;
          child.kill();
        }, timeoutMs);
        child.on('error', (error) => {
          clearTimeout(timer);
          resolve({ ...c, ...failure(error), ms: performance.now() - start });
        });
        child.on('close', (code, signal) => {
          clearTimeout(timer);
          let result;
          if (timedOut) result = { status: 'hang', signature: 'case exceeded 60 s', stderr };
          else {
            try {
              result = JSON.parse(stdout.trim().split('\n').at(-1));
            } catch {
              result = {
                status: 'crash',
                signature: `child exited ${code}/${signal}`,
                stdout: stdout.slice(-4000),
                stderr,
              };
            }
          }
          resolve({ ...c, ...result, ms: performance.now() - start, exitCode: code });
        });
      });
      appendFileSync(output, `${JSON.stringify(row)}\n`);
      rows.push(row);
      done++;
      if (done % 25 === 0 || done === pending.length)
        console.log(`${path.basename(output)} ${done}/${pending.length} ${JSON.stringify(counts(rows))}`);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(12, workers)) }, lane));
  return rows;
}

export function counts(rows) {
  const out = { passed: 0, refused: 0, invalid: 0, wrong: 0, crash: 0, hang: 0 };
  for (const r of rows) out[r.status] = (out[r.status] ?? 0) + 1;
  return out;
}

export const isMain = (url) => process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === url;
