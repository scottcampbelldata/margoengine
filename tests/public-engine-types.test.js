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

test('regression: importing scene leaves plugins fitting engine.use, and public meshes and atomics type-check', () => {
  assert.equal(
    errors(
      'packages',
      `import '@margoengine/scene';
import type { EngineKernel, Mesh } from '@margoengine/core';
import { CulledModels } from '@margoengine/culling/models';
import { storage } from '@margoengine/shader';
import { webglPicking } from '@margoengine/webgl2-compat/pick';
declare const engine: EngineKernel;
declare const wall: Mesh;
engine.use(webglPicking());
declare const culled: CulledModels;
culled.addOccluder(wall);
export const previous = storage(1, 'u32', {atomic: true}).atomicAdd(0, 1);
`,
    ),
    '',
  );
});

test('regression: a block keeps the type of the Var it returns', () => {
  assert.equal(
    errors(
      'block',
      `import { NodeMaterial, Var, block, vec3 } from '@margoengine/shader';
const march = block(() => {
  const light = Var(vec3(0)), depth = Var(0);
  depth.addAssign(0.01);
  return light;
});
export const material = new NodeMaterial({ colorNode: march });
`,
    ),
    '',
  );
});

test('regression: voxel messages are bytes a WebSocket takes', () => {
  assert.equal(
    errors(
      'voxel-bytes',
      `import { EntityCodec, encodeBlockChanges } from '@margoengine/voxel/codec';
declare const socket: WebSocket;
socket.send(encodeBlockChanges([0, 0, 0, 1]));
socket.send(new EntityCodec({ health: 'u8' }).encode(new Map([[1, { health: 20 }]])));
`,
    ),
    '',
  );
});

test('regression: an animation Skeleton is what rigging poses', () => {
  assert.equal(
    errors(
      'skeleton',
      `import type { Skeleton } from '@margoengine/animation';
import { solveSkeletonIK, type IKSkeleton } from '@margoengine/rigging/ik';
import type { SpringSkeleton } from '@margoengine/rigging/springs';
declare const skeleton: Skeleton;
export const ik: IKSkeleton = skeleton;
export const springs: SpringSkeleton = skeleton;
export const solve = solveSkeletonIK;
`,
    ),
    '',
  );
});
