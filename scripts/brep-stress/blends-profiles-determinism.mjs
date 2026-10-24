import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { isMain, outputRoot } from './common.mjs';

const read = (filename) => readFileSync(filename, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
const canonical = (value) => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .filter((key) => key !== 'stack')
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  }
  return value;
};
const hash = (value) =>
  createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
const error = (e) => e && { name: e.name, message: e.message };

function resultFingerprint(row) {
  if (row.mass) {
    return hash({
      faces: row.faces,
      edges: row.edges,
      vertices: row.vertices,
      shells: row.shells,
      mass: row.mass,
      stepHash: row.stepHash,
      mesh: row.mesh,
      roundtrip: row.roundtrip,
      input: row.input,
    });
  }
  return hash({ status: row.status, error: error(row.error), signature: row.signature });
}

export function compare(first, second) {
  const byId = new Map(second.map((row) => [row.id, row]));
  const missing = [],
    changedResults = [],
    changedOracles = [],
    changedClassifications = [];
  for (const before of first) {
    const after = byId.get(before.id);
    if (!after) {
      missing.push(before.id);
      continue;
    }
    byId.delete(before.id);
    const a = resultFingerprint(before),
      b = resultFingerprint(after);
    if (a !== b) changedResults.push({ id: before.id, before: a, after: b });
    if (before.status !== after.status)
      changedClassifications.push({ id: before.id, before: before.status, after: after.status });
    const oracle = (row) => ({
      issues: row.issues,
      coverage: row.coverage,
      error: row.oracleError && {
        stage: row.oracleError.stage,
        status: row.oracleError.status,
        error: error(row.oracleError.error),
      },
    });
    if (hash(oracle(before)) !== hash(oracle(after))) changedOracles.push(before.id);
  }
  return {
    firstCases: first.length,
    secondCases: second.length,
    missing,
    extra: [...byId.keys()],
    resultFingerprintsEqual: changedResults.length === 0 && missing.length === 0 && byId.size === 0,
    changedResults,
    changedClassifications,
    changedOracles,
    fingerprintFields: [
      'mass',
      'faces',
      'edges',
      'vertices',
      'shells',
      'stepHash',
      'mesh',
      'roundtrip',
      'input',
      'error.name',
      'error.message',
    ],
    ignoredFields: ['ms', 'exitCode', 'stack', 'stderr', 'classification/coverage changes reported separately'],
    note: 'STEP export timestamps are blank. Empty results changed only classification/coverage after the harness learned to skip an inapplicable empty-boundary export.',
  };
}

if (isMain(import.meta.url)) {
  const result = compare(
    read(`${outputRoot}/blends-profiles.jsonl`),
    read(`${outputRoot}/blends-profiles-repeat.jsonl`),
  );
  writeFileSync(`${outputRoot}/blends-profiles-determinism.json`, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result));
  if (!result.resultFingerprintsEqual) process.exitCode = 1;
}
