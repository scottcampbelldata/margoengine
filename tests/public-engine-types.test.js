// The public engine type as a user's strict project sees it, against the built packages.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { README_OPTIONS } from '../scripts/support/readme-types.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));

/** The compiler's errors for `code`, in a project under the repository so packages resolve as for a consumer. */
function errors(name, code) {
  const folder = join(root, 'test-results', `public-engine-types-${name}-${process.pid}`);
  mkdirSync(folder, { recursive: true });
  try {
    writeFileSync(join(folder, 'program.ts'), code);
    writeFileSync(
      join(folder, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: README_OPTIONS, include: ['program.ts'] }),
    );
    const run = spawnSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '-p', folder, '--pretty', 'false'], {
      encoding: 'utf8',
      timeout: 120_000,
    });
    return run.stdout;
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

test('regression: EngineKernel declares the members the running engine has', () => {
  assert.equal(
    errors(
      'kernel',
      `import type { EngineKernel } from '@margoengine/core';
declare const engine: EngineKernel;
export const device: GPUDevice | null = engine.gpu;
export const formats = engine.renderTarget?.format;
export const sun: Float32Array = engine.lighting.direction;
`,
    ),
    '',
  );
});
