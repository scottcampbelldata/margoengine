// Loop and switch shapes ANGLE's Direct3D 11 back end got wrong. KB-LOOP-D3D11: a `continue` in a loop nested in a loop
// whose header ANGLE splits into statements; ANGLE rewrote such an outer `for` as `for (; s; )` and put its update
// before every continue in its body, a nested loop's continue too, so a skipped inner iteration advanced the outer
// counter. KB-SW2: a switch with one case and an empty default; ANGLE dropped the default and the lone case then ran
// whatever the selector. test/d3d11-control-flow.html runs fifteen shapes on native WebGPU and on the layer, on each
// real ANGLE back end of the platform, against a CPU reference; every shape must match it on the GLSL (fragment) tier.
import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
import { ANGLE_BACKENDS } from './angle-backends.mjs';

const path = '/packages/webgl2-compat/test/d3d11-control-flow.html';
const backends = ANGLE_BACKENDS[process.platform];
if (!backends)
  throw new Error(`No ANGLE backends listed for ${process.platform}; add its real backends to ANGLE_BACKENDS`);
const clean = (wrong) => Object.fromEntries(Object.keys(wrong).map((k) => [k, 0]));

const native = await openBrowser({ startPath: path, port: 'free', compat: false, args: [] });
try {
  await native.page.waitForFunction(() => window.ready, null, { timeout: 60000 });
  const r = await native.page.evaluate(() => window.check.native());
  assert.deepEqual(r.wrong, clean(r.wrong), `native WebGPU: ${JSON.stringify(r.first)}`);
  console.log('native WebGPU: 15 control-flow shapes match the CPU reference');
} finally {
  await native.close();
}
for (const [backend, renderer] of backends) {
  const context = await openBrowser({ startPath: path, port: 'free', compat: false, args: [`--use-angle=${backend}`] });
  const errors = [];
  context.page.on('pageerror', (error) => errors.push(error.message));
  try {
    assert.match(context.hardware.webglRenderer, renderer);
    await context.page.waitForFunction(() => window.ready, null, { timeout: 60000 });
    const r = await context.page.evaluate(() => window.check.compat());
    assert.notEqual(r.tier, 'cpu', `${backend}: the shapes run as GLSL, not on the CPU tier`);
    assert.deepEqual(r.wrong, clean(r.wrong), `${backend}: wrong sums per shape, first ${JSON.stringify(r.first)}`);
    assert.deepEqual(errors, []);
    console.log(`${backend}: 15 control-flow shapes match the CPU reference on the ${r.tier} tier`);
  } finally {
    await context.close();
  }
}
