// A material plugin's live uniforms as a user's strict project sees them, against the built packages.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { README_OPTIONS } from '../scripts/support/readme-types.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));

/** The compiler's errors for `code`, in a project under the repository so packages resolve as for a consumer. */
function errors(code) {
  const folder = join(root, 'test-results', `material-plugin-types-${process.pid}`);
  mkdirSync(folder, { recursive: true });
  try {
    writeFileSync(join(folder, 'program.ts'), code);
    writeFileSync(
      join(folder, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: README_OPTIONS, include: ['program.ts'] }),
    );
    return spawnSync(
      process.execPath,
      [join(root, 'node_modules/typescript/bin/tsc'), '-p', folder, '--pretty', 'false'],
      { encoding: 'utf8', timeout: 120_000 },
    ).stdout;
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

test('regression: a plugin uniform keeps the kind it was declared with', () => {
  assert.equal(
    errors(`import type { MaterialFeature } from '@margoengine/materials';
import { materialPlugin, type MaterialPlugin } from '@margoengine/materials/plugins';
const ripple = materialPlugin({ name: 'ripple', uniforms: { time: 0, tint: [0.2, 0.5, 1] }, output: 'color = color;' });
ripple.uniforms.time += 0.016;
ripple.uniforms.tint[0] = 1;
export const features: MaterialFeature[] = [ripple];
export const any: MaterialPlugin = ripple;
export const loose = materialPlugin({ name: 'plain', output: 'color = color;' });
// @ts-expect-error a uniform that was never declared
ripple.uniforms.speed = 1;
// @ts-expect-error an array uniform is not a number
export const wrong: number = ripple.uniforms.tint;
`),
    '',
  );
});
