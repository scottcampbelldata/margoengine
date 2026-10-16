import test from 'node:test';
import assert from 'node:assert/strict';
import { Camera } from '@margoengine/core';
import { fakeEngine } from './fake-dom.js';
import {
  LabelRenderer,
  projectPoint,
  lookAtView,
  cssPerspective,
  cameraCSSTransform,
  objectCSSTransform,
  orthographicCSSTransform,
  isOrthographic,
  cssPointToWorld,
  composeMatrix,
} from '../dist/index.js';
import { CameraProjection } from '../../cameras/dist/index.js';

const close = (a, b, epsilon = 1e-6) => Math.abs(a - b) <= epsilon;

test('projectPoint maps world points to CSS pixels on both backends', () => {
  for (const backend of ['webgpu', 'webgl2']) {
    const camera = new Camera({ position: [0, 0, 5], target: [0, 0, 0], near: 0.5, far: 50 });
    camera.update(2, backend === 'webgpu');
    const center = projectPoint(camera.matrix, 0, 0, 0, 800, 400, backend);
    assert.ok(close(center.x, 400, 1e-3) && close(center.y, 200, 1e-3), `${backend} center ${center.x},${center.y}`);
    assert.ok(center.inFront && center.inFrustum);
    assert.ok(close(center.w, 5, 1e-5));
    const f = 1 / Math.tan(Math.PI / 6);
    const right = projectPoint(camera.matrix, 1, 0.5, 0, 800, 400, backend);
    assert.ok(close(right.x, 400 + (f / 2 / 5) * 400, 1e-3), `${backend} x ${right.x}`);
    assert.ok(close(right.y, 200 - ((f * 0.5) / 5) * 200, 1e-3), `${backend} y ${right.y}`);
    // Depth is normalized 0 near .. 1 far on both backends, despite reversed-Z WebGPU clip space.
    assert.ok(close(projectPoint(camera.matrix, 0, 0, 4.5, 800, 400, backend).depth, 0, 1e-4));
    assert.ok(close(projectPoint(camera.matrix, 0, 0, -45, 800, 400, backend).depth, 1, 1e-4));
    assert.ok(projectPoint(camera.matrix, 0, 0, -44, 800, 400, backend).inFrustum);
    assert.equal(projectPoint(camera.matrix, 0, 0, -46, 800, 400, backend).inFrustum, false, 'beyond far');
    assert.equal(projectPoint(camera.matrix, 0, 0, 4.8, 800, 400, backend).inFrustum, false, 'closer than near');
    const behind = projectPoint(camera.matrix, 0, 0, 8, 800, 400, backend);
    assert.equal(behind.inFront, false);
    assert.equal(behind.inFrustum, false);
    const outside = projectPoint(camera.matrix, 20, 0, 0, 800, 400, backend);
    assert.equal(outside.inFront, true);
    assert.equal(outside.inFrustum, false);
  }
});

test('lookAtView reproduces the core camera view matrix', () => {
  const camera = new Camera({ position: [3, 2, 7], target: [-1, 0.5, 0], fov: 50, near: 0.1, far: 100 });
  camera.update(1.5, true);
  const view = lookAtView(camera.position, camera.target);
  const f = 1 / Math.tan((50 * Math.PI) / 360),
    d = 0.1 - 100;
  const projection = [f / 1.5, 0, 0, 0, 0, f, 0, 0, 0, 0, -0.1 / d, -1, 0, 0, (-100 * 0.1) / d, 0];
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++) {
      let value = 0;
      for (let k = 0; k < 4; k++) value += projection[k * 4 + r] * view[c * 4 + k];
      assert.ok(
        close(value, camera.matrix[c * 4 + r], 1e-5),
        `m[${c * 4 + r}] ${value} vs ${camera.matrix[c * 4 + r]}`,
      );
    }
  assert.throws(() => lookAtView([0, 0, 0], [0, 0, 0]), RangeError);
  assert.throws(() => lookAtView([0, 5, 0], [0, 0, 0]), RangeError);
});

// Evaluates the CSS transform chain the browser builds for a CSS3D element, to check it lands where projectPoint says.
function parse(transform) {
  const functions = [...transform.matchAll(/(\w+)\(([^)]*)\)/g)];
  return functions.map(([, name, args]) => ({ name, args: args.split(',').map((value) => value.trim()) }));
}
const multiply = (a, b) => {
  const out = new Array(16).fill(0);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) out[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return out;
};
const translation = (x, y, z = 0) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
function cssMatrix(transform, width, height) {
  let m = translation(0, 0);
  for (const { name, args } of parse(transform)) {
    const length = (value, size) => (value.endsWith('%') ? (parseFloat(value) / 100) * size : parseFloat(value));
    if (name === 'translateZ') m = multiply(m, translation(0, 0, parseFloat(args[0])));
    else if (name === 'translate') m = multiply(m, translation(length(args[0], width), length(args[1], height)));
    else if (name === 'matrix3d') m = multiply(m, args.map(Number));
    else throw new Error(`Unexpected ${name}`);
  }
  // transform-origin defaults to the element center.
  return multiply(multiply(translation(width / 2, height / 2), m), translation(-width / 2, -height / 2));
}
function cssScreen(point, { viewerWidth, viewerHeight, perspective, camera, object, elementWidth, elementHeight }) {
  const perspectiveMatrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, -1 / perspective, 0, 0, 0, 1];
  const viewer = multiply(
    multiply(translation(viewerWidth / 2, viewerHeight / 2), perspectiveMatrix),
    translation(-viewerWidth / 2, -viewerHeight / 2),
  );
  const total = multiply(
    multiply(viewer, cssMatrix(camera, viewerWidth, viewerHeight)),
    cssMatrix(object, elementWidth, elementHeight),
  );
  const [x, y, , w] = [0, 1, 2, 3].map((r) => total[r] * point[0] + total[4 + r] * point[1] + total[12 + r]);
  return [x / w, y / w];
}

test('CSS3D transforms place element corners on the projected world corners', () => {
  const width = 640,
    height = 360;
  const camera = new Camera({ position: [2, 1.5, 4], target: [0, 0.25, 0], fov: 55 });
  camera.update(width / height, true);
  const perspective = cssPerspective(camera.fov, height);
  assert.ok(close(perspective, (height / 2) * (1 / Math.tan((55 * Math.PI) / 360))));
  const view = lookAtView(camera.position, camera.target);
  const world = composeMatrix([0.3, 0.2, -0.4], [0.2, 0.3, -0.1, 0.92], [1.5, 0.8, 1]);
  const pixelScale = 0.01,
    elementWidth = 120,
    elementHeight = 80;
  const setup = {
    viewerWidth: width,
    viewerHeight: height,
    perspective,
    camera: cameraCSSTransform(view, perspective, width, height),
    object: objectCSSTransform(world, pixelScale),
    elementWidth,
    elementHeight,
  };
  for (const [cx, cy] of [
    [0, 0],
    [elementWidth, 0],
    [0, elementHeight],
    [elementWidth, elementHeight],
    [60, 40],
  ]) {
    const css = cssScreen([cx, cy], setup);
    const point = cssPointToWorld(world, pixelScale, cx - elementWidth / 2, cy - elementHeight / 2);
    const projected = projectPoint(camera.matrix, ...point, width, height);
    assert.ok(
      close(css[0], projected.x, 1e-2) && close(css[1], projected.y, 1e-2),
      `corner ${cx},${cy}: css ${css} vs ${projected.x},${projected.y}`,
    );
  }
});

function setup(options = {}) {
  const engine = fakeEngine(Camera, options);
  const renderer = new LabelRenderer(options.renderer);
  renderer.setup(engine);
  renderer.registerPasses(engine.graph);
  return { engine, renderer, document: engine.document };
}
const translate = (element) =>
  element.style.transform
    .match(/translate\(([-\d.]+)px,([-\d.]+)px\)/)
    .slice(1)
    .map(Number);

test('overlay root sits after the canvas, covers it and passes pointer events through', () => {
  const { engine, renderer } = setup();
  const root = renderer.root;
  assert.equal(engine.canvas.nextSibling, root);
  assert.equal(root.style.pointerEvents, 'none');
  assert.equal(engine.passes[0].name, 'margoengine-labels');
  assert.ok(engine.passes[0].order > 0);
  engine.frame();
  assert.deepEqual(root.getBoundingClientRect(), engine.canvas.getBoundingClientRect());
  assert.equal(root.style.width, '800px');
  assert.equal(root.style.height, '400px');
});

test('a mesh label sits on the projected mesh center, follows it, hides behind the camera and when hidden', () => {
  const { engine, renderer, document } = setup();
  const mesh = engine.createMesh([1, 0.5, 0]);
  const label = renderer.add(document.createElement('div'), { mesh });
  engine.frame();
  let expected = projectPoint(engine.camera.matrix, 1, 0.5, 0, 800, 400);
  let [x, y] = translate(label.element);
  assert.ok(close(x, expected.x, 0.01) && close(y, expected.y, 0.01), `label ${x},${y} vs ${expected.x},${expected.y}`);
  assert.equal(label.element.style.display, '');
  assert.match(label.element.style.transform, /translate\(-50%,-50%\)$/);
  assert.equal(label.element.style.pointerEvents, 'none');
  engine.move(mesh, [-1.5, -0.2, 1]);
  engine.frame();
  expected = projectPoint(engine.camera.matrix, -1.5, -0.2, 1, 800, 400);
  [x, y] = translate(label.element);
  assert.ok(close(x, expected.x, 0.01) && close(y, expected.y, 0.01), 'label did not follow the mesh');
  engine.move(mesh, [0, 0, 9]);
  engine.frame();
  assert.equal(label.element.style.display, 'none');
  assert.equal(label.onScreen, false);
  engine.move(mesh, [0, 0, 0]);
  engine.store.hidden[mesh.id] = 1;
  engine.frame();
  assert.equal(label.element.style.display, 'none', 'hidden mesh hides its label');
  label.followVisibility = false;
  engine.frame();
  assert.equal(label.element.style.display, '');
  engine.meshes.delete(mesh.id);
  engine.frame();
  assert.equal(label.element.style.display, 'none', 'disposed mesh hides its label');
});

test('local and world offsets, anchors and world-point labels', () => {
  const { engine, renderer, document } = setup();
  const mesh = engine.createMesh([0, 0, 0]);
  // Rotate 90 degrees about Z and scale 2: local +X maps to world +Y * 2.
  engine.move(mesh, [0.5, 0, 0], [0, 2, 0, -2, 0, 0, 0, 0, 2]);
  const local = renderer.add(document.createElement('div'), { mesh, offset: [0.5, 0, 0], anchor: [0, 1] });
  const world = renderer.add(document.createElement('div'), { mesh, offset: [0.5, 0, 0], offsetSpace: 'world' });
  const point = renderer.add(document.createElement('div'), { position: [-1, 1, 0], pointerEvents: 'auto' });
  engine.frame();
  const at = (x, y, z) => projectPoint(engine.camera.matrix, x, y, z, 800, 400);
  const check = (label, p) => {
    const [x, y] = translate(label.element);
    assert.ok(close(x, p.x, 0.01) && close(y, p.y, 0.01), `${x},${y} vs ${p.x},${p.y}`);
  };
  check(local, at(0.5, 1, 0));
  check(world, at(1, 0, 0));
  check(point, at(-1, 1, 0));
  assert.match(local.element.style.transform, /translate\(0%,-100%\)$/);
  assert.equal(point.element.style.pointerEvents, 'auto');
  point.setPosition([0, -1, 0]);
  engine.frame();
  check(point, at(0, -1, 0));
});

test('labels outside the frustum hide unless frustum culling is off', () => {
  const { engine, renderer, document } = setup();
  const culled = renderer.add(document.createElement('div'), { position: [30, 0, 0] });
  const kept = renderer.add(document.createElement('div'), { position: [30, 0, 0], frustumCulling: false });
  engine.frame();
  assert.equal(culled.element.style.display, 'none');
  assert.equal(kept.element.style.display, '');
});

test('z-index follows depth: nearer labels draw on top', () => {
  const { engine, renderer, document } = setup();
  const far = renderer.add(document.createElement('div'), { position: [0, 0, -5] });
  const middle = renderer.add(document.createElement('div'), { position: [0.2, 0, 0] });
  const nearLabel = renderer.add(document.createElement('div'), { position: [-0.2, 0, 3] });
  const unsorted = renderer.add(document.createElement('div'), { position: [0, 0, 2], sort: false });
  engine.frame();
  const z = (label) => Number(label.element.style.zIndex);
  assert.ok(z(nearLabel) > z(middle) && z(middle) > z(far), `${z(far)} ${z(middle)} ${z(nearLabel)}`);
  assert.equal(unsorted.element.style.zIndex, undefined);
  engine.camera.position = [0, 0, -12];
  engine.frame();
  assert.ok(z(far) > z(middle) && z(middle) > z(nearLabel), 'z-order did not flip with the camera');
});

test('DOM writes happen only when values change', () => {
  const { engine, renderer, document } = setup();
  const mesh = engine.createMesh([0, 0, 0]);
  const labels = [0, 1, 2].map((i) => renderer.add(document.createElement('div'), { mesh, offset: [i * 0.3, 0, 0] }));
  engine.frame();
  assert.ok(renderer.writes > 0);
  const before = labels.map((label) => label.element.styleWrites),
    rootBefore = renderer.root.styleWrites;
  engine.frame();
  assert.equal(renderer.writes, 0);
  assert.deepEqual(
    labels.map((label) => label.element.styleWrites),
    before,
  );
  assert.equal(renderer.root.styleWrites, rootBefore);
  engine.move(mesh, [0.1, 0, 0]);
  engine.frame();
  assert.equal(renderer.writes, 3, 'one transform per moved label');
});

test('distance scaling and the occlusion hook', () => {
  const { engine, renderer, document } = setup({ renderer: { occlude: (_label, info) => info.x < 100 } });
  const scaled = renderer.add(document.createElement('div'), {
    position: [0, 0, 0],
    distanceScale: { reference: 10, max: 1.5 },
  });
  const clamped = renderer.add(document.createElement('div'), {
    position: [0, 0, 4],
    distanceScale: { reference: 10, max: 1.5 },
  });
  const left = renderer.add(document.createElement('div'), { position: [-4.5, 0, 0] });
  let calls = 0;
  const custom = renderer.add(document.createElement('div'), {
    position: [-4.5, 0, 0],
    occlude: (label, info) => {
      calls++;
      assert.equal(label, custom);
      assert.ok(close(info.distance, Math.hypot(4.5, 5), 1e-5));
      return false;
    },
  });
  engine.frame();
  assert.match(scaled.element.style.transform, / scale\(1\.5\) /, 'clamped to max');
  assert.match(clamped.element.style.transform, / scale\(1\.5\) /);
  scaled.distanceScale = 20;
  engine.frame();
  assert.match(scaled.element.style.transform, / scale\(4\) /);
  assert.equal(left.element.style.display, 'none', 'renderer occlusion hook hides labels');
  assert.equal(custom.element.style.display, '', 'label hook overrides the renderer hook');
  assert.equal(calls, 2);
});

test('WebGL2 backend uses its own clip space', () => {
  const { engine, renderer, document } = setup({ backend: 'webgl2' });
  const label = renderer.add(document.createElement('div'), { position: [1, 1, -2] });
  const behind = renderer.add(document.createElement('div'), { position: [0, 0, 6] });
  engine.frame();
  const expected = projectPoint(engine.camera.matrix, 1, 1, -2, 800, 400, 'webgl2');
  const [x, y] = translate(label.element);
  assert.ok(close(x, expected.x, 0.01) && close(y, expected.y, 0.01));
  assert.equal(behind.element.style.display, 'none');
});

test('CSS3D objects get perspective, camera and object transforms, and follow meshes', () => {
  const { engine, renderer, document } = setup();
  const mesh = engine.createMesh([0, 1, 0]);
  const panel = renderer.add3D(document.createElement('div'), { mesh, pixelScale: 0.02 });
  const free = renderer.add3D(document.createElement('div'), {
    position: [1, 0, 0],
    quaternion: [0, Math.SQRT1_2, 0, Math.SQRT1_2],
  });
  const behind = renderer.add3D(document.createElement('div'), { position: [0, 0, 7] });
  engine.frame();
  const viewer = renderer.root.children[0],
    cameraElement = viewer.children[0];
  assert.equal(viewer.style.perspective, `${Math.round(cssPerspective(60, 400) * 100) / 100}px`);
  assert.equal(cameraElement.style.transformStyle, 'preserve-3d');
  assert.equal(
    cameraElement.style.transform,
    cameraCSSTransform(lookAtView([0, 0, 5], [0, 0, 0]), cssPerspective(60, 400), 800, 400),
  );
  assert.equal(panel.element.style.transform, objectCSSTransform(engine.store.matrices.subarray(0, 16), 0.02));
  assert.equal(
    free.element.style.transform,
    objectCSSTransform(composeMatrix([1, 0, 0], [0, Math.SQRT1_2, 0, Math.SQRT1_2]), 0.01),
  );
  assert.equal(behind.element.style.display, 'none');
  assert.equal(behind.onScreen, false);
  engine.move(mesh, [0, 2, 0]);
  engine.frame();
  assert.match(panel.element.style.transform, /,0,2,0,1\)$/);
  const writes = panel.element.styleWrites;
  engine.frame();
  assert.equal(panel.element.styleWrites, writes);
  assert.equal(renderer.writes, 0);
});

test('remove and dispose clean up every element and the overlay root', () => {
  const { engine, renderer, document } = setup();
  const a = renderer.add(document.createElement('div'), { position: [0, 0, 0] });
  const b = renderer.add3D(document.createElement('div'));
  renderer.add(document.createElement('span'), { position: [1, 0, 0] });
  engine.frame();
  a.remove();
  assert.equal(a.element.parentElement, null);
  assert.equal(renderer.size, 2);
  const root = renderer.root;
  renderer.dispose();
  assert.equal(root.parentElement, null);
  assert.equal(b.element.parentElement, null);
  assert.equal(engine.container.children.length, 1, 'only the canvas remains');
  assert.equal(renderer.root, null);
  renderer.update();
  assert.equal(renderer.writes, 0);
});

// Orthographic cameras (@margoengine/cameras replaces camera.update; labels only read camera.matrix).
const orthographic = (camera, options) => {
  new CameraProjection(options).attach(camera);
  return camera;
};

test('orthographic: projectPoint keeps labels in front and CSS3D corners land on the projected corners', () => {
  const width = 640,
    height = 360;
  for (const backend of ['webgpu', 'webgl2']) {
    const camera = orthographic(new Camera({ position: [2, 1.5, 4], target: [0, 0.25, 0], fov: 55 }), {
      height: 3,
      zoom: 1.5,
      near: -2,
      far: 20,
    });
    camera.update(width / height, backend === 'webgpu');
    assert.ok(isOrthographic(camera.matrix));
    // Behind the eye but inside the (negative) near plane: still drawn by the GPU, so still in the frustum.
    const back = [2, 1.25, 4].map((v) => v / Math.hypot(2, 1.25, 4)),
      behind = projectPoint(camera.matrix, 2 + back[0], 1.5 + back[1], 4 + back[2], width, height, backend);
    assert.ok(behind.inFront && behind.inFrustum && behind.depth > 0 && behind.depth < 1);
    const world = composeMatrix([0.3, 0.2, -0.4], [0.2, 0.3, -0.1, 0.92], [1.5, 0.8, 1]);
    const pixelScale = 0.01,
      elementWidth = 120,
      elementHeight = 80;
    const setup = {
      viewerWidth: width,
      viewerHeight: height,
      perspective: Infinity,
      camera: orthographicCSSTransform(camera.matrix, width, height, backend),
      object: objectCSSTransform(world, pixelScale),
      elementWidth,
      elementHeight,
    };
    for (const [cx, cy] of [
      [0, 0],
      [elementWidth, 0],
      [0, elementHeight],
      [elementWidth, elementHeight],
      [60, 40],
    ]) {
      const css = cssScreen([cx, cy], setup);
      const projected = projectPoint(
        camera.matrix,
        ...cssPointToWorld(world, pixelScale, cx - elementWidth / 2, cy - elementHeight / 2),
        width,
        height,
        backend,
      );
      assert.ok(
        close(css[0], projected.x, 1e-2) && close(css[1], projected.y, 1e-2),
        `${backend} corner ${cx},${cy}: css ${css} vs ${projected.x},${projected.y}`,
      );
    }
    // CSS depth follows the camera: nearer points get larger CSS z (drawn on top with preserve-3d).
    const m = cssMatrix(setup.camera, width, height),
      z = (p) => m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14];
    const toward = [
      camera.position[0] - camera.target[0],
      camera.position[1] - camera.target[1],
      camera.position[2] - camera.target[2],
    ];
    assert.ok(z(toward) > z([0, 0, 0]), backend);
  }
  const perspective = new Camera({ position: [2, 1.5, 4], target: [0, 0.25, 0] });
  perspective.update(1, true);
  assert.equal(isOrthographic(perspective.matrix), false);
});

test('orthographic: renderer drops CSS perspective, hides objects before the near plane and scales labels by zoom', () => {
  const { engine, renderer, document } = setup();
  const projection = new CameraProjection({ height: 4, near: 1, far: 20 });
  projection.attach(engine.camera);
  const panel = renderer.add3D(document.createElement('div'), { position: [0, 1, 0] });
  const before = renderer.add3D(document.createElement('div'), { position: [0, 0, 4.5] });
  const label = renderer.add(document.createElement('div'), { position: [1, 0.5, 0], distanceScale: 10 });
  const far = renderer.add(document.createElement('div'), { position: [1, 0.5, -10], distanceScale: 10 });
  engine.frame();
  const viewer = renderer.root.children[0],
    cameraElement = viewer.children[0];
  assert.equal(viewer.style.perspective, 'none');
  assert.equal(cameraElement.style.transform, orthographicCSSTransform(engine.camera.matrix, 800, 400));
  assert.equal(panel.element.style.display, '');
  assert.equal(before.element.style.display, 'none', 'eye-space z 0.5 is before the near plane at 1');
  const expected = projectPoint(engine.camera.matrix, 1, 0.5, 0, 800, 400);
  const [x, y] = translate(label.element);
  assert.ok(close(x, expected.x, 0.01) && close(y, expected.y, 0.01));
  // Height 4 at fov 60 is what a perspective camera sees at 2 / tan(30 deg) = 3.464: scale 10 / 3.464, at any depth.
  const scale = (element) => Number(element.style.transform.match(/scale\(([-\d.]+)\)/)[1]);
  assert.ok(close(scale(label.element), 10 / (2 / Math.tan(Math.PI / 6)), 1e-3));
  assert.equal(scale(far.element), scale(label.element));
  projection.zoom = 2;
  engine.frame();
  assert.ok(
    close(scale(label.element), 20 / (2 / Math.tan(Math.PI / 6)), 1e-3),
    'zooming in enlarges distance-scaled labels',
  );
  projection.dispose();
  engine.frame();
  assert.equal(viewer.style.perspective, `${Math.round(cssPerspective(60, 400) * 100) / 100}px`, 'back to perspective');
});

test('LabelRenderer direct disposal unregisters its pass and allows a replacement',()=>{
 const engine=fakeEngine(Camera),plugins=new Map();engine.hasPlugin=name=>plugins.has(name);engine.removePlugin=name=>{const plugin=plugins.get(name);plugins.delete(name);engine.passes.length=0;plugin?.dispose();};
 const renderer=new LabelRenderer();renderer.setup(engine);renderer.registerPasses(engine.graph);plugins.set(renderer.name,renderer);renderer.dispose();
 assert.equal(plugins.size,0);assert.equal(engine.passes.length,0);const replacement=new LabelRenderer();replacement.setup(engine);replacement.registerPasses(engine.graph);plugins.set(replacement.name,replacement);engine.frame();replacement.dispose();assert.equal(plugins.size,0);
});
