import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// OccludedScatter took only three ring meshes, so the one-mesh form every other Scatter accepts did not type-check.
test('OccludedScatter takes one geometry or three rings, as Scatter does', { timeout: 30000 }, () => {
  const results = fileURLToPath(new URL('../../../test-results/', import.meta.url));
  mkdirSync(results, { recursive: true });
  const folder = mkdtempSync(join(results, 'scatter-occlusion-types-'));
  const path = (url) => JSON.stringify(fileURLToPath(new URL(url, import.meta.url)).replaceAll('\\', '/'));
  const source = `
    import type { EngineKernel, Geometry } from '@margoengine/core';
    import { OccludedScatter } from ${path('../dist/occlusion.js')};
    declare const engine: EngineKernel, bush: Geometry;
    const one: OccludedScatter = OccludedScatter.attach(engine, bush, { count: 10 });
    const rings: OccludedScatter = new OccludedScatter([bush, bush, bush]);
    // @ts-expect-error two meshes are neither form
    new OccludedScatter([bush, bush]);
    void [one, rings];
  `;
  try {
    const file = join(folder, 'consumer.mts');
    writeFileSync(file, source);
    writeFileSync(
      join(folder, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          noEmit: true,
          strict: true,
          skipLibCheck: true,
          target: 'ESNext',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          types: [],
          lib: ['ESNext', 'DOM'],
        },
        files: [file],
      }),
    );
    const compiler = fileURLToPath(new URL('./bin/tsc', import.meta.resolve('typescript/package.json')));
    const result = spawnSync(process.execPath, [compiler, '-p', join(folder, 'tsconfig.json')], {
      encoding: 'utf8',
      timeout: 25000,
      windowsHide: true,
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
