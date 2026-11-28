import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { openShotPage } from '../../../tools/shot/render.mjs';
import { parseShot } from '../../../tools/shot/shot-file.mjs';

test('the captioned row shot shows solar trackers tilt through noon', { timeout: 30_000 }, async () => {
  const config = JSON.parse(await readFile(new URL('../the-solar-field.shot.json', import.meta.url), 'utf8'));
  config.shot.size = [480, 270];
  const file = parseShot(config);
  const { path, query, apply } = file.shot.page;
  const browser = await openShotPage(file);
  try {
    await browser.page.goto(
      `http://127.0.0.1:${browser.server.config.server.port}/${path}?${new URLSearchParams(query)}`,
    );
    await browser.page.waitForFunction((key) => typeof window.__margoShot.get(key) === 'function', apply, {
      timeout: 20_000,
      polling: 120,
    });
    const [east, level, west] = await browser.page.evaluate(
      (times) => {
        const { engine, apply } = window.showcase;
        const nodes = [...engine.scene.meshes.values()];
        const tracker = nodes.find((mesh) => mesh.name === 'Tracker torque tube');
        const post = nodes.find((mesh) => mesh.name === 'Driven support');
        return times.map((time) => {
          apply({ time });
          const [sunX, sunY] = engine.lighting.direction;
          return {
            tilt: tracker.rotation.z,
            expectedTilt: Math.atan2(-sunX, sunY),
            postTilt: post.rotation.z,
            camera: [...engine.camera.position, ...engine.camera.target, engine.camera.fov],
          };
        });
      },
      ['rows-east', 'rows-level', 'rows-west'].map((key) => file.shot.probes[key]),
    );
    assert.ok(east.tilt < -0.6, 'the panels start angled east');
    assert.ok(Math.abs(level.tilt) < 0.07, 'the panels pass close to horizontal');
    assert.ok(west.tilt > 0.3, 'the panels end angled west');
    for (const sample of [east, level, west]) {
      assert.ok(Math.abs(sample.tilt - sample.expectedTilt) < 0.0001, 'the panels follow the rendered sun');
      assert.equal(sample.postTilt, 0);
      assert.deepEqual(sample.camera, east.camera);
    }
  } finally {
    await browser.close();
  }
});
