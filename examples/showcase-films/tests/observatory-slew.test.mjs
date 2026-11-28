import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { openShotPage } from '../../../tools/shot/render.mjs';
import { parseShot } from '../../../tools/shot/shot-file.mjs';

test('the interior shot shows the entire telescope slew against the fixed dome', { timeout: 30_000 }, async () => {
  const config = JSON.parse(await readFile(new URL('../the-observatory-dome.shot.json', import.meta.url), 'utf8'));
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
    const [start, mid, aligned] = await browser.page.evaluate(
      (times) => {
        const { engine, apply } = window.showcase;
        const meshes = [...engine.scene.meshes.values()];
        const dome = meshes.find((mesh) => mesh.name === 'Azimuth ring');
        const mount = meshes.find((mesh) => mesh.name === 'Motorized telescope fork');
        const optical = meshes.find((mesh) => mesh.name === 'Reflector tube');
        return times.map((time) => {
          apply({ time });
          return {
            dome: dome.rotation.y,
            yaw: mount.rotation.y,
            elevation: -optical.rotation.x,
            camera: [...engine.camera.position, ...engine.camera.target, engine.camera.fov],
          };
        });
      },
      ['scope-start', 'scope-mid', 'scope-aligned'].map((key) => file.shot.probes[key]),
    );

    assert.ok(aligned.yaw - start.yaw > 1.1, 'interior view should show more than 63° of azimuth travel');
    assert.ok(aligned.elevation - start.elevation > 0.55, 'interior view should show more than 31° of altitude travel');
    assert.ok(start.yaw < mid.yaw && mid.yaw < aligned.yaw);
    assert.ok(start.elevation < mid.elevation && mid.elevation < aligned.elevation);
    assert.ok(Math.abs(aligned.dome - start.dome) < 0.02, 'dome holds its direction during the telescope shot');
    assert.ok(Math.abs(aligned.dome - aligned.yaw) < 0.0001, 'telescope finishes on the viewing slit azimuth');
    assert.deepEqual(mid.camera, start.camera);
    assert.deepEqual(aligned.camera, start.camera);
  } finally {
    await browser.close();
  }
});
