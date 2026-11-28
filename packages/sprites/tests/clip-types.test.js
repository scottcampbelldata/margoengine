import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { Skeleton2D, poseSkeleton } from '../dist/skeletal.js';

// A clip kept in a variable widens its literals to number[][]; keys accepted that, Bezier curves did not.
test('a clip held in a variable, with Bezier curves, type-checks as a SkeletonClip', { timeout: 30000 }, () => {
  const results = fileURLToPath(new URL('../../../test-results/', import.meta.url));
  mkdirSync(results, { recursive: true });
  const folder = mkdtempSync(join(results, 'sprites-clip-types-'));
  const skeletal = fileURLToPath(new URL('../dist/skeletal.js', import.meta.url)).replaceAll('\\', '/');
  const source = `
    import { Skeleton2D, poseSkeleton, type SkeletonClip } from ${JSON.stringify(skeletal)};
    const skeleton = new Skeleton2D([{ name: 'head' }]);
    const clip = {
      duration: 1,
      bones: { head: { y: [[0, -8], [1, -6]] } },
      curves: { head: { y: [[0.42, 0, 0.58, 1]] } },
    };
    poseSkeleton(skeleton, clip, 0.5);
    const mixed: SkeletonClip = { duration: 1, bones: { head: { x: [[0, 0], [0.5, 1], [1, 0]] } }, curves: { head: { x: ['stepped', [0, 0, 1, 1]] } } };
    poseSkeleton(skeleton, mixed, 0.25);
    // @ts-expect-error a curve is numbers or 'linear' or 'stepped'
    const wrong: SkeletonClip = { duration: 1, bones: {}, curves: { head: { x: ['ease'] } } };
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
        },
        files: [file],
      }),
    );
    const compiler = fileURLToPath(new URL('./bin/tsc', import.meta.resolve('typescript/package.json')));
    const result = spawnSync(process.execPath, [compiler, '-p', join(folder, 'tsconfig.json')], {
      encoding: 'utf8',
      timeout: 20000,
      windowsHide: true,
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('a curve of the wrong length is still refused when posed', () => {
  const skeleton = new Skeleton2D([{ name: 'head' }]);
  const clip = {
    duration: 1,
    bones: {
      head: {
        y: [
          [0, 0],
          [1, 1],
        ],
      },
    },
    curves: { head: { y: [[0.4, 0, 0.6]] } },
  };
  assert.throws(() => poseSkeleton(skeleton, clip, 0.5), RangeError);
  clip.curves.head.y = [[0.42, 0, 0.58, 1]];
  poseSkeleton(skeleton, clip, 0.5);
  assert.ok(Math.abs(skeleton.bone('head').y - 0.5) < 1e-9); // a symmetric ease is halfway at half time
});
