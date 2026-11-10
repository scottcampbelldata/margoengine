import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
import { files, fixture } from './texture-helper.js';
const browser = await openBrowser({ startPath: '/packages/fbx/test/textures.html', port: 'free' });
try {
  const errors = [];
  browser.page.on('pageerror', (e) => errors.push(e.message));
  for (const [name, bytes] of Object.entries(files)) for (const worker of [false, true]) {
    const result = await browser.page.evaluate(
      async ({input,worker}) => {
        const [{ Engine }, { parseFBX }, { textures }, { readPixels, createHeadlessCanvas },{parseFBXInWorker}] = await Promise.all([
          import('/packages/core/dist/index.js'),
          import('/packages/fbx/dist/index.js'),
          import('/packages/fbx/dist/textures.js'),
          import('/packages/headless/dist/index.js'),import('/packages/fbx/dist/worker.js'),
        ]);
        const engine = await Engine.create(createHeadlessCanvas({ width: 128, height: 128 }), {
          camera: { position: [3.3, 0.3, 3], target: [3.3, 0.3, 0] },
        });
        engine.gpu.pushErrorScope('validation');
        const model = await (worker?parseFBXInWorker:parseFBX)(engine, new Uint8Array(input), { extensions: [textures] });
        engine.render();
        await engine.gpu.queue.onSubmittedWorkDone();
        const { data: rgba } = await readPixels(engine);
        let red = 0;
        for (let i = 0; i < rgba.length; i += 4)
          if (rgba[i] > rgba[i + 1] * 2 + 20 && rgba[i] > rgba[i + 2] * 2 + 20) red++;
        const error = await engine.gpu.popErrorScope();
        const count = model.primitives.length;
        model.dispose();
        engine.dispose();
        return { red, error: error?.message, count };
      },
      {input:[...fixture(name, bytes)],worker},
    );
    assert.equal(result.error, undefined, name);
    assert.equal(result.count, 1, name);
    assert.ok(result.red > 20, `${name}: ${JSON.stringify(result)}`);
  }
  assert.deepEqual(errors, []);
  console.log(
    'FBX four texture formats render red pixels on ' + (process.argv.includes('--compat') ? 'WebGL2' : 'WebGPU'),
  );
} finally {
  await browser.close();
}
