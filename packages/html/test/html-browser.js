import { Engine, PbrMaterial, box as cube } from '@margoengine/core';
import { HTML } from '@margoengine/html';
import { HTMLTexture } from '@margoengine/html/texture';
import { webglRenderer } from '@margoengine/webgl';

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};
const tag = () => {
  const element = document.createElement('div');
  element.className = 'tag';
  return element;
};
// Renders a frame at a time, each after the GPU finished the last and the page drew, until `ready` holds: depth results
// arrive a frame or more late. Fails after `frames` frames.
const until = async (engine, ready, what, frames = 300) => {
  for (let i = 0; i < frames; i++) {
    engine.render();
    await engine.gpu?.queue.onSubmittedWorkDone();
    await new Promise((resolve) => requestAnimationFrame(resolve));
    if (ready()) return i + 1;
  }
  throw new Error(`${engine.backend}: ${what} not reached in ${frames} frames`);
};
function freshCanvas() {
  const old = document.getElementById('view'),
    canvas = document.createElement('canvas');
  canvas.id = 'view';
  canvas.setAttribute('aria-label', 'HTML anchor test scene');
  old.replaceWith(canvas);
  return canvas;
}
// The camera looks down -z from z = 6 at a unit box. A point at z = -1 on the ray through the front face's right edge
// (x = 0.5, z = 0.5) projects onto that edge: half of a square around it is covered by the box, half is clear.
const EDGE = [(0.5 * 7) / 5.5, 0, -1];

async function scenario(backend) {
  const checks = [],
    measurements = {};
  const engine = await Engine.create(freshCanvas(), {
    backend,
    fallback: webglRenderer,
    camera: { position: [0, 0, 6], target: [0, 0, 0], near: 0.1, far: 100 },
  });
  assert(engine.backend === backend, `Expected ${backend}, got ${engine.backend}`);
  const gpuErrors = [],
    device = engine.gpu;
  device?.addEventListener('uncapturederror', (event) => gpuErrors.push(event.error.message));
  device?.pushErrorScope('validation');
  const box = engine
    .createMesh()
    .setGeometry(cube())
    .setMaterial(new PbrMaterial({ color: [0.9, 0.2, 0.1] }));

  // Job 1: smooth partial occlusion. Duration 0, so the opacity is the visible share of the 4 x 4 grid itself.
  const fade = HTML.attach(engine, { fade: { samples: 4, radius: 8, duration: 0 } });
  const behind = fade.add(tag(), { position: [0, 0, -1] }),
    edge = fade.add(tag(), { position: EDGE }),
    clear = fade.add(tag(), { position: [2, 0, -1] });
  {
    measurements.fadeFrames = await until(
      engine,
      () => !behind.onScreen && edge.onScreen && edge.element.style.opacity === '0.5' && clear.onScreen,
      'fade: behind hidden, edge at 0.5, clear shown',
    );
  }
  measurements.fade = {
    behind: [behind.onScreen, behind.element.style.opacity],
    edge: [edge.onScreen, edge.element.style.opacity],
    clear: [clear.onScreen, clear.element.style.opacity],
  };
  {
    assert(!behind.onScreen, `${backend}: an anchor wholly behind the box stays shown`);
    assert(
      edge.onScreen && edge.element.style.opacity === '0.5',
      `${backend}: edge anchor opacity ${edge.element.style.opacity}`,
    );
    assert(clear.onScreen && clear.element.style.opacity === '', `${backend}: clear anchor faded`);
    checks.push(
      `${backend}: fade hides a covered anchor, shows a clear one at opacity 1 and one on the box edge at 0.5`,
    );
  }
  fade.dispose();

  // Job 2: the hard test on both backends (WebGL2 by occlusion queries): behind hidden, beside shown, and shown again
  // once the box moves out of the way.
  const hard = HTML.attach(engine, { name: 'html-hard' });
  const covered = hard.add(tag(), { position: [0, 0, -1] }),
    beside = hard.add(tag(), { position: [2, 0, -1] });
  measurements.hardFrames = await until(engine, () => !covered.onScreen && beside.onScreen, 'hard: behind hidden');
  box.setPosition([0, 3, 0]);
  measurements.uncoverFrames = await until(engine, () => covered.onScreen && beside.onScreen, 'hard: shown once clear');
  box.setPosition([0, 0, 0]);
  checks.push(`${backend}: hard occlusion hides an anchor behind the box and shows it again when the box moves away`);
  hard.dispose();

  // Job 4: more than 4,096 anchors. 4,199 behind the box and one beside it, slot 4,199: all occluded but that one.
  const many = HTML.attach(engine, { name: 'html-many', capacity: 5_000 });
  const crowd = [];
  for (let i = 0; i < 4_199; i++) crowd.push(many.add(tag(), { position: [((i % 61) - 30) / 200, 0, -1] }));
  const last = many.add(tag(), { position: [2, 0, -1] });
  measurements.manyFrames = await until(
    engine,
    () => last.onScreen && crowd.every((anchor) => !anchor.onScreen),
    'many: 4,199 anchors behind the box hidden, the 4,200th beside it shown',
  );
  checks.push(`${backend}: 4,200 anchors in one overlay, the 4,199 behind the box hidden and the one beside it shown`);
  many.dispose();
  if (device) {
    const error = await device.popErrorScope();
    if (error) gpuErrors.push(error.message);
  }
  engine.render();
  await device?.queue.onSubmittedWorkDone();
  assert(gpuErrors.length === 0, `WebGPU validation errors: ${gpuErrors.join('; ')}`);
  engine.dispose();
  return { checks, measurements };
}

// Job 3: an element drawn on a quad in the scene (WebGPU). A 200 x 100 CSS px panel (blue, a yellow button on its
// right) on a 2 x 1 quad at the origin, facing the camera; a small box in front of its left part.
const project = (engine, [x, y, z]) => {
  const m = engine.camera.matrix,
    w = m[3] * x + m[7] * y + m[11] * z + m[15];
  return [(m[0] * x + m[4] * y + m[8] * z + m[12]) / w, (m[1] * x + m[5] * y + m[9] * z + m[13]) / w];
};
const near = (pixel, expected, tolerance = 12) => expected.every((v, i) => Math.abs(pixel[i] - v) <= tolerance);
async function textureScenario(rasterizer) {
  const checks = [],
    measurements = {};
  const canvas = freshCanvas(),
    engine = await Engine.create(canvas, {
      backend: 'webgpu',
      camera: { position: [0, 0, 6], target: [0, 0, 0], near: 0.1, far: 100 },
    });
  const gpuErrors = [],
    device = engine.gpu;
  device.addEventListener('uncapturederror', (event) => gpuErrors.push(event.error.message));
  device.pushErrorScope('validation');
  const panel = document.createElement('div'),
    button = document.createElement('button');
  panel.style.cssText = 'position:relative;width:200px;height:100px;margin:0;background:rgb(0,160,255)';
  button.style.cssText =
    'position:absolute;left:120px;top:20px;width:60px;height:60px;margin:0;padding:0;border:0;background:rgb(255,200,0)';
  button.setAttribute('aria-label', 'Scene button');
  let presses = 0;
  button.addEventListener('pointerdown', () => presses++);
  panel.appendChild(button);
  const textures = HTMLTexture.attach(engine, { rasterizer });
  const surface = textures.add(panel, { width: 2, height: 1, pixelRatio: 1 });
  engine
    .createMesh()
    .setGeometry(cube(0.3, 0.3, 0.3))
    .setMaterial(new PbrMaterial({ color: [0.9, 0.2, 0.1] }))
    .setPosition([-0.6, 0, 1]);
  measurements.rasterFrames = await until(engine, () => surface.draws > 0, `texture (${rasterizer}): first raster`);
  engine.render();
  const snapshot = document.createElement('canvas');
  snapshot.width = canvas.width;
  snapshot.height = canvas.height;
  const context = snapshot.getContext('2d', { willReadFrequently: true });
  context.drawImage(canvas, 0, 0);
  const sample = (world) => {
    const [x, y] = project(engine, world),
      px = Math.floor(((x + 1) / 2) * canvas.width),
      py = Math.floor(((1 - y) / 2) * canvas.height);
    return [...context.getImageData(px, py, 1, 1).data.slice(0, 3)];
  };
  // Panel UV (u, v) is at local ((u - 0.5) * 2, (0.5 - v) * 1).
  const blue = sample([-0.2, 0.35, 0]),
    yellow = sample([0.5, 0, 0]),
    front = sample([-0.6, 0, 1.15]),
    beside = sample([1.5, 0, 0]);
  measurements.pixels = { blue, yellow, front, beside };
  assert(near(blue, [0, 160, 255]), `texture (${rasterizer}): panel pixel ${blue}`);
  assert(near(yellow, [255, 200, 0]), `texture (${rasterizer}): button pixel ${yellow}`);
  assert(!near(front, [0, 160, 255], 60) && front[0] > front[2], `texture (${rasterizer}): box in front ${front}`);
  assert(!near(beside, [0, 160, 255], 60), `texture (${rasterizer}): off-quad pixel ${beside}`);
  checks.push(`webgpu: ${rasterizer} draws the panel and its button on the quad, a box in front hides its part`);
  // The pointer over the quad's button: the browser's own hit test then finds the button, and a press reaches it.
  const rect = canvas.getBoundingClientRect(),
    [bx, by] = project(engine, [0.5, 0, 0]),
    clientX = rect.left + ((bx + 1) / 2) * rect.width,
    clientY = rect.top + ((1 - by) / 2) * rect.height,
    init = { clientX, clientY, bubbles: true, pointerId: 1, pointerType: 'mouse' };
  canvas.dispatchEvent(new PointerEvent('pointermove', init));
  const hit = document.elementFromPoint(clientX, clientY);
  measurements.hit = hit?.tagName;
  assert(hit === button, `texture (${rasterizer}): elementFromPoint over the quad's button is ${hit?.tagName}`);
  hit.dispatchEvent(new PointerEvent('pointerdown', init));
  assert(presses === 1, `texture (${rasterizer}): the button saw ${presses} presses`);
  // Off the quad: the holder goes back out of the way, and the canvas is hit again.
  const [ox, oy] = project(engine, [1.5, 0.8, 0]),
    away = {
      ...init,
      clientX: rect.left + ((ox + 1) / 2) * rect.width,
      clientY: rect.top + ((1 - oy) / 2) * rect.height,
    };
  canvas.dispatchEvent(new PointerEvent('pointermove', away));
  const off = document.elementFromPoint(away.clientX, away.clientY);
  assert(off === canvas, `texture (${rasterizer}): off the quad the pointer reaches ${off?.tagName}`);
  checks.push(
    `webgpu: ${rasterizer} routes the pointer to the button under it on the quad, and away from it off the quad`,
  );
  // A change to the element draws the texture again.
  const before = surface.draws;
  button.style.background = 'rgb(255,0,255)';
  // Settled: drawn again, and no change waiting (the mutation observer reports after the first frame's raster began).
  measurements.redrawFrames = await until(
    engine,
    () => surface.draws > before && !surface.dirty && !surface.busy,
    `texture (${rasterizer}): redraw`,
  );
  // And only then: an unchanged element is not drawn again (a paint event the raster asked for is not a change).
  const settled = surface.draws;
  // fixed-wait: a set number of idle frames is the check itself (no redraw in 10 frames), not a wait for readiness
  for (let i = 0; i < 10; i++) {
    engine.render();
    await device.queue.onSubmittedWorkDone();
    await new Promise((resolve) => requestAnimationFrame(resolve));
  }
  measurements.idleDraws = surface.draws - settled;
  assert(
    surface.draws === settled,
    `texture (${rasterizer}): ${surface.draws - settled} draws in 10 frames of no change`,
  );
  checks.push(`webgpu: ${rasterizer} draws the texture again after the element changes, and not while it does not`);
  textures.dispose();
  assert(!panel.isConnected, `texture (${rasterizer}): dispose leaves the element in the page`);
  const error = await device.popErrorScope();
  if (error) gpuErrors.push(error.message);
  engine.render();
  await device.queue.onSubmittedWorkDone();
  assert(gpuErrors.length === 0, `WebGPU validation errors: ${gpuErrors.join('; ')}`);
  engine.dispose();
  return { checks, measurements };
}

window.runHTMLTests = async () => {
  const webgpu = await scenario('webgpu');
  const webgl2 = await scenario('webgl2');
  // The HTML-in-canvas rasterizer runs where the browser has it (behind a flag in Chromium for now).
  const rasterizers = ['foreign-object'];
  if ('drawElementImage' in CanvasRenderingContext2D.prototype) rasterizers.push('element-image');
  const textures = [];
  for (const rasterizer of rasterizers) textures.push(await textureScenario(rasterizer));
  return {
    checks: [...webgpu.checks, ...webgl2.checks, ...textures.flatMap((t) => t.checks)],
    measurements: {
      webgpu: webgpu.measurements,
      webgl2: webgl2.measurements,
      texture: Object.fromEntries(rasterizers.map((r, i) => [r, textures[i].measurements])),
    },
  };
};
