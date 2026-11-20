import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Camera } from '../../core/dist/index.js';

test('HDR shadow browser fixture configures a supported straight-down camera', async () => {
  const html = readFileSync(new URL('./hdr-shadow-browser.html', import.meta.url), 'utf8');
  const start = html.indexOf('const engine=');
  const end = html.indexOf('const errors=', start);
  assert(start >= 0 && end > start, 'fixture initialization boundary');
  const initialize = new (Object.getPrototypeOf(async function () {}).constructor)(
    'Engine',
    'document',
    html.slice(start, end) + ';return engine;',
  );
  const engine = await initialize(
    { create: async (_canvas, options) => ({ camera: new Camera(options.camera) }) },
    { querySelector: () => ({}) },
  );
  assert.doesNotThrow(() => engine.camera.update(1, true));
  assert(engine.camera.matrix.every(Number.isFinite));
});
