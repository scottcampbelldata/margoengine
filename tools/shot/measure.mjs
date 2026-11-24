// The measure of a shot (docs/shots.md, Measure): its page loaded and warmed up exactly as a render loads it, nothing
// captured, and what a film pipeline's rules gate reads before any still is made: the errors the page reported, the
// engine camera's near and far planes, and the ground under the camera and under the target of every kept frame
// (shot.page.ground) and under the shot's subject, the scene record its scene audit judges (scene-record.mjs: lights,
// plugins and their options, meshes, materials, draws) and every file the page loaded from its own origin. It writes
// no picture, so a measure is never a still or footage.
import { cameraFrames } from './shot-file.mjs';
import { loadShotPage, openShotPage, pageHooks, watchPage } from './render.mjs';
import { readSceneRecord } from './scene-record.mjs';

/** Metres between the ground samples under a piece's base in the scene record (its centre and four corners). */
export const GROUND_STEP = 0.5;

/**
 * Measures a parsed shot in an open browser (openShotPage). Rejects at the page's first error, as a render does.
 * @param {{ page: import('@playwright/test').Page, server: object, hardware?: { webgpu?: unknown } }} browser
 * @param {object} file A parsed shot file (parseShot).
 * @returns {Promise<{ format: 'margo-shot-measure', version: 2, id: string, heights: 'ground' | 'world',
 *   near: number | null, far: number | null, errors: string[], adapter: unknown,
 *   cameras: { frame: number, ground: [number, number] | null }[], subjectGround: number | null, scene: object,
 *   loaded: string[] }>}
 */
export async function measureOpen(browser, file) {
  const { shot } = file,
    watch = watchPage(browser.page);
  try {
    await loadShotPage(browser, file, watch, pageHooks(shot));
    const { cameras } = cameraFrames(file),
      subject = shot.subject?.target,
      points = cameras.flatMap((camera) => [
        [camera.position[0], camera.position[2]],
        [camera.target[0], camera.target[2]],
      ]);
    // The ground under the shot's subject last, so its height can be put on the ground like the cameras'.
    if (subject) points.push([subject[0], subject[2]]);
    const got = await browser.page.evaluate(
      ({ engine, ground, points }) => {
        const driver = globalThis.__margoShot,
          camera = driver.get(engine)?.camera,
          at = ground ? driver.get(ground) : null;
        return {
          near: Number.isFinite(camera?.near) ? camera.near : null,
          far: Number.isFinite(camera?.far) ? camera.far : null,
          ground: typeof at === 'function' ? points.map(([x, z]) => at(x, z)) : null,
        };
      },
      { engine: shot.page.engine, ground: shot.page.ground ?? null, points },
    );
    if (shot.page.ground && !got.ground)
      throw new Error(`${shot.page.ground} is not a function in the page; set shot.page.ground to the page's ground`);
    if (got.ground?.some((height) => !Number.isFinite(height)))
      throw new Error(`${shot.page.ground} gave a height that is not metres under a camera of the shot`);
    const scene = await browser.page.evaluate(readSceneRecord, {
      engine: shot.page.engine,
      ground: shot.page.ground ?? null,
      step: GROUND_STEP,
    });
    if (watch.errors.length) throw new Error(`the page reported errors:\n  ${watch.errors.slice(0, 10).join('\n  ')}`);
    return {
      format: 'margo-shot-measure',
      version: 2,
      id: shot.id,
      heights: shot.page.ground ? 'ground' : 'world',
      near: got.near,
      far: got.far,
      errors: [...watch.errors],
      adapter: browser.hardware?.webgpu ?? null,
      cameras: cameras.map((camera, i) => ({
        frame: camera.frame,
        ground: got.ground ? [got.ground[2 * i], got.ground[2 * i + 1]] : null,
      })),
      subjectGround: got.ground && subject ? got.ground[2 * cameras.length] : null,
      scene,
      loaded: [...watch.loaded].sort(),
    };
  } finally {
    watch.stop();
  }
}

/**
 * Opens the shot's page, measures it (measureOpen) and closes the browser.
 * @param {object} file A parsed shot file (parseShot).
 */
export async function measureShot(file) {
  const browser = await openShotPage(file);
  try {
    return await measureOpen(browser, file);
  } finally {
    await browser.close();
  }
}
