import {Engine, PbrMaterial, box} from '@margoengine/core';
import {engineRuntime, meshRuntime} from '@margoengine/core/extension';
import {LabelRenderer, projectPoint, cssPointToWorld} from '@margoengine/labels';

const assert = (condition, message) => {if (!condition) throw new Error(message);};
const center = element => {const r = element.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2];};
const tag = text => {const element = document.createElement('div'); element.className = 'tag'; element.textContent = text; return element;};

/** Projected world point in page coordinates (canvas content box origin + CSS pixels). */
function pagePoint(engine, point) {
  const canvas = engine.canvas, rect = canvas.getBoundingClientRect();
  const p = projectPoint(engine.camera.matrix, point[0], point[1], point[2], canvas.clientWidth, canvas.clientHeight, engine.backend);
  return [rect.left + canvas.clientLeft + p.x, rect.top + canvas.clientTop + p.y];
}
function readPixel(canvas, x, y) {
  const copy = document.createElement('canvas'); copy.width = canvas.width; copy.height = canvas.height;
  const context = copy.getContext('2d');
  context.drawImage(canvas, 0, 0);
  return [...context.getImageData(Math.round(x), Math.round(y), 1, 1).data];
}

async function scenario(backend) {
  const checks = [], measurements = {};
  const canvas = document.getElementById('view');
  const engine = await Engine.create(canvas, {backend, camera: {position: [0, 1.5, 6], target: [0, 0, 0], near: 0.1, far: 100}});
  assert(engine.backend === backend, `Expected ${backend}, got ${engine.backend}`);
  const gpuErrors = [];
  const device = engine.gpu;
  device?.addEventListener('uncapturederror', event => gpuErrors.push(event.error.message));
  device?.pushErrorScope('validation');
  const labels = new LabelRenderer();
  engine.use(labels);
  const material = new PbrMaterial({color: [0.95, 0.15, 0.1], roughness: 0.6});
  const mesh = engine.createMesh().setGeometry(box()).setMaterial(material).setPosition([0.8, 0.2, 0]);
  const label = labels.add(tag('A'), {mesh});
  engine.render();
  const root = document.querySelector('[data-margoengine-labels]');
  const canvasRect = canvas.getBoundingClientRect(), rootRect = root.getBoundingClientRect();
  assert(Math.abs(rootRect.left - canvasRect.left - canvas.clientLeft) < 0.5 && Math.abs(rootRect.top - canvasRect.top - canvas.clientTop) < 0.5 && Math.abs(rootRect.width - canvas.clientWidth) < 0.5, `Overlay root misplaced ${JSON.stringify(rootRect)} vs ${JSON.stringify(canvasRect)}`);
  let expected = pagePoint(engine, [0.8, 0.2, 0]), actual = center(label.element);
  measurements.centerError = Math.hypot(actual[0] - expected[0], actual[1] - expected[1]);
  assert(measurements.centerError <= 1, `${backend}: label ${actual} vs projected center ${expected}`);
  // Pixel readback: the mesh really is under the label.
  if (backend === 'webgpu') {
    const pixel = readPixel(canvas, expected[0] - canvasRect.left - canvas.clientLeft, expected[1] - canvasRect.top - canvas.clientTop);
    measurements.pixelUnderLabel = pixel;
    assert(pixel[0] > 80 && pixel[0] > pixel[1] * 1.5 && pixel[0] > pixel[2] * 1.5, `Mesh not rendered under the label: ${pixel}`);
  }
  checks.push(`${backend}: overlay covers the canvas content box; a mesh label sits on the projected mesh center within 1 px`);

  // Follows a moving mesh.
  mesh.setPosition([-1.2, -0.4, 0.5]);
  engine.render();
  expected = pagePoint(engine, [-1.2, -0.4, 0.5]); actual = center(label.element);
  measurements.followError = Math.hypot(actual[0] - expected[0], actual[1] - expected[1]);
  assert(measurements.followError <= 1, `${backend}: label did not follow the mesh ${actual} vs ${expected}`);
  checks.push(`${backend}: the label follows a moving mesh`);

  // Pointer events pass through to the canvas by default.
  assert(document.elementFromPoint(...center(label.element)) === canvas, 'Default label blocked pointer events');

  // Hidden behind the camera, back when in front again.
  engine.camera.position = [0, 1.5, -6];
  engine.camera.target = [0, 1.5, -12];
  engine.render();
  assert(getComputedStyle(label.element).display === 'none' && !label.onScreen, `${backend}: label behind the camera is visible`);
  engine.camera.position = [0, 1.5, 6]; engine.camera.target = [0, 0, 0];
  engine.render();
  assert(getComputedStyle(label.element).display !== 'none', 'label did not come back');
  checks.push(`${backend}: the label hides when its mesh is behind the camera`);

  // Depth order: two overlapping (both on the camera's line of sight) interactive labels; the nearer one is on top.
  const farLabel = labels.add(tag('far'), {position: [0, -0.75, -3], pointerEvents: 'auto'});
  const nearLabel = labels.add(tag('near'), {position: [0, 0.75, 3], pointerEvents: 'auto'});
  engine.render();
  const overlap = center(farLabel.element);
  assert(document.elementFromPoint(overlap[0], overlap[1]) === nearLabel.element, `${backend}: near label is not on top`);
  assert(Number(nearLabel.element.style.zIndex) > Number(farLabel.element.style.zIndex), 'z-index not sorted');
  // Look back along the same line from the other side so the labels still overlap.
  engine.camera.position = [0, -2.25, -9]; engine.camera.target = [0, 0, 0];
  engine.render();
  const flipped = center(nearLabel.element);
  assert(document.elementFromPoint(flipped[0], flipped[1]) === farLabel.element, `${backend}: z-order did not follow depth after moving the camera`);
  engine.camera.position = [0, 1.5, 6];
  checks.push(`${backend}: labels z-order by depth (hit testing picks the nearer one) and re-sort when the camera moves`);

  // CSS3D: corner markers of a rotated, scaled panel land on the projected world corners.
  const panel = document.createElement('div'); panel.className = 'panel';
  const corners = [[0, 0], [100, 0], [0, 60], [100, 60]].map(([x, y]) => {
    const marker = document.createElement('div'); marker.className = 'corner'; marker.style.left = `${x}px`; marker.style.top = `${y}px`; panel.appendChild(marker); return [marker, x, y];
  });
  const holder = engine.createMesh().setPosition([0.4, 0.9, 0.3]).setRotation([0.3, 0.6, 0.15]).setScale([1.4, 1.1, 1]);
  const object = labels.add3D(panel, {mesh: holder, pixelScale: 0.012});
  engine.render();
  const world = engineRuntime(engine).store.matrices.subarray(holderId(holder) * 16, holderId(holder) * 16 + 16);
  let worst = 0;
  for (const [marker, x, y] of corners) {
    const point = cssPointToWorld(world, object.pixelScale, x - 50, y - 30), expectedCorner = pagePoint(engine, point);
    const r = marker.getBoundingClientRect();
    worst = Math.max(worst, Math.hypot(r.left - expectedCorner[0], r.top - expectedCorner[1]));
  }
  measurements.css3dCornerError = worst;
  assert(worst <= 2, `${backend}: CSS3D corners off by ${worst}px`);
  checks.push(`${backend}: CSS3D element corners land on the projected world corners within 2 px`);

  // Dispose cleans the DOM.
  const elements = [label.element, farLabel.element, nearLabel.element, panel];
  if (device) {const error = await device.popErrorScope(); if (error) gpuErrors.push(error.message);}
  engine.removePlugin(labels.name);
  assert(!document.querySelector('[data-margoengine-labels]') && elements.every(element => !element.isConnected), 'Dispose left overlay elements in the DOM');
  assert(canvas.parentElement.children.length === 1, 'Unexpected siblings after dispose');
  engine.render();
  await new Promise(resolve => setTimeout(resolve, 50));
  assert(gpuErrors.length === 0, `WebGPU validation errors: ${gpuErrors.join('; ')}`);
  checks.push(`${backend}: removing the plugin removes the overlay root and every element${device ? '; zero WebGPU validation errors' : ''}`);
  engine.dispose();
  return {checks, measurements};
}
const holderId = mesh => meshRuntime(mesh).id;

window.runLabelTests = async () => {
  const webgpu = await scenario('webgpu');
  // A fresh canvas for the WebGL2 backend (a canvas keeps the first context type it was given).
  const old = document.getElementById('view'), fresh = document.createElement('canvas');
  fresh.id = 'view'; fresh.setAttribute('aria-label', 'Label test scene'); old.replaceWith(fresh);
  const webgl2 = await scenario('webgl2');
  return {checks: [...webgpu.checks, ...webgl2.checks], measurements: {webgpu: webgpu.measurements, webgl2: webgl2.measurements}};
};
