// Corpus import inventory and a complete, resumable E/B operation matrix.
// Run from the repository root: node scripts/brep-stress/corpus.mjs --inventory
// Then --generate; --run [--limit=100] [--only=<id fragment>] executes isolated cases.
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { model, parseJT, parseSAT, parseSTEP, parseXT, tessellateSTEP } from '@margoengine/brep';
import { failure, inspectBody, runCases, workerMain } from './common.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const outputRoot = resolve(here, '../../test-results/brep-stress');
const inventoryPath = join(outputRoot, 'corpus-inventory.jsonl');
const defaultCorpus = process.env.BREP_CORPUS || resolve(here, '../../test-results/cad-corpus');
const cacheRoot = join(outputRoot, 'corpus-cache');
const importerBuild = statSync(fileURLToPath(import.meta.resolve('@margoengine/brep'))).mtimeMs;
const recognized = new Set(['.step', '.stp', '.sat', '.x_t', '.x_b', '.jt']);
const argument = (name, fallback) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const add = (a, b) => a.map((v, i) => v + b[i]);
const mul = (a, n) => a.map((v) => v * n);
const dot = (a, b) => a.reduce((v, x, i) => v + x * b[i], 0);

/** Every available exact-CAD candidate on disk, including files absent from the manifest. */
export function corpusFiles(root = defaultCorpus) {
  const walk = (dir) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      return entry.isDirectory() ? walk(path) : recognized.has(extname(path).toLowerCase()) ? [path] : [];
    });
  const manifestFile = join(root, 'manifest.json');
  const manifest = existsSync(manifestFile) ? JSON.parse(readFileSync(manifestFile, 'utf8')) : [];
  return walk(root)
    .map((path) => {
      const file = relative(root, path).replaceAll('\\', '/');
      const listed = manifest.find((entry) => entry.file === file);
      const extension = extname(path).toLowerCase();
      const format =
        extension === '.jt' ? 'jt' : extension === '.sat' ? 'sat' : extension.startsWith('.x_') ? 'xt' : 'step';
      return {
        file,
        path,
        format,
        bytes: statSync(path).size,
        manifest: !!listed,
        license: listed?.license,
        source: listed?.source,
      };
    })
    .sort((a, b) => a.bytes - b.bytes || a.file.localeCompare(b.file));
}

function parsedModels(c) {
  const bytes = readFileSync(c.path);
  if (c.format === 'jt') {
    const jt = parseJT(bytes, { meshes: false });
    return {
      models: jt.parts.flatMap((part, index) =>
        part.brep ? [{ part: index, partName: part.name, step: part.brep }] : [],
      ),
      jt: {
        version: jt.version,
        parts: jt.parts.length,
        withoutBrep: jt.parts.filter((p) => !p.brep).length,
        warnings: jt.warnings,
      },
    };
  }
  const step = (c.format === 'sat' ? parseSAT : c.format === 'xt' ? parseXT : parseSTEP)(bytes);
  return { models: [{ part: 0, step }] };
}

function importInventory(c) {
  const { models, jt } = parsedModels(c);
  const bodies = [],
    omitted = [],
    warnings = [],
    kinds = {};
  for (const { part, partName, step } of models) {
    const imported = model.bodiesFromSTEP(step);
    for (let index = 0; index < step.bodies.length; index++) {
      const source = step.bodies[index],
        body = imported.bodies[index];
      kinds[source.kind] = (kinds[source.kind] ?? 0) + 1;
      if (source.kind !== 'solid') continue;
      const problems = imported.problems.filter((p) => p.body === index);
      if (!body) {
        omitted.push({ part, body: index, name: source.name, problems });
        continue;
      }
      const edgeKinds = {};
      for (const edge of body.edges) edgeKinds[edge.curve.kind] = (edgeKinds[edge.curve.kind] ?? 0) + 1;
      bodies.push({
        part,
        partName,
        body: index,
        name: body.name,
        faces: body.faces.length,
        edges: body.edges.length,
        vertices: body.vertices.length,
        shells: body.shells.length,
        edgeKinds,
        unit: source.unit,
        problems,
      });
    }
    warnings.push(...step.warnings);
  }
  return {
    ...c,
    status: omitted.length ? 'refused' : bodies.some((b) => b.problems.length) ? 'invalid' : 'passed',
    models: models.length,
    sourceSolidCount: kinds.solid ?? 0,
    importedSolidCount: bodies.length,
    bodies,
    omitted,
    kinds,
    warnings,
    jt,
  };
}

function loadBody(c) {
  const { models } = parsedModels(c);
  const entry = models.find((p) => p.part === c.part);
  if (!entry) throw new RangeError(`Corpus part ${c.part} has no exact B-rep; choose a part with brep`);
  const source = entry.step.bodies[c.body];
  if (!source || source.kind !== 'solid')
    throw new RangeError(`Corpus body ${c.body} is not a solid; choose a solid body`);
  const sliced = { ...entry.step, bodies: [source] };
  const imported = model.bodiesFromSTEP(sliced);
  if (!imported.bodies[0]) throw new RangeError(`Corpus body refused: ${JSON.stringify(imported.problems)}`);
  return { body: imported.bodies[0], step: sliced, importProblems: imported.problems };
}

function encodeBody(body) {
  const vertices = body.vertices;
  const edges = body.edges;
  return {
    name: body.name,
    kind: body.kind,
    vertices: vertices.map((v) => ({ name: v.name, point: v.point, tolerance: v.tolerance })),
    edges: edges.map((e) => ({
      name: e.name,
      curve: e.curve,
      start: vertices.indexOf(e.start),
      end: vertices.indexOf(e.end),
      sameSense: e.sameSense,
      tolerance: e.tolerance,
    })),
    shells: body.shells.map((s) => ({
      outer: s.outer ? body.shells.indexOf(s.outer) : null,
      faces: s.faces.map((f) => ({
        name: f.name,
        surface: f.surface,
        sense: f.sense,
        loops: f.loops.map((l) => l.coedges.map((c) => ({ edge: edges.indexOf(c.edge), forward: c.forward }))),
      })),
    })),
  };
}

function decodeBody(raw) {
  const body = new model.Body(raw.name, raw.kind);
  const vertices = raw.vertices.map((v) => new model.Vertex(v.name, v.point, v.tolerance));
  const edges = raw.edges.map(
    (e) => new model.Edge(e.name, e.curve, vertices[e.start], vertices[e.end], e.sameSense, e.tolerance),
  );
  const shells = raw.shells.map(() => body.shell());
  raw.shells.forEach((s, i) => {
    if (s.outer !== null) shells[i].outer = shells[s.outer];
    for (const f of s.faces) {
      const face = shells[i].add(new model.Face(f.name, f.surface, f.sense));
      for (const coedges of f.loops) {
        const loop = face.loop();
        for (const c of coedges) loop.use(edges[c.edge], c.forward);
      }
    }
  });
  return body;
}

function cacheFile(c) {
  const source = statSync(c.path);
  const key = createHash('sha256')
    .update(`${c.path}:${source.size}:${source.mtimeMs}:${c.part}:${c.body}:${importerBuild}:v1`)
    .digest('hex');
  return join(cacheRoot, `${key}.json`);
}

function readCache(c) {
  const path = cacheFile(c);
  if (!existsSync(path)) return undefined;
  const cached = JSON.parse(readFileSync(path, 'utf8'));
  return { ...cached, body: decodeBody(cached.body), inputCache: path };
}

function saveCache(c, body, importProblems, bounds, sizingFailure) {
  const raw = encodeBody(body);
  // This is topology data, not a STEP roundtrip: all numbers, geometry definitions,
  // edge uses, names, tolerances and shell links must survive unchanged.
  const text = JSON.stringify(raw);
  if (JSON.stringify(encodeBody(decodeBody(JSON.parse(text)))) !== text)
    throw new Error('Corpus topology cache changed the serialized body');
  mkdirSync(cacheRoot, { recursive: true });
  writeFileSync(
    cacheFile(c),
    JSON.stringify({ body: raw, importProblems, bounds, sizingFailure, cacheVerified: true }),
  );
}

function meshBounds(step) {
  const [mesh] = tessellateSTEP(step, { relativeDeflection: 0.002, angle: 0.35 });
  if (mesh.failures.length) throw new RangeError(`Source sizing mesh has ${mesh.failures.length} failed faces`);
  const lo = [Infinity, Infinity, Infinity],
    hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < mesh.positions.length; i += 3)
    for (let k = 0; k < 3; k++) {
      const value = mesh.positions[i + k] * mesh.unit;
      lo[k] = Math.min(lo[k], value);
      hi[k] = Math.max(hi[k], value);
    }
  const size = hi.map((v, k) => v - lo[k]);
  if (!size.every((v) => Number.isFinite(v) && v > 0))
    throw new RangeError(`Source has a degenerate mesh box: ${size}`);
  return {
    lo,
    hi,
    size,
    min: Math.min(...size),
    center: lo.map((v, k) => (v + hi[k]) / 2),
    method: 'source tessellation bounds, metres',
    triangles: mesh.indices.length / 3,
  };
}

function drill(c, bounds) {
  const axis =
    c.direction === 'x'
      ? [1, 0, 0]
      : c.direction === 'y'
        ? [0, 1, 0]
        : c.direction === 'z'
          ? [0, 0, 1]
          : mul([1, 1, 1], 1 / Math.sqrt(3));
  const frame = model.frameOf(bounds.center, axis);
  const radius = bounds.min / c.radiusDivisor;
  // Project the eight source-box corners onto a perpendicular to the drill axis.
  const corners = Array.from({ length: 8 }, (_, i) => bounds.lo.map((v, k) => ((i >> k) & 1 ? bounds.hi[k] : v)));
  const reach = Math.max(
    ...corners.map((p) =>
      dot(
        p.map((v, k) => v - bounds.center[k]),
        frame.x,
      ),
    ),
  );
  const offset = c.position === 'centre' ? 0 : c.position === 'edge' ? reach : reach + radius;
  const span = Math.hypot(...bounds.size) * 2 + 4 * radius;
  const shifted = add(add(bounds.center, mul(frame.x, offset)), mul(axis, -span / 2));
  const origin = add(shifted, c.toolJitter ? mul([1, -1, 1], c.toolJitter) : [0, 0, 0]);
  return model.cylinder('corpus-drill', radius, span, model.frameOf(origin, axis));
}

/** Complete matrix. Every case is reproducible independently; --limit affects execution only. */
export function cases(options = {}) {
  const inventory =
    options.inventory ??
    (existsSync(inventoryPath)
      ? readFileSync(inventoryPath, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      : undefined);
  if (!inventory)
    return corpusFiles(options.root).map((entry) => ({
      suite: 'E',
      id: `import:${entry.file}`,
      action: 'import',
      ...entry,
    }));
  const out = [];
  for (const file of inventory) {
    if (!file.bodies) continue;
    for (const body of file.bodies) {
      const base = {
        suite: 'E',
        file: file.file,
        path: file.path,
        format: file.format,
        part: body.part,
        body: body.body,
      };
      const key = `${file.file}:p${body.part}:b${body.body}`;
      out.push({ ...base, id: `check:${key}`, action: 'check' });
      for (const direction of ['x', 'y', 'z', 'diagonal'])
        for (const radiusDivisor of [50, 10, 3])
          for (const position of ['centre', 'edge', 'graze'])
            out.push({
              ...base,
              id: `drill:${key}:${direction}:r1-${radiusDivisor}:${position}`,
              action: 'drill',
              direction,
              radiusDivisor,
              position,
            });
      out.push(
        { ...base, id: `box-union:${key}`, action: 'box-union' },
        { ...base, id: `sphere-intersection:${key}`, action: 'sphere-intersection' },
      );
      for (let edge = 0; edge < body.edges; edge++)
        for (const radiusDivisor of [50, 10, 3])
          out.push({
            ...base,
            id: `fillet:${key}:e${edge}:r1-${radiusDivisor}`,
            action: 'fillet',
            edge,
            radiusDivisor,
          });
      for (const amplitudeMm of [1e-7, 1e-6, 1e-5])
        for (const sign of [-1, 1]) {
          out.push({
            ...base,
            suite: 'B',
            amplitudeMm,
            direction: 'z',
            radiusDivisor: 10,
            position: 'centre',
            id: `jitter-tool:${key}:${amplitudeMm}mm:${sign}`,
            action: 'drill',
            toolJitter: (sign * amplitudeMm) / 1000,
          });
        }
    }
  }
  return out;
}

/** One bounded child executes one operation plus the shared topology/mesh/mass/STEP diagnostics. */
export async function executeCase(c) {
  if (c.action === 'mesh-audit') {
    const step = parseSTEP(readFileSync(resolve(c.exportFile)));
    const meshes = tessellateSTEP(step, { deflection: c.deflection, angle: 0.15, maxFaceVertices: 200000 });
    let volume = 0,
      triangles = 0;
    const failures = [];
    for (const mesh of meshes) {
      const p = mesh.positions,
        t = mesh.indices,
        origin = [p[0] || 0, p[1] || 0, p[2] || 0];
      let local = 0;
      for (let i = 0; i < t.length; i += 3) {
        const [a, b, d] = [t[i], t[i + 1], t[i + 2]].map((index) => [
          p[3 * index] - origin[0],
          p[3 * index + 1] - origin[1],
          p[3 * index + 2] - origin[2],
        ]);
        local +=
          (a[0] * (b[1] * d[2] - b[2] * d[1]) +
            a[1] * (b[2] * d[0] - b[0] * d[2]) +
            a[2] * (b[0] * d[1] - b[1] * d[0])) /
          6;
      }
      volume += local * mesh.unit ** 3;
      triangles += t.length / 3;
      failures.push(...mesh.failures);
    }
    const error = Math.abs(volume - c.expectedVolume);
    return {
      ...c,
      status: failures.length ? 'invalid' : error > c.bound ? 'wrong' : 'passed',
      volume,
      error,
      triangles,
      failures,
      maxFaceVertices: 200000,
      coverage: { meshVolume: true, meshOpen: false },
    };
  }
  if (c.action === 'import') {
    try {
      return importInventory(c);
    } catch (error) {
      return { ...c, ...failure(error), stage: 'import' };
    }
  }
  let loaded;
  try {
    loaded = c.action === 'check' ? loadBody(c) : (readCache(c) ?? loadBody(c));
  } catch (error) {
    return { ...c, ...failure(error), stage: 'import' };
  }
  const { body, step, importProblems, inputCache } = loaded;
  if (c.action === 'check') return { ...c, ...inspectBody(body, { label: c.id }), importProblems };
  let bounds = loaded.bounds;
  if (loaded.sizingFailure) return { ...c, ...loaded.sizingFailure, stage: 'sizing', importProblems, inputCache };
  try {
    if (!bounds) bounds = meshBounds(step);
    if (!inputCache) saveCache(c, body, importProblems, bounds);
  } catch (error) {
    const sizingFailure = failure(error);
    if (!inputCache) saveCache(c, body, importProblems, undefined, sizingFailure);
    return { ...c, ...sizingFailure, stage: 'sizing', importProblems, inputCache };
  }
  let result;
  try {
    if (c.action === 'drill') result = model.boolean(c.id, 'subtract', body, drill(c, bounds));
    else if (c.action === 'box-union') {
      const origin = add(bounds.center, mul(bounds.size, -0.125));
      result = model.boolean(
        c.id,
        'union',
        body,
        model.box('corpus-box', mul(bounds.size, 0.5), model.frameOf(origin, [0, 0, 1], [1, 0, 0])),
      );
    } else if (c.action === 'sphere-intersection')
      result = model.boolean(
        c.id,
        'intersect',
        body,
        model.sphere('corpus-sphere', bounds.min / 2, model.frameOf(bounds.center, [0, 0, 1])),
      );
    else if (c.action === 'fillet') {
      const edge = body.edges[c.edge];
      if (!edge) throw new RangeError(`Corpus edge ${c.edge} absent; choose an existing edge`);
      result = model.fillet(c.id, body, [edge.name], bounds.min / c.radiusDivisor);
    } else throw new TypeError(`Unknown corpus action ${c.action}`);
  } catch (error) {
    return { ...c, ...failure(error), stage: 'operation', bounds, importProblems, inputCache };
  }
  const inspected = inspectBody(result, { label: c.id });
  if (c.action === 'fillet' && !result.faces.length) {
    inspected.issues.push({
      oracle: 'fillet-nonempty',
      message: 'fillet returned an empty result for a nonempty solid',
      actual: 0,
      expected: 'a nonempty solid or typed radius refusal',
    });
    inspected.status = 'wrong';
  }
  const baselineFile = join(outputRoot, 'corpus-checks.jsonl');
  if (
    ['drill', 'sphere-intersection', 'box-union'].includes(c.action) &&
    Number.isFinite(inspected.volume) &&
    existsSync(baselineFile)
  ) {
    const original = readFileSync(baselineFile, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .find((row) => row.file === c.file && row.part === c.part && row.body === c.body)?.volume;
    if (original > 0) {
      const relative = (inspected.volume - original) / original;
      inspected.originalVolume = original;
      if ((c.action === 'box-union' && relative < -1e-8) || (c.action !== 'box-union' && relative > 1e-8)) {
        inspected.issues.push({
          oracle: 'boolean-volume-ordering',
          message: 'Boolean volume violates containment ordering',
          actual: inspected.volume,
          expected: { operation: c.action, original },
        });
        if (inspected.status === 'passed') inspected.status = 'wrong';
      }
    }
  }
  return { ...c, ...inspected, bounds, importProblems, inputCache };
}

function fairOrder(all) {
  const groups = new Map();
  for (const c of all) {
    const key = `${c.action}:${c.file}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  }
  const out = [];
  for (let i = 0; ; i++) {
    let any = false;
    for (const group of groups.values())
      if (i < group.length) {
        out.push(group[i]);
        any = true;
      }
    if (!any) return out;
  }
}

function bodyFirst(all) {
  const byFile = new Map();
  for (const c of all) {
    if (!byFile.has(c.file)) byFile.set(c.file, new Map());
    const byBody = byFile.get(c.file);
    const key = `${c.part}:${c.body}`;
    if (!byBody.has(key)) byBody.set(key, []);
    byBody.get(key).push(c);
  }
  const perFile = [...byFile.values()].map((group) => [...group.values()]);
  const bodies = [];
  for (let index = 0; ; index++) {
    let any = false;
    for (const file of perFile)
      if (index < file.length) {
        bodies.push(file[index]);
        any = true;
      }
    if (!any) break;
  }
  const out = [];
  for (let round = 0; ; round++) {
    let any = false;
    for (const group of bodies)
      if (round < group.length) {
        const start = (group[0].body + group[0].part) % group.length;
        out.push(group[(round + start) % group.length]);
        any = true;
      }
    if (!any) return out;
  }
}

function stratifiedCases(all) {
  const files = new Map();
  for (const c of all) {
    if (!files.has(c.file)) files.set(c.file, { part: c.part, body: c.body, cases: [] });
    const entry = files.get(c.file);
    if (c.part === entry.part && c.body === entry.body) entry.cases.push(c);
  }
  const out = [];
  let index = 0;
  for (const entry of files.values()) {
    for (const [axisIndex, direction] of ['x', 'y', 'z', 'diagonal'].entries()) {
      const radiusDivisor = [50, 10, 3][(index + axisIndex) % 3];
      const position = ['centre', 'edge', 'graze'][(index + 2 * axisIndex) % 3];
      const c = entry.cases.find(
        (c) =>
          c.suite === 'E' &&
          c.action === 'drill' &&
          c.direction === direction &&
          c.radiusDivisor === radiusDivisor &&
          c.position === position,
      );
      if (c) out.push(c);
    }
    out.push(...entry.cases.filter((c) => c.suite === 'B'));
    const fillets = entry.cases.filter((c) => c.action === 'fillet');
    const last = Math.max(-1, ...fillets.map((c) => c.edge));
    for (const [radiusIndex, radiusDivisor] of [50, 10, 3].entries()) {
      const edge = Math.floor((last * radiusIndex) / 2);
      const c = fillets.find((c) => c.edge === edge && c.radiusDivisor === radiusDivisor);
      if (c) out.push(c);
    }
    index++;
  }
  return out;
}

function summarize(matrix) {
  const files = readdirSync(outputRoot).filter((name) => /^corpus-.*\.jsonl$/.test(name));
  const rows = new Map();
  const repeats = new Map();
  for (const file of files)
    for (const line of readFileSync(join(outputRoot, file), 'utf8').split('\n').filter(Boolean)) {
      const row = JSON.parse(line);
      if (!repeats.has(row.id)) repeats.set(row.id, []);
      repeats.get(row.id).push(row);
      rows.set(row.id, row);
    }
  const all = [...rows.values()];
  const inventory = all.filter((r) => r.action === 'import');
  const executed = all.filter((r) => r.action !== 'import');
  const raisedCapFile = join(outputRoot, 'mesh-audit-corpus.jsonl');
  const raisedCap = new Map(
    existsSync(raisedCapFile)
      ? readFileSync(raisedCapFile, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((line) => {
            const row = JSON.parse(line);
            return [row.id, row];
          })
      : [],
  );
  const audit = {};
  for (const row of all) {
    const oracles = row.issues?.map((i) => i.oracle) ?? [];
    const capped =
      row.file === 'jubilee/jubilee.STEP' &&
      row.body === 141 &&
      row.action === 'drill' &&
      ['y', 'diagonal'].includes(row.direction) &&
      row.radiusDivisor === 50 &&
      row.position === 'centre' &&
      oracles.length === 1 &&
      oracles[0] === 'mesh-volume';
    const availability =
      row.oracleError?.error?.name === 'RangeError' &&
      /no circle round its torus's tube cuts it open/.test(row.oracleError.error.message);
    const capResolved = capped && raisedCap.get(`mesh-audit:${row.id}`)?.status === 'passed';
    let outcomeCategory = row.status;
    if (row.status === 'hang') outcomeCategory = 'aggregate-case-timeout';
    else if (availability) outcomeCategory = 'typed-oracle-availability-refusal';
    else if (capped) outcomeCategory = capResolved ? 'mesh-volume-passed-at-raised-cap' : 'mesh-cap-limited-candidate';
    else if (oracles.includes('roundtrip-volume')) outcomeCategory = 'measured-step-volume-invariant';
    else if (oracles.includes('roundtrip-import')) outcomeCategory = 'reported-step-reimport-problems';
    else if (oracles.includes('check')) outcomeCategory = 'checker-geometry-disagreement';
    else if (oracles.includes('mesh-faces') || oracles.includes('mesh-open'))
      outcomeCategory = 'mesh-boundary-candidate';
    audit[row.id] = {
      suite: row.suite,
      rawStatus: row.status,
      status: availability ? 'refused' : capResolved ? 'passed' : row.status,
      outcomeCategory,
      oracleFailures: oracles,
      independentGeometryAdjudicationRequired:
        (capped && !capResolved) || oracles.includes('check') || oracles.includes('mesh-open'),
      note: capped
        ? capResolved
          ? 'Mesh volume passes the same chord bound with maxFaceVertices=200000; default 50000-vertex budget limited refinement.'
          : 'At 99978 triangles this may be one face at the default 50000-vertex cap; not a proven volume error until higher-cap audit.'
        : availability
          ? 'Typed diagnostic availability refusal; does not establish invalid input geometry.'
          : row.status === 'hang'
            ? '60-second cap includes import, diagnostics, mesh and export; does not establish an unbounded kernel operation.'
            : undefined,
    };
  }
  const count = (items, key) => {
    const out = {};
    for (const item of items) {
      const value = key(item);
      if (value === undefined) continue;
      out[value] = (out[value] ?? 0) + 1;
    }
    return out;
  };
  const groups = new Map();
  const normalize = (text) =>
    String(text)
      .replaceAll(/#\d+/g, '#')
      .replaceAll(/[+-]?\d+(?:\.\d+)?(?:e[+-]?\d+)?/gi, 'N');
  for (const row of all.filter((r) => r.status !== 'passed')) {
    const message = String(
      row.signature || row.error?.message || `${row.stage || row.action}: ${row.status}`,
    ).replaceAll(row.id, 'CASE');
    const signatures = row.issues?.length ? row.issues.map((i) => `${i.oracle}: ${i.message}`) : [normalize(message)];
    for (const signature of new Set(signatures)) {
      if (!groups.has(signature)) groups.set(signature, { signature, count: 0, examples: [] });
      const group = groups.get(signature);
      group.count++;
      if (group.examples.length < 3) group.examples.push(row.id);
    }
  }
  const bodyKey = (r) => `${r.file}:${r.part}:${r.body}`;
  const originalVolumes = new Map(
    executed.filter((r) => r.action === 'check' && Number.isFinite(r.volume)).map((r) => [bodyKey(r), r.volume]),
  );
  const volumeBounds = [];
  let unchangedDrills = 0;
  for (const row of executed) {
    const original = originalVolumes.get(bodyKey(row));
    if (!(original > 0) || !Number.isFinite(row.volume)) continue;
    const relative = (row.volume - original) / original;
    if (row.action === 'drill' && Math.abs(relative) <= 1e-9) unchangedDrills++;
    if (
      (['drill', 'sphere-intersection'].includes(row.action) && relative > 1e-8) ||
      (row.action === 'box-union' && relative < -1e-8)
    )
      volumeBounds.push({ id: row.id, original, result: row.volume, relative });
  }
  for (const violation of volumeBounds) {
    audit[violation.id].outcomeCategory = 'measured-boolean-volume-ordering';
    audit[violation.id].volumeIssues = [{ oracle: 'boolean-volume-ordering', ...violation }];
    audit[violation.id].provenPublicApiInvariantViolation = true;
    audit[violation.id].note =
      'Subtraction/intersection must not increase volume, and union must not reduce it. This proves a Boolean/mass contract violation without deciding which component is wrong.';
  }
  const timing = {};
  for (const action of new Set(executed.map((r) => r.action))) {
    const values = executed
      .filter((r) => r.action === action && Number.isFinite(r.ms))
      .map((r) => r.ms)
      .sort((a, b) => a - b);
    if (!values.length) continue;
    const meanMs = values.reduce((n, ms) => n + ms, 0) / values.length;
    const planned = matrix.filter((c) => c.action === action).length;
    timing[action] = {
      samples: values.length,
      meanMs,
      medianMs: values[Math.floor(values.length / 2)],
      p95Ms: values[Math.min(values.length - 1, Math.ceil(values.length * 0.95) - 1)],
      planned,
      projectedHoursAtThreeWorkers: (planned * meanMs) / 3 / 3_600_000,
    };
  }
  const repeated = [...repeats.values()].filter((items) => items.length > 1);
  const fingerprint = (r) =>
    JSON.stringify({
      status: r.status,
      volume: r.volume,
      mass: r.mass,
      faces: r.faces,
      edges: r.edges,
      vertices: r.vertices,
      stepHash: r.stepHash,
      roundtrip: r.roundtrip,
      mesh: r.mesh,
      error: r.error ? { name: r.error.name, message: r.error.message } : undefined,
      issues: r.issues?.map((i) => ({ oracle: i.oracle, message: i.message })),
    });
  const changedRepeats = repeated
    .filter((items) => items.some((r) => fingerprint(r) !== fingerprint(items[0])))
    .map((items) => items[0].id);
  const summary = {
    files,
    sourceFiles: inventory.length,
    parsedFiles: inventory.filter((r) => r.bodies).length,
    declaredSolidsInParsedFiles: inventory.reduce((n, r) => n + (r.sourceSolidCount || 0), 0),
    importedSolids: inventory.reduce((n, r) => n + (r.importedSolidCount || 0), 0),
    plannedCases: matrix.length,
    executedCases: executed.length,
    pendingCases: matrix.filter((c) => !rows.has(c.id)).length,
    importStatuses: count(inventory, (r) => r.status),
    statuses: count(executed, (r) => r.status),
    byAction: count(executed, (r) => `${r.suite}:${r.action}:${r.status}`),
    byFormat: count(executed, (r) => `${r.format}:${r.status}`),
    byDirection: count(executed, (r) => r.direction),
    byRadiusDivisor: count(executed, (r) => r.radiusDivisor),
    byPosition: count(executed, (r) => r.position),
    byJitterMm: count(executed, (r) => r.amplitudeMm),
    checkedBodies: executed.filter((r) => r.action === 'check').length,
    operationBodies: new Set(executed.filter((r) => r.action !== 'check').map((r) => `${r.file}:${r.part}:${r.body}`))
      .size,
    preOperationRefusals: count(
      executed.filter((r) => r.action !== 'check' && ['import', 'sizing'].includes(r.stage)),
      (r) => `${r.action}:${r.stage}`,
    ),
    operationAttempts: count(
      executed.filter((r) => r.action !== 'check' && !['import', 'sizing'].includes(r.stage)),
      (r) => r.action,
    ),
    filletEdges: new Set(
      executed.filter((r) => r.action === 'fillet').map((r) => `${r.file}:${r.part}:${r.body}:${r.edge}`),
    ).size,
    unchangedDrills,
    volumeBoundViolations: volumeBounds,
    timing,
    auditedStatuses: count(
      executed.map((r) => audit[r.id]),
      (r) => r.status,
    ),
    auditCategories: count(Object.values(audit), (r) => r.outcomeCategory),
    repeatedCaseAudit: {
      ids: repeated.length,
      unchanged: repeated.length - changedRepeats.length,
      changed: changedRepeats,
      includes:
        'status, STEP hash, topology counts, mass, roundtrip and mesh diagnostics; excludes timings, cache path and stack locations',
    },
    failureGroups: [...groups.values()].sort((a, b) => b.count - a.count),
    limitations: [
      'The complete matrix is a generated plan; pending cases have not been tested.',
      'No ABC models were available locally; no ABC slice was downloaded or tested.',
      'Unsupported source versions and omitted source solids have no operation cases.',
      'Bounds, edge and graze placements use source tessellation; these are bounding-box contacts, not a guarantee of material contact.',
      'Each child has a 60-second wall-clock cap including import, operation and diagnostics; a timeout is not proof of nontermination.',
      'The shared diagnostics are Margo topology, mass invariants, model mesh and STEP roundtrip; no external CAD reader runs here.',
      'Timing projections use the measured sample mean including worker startup, cached/original inputs and concurrent suite load; they are estimates, not comparative kernel benchmarks.',
    ],
  };
  writeFileSync(join(outputRoot, 'corpus-audit-map.json'), JSON.stringify(audit, null, 2));
  writeFileSync(join(outputRoot, 'corpus-coverage.json'), JSON.stringify(summary, null, 2));
  console.log(
    JSON.stringify({
      summary: join(outputRoot, 'corpus-coverage.json'),
      executedCases: summary.executedCases,
      pendingCases: summary.pendingCases,
    }),
  );
}

if (process.argv.some((a) => a.startsWith('--case='))) await workerMain(executeCase);
else if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  mkdirSync(outputRoot, { recursive: true });
  if (process.argv.includes('--inventory')) {
    const jobs = corpusFiles(argument('root', defaultCorpus)).map((entry) => ({
      suite: 'E',
      id: `import:${entry.file}`,
      action: 'import',
      ...entry,
    }));
    const result = await runCases(jobs, new URL(import.meta.url), {
      output: inventoryPath,
      workers: 3,
      timeoutMs: 60000,
    });
    console.log(JSON.stringify({ inventory: inventoryPath, files: result.length }));
  } else if (process.argv.includes('--mesh-audit')) {
    const rows = readFileSync(join(outputRoot, 'corpus-centres.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const jobs = rows
      .filter(
        (r) =>
          r.file === 'jubilee/jubilee.STEP' &&
          r.body === 141 &&
          r.action === 'drill' &&
          ['y', 'diagonal'].includes(r.direction) &&
          r.issues?.length === 1 &&
          r.issues[0].oracle === 'mesh-volume',
      )
      .map((r) => ({
        suite: 'audit',
        id: `mesh-audit:${r.id}`,
        action: 'mesh-audit',
        exportFile: r.exportFile,
        expectedVolume: r.volume,
        bound: r.issues[0].expected.bound,
        deflection: r.mesh.deflection,
      }));
    await runCases(jobs, new URL(import.meta.url), {
      output: join(outputRoot, 'mesh-audit-corpus.jsonl'),
      workers: 3,
      timeoutMs: 60000,
    });
  } else {
    let matrix = cases();
    if (process.argv.includes('--generate')) {
      const counts = {};
      for (const c of matrix) counts[c.action] = (counts[c.action] ?? 0) + 1;
      writeFileSync(
        join(outputRoot, 'corpus-matrix.json'),
        JSON.stringify({ count: matrix.length, counts, cases: matrix }, null, 2),
      );
      console.log(JSON.stringify({ count: matrix.length, counts }));
    }
    if (process.argv.includes('--run')) {
      const only = argument('only', '');
      const campaign = argument('campaign', 'all');
      const selectedByCampaign = (c) =>
        campaign === 'all' ||
        (campaign === 'centres' &&
          c.suite === 'E' &&
          c.action === 'drill' &&
          c.position === 'centre' &&
          c.radiusDivisor === 50) ||
        (campaign === 'required' &&
          ((c.suite === 'E' && c.action === 'drill' && c.position === 'centre' && c.radiusDivisor === 50) ||
            ['box-union', 'sphere-intersection'].includes(c.action))) ||
        (campaign === 'operations' && c.action !== 'check');
      const selectedCampaign = campaign === 'stratified' ? stratifiedCases(matrix) : matrix.filter(selectedByCampaign);
      const filtered = selectedCampaign.filter((c) => c.id.includes(only));
      matrix = ['centres', 'required'].includes(campaign) ? bodyFirst(filtered) : fairOrder(filtered);
      const selected = matrix.slice(
        Number(argument('offset', 0)),
        Number(argument('offset', 0)) + Number(argument('limit', matrix.length)),
      );
      const output = resolve(argument('output', join(outputRoot, 'corpus-results.jsonl')));
      await runCases(selected, new URL(import.meta.url), {
        output,
        workers: Math.min(3, Number(argument('workers', 3))),
        timeoutMs: 60000,
      });
    }
    if (process.argv.includes('--summarize')) summarize(cases());
  }
}
