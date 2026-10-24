import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseSTEP } from '@margoengine/brep';
import {
  failure,
  inspectBody,
  isMain,
  model,
  outputRoot,
  root,
  runCases,
  summarizeBody,
  workerMain,
} from './common.mjs';

const mm = 0.001;
const axis = { origin: [0, 0, 0], direction: [0, 0, 1] };
const corpusRoot = process.env.BREP_CORPUS || path.join(root, 'test-results/cad-corpus');
const point = (q, plane = 'xy') => (plane === 'xy' ? [q[0] * mm, q[1] * mm, 0] : [q[0] * mm, 0, q[1] * mm]);
const line = (q, plane = 'xy') => ({ kind: 'line', to: point(q, plane) });
const profile = (name, points, plane = 'xy') => ({
  name,
  normal: plane === 'xy' ? [0, 0, 1] : [0, -1, 0],
  start: point(points[0], plane),
  segments: points.slice(1).map((q) => line(q, plane)),
});
const arcProfile = (name, start, segments, plane = 'xy') => ({
  name,
  normal: plane === 'xy' ? [0, 0, 1] : [0, -1, 0],
  start: point(start, plane),
  segments: segments.map((s) => ({
    ...s,
    to: point(s.to, plane),
    ...(s.center ? { center: point(s.center, plane) } : {}),
  })),
});
const at = (x, y, z) => model.frameOf([x * mm, y * mm, z * mm], [0, 0, 1], [1, 0, 0]);

function source(id) {
  if (id === 'box') return model.box('box', [10 * mm, 12 * mm, 15 * mm]);
  if (id === 'cylinder') return model.cylinder('can', 5 * mm, 10 * mm);
  if (id === 'sphere') return model.sphere('sphere', 5 * mm);
  if (id === 'torus') return model.torus('torus', 8 * mm, 2 * mm);
  if (id === 'frustum')
    return model.revolve(
      'frustum',
      profile(
        'frustum-p',
        [
          [2, 0],
          [5, 0],
          [3, 8],
          [2, 8],
          [2, 0],
        ],
        'xz',
      ),
      axis,
    );
  if (id === 'L-union')
    return model.boolean(
      'L',
      'union',
      model.box('low', [20 * mm, 10 * mm, 5 * mm]),
      model.box('high', [10 * mm, 10 * mm, 15 * mm]),
    );
  if (id === 'drilled')
    return model.boolean(
      'drilled',
      'subtract',
      model.box('plate', [20 * mm, 20 * mm, 10 * mm]),
      model.cylinder('drill', 3 * mm, 20 * mm, at(10, 10, -5)),
    );
  if (id === 'boss')
    return model.boolean(
      'boss',
      'union',
      model.box('plate', [20 * mm, 20 * mm, 10 * mm]),
      model.cylinder('boss-can', 3 * mm, 5 * mm, at(10, 10, 10)),
    );
  if (id.startsWith('imported-')) {
    const original = source(id.slice('imported-'.length));
    return model.bodiesFromSTEP(parseSTEP(model.bodiesToSTEP([original]))).bodies[0];
  }
  if (id === 'nist-tube')
    return model.bodiesFromSTEP(parseSTEP(readFileSync(`${corpusRoot}/nist/nist_ftc_11_asme1_rb.stp`, 'utf8')))
      .bodies[0];
  throw new Error(`unknown source ${id}`);
}

function maxBlend(edge, sourceId) {
  if (sourceId === 'box' || sourceId === 'imported-box') {
    const direction = edge.start.point.map((v, i) => Math.abs(v - edge.end.point[i]));
    const d = direction.indexOf(Math.max(...direction));
    return Math.min(...[10, 12, 15].filter((_, i) => i !== d)) * mm;
  }
  if (sourceId === 'cylinder' || sourceId === 'imported-cylinder') return 5 * mm;
  return undefined;
}

function blendRadii(limit, reduced) {
  if (limit)
    return [
      ...new Set([
        1e-7,
        1e-6,
        1e-5,
        1e-4,
        1e-3,
        ...[0.25, 0.5, 0.9, 0.99, 0.9999, 1, 1.0001, 1.01, 1.1, 2].map((f) => f * limit),
      ]),
    ].sort((a, b) => a - b);
  return reduced ? [1e-7, 1e-5, 1e-3, 3e-3, 1e-2, 3e-2] : [1e-7, 1e-6, 1e-5, 1e-4, 1e-3, 3e-3, 1e-2, 3e-2];
}

function profileCases() {
  const out = [];
  const add = (id, op, p, options = {}) => out.push({ suite: 'F', id, op, profile: p, ...options });
  for (const epsilon of [1e-7, 1e-6, 1e-5, 1e-4, 1e-3, 0.01, 0.1]) {
    add(
      `extrude-microsegment-${epsilon}mm`,
      'extrude',
      profile('micro', [
        [0, 0],
        [epsilon, 0],
        [10, 0],
        [10, 10],
        [0, 10],
        [0, 0],
      ]),
      { volume: 500 * mm ** 3 },
    );
    add(
      `revolve-microsegment-${epsilon}mm`,
      'revolve',
      profile(
        'micro-r',
        [
          [2, 0],
          [5, 0],
          [5, epsilon],
          [5, 5],
          [2, 5],
          [2, 0],
        ],
        'xz',
      ),
      { volume: Math.PI * 21 * 5 * mm ** 3 },
    );
  }
  for (const delta of [-0.001, -1e-5, -1e-7, 0, 1e-7, 1e-5, 0.001]) {
    add(
      `extrude-collinear-${delta}mm`,
      'extrude',
      profile('collinear', [
        [0, 0],
        [5, delta],
        [10, 0],
        [10, 10],
        [0, 10],
        [0, 0],
      ]),
      { volume: (100 - 5 * delta) * 5 * mm ** 3 },
    );
    add(
      `revolve-collinear-${delta}mm`,
      'revolve',
      profile(
        'collinear-r',
        [
          [2, 0],
          [5, 0],
          [5 + delta, 2.5],
          [5, 5],
          [2, 5],
          [2, 0],
        ],
        'xz',
      ),
      { volume: Math.PI * (105 + 25 * delta + (5 / 3) * delta ** 2) * mm ** 3 },
    );
  }
  for (const radius of [1e-4, 0.001, 0.01, 0.1, 1]) {
    const p = arcProfile(
      'slot',
      [0, -radius],
      [
        { kind: 'line', to: [10, -radius] },
        { kind: 'arc', to: [10, radius], center: [10, 0] },
        { kind: 'line', to: [0, radius] },
        { kind: 'arc', to: [0, -radius], center: [0, 0] },
      ],
    );
    add(`extrude-tangent-slot-${radius}mm`, 'extrude', p, {
      volume: (20 * radius + Math.PI * radius ** 2) * 5 * mm ** 3,
    });
    add(`extrude-oblique-arcs-${radius}mm`, 'extrude', p, { vector: [1 * mm, 0, 5 * mm], expectedRefusal: true });
  }
  for (const gap of [0, 1e-7, 1e-6, 1e-5, 1e-4, 0.001, 0.01, 0.1, 1]) {
    add(
      `revolve-near-axis-${gap}mm`,
      'revolve',
      profile(
        'axis-gap',
        [
          [gap, 0],
          [5, 0],
          [5, 5],
          [gap, 5],
          [gap, 0],
        ],
        'xz',
      ),
      { volume: Math.PI * (25 - gap ** 2) * 5 * mm ** 3, expectedRefusal: gap <= 1e-6 },
    );
  }
  for (const radius of [1e-4, 0.001, 0.01, 0.1, 1, 4.9, 4.9999, 5, 5.0001]) {
    add(
      `revolve-arc-torus-${radius}mm`,
      'revolve',
      arcProfile(
        'arc-torus',
        [5 + radius, 0],
        [
          { kind: 'arc', to: [5 - radius, 0], center: [5, 0] },
          { kind: 'arc', to: [5 + radius, 0], center: [5, 0] },
        ],
        'xz',
      ),
      { volume: 2 * Math.PI ** 2 * 5 * radius ** 2 * mm ** 3, expectedRefusal: radius >= 5 },
    );
  }
  for (const delta of [-1e-5, 0, 1e-5]) {
    add(
      `extrude-arc-line-tangency-${delta}mm`,
      'extrude',
      arcProfile(
        'arc-line',
        [-5, -1],
        [
          { kind: 'line', to: [5, -1] },
          { kind: 'arc', to: [6, 0], center: [5, 0] },
          { kind: 'line', to: [6 + delta, 5] },
          { kind: 'line', to: [-5, 5] },
          { kind: 'line', to: [-5, -1] },
        ],
      ),
      { volume: (65 + Math.PI / 4 + 2.5 * delta) * 5 * mm ** 3 },
    );
  }
  add(
    'revolve-spherical-zone-arc',
    'revolve',
    arcProfile(
      'sphere-zone',
      [2, -3],
      [
        { kind: 'line', to: [4, -3] },
        { kind: 'arc', to: [4, 3], center: [0, 0] },
        { kind: 'line', to: [2, 3] },
        { kind: 'line', to: [2, -3] },
      ],
      'xz',
    ),
    { volume: 108 * Math.PI * mm ** 3 },
  );
  add(
    'extrude-self-crossing',
    'extrude',
    profile('bowtie', [
      [0, 0],
      [10, 10],
      [0, 10],
      [10, 0],
      [0, 0],
    ]),
    { expectedRefusal: true },
  );
  add(
    'revolve-self-crossing',
    'revolve',
    profile(
      'bowtie-r',
      [
        [2, 0],
        [10, 10],
        [2, 10],
        [10, 0],
        [2, 0],
      ],
      'xz',
    ),
    { expectedRefusal: true },
  );
  add(
    'extrude-hairpin',
    'extrude',
    profile('hairpin', [
      [0, 0],
      [10, 0],
      [5, 0],
      [10, 10],
      [0, 10],
      [0, 0],
    ]),
    { expectedRefusal: true },
  );
  return out;
}

export function cases() {
  const out = [];
  for (const sourceId of [
    'box',
    'cylinder',
    'frustum',
    'sphere',
    'torus',
    'L-union',
    'drilled',
    'boss',
    'imported-box',
    'imported-cylinder',
    'nist-tube',
  ]) {
    const body = source(sourceId);
    if (!body.edges.length) out.push({ suite: 'C', id: `${sourceId}-no-edges`, source: sourceId, noEdges: true });
    else out.push({ suite: 'C', id: `${sourceId}-input`, source: sourceId, inputOnly: true });
    for (const [index, edge] of body.edges.entries()) {
      const limit = maxBlend(edge, sourceId);
      for (const op of ['fillet', 'chamfer'])
        for (const radius of blendRadii(limit, sourceId !== 'box')) {
          out.push({
            suite: 'C',
            id: `${sourceId}-${index}-${op}-${radius.toExponential(5)}`,
            source: sourceId,
            edge: index,
            edgeName: edge.name,
            edgeKind: edge.curve.kind,
            op,
            radius,
            limit,
            expectedRefusal: Boolean(limit && radius > limit),
          });
        }
    }
  }
  for (const op of ['fillet', 'chamfer'])
    for (const radius of [1e-7, 1e-6, 1e-5, 1e-4, 1e-3, 4e-3, 4.9e-3, 4.999e-3, 5e-3, 5.001e-3, 6e-3]) {
      out.push({
        suite: 'C',
        id: `box-all-${op}-${radius.toExponential(5)}`,
        source: 'box',
        allEdges: true,
        op,
        radius,
        limit: 5e-3,
        expectedRefusal: radius > 5e-3,
      });
    }
  return [...out, ...profileCases()];
}

function exactBoxVolume(c, edge) {
  if (c.source !== 'box' || c.allEdges || !edge || c.radius >= c.limit) return undefined;
  const length = Math.hypot(...edge.start.point.map((v, i) => v - edge.end.point[i]));
  const area = c.op === 'fillet' ? 1 - Math.PI / 4 : 0.5;
  return 10 * 12 * 15 * mm ** 3 - area * c.radius ** 2 * length;
}

export async function executeCase(c) {
  try {
    let body;
    let input;
    let expectedVolume = c.volume;
    if (c.suite === 'C') {
      input = source(c.source);
      if (c.noEdges || c.inputOnly)
        return { ...c, ...(await inspectBody(input)), ...(c.noEdges ? { primitiveHasNoEdges: true } : {}) };
      const edge = input.edges[c.edge];
      expectedVolume = exactBoxVolume(c, edge);
      const names = c.allEdges ? input.edges.map((e) => e.name) : [edge.name];
      body = model[c.op](`stress-${c.op}`, input, names, c.radius);
    } else {
      body =
        c.op === 'extrude'
          ? model.extrude('stress-extrude', c.profile, c.vector ?? [0, 0, 5 * mm])
          : model.revolve('stress-revolve', c.profile, axis);
    }
    const inspection = await inspectBody(body, { expectedVolume, label: c.id });
    const result = { ...c, ...inspection };
    if (input) result.input = summarizeBody(input);
    if (c.expectedRefusal && result.status === 'passed') {
      result.status = 'wrong';
      result.issues = [
        ...(result.issues ?? []),
        {
          check: 'past-limit',
          message: 'operation accepted a radius beyond the original faces or a profile requiring refusal',
        },
      ];
    }
    return result;
  } catch (error) {
    return { ...c, ...failure(error) };
  }
}

if (!workerMain(executeCase) && isMain(import.meta.url)) {
  const selected = cases().filter((c) => !process.env.BREP_STRESS_SUITE || c.suite === process.env.BREP_STRESS_SUITE);
  await runCases(selected, new URL(import.meta.url), {
    output: `${outputRoot}/blends-profiles.jsonl`,
    workers: 3,
    timeoutMs: 60000,
  });
}
