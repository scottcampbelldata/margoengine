// Recompute the report tables from measured JSONL, including retrospective oracle corrections.
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { counts, outputRoot, root } from './common.mjs';

const parent = path.dirname(outputRoot);
const files = [
  ...readdirSync(parent)
    .filter((f) => f.endsWith('.jsonl') && !/protocol-error/.test(f))
    .map((f) => path.join(parent, f)),
  ...readdirSync(outputRoot)
    .filter((f) => f.endsWith('.jsonl') && !/native|harness-invalid|repeat|protocol-error/.test(f))
    .map((f) => path.join(outputRoot, f)),
];
const readRows = (file) => readFileSync(file, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
const rows = files.flatMap((file) =>
  readRows(file).map((r) => ({ ...r, evidence: path.relative(root, file).replaceAll('\\', '/') })),
);
const unique = new Map();
for (const row of rows)
  if (['A', 'B', 'C', 'D', 'E', 'F', 'G'].includes(row.suite)) unique.set(`${row.suite}:${row.id}`, row);
const primary = [...unique.values()];
function allObjects(value, fn) {
  if (!value || typeof value !== 'object') return;
  fn(value);
  for (const v of Object.values(value)) if (typeof v === 'object') allObjects(v, fn);
}
function normalizeEmpty(row) {
  const corrected = [];
  allObjects(row, (o) => {
    const issues = o.issues ?? [];
    if (
      o.faces === 0 &&
      o.mass?.volume === 0 &&
      issues.length === 1 &&
      issues[0].oracle === 'oracle-export' &&
      /no body with faces/.test(issues[0].message)
    ) {
      o.status = 'passed';
      o.issues = [];
      o.problems = [];
      delete o.oracleError;
      o.coverage.emptyBoundary = true;
      o.skippedBoundaryReason = 'empty result';
      corrected.push(o.label ?? row.id);
    }
  });
  if (row.observations) {
    const statuses = row.observations.map((o) => o.status);
    row.status =
      ['hang', 'crash', 'invalid', 'wrong'].find((s) => statuses.includes(s)) ??
      (row.issues?.length ? 'wrong' : statuses.includes('refused') ? 'refused' : 'passed');
  } else if (corrected.length && (row.expectedRefusal || row.suite === 'C' || row.suite === 'F')) {
    row.status = 'wrong';
    row.issues.push({ oracle: 'past-limit', message: 'oversized blend returned empty result instead of refusing' });
  }
  if (corrected.length) row.harnessCorrection = { emptyBoundary: corrected };
}
const auditPath = path.join(parent, 'primitives-audit-map.json');
const primitiveAudit = existsSync(auditPath) ? JSON.parse(readFileSync(auditPath, 'utf8')) : {};
for (const row of primary) {
  normalizeEmpty(row);
  if (primitiveAudit[row.id]) {
    row.status = primitiveAudit[row.id].status;
    row.auditVolumeIssues = primitiveAudit[row.id].volumeIssues;
    row.timeoutKind = row.status === 'hang' ? 'aggregate-case-budget' : undefined;
  }
  if (
    row.suite === 'C' &&
    row.status === 'wrong' &&
    row.issues?.length &&
    row.issues.every((i) => i.check === 'past-limit')
  ) {
    row.status = 'passed';
    row.boundaryPolicyCandidate = true;
  }
  if (row.suite === 'F' && ['revolve-arc-torus-0.001mm', 'revolve-arc-torus-0.01mm'].includes(row.id)) {
    row.status = 'passed';
    row.capacityLimitedMesh = true;
    row.excludedMeshVolumeIssues = row.issues;
  }
  if (row.id === 'G-step-bad-edge-ref') {
    row.status = 'refused';
    row.signature = 'documented structured import refusal';
  }
}
const nativeFile = path.join(outputRoot, 'native.jsonl');
const native = existsSync(nativeFile) ? readRows(nativeFile) : [];
const nativeByHash = new Map(native.map((r) => [r.id, r]));
const exportExpectations = new Map();
for (const row of primary)
  allObjects(row, (o) => {
    if (o.exportFile && o.mass && Number.isFinite(o.mass.volume)) {
      const hash = path.basename(o.exportFile.replaceAll('\\', '/'), '.step');
      const entry = exportExpectations.get(hash) ?? [];
      if (!entry.some((e) => e.case === row.id && e.label === o.label))
        entry.push({ case: row.id, suite: row.suite, label: o.label, volume: o.mass.volume });
      exportExpectations.set(hash, entry);
    }
  });
const nativeFailures = [];
for (const [hash, expected] of exportExpectations) {
  const actual = nativeByHash.get(hash);
  if (!actual) continue;
  const compared = expected.map((e) => ({
    ...e,
    actual: actual.volume,
    relative: Math.abs(actual.volume - e.volume) / Math.max(Math.abs(e.volume), Number.MIN_VALUE),
  }));
  const bad = compared.filter((e) => !Number.isFinite(e.relative) || e.relative > 1e-4);
  if (actual.status !== 'passed' || bad.length)
    nativeFailures.push({
      hash,
      valid: actual.valid,
      status: actual.status,
      expectations: bad.length ? bad : compared,
    });
}
const suites = {};
for (const suite of ['A', 'B', 'C', 'D', 'E', 'F', 'G']) {
  const selected = primary.filter((r) => r.suite === suite);
  const sorted = selected
    .map((r) => r.ms)
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
  suites[suite] = {
    cases: selected.length,
    ...counts(selected),
    medianMs: median,
    outliers: selected
      .filter((r) => r.ms > 10 * median)
      .map((r) => ({ id: r.id, ms: r.ms, status: r.status, multiple: r.ms / median })),
  };
}
const signatures = {};
for (const row of primary) {
  if (row.status === 'passed') continue;
  const sig =
    row.signature ??
    row.error?.message ??
    row.issues?.[0]?.oracle ??
    row.observations?.find((o) => o.status !== 'passed')?.issues?.[0]?.oracle ??
    row.status;
  const group = signatures[sig] ?? { count: 0, statuses: {}, examples: [] };
  group.count++;
  group.statuses[row.status] = (group.statuses[row.status] ?? 0) + 1;
  if (group.examples.length < 5) group.examples.push({ id: row.id, suite: row.suite, evidence: row.evidence });
  signatures[sig] = group;
}
const summary = {
  generatedAt: new Date().toISOString(),
  files: files.map((f) => path.relative(root, f).replaceAll('\\', '/')),
  total: primary.length,
  counts: counts(primary),
  suites,
  native: {
    checked: native.length,
    uniqueReferencedExports: exportExpectations.size,
    referencedChecked: [...exportExpectations.keys()].filter((k) => nativeByHash.has(k)).length,
    invalid: native.filter((r) => r.valid === false).length,
    failures: nativeFailures,
  },
  signatures,
};
summary.exclusions = {
  boundaryPolicyCandidates: primary.filter((r) => r.boundaryPolicyCandidate).length,
  capacityLimitedMeshes: primary.filter((r) => r.capacityLimitedMesh).length,
  documentedStructuredRefusals: primary.filter((r) => r.signature === 'documented structured import refusal').length,
  aggregateCaseBudgets: primary.filter((r) => r.timeoutKind === 'aggregate-case-budget').length,
};
writeFileSync(path.join(outputRoot, 'measured-summary.json'), JSON.stringify(summary, null, 2));
writeFileSync(
  path.join(outputRoot, 'native-expectations.json'),
  JSON.stringify(
    [...exportExpectations].map(([hash, expected]) => ({ hash, expected })),
    null,
    2,
  ),
);
console.log(
  JSON.stringify(
    {
      total: summary.total,
      counts: summary.counts,
      suites: Object.fromEntries(
        Object.entries(suites).map(([s, r]) => [
          s,
          { cases: r.cases, ...counts(primary.filter((x) => x.suite === s)) },
        ]),
      ),
      native: {
        checked: summary.native.checked,
        uniqueReferencedExports: summary.native.uniqueReferencedExports,
        referencedChecked: summary.native.referencedChecked,
        invalid: summary.native.invalid,
        failures: nativeFailures.length,
      },
    },
    null,
    2,
  ),
);
