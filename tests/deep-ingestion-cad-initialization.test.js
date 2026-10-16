import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Camera } from '../packages/core/dist/camera.js';
const sourceFile = process.env.DEEP_INGESTION_BASELINE
  ? resolve(process.env.DEEP_INGESTION_BASELINE, 'packages/core/src/controls.ts')
  : fileURLToPath(new URL('../packages/core/src/controls.ts', import.meta.url));
// Parameter properties need compilation; Node 26 only supports type stripping.
const directory = await fs.mkdtemp(join(tmpdir(), 'margo-cad-controls-'));
let source;
try {
  const config = join(directory, 'tsconfig.json');
  await fs.writeFile(
    config,
    JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'ESNext',
        moduleResolution: 'Bundler',
        rootDir: dirname(sourceFile),
        outDir: join(directory, 'dist'),
        types: [],
        noCheck: true,
      },
      files: [sourceFile],
    }),
  );
  await promisify(execFile)(process.execPath, [
    fileURLToPath(new URL('../node_modules/typescript/bin/tsc', import.meta.url)),
    '-p',
    config,
  ]);
  source = await fs.readFile(join(directory, 'dist/controls.js'), 'utf8');
} finally {
  await fs.rm(directory, { recursive: true, force: true });
}
source = source.replace(
  "'./camera.js'",
  JSON.stringify(new URL('../packages/core/dist/camera.js', import.meta.url).href),
);
const { CADCameraControls } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
function element(failAt = Infinity) {
  const listeners = new Map(),
    captures = new Set(),
    failure = new Error('Injected listener initialization failure');
  let count = 0;
  return {
    style: { touchAction: 'pan-x' },
    listeners,
    captures,
    failure,
    clientHeight: 100,
    addEventListener(name, listener) {
      if (++count === failAt) throw failure;
      listeners.set(name, listener);
    },
    removeEventListener(name, listener) {
      if (listeners.get(name) === listener) listeners.delete(name);
    },
    setPointerCapture(id) {
      captures.add(id);
    },
    hasPointerCapture(id) {
      return captures.has(id);
    },
    releasePointerCapture(id) {
      captures.delete(id);
    },
  };
}
test('Core CAD initialization releases every partially installed listener and restores touch action', () => {
  for (let failAt = 1; failAt <= 6; failAt++) {
    const target = element(failAt);
    assert.throws(
      () => new CADCameraControls(new Camera(), target),
      (error) => error === target.failure,
    );
    assert.equal(target.listeners.size, 0, 'Partial listeners leaked at registration ' + failAt);
    assert.equal(target.style.touchAction, 'pan-x');
  }
});
test('Core CAD controls retain ordinary navigation and complete listener/pointer cleanup', () => {
  const target = element(),
    camera = new Camera(),
    controls = new CADCameraControls(camera, target);
  assert.equal(target.listeners.size, 6);
  assert.equal(target.style.touchAction, 'none');
  const before = camera.position.slice();
  target.listeners.get('pointerdown')({ button: 0, pointerId: 7, clientX: 10, clientY: 10 });
  assert.ok(target.captures.has(7));
  target.listeners.get('pointermove')({ pointerId: 7, clientX: 20, clientY: 15 });
  assert.notDeepEqual(camera.position, before);
  assert.ok(camera.position.every(Number.isFinite));
  controls.dispose();
  assert.equal(target.listeners.size, 0);
  assert.equal(target.captures.size, 0);
  assert.equal(target.style.touchAction, 'pan-x');
  controls.dispose();
  assert.equal(target.listeners.size, 0);
});

test('CAD pole pans stay finite and preserve eye-to-target distance', () => {
  for (const sign of [-1, 1]) {
    const camera = new Camera({ position: [0, sign * 5, 0], target: [0, 0, 0], up: [0, 0, -sign] }),
      controls = new CADCameraControls(camera, element());
    controls.pan(0.2, 0.3);
    assert.ok([...camera.position, ...camera.target].every(Number.isFinite));
    assert.ok(Math.abs(Math.hypot(...camera.position.map((v, i) => v - camera.target[i])) - 5) < 1e-10);
    assert.notDeepEqual(camera.target, [0, 0, 0]);
    controls.dispose();
  }
});
test('CAD orbit rejects a coincident eye atomically', () => {
  const target = element(),
    camera = new Camera(),
    controls = new CADCameraControls(camera, target);
  camera.position = [...camera.target];
  const before = [...camera.position];
  assert.throws(() => controls.orbit(0.1, 0.1), RangeError);
  assert.deepEqual(camera.position, before);
  controls.dispose();
});
test('CAD capture failure leaves the next pointer usable', () => {
  const target = element(),
    camera = new Camera({ position: [0, 0, 5] }),
    controls = new CADCameraControls(camera, target);
  const capture = target.setPointerCapture;
  target.setPointerCapture = () => {
    throw new Error('capture failed');
  };
  assert.throws(
    () => target.listeners.get('pointerdown')({ button: 0, pointerId: 1, clientX: 0, clientY: 0 }),
    /capture failed/,
  );
  target.setPointerCapture = capture;
  target.listeners.get('pointerdown')({ button: 0, pointerId: 2, clientX: 0, clientY: 0 });
  assert.ok(target.captures.has(2));
  target.listeners.get('pointermove')({ pointerId: 2, clientX: 10, clientY: 0 });
  assert.notDeepEqual(camera.position, [0, 0, 5]);
  controls.dispose();
});
