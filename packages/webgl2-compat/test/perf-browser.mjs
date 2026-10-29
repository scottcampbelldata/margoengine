// Milestone M7: the layer's performance on the browser matrix this PC has (Edge's default ANGLE Direct3D 11, and
// Chrome on ANGLE Direct3D 11, OpenGL, Vulkan and SwiftShader), against native WebGPU in the same browser. For each
// scene: start-up (Engine.create to the first finished frame), programs made with their translation and link time,
// frame time as throughput, the state cache's hit rate, and stalls. The milestone M2 layer (built from bd1fcd0a into
// test-results/m2-layer/dist by scripts/build-m2-baseline.mjs of this package, if present) runs the basic scene
// as the baseline.
// Timing: take the GPU exclusively.
//   node scripts/gpu-lock.mjs run --exclusive --owner=<you> -- node packages/webgl2-compat/test/perf-browser.mjs
// Writes test-results/webgl2-compat-perf.json.
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';

const CONFIGS = [
  ['Edge, ANGLE Direct3D 11', undefined, []],
  ['Chrome, ANGLE Direct3D 11', 'chrome', ['--use-angle=d3d11']],
  ['Chrome, ANGLE OpenGL', 'chrome', ['--use-angle=gl']],
  ['Chrome, ANGLE Vulkan', 'chrome', ['--use-angle=vulkan']],
  ['Chrome, SwiftShader (CPU)', 'chrome', ['--use-angle=swiftshader', '--enable-unsafe-swiftshader']],
];
const only = process.argv
  .find((a) => a.startsWith('--configs='))
  ?.slice(10)
  .split(',')
  .map(Number);
const SCENES = ['basic', 'dof', 'splats', 'instances'];
const m2 = existsSync('test-results/m2-layer/dist/index.js');
const results = [];
for (const [index, [label, channel, args]] of CONFIGS.entries()) {
  if (only && !only.includes(index)) continue;
  let context;
  try {
    context = await openBrowser({ startPath: '/packages/webgl2-compat/test/perf.html', port: 'free', channel, args });
  } catch (error) {
    console.log(`${label}: not available (${error.message.split('\n')[0]})`);
    continue;
  }
  const { page } = context,
    origin = new URL(page.url()).origin;
  const run = async (mode, scene, layer) => {
    await page.goto(
      `${origin}/packages/webgl2-compat/test/perf.html?mode=${mode}&scene=${scene}${layer ? `&layer=${layer}` : ''}`,
    );
    await page.waitForFunction(() => window.ready, null, { timeout: 120000 });
    return page.evaluate(() => window.check.measure());
  };
  try {
    // The scatter tier runs the shader once per stored word: the cost of 65,536 invocations storing 1 to 16 words.
    if (index === 0 && !process.argv.includes('--no-scatter'))
      for (const words of [1, 2, 4, 8, 16]) {
        const native = await run('native', `scatter&words=${words}`),
          compat = await run('compat', `scatter&words=${words}`);
        results.push({ config: label, scene: `scatter ${words} words`, native, compat });
        console.log(
          `${label} | scatter, 65,536 invocations x ${words} words (${compat.tier}): native ${native.frame?.toFixed(3)} ms, layer ${compat.frame?.toFixed(3)} ms a dispatch`,
        );
      }
    for (const scene of SCENES) {
      const native = await run('native', scene),
        compat = await run('compat', scene);
      const row = { config: label, scene, native, compat };
      if (scene === 'basic' && m2) row.m2 = await run('compat', scene, '/test-results/m2-layer/dist/index.js');
      results.push(row);
      const f = (r) => (r?.frame === undefined ? `error ${r?.errors}` : `${r.frame.toFixed(2)} ms`);
      console.log(
        `${label} | ${scene}: native ${f(native)}, layer ${f(compat)}${row.m2 ? `, M2 layer ${f(row.m2)}` : ''}; ` +
          `start-up ${native.startup?.toFixed(0)} / ${compat.startup?.toFixed(0)} ms; ` +
          `${compat.programs?.count} programs, translate ${compat.programs?.translateMs?.toFixed(1)} ms, link ` +
          `${compat.programs?.linkMs?.toFixed(1)} ms; state cache ${(100 * compat.hitRate).toFixed(1)}% hits of ` +
          `${compat.requestsPerFrame?.toFixed(0)} a frame; ${compat.stalls} stalls`,
      );
    }
  } finally {
    await context.close();
  }
}
await writeFile('test-results/webgl2-compat-perf.json', JSON.stringify(results, null, 2));
