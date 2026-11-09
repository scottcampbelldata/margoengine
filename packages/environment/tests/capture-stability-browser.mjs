// Exact-value regression for a clipped refractor after restoring its clip plane.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';
import { acquire } from '../../../scripts/gpu-lock.mjs';

const release = await acquire({ owner: 'environment-capture-stability' });
let browser;
try {
  browser = await openBrowser({ startPath: '/tests/env-mirror.html', port: 'free' });
  const { page } = browser;
  await page.waitForFunction(() => window.mirrorFixture);
  // --gpu-load=<iterations>: a second WebGL2 canvas keeps the GPU busy with long full-screen draws. Under such load
  // ANGLE D3D11 on NVIDIA evaluated a shader's uniform-only normalize on two paths an ulp apart; a quiet GPU hid it.
  const load = Number(process.argv.find((a) => a.startsWith('--gpu-load='))?.slice(11) ?? 0);
  if (load)
    await page.evaluate((iterations) => {
      const canvas = Object.assign(document.createElement('canvas'), { width: 2048, height: 2048 }),
        gl = canvas.getContext('webgl2'),
        program = gl.createProgram();
      for (const [type, source] of [
        [gl.VERTEX_SHADER, 'void main(){gl_Position=vec4(vec2(gl_VertexID&1,gl_VertexID>>1)*4.0-1.0,0,1);}'],
        [
          gl.FRAGMENT_SHADER,
          `precision highp float;out vec4 o;void main(){float a=0.0;for(int i=0;i<${iterations};i++)a=fract(sin(a+gl_FragCoord.x*0.001+float(i))*43758.5);o=vec4(a);}`,
        ],
      ]) {
        const shader = gl.createShader(type);
        gl.shaderSource(shader, `#version 300 es
${source}`);
        gl.compileShader(shader);
        gl.attachShader(program, shader);
      }
      gl.linkProgram(program);
      gl.useProgram(program);
      const draw = () => {
        if (!window.mirrorFixture) return;
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        gl.flush();
        setTimeout(draw, 0);
      };
      draw();
    }, load);
  const render = (state) => page.evaluate((s) => window.mirrorFixture.render(s), state);
  const capture = (state) => page.evaluate((s) => window.mirrorFixture.capture('glass', s), state);
  // Keep the original mirror gate's glass setup and its negative clipping control.
  await render({ scene: 'glass' });
  await render({ scene: 'glass', tint: [0, 0, 0] });
  await render({ scene: 'glass-reference' });
  const front = await capture({ scene: 'glass', yellow: true });
  const absent = await capture({ scene: 'glass', yellow: false });
  const leaking = await capture({ scene: 'glass', yellow: true, clipBias: -2 });
  const free = await capture({ scene: 'glass', yellow: false, clipBias: -2 });
  const maximum = (a, b) => a.data.reduce((max, value, i) => Math.max(max, Math.abs(value - b.data[i])), 0);
  const initialDifference = maximum(front, absent);
  const controlDifference = maximum(leaking, free);
  // A fixed sample count measures failures; every pair runs even when an earlier one differs. Each capture is its own
  // page task, as in an application frame loop: other GPU work then queues between captures.
  const rows = [],
    mismatches = [];
  for (let pair = 0; pair < 12; pair++) {
    await page.evaluate(async () => {
      window.captureStabilityFront = await window.mirrorFixture.capture('glass', { scene: 'glass', yellow: true });
    });
    const differences = await page.evaluate(async () => {
      const a = window.captureStabilityFront,
        b = await window.mirrorFixture.capture('glass', { scene: 'glass', yellow: false }),
        found = [];
      for (let i = 0; i < a.data.length; i++)
        if (a.data[i] !== b.data[i])
          found.push({
            index: i,
            x: (i >> 2) % a.width,
            y: Math.floor((i >> 2) / a.width),
            channel: i % 4,
            front: a.data[i],
            absent: b.data[i],
          });
      return found;
    });
    rows.push({ pair, differences: differences.length });
    if (differences.length) mismatches.push({ pair, differences });
  }
  const repeat = { rows, mismatches, errors: await page.evaluate(() => window.mirrorFixture.errors) };
  const out = `test-results/env-capture-stability/${process.argv.includes('--compat') ? 'compat' : 'webgpu'}`;
  await mkdir(out, { recursive: true });
  await writeFile(
    `${out}/result.json`,
    JSON.stringify({ hardware: browser.hardware, initialDifference, controlDifference, repeat }, null, 2),
  );
  console.log(
    JSON.stringify({ initialDifference, controlDifference, rows: repeat.rows, report: `${out}/result.json` }),
  );
  assert.equal(initialDifference, 0, 'The front box is absent from the original capture pair');
  assert(controlDifference > 0.05, 'The negative clip bias admits the front box');
  assert.deepEqual(repeat.errors, [], 'No GPU validation or engine errors');
  assert.equal(repeat.rows.length, 12, 'Every bounded comparison completed');
  assert(
    repeat.rows.every((row) => row.differences === 0),
    'Restoring the clip plane preserves exact capture values',
  );
} finally {
  try {
    try {
      await browser?.page.evaluate(() => window.mirrorFixture?.dispose());
    } finally {
      await browser?.close();
    }
  } finally {
    release();
  }
}
