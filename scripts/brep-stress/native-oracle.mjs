import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { failure, isMain, outputRoot, root, runCases, workerMain } from './common.mjs';
export function executeCase(c) {
  const python = process.env.BREP_STRESS_PYTHON || path.join(root, 'test-results/brep-occt-env/Scripts/python.exe');
  const r = spawnSync(
    python,
    [path.join(root, 'scripts/brep-stress/native-oracle.py'), path.join(root, c.exportFile)],
    { encoding: 'utf8', windowsHide: true, timeout: 55000, maxBuffer: 1000000 },
  );
  if (r.error) return { ...c, ...failure(r.error), status: r.error.code === 'ETIMEDOUT' ? 'hang' : 'crash' };
  try {
    const result = JSON.parse(r.stdout.trim().split('\n').at(-1));
    return { ...c, ...result, status: result.read && result.valid ? 'passed' : 'invalid', stderr: r.stderr };
  } catch (error) {
    return { ...c, ...failure(error), stdout: r.stdout, stderr: r.stderr };
  }
}
if (isMain(import.meta.url) && !workerMain(executeCase)) {
  const folder = path.join(outputRoot, 'exports');
  const cases = existsSync(folder)
    ? readdirSync(folder)
        .filter((f) => f.endsWith('.step'))
        .map((f) => ({ suite: 'OCCT', id: f.slice(0, -5), exportFile: path.relative(root, path.join(folder, f)) }))
    : [];
  const limit = process.argv.find((a) => a.startsWith('--limit='));
  const workers = Number(process.argv.find((a) => a.startsWith('--workers='))?.slice(10) ?? 3);
  await runCases(limit ? cases.slice(0, Number(limit.slice(8))) : cases, import.meta.url, {
    output: path.join(outputRoot, 'native.jsonl'),
    workers: Math.min(3, workers),
  });
}
