import { Engine, PbrMaterial, box } from '@margoengine/core';
import { HTML } from '@margoengine/html';
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
  engine
    .createMesh()
    .setGeometry(box())
    .setMaterial(new PbrMaterial({ color: [0.9, 0.2, 0.1] }));

  // Job 1: smooth partial occlusion. Duration 0, so the opacity is the visible share of the 4 x 4 grid itself.
  const fade = HTML.attach(engine, { fade: { samples: 4, radius: 8, duration: 0 } });
  const behind = fade.add(tag(), { position: [0, 0, -1] }),
    edge = fade.add(tag(), { position: EDGE }),
    clear = fade.add(tag(), { position: [2, 0, -1] });
  if (backend === 'webgpu') {
    measurements.fadeFrames = await until(
      engine,
      () => !behind.onScreen && edge.onScreen && edge.element.style.opacity === '0.5' && clear.onScreen,
      'fade: behind hidden, edge at 0.5, clear shown',
    );
  } else await until(engine, () => true, 'a frame');
  measurements.fade = {
    behind: [behind.onScreen, behind.element.style.opacity],
    edge: [edge.onScreen, edge.element.style.opacity],
    clear: [clear.onScreen, clear.element.style.opacity],
  };
  if (backend === 'webgpu') {
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

window.runHTMLTests = async () => {
  const webgpu = await scenario('webgpu');
  const webgl2 = await scenario('webgl2');
  return {
    checks: [...webgpu.checks, ...webgl2.checks],
    measurements: { webgpu: webgpu.measurements, webgl2: webgl2.measurements },
  };
};
