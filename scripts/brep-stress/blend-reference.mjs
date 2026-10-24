import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { failure, inspectBody, isMain, model, outputRoot, root, runCases, workerMain } from './common.mjs';

export function cases() {
  const radii = [0.0001, 0.001, 0.01, 0.1, 1, 2.5, 5, 9, 9.9, 9.999, 10, 10.001, 10.1, 11, 20, 100];
  return ['fillet', 'chamfer'].flatMap((op) =>
    radii.map((radiusMm) => ({ suite: 'C-reference', id: `box-edge0-${op}-${radiusMm}mm`, op, radiusMm })),
  );
}

export function executeCase(c) {
  const python = process.env.BREP_STRESS_PYTHON || path.join(root, 'test-results/brep-occt-env/Scripts/python.exe');
  const native = spawnSync(python, [path.join(root, 'scripts/brep-stress/blend-reference.py'), c.op, `${c.radiusMm}`], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 55000,
    maxBuffer: 1000000,
  });
  if (native.error) return { ...c, ...failure(native.error) };
  let reference;
  try {
    reference = JSON.parse(native.stdout.trim().split('\n').at(-1));
  } catch (error) {
    return { ...c, ...failure(error), stdout: native.stdout, stderr: native.stderr };
  }
  let margo;
  try {
    const source = model.box('box', [0.01, 0.012, 0.015]);
    const edge = source.edges[0];
    const body = model[c.op](`stress-${c.op}`, source, [edge.name], c.radiusMm / 1000);
    margo = {
      ...inspectBody(body, { label: c.id }),
      endpointsMm: [edge.start, edge.end].map((v) => v.point.map((n) => n * 1000)),
    };
  } catch (error) {
    margo = failure(error);
  }
  const protocolError =
    reference.error && ['AttributeError', 'TypeError', 'ImportError', 'ValueError'].includes(reference.error.name);
  return { ...c, status: protocolError ? 'crash' : 'passed', reference, margo };
}

if (!workerMain(executeCase) && isMain(import.meta.url)) {
  await runCases(cases(), import.meta.url, {
    output: `${outputRoot}/blend-reference.jsonl`,
    workers: 1,
    timeoutMs: 60000,
  });
}
