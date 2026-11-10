import { readFileSync, writeFileSync } from 'node:fs';
const cases = JSON.parse(readFileSync(process.argv[2] ?? 'test-results/batch-274/oracle-cases.json', 'utf8'));
const oracle = JSON.parse(readFileSync(process.argv[3] ?? 'test-results/batch-274/oracle-results.json', 'utf8'));
const output = {
  provenance: {
    generator: 'packages/compute/scripts/onnx-oracle-cases.mjs',
    runner: 'packages/compute/scripts/onnx-oracle.py',
    onnx: oracle.onnx,
    onnxruntime: oracle.onnxruntime,
    numpy: oracle.numpy,
    executionProvider: 'CPUExecutionProvider',
    optimization: 'ORT_DISABLE_ALL',
    source:
      'Original Margo analytic inputs serialized through the normative ONNX schema. Unmodified external ONNX Runtime computes reference output only. No external implementation source or runtime ships with Margo.',
  },
  cases: [],
  unavailable: [],
};
for (const c of cases) {
  const ref = oracle.results.find((r) => r.id === c.id);
  if (!ref) throw new Error(`Missing oracle result: ${c.id}`);
  if (ref.error) {
    if (!['Det-0', 'Binarizer-0'].includes(c.id) || !ref.error.includes('NOT_IMPLEMENTED'))
      throw new Error(`${c.id}: ${ref.error}`);
    output.unavailable.push({
      id: c.id,
      reason: ref.error,
      proof: 'Analytic regression in tests/onnx-operators.test.js',
    });
  } else output.cases.push({ ...c, expected: ref.expected });
}
writeFileSync(
  process.argv[4] ?? 'packages/compute/tests/fixtures/onnx/operators-reference.json',
  `${JSON.stringify(output, null, 2)}\n`,
);
console.log({ references: output.cases.length, oracleUnavailable: output.unavailable.length });
