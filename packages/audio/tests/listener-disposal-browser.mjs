import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';
process.chdir(fileURLToPath(new URL('../../..', import.meta.url)));

for (const compat of [false, true]) {
  const browser = await openBrowser({ startPath: '/packages/audio/tests/audio.html', port: 'free', compat });
  const errors = [];
  browser.page.on('pageerror', error => errors.push(error.message));
  try {
    const result = await browser.page.evaluate(async () => {
      const { Engine } = await import('/packages/core/dist/index.js');
      const { AudioListener } = await import('/packages/audio/dist/index.js');
      const canvas = document.createElement('canvas');
      canvas.style.cssText = 'width:64px;height:64px';
      document.body.append(canvas);
      const engine = await Engine.create(canvas, { exactSize: [64, 64] });
      const check = (value, message) => { if (!value) throw new Error(message); };
      try {
        const first = AudioListener.attach(engine, { autoResume: false });
        const owner = engine.sceneOf(first);
        const foreignScene = engine.createScene('foreign listener');
        const foreign = new AudioListener({ autoResume: false });
        engine.use(foreign, foreignScene);
        first.dispose();
        check(engine.sceneOf(first) === undefined, 'Direct disposal retained its plugin registration');
        check(engine.sceneOf(foreign) === foreignScene, 'Disposal removed another scene listener');
        const replacement = AudioListener.attach(engine, { autoResume: false });
        first[Symbol.dispose]();
        check(engine.sceneOf(replacement) === owner, 'Stale disposal removed its replacement');
        foreign.dispose();
        check(engine.sceneOf(foreign) === undefined, 'Non-active scene listener retained its registration');
        check(engine.sceneOf(replacement) === owner, 'Foreign scene disposal removed the active listener');
        replacement.dispose();
        check(engine.sceneOf(replacement) === undefined, 'Replacement disposal retained its registration');
        check(!first.hasContext && !foreign.hasContext && !replacement.hasContext, 'Ownership cleanup created an audio context');
        engine.render();
        return { backend: engine.backend, released: 3, contextCreated: false };
      } finally {
        engine.dispose();
        canvas.remove();
      }
    });
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ compat, hardware: browser.hardware, result }));
  } finally {
    await browser.close();
  }
}
