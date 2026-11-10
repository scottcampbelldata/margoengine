import { Engine, PbrMaterial, box } from '@margoengine/core';
import { engineRuntime, meshRuntime } from '@margoengine/core/extension';
import { LabelRenderer, cssPointToWorld } from '@margoengine/labels';
import { Callouts } from '@margoengine/labels/callouts';
import { DistanceLabels } from '@margoengine/labels/distance';
import { ClusterLabels } from '@margoengine/labels/cluster';
import { RoutedCallouts } from '@margoengine/labels/callouts-route';
import { projectPoint } from '@margoengine/math/mat4';
import { webglRenderer } from '@margoengine/webgl2-compat/preview';

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};
const center = (element) => {
  const r = element.getBoundingClientRect();
  return [r.left + r.width / 2, r.top + r.height / 2];
};
const tag = (text) => {
  const element = document.createElement('div');
  element.className = 'tag';
  element.textContent = text;
  return element;
};

/** Projected world point in page coordinates (canvas content box origin + CSS pixels, times any CSS scale above). */
function pagePoint(engine, point) {
  const canvas = engine.canvas,
    rect = canvas.getBoundingClientRect(),
    scale = rect.width / canvas.offsetWidth;
  const p = projectPoint(
    engine.camera.matrix,
    point[0],
    point[1],
    point[2],
    canvas.clientWidth,
    canvas.clientHeight,
    engine.backend,
  );
  return [rect.left + (canvas.clientLeft + p.x) * scale, rect.top + (canvas.clientTop + p.y) * scale];
}
function readPixel(canvas, x, y) {
  const copy = document.createElement('canvas');
  copy.width = canvas.width;
  copy.height = canvas.height;
  const context = copy.getContext('2d');
  context.drawImage(canvas, 0, 0);
  return [...context.getImageData(Math.round(x), Math.round(y), 1, 1).data];
}

async function scenario(backend) {
  const checks = [],
    measurements = {};
  const canvas = document.getElementById('view');
  const engine = await Engine.create(canvas, {
    backend,
    fallback: webglRenderer,
    camera: { position: [0, 1.5, 6], target: [0, 0, 0], near: 0.1, far: 100 },
  });
  assert(engine.backend === backend, `Expected ${backend}, got ${engine.backend}`);
  const gpuErrors = [];
  const device = engine.gpu;
  device?.addEventListener('uncapturederror', (event) => gpuErrors.push(event.error.message));
  device?.pushErrorScope('validation');
  const labels = new LabelRenderer();
  engine.use(labels);
  const material = new PbrMaterial({ color: [0.95, 0.15, 0.1], roughness: 0.6 });
  const mesh = engine.createMesh().setGeometry(box()).setMaterial(material).setPosition([0.8, 0.2, 0]);
  const label = labels.add(tag('A'), { mesh });
  engine.render();
  const root = document.querySelector('[data-margoengine-labels]');
  const canvasRect = canvas.getBoundingClientRect(),
    rootRect = root.getBoundingClientRect();
  assert(
    Math.abs(rootRect.left - canvasRect.left - canvas.clientLeft) < 0.5 &&
      Math.abs(rootRect.top - canvasRect.top - canvas.clientTop) < 0.5 &&
      Math.abs(rootRect.width - canvas.clientWidth) < 0.5,
    `Overlay root misplaced ${JSON.stringify(rootRect)} vs ${JSON.stringify(canvasRect)}`,
  );
  let expected = pagePoint(engine, [0.8, 0.2, 0]),
    actual = center(label.element);
  measurements.centerError = Math.hypot(actual[0] - expected[0], actual[1] - expected[1]);
  assert(measurements.centerError <= 1, `${backend}: label ${actual} vs projected center ${expected}`);
  // Pixel readback: the mesh really is under the label.
  if (backend === 'webgpu') {
    const pixel = readPixel(
      canvas,
      expected[0] - canvasRect.left - canvas.clientLeft,
      expected[1] - canvasRect.top - canvas.clientTop,
    );
    measurements.pixelUnderLabel = pixel;
    assert(
      pixel[0] > 80 && pixel[0] > pixel[1] * 1.5 && pixel[0] > pixel[2] * 1.5,
      `Mesh not rendered under the label: ${pixel}`,
    );
  }
  checks.push(
    `${backend}: overlay covers the canvas content box; a mesh label sits on the projected mesh center within 1 px`,
  );

  // Follows a moving mesh.
  mesh.setPosition([-1.2, -0.4, 0.5]);
  engine.render();
  expected = pagePoint(engine, [-1.2, -0.4, 0.5]);
  actual = center(label.element);
  measurements.followError = Math.hypot(actual[0] - expected[0], actual[1] - expected[1]);
  assert(measurements.followError <= 1, `${backend}: label did not follow the mesh ${actual} vs ${expected}`);
  checks.push(`${backend}: the label follows a moving mesh`);

  // Scaled ancestors: the canvas's frame scaled by CSS. Labels beside the canvas, and in a second overlay placed in
  // document.body (outside the scaled frame, so it is scaled itself), stay on their points.
  const frame = canvas.parentElement;
  const outside = new LabelRenderer({ parent: document.body, name: 'margoengine-labels-outside' });
  engine.use(outside);
  const free = outside.add(tag('B'), { position: [0.6, 0.7, 0] });
  frame.style.transformOrigin = '0 0';
  for (const scale of [0.75, 2]) {
    frame.style.transform = `scale(${scale})`;
    engine.render();
    expected = pagePoint(engine, [-1.2, -0.4, 0.5]);
    actual = center(label.element);
    const inside = Math.hypot(actual[0] - expected[0], actual[1] - expected[1]);
    const away = pagePoint(engine, [0.6, 0.7, 0]),
      there = center(free.element),
      outsideError = Math.hypot(there[0] - away[0], there[1] - away[1]),
      size = free.element.getBoundingClientRect().width / free.element.offsetWidth;
    measurements[`scaled${scale}`] = { inside, outside: outsideError, size };
    assert(inside <= 1, `${backend}: at scale ${scale} the label is ${inside} px off its point`);
    assert(outsideError <= 1, `${backend}: at scale ${scale} the outside label is ${outsideError} px off its point`);
    assert(Math.abs(size - scale) < 1e-3, `${backend}: at scale ${scale} the outside label is drawn at ${size}`);
  }
  frame.style.transform = '';
  engine.removePlugin(outside.name);
  engine.render();
  assert(!free.element.isConnected, 'the outside overlay was not removed');
  checks.push(
    `${backend}: with the canvas's frame scaled by 0.75 and 2, labels beside the canvas and in an overlay outside the frame stay within 1 px of their points in one update`,
  );

  // Pointer events pass through to the canvas by default.
  assert(document.elementFromPoint(...center(label.element)) === canvas, 'Default label blocked pointer events');

  // Hidden behind the camera, back when in front again.
  engine.camera.position = [0, 1.5, -6];
  engine.camera.target = [0, 1.5, -12];
  engine.render();
  assert(
    getComputedStyle(label.element).display === 'none' && !label.onScreen,
    `${backend}: label behind the camera is visible`,
  );
  engine.camera.position = [0, 1.5, 6];
  engine.camera.target = [0, 0, 0];
  engine.render();
  assert(getComputedStyle(label.element).display !== 'none', 'label did not come back');
  checks.push(`${backend}: the label hides when its mesh is behind the camera`);

  // Depth order: two overlapping (both on the camera's line of sight) interactive labels; the nearer one is on top.
  const farLabel = labels.add(tag('far'), { position: [0, -0.75, -3], pointerEvents: 'auto' });
  const nearLabel = labels.add(tag('near'), { position: [0, 0.75, 3], pointerEvents: 'auto' });
  engine.render();
  const overlap = center(farLabel.element);
  assert(
    document.elementFromPoint(overlap[0], overlap[1]) === nearLabel.element,
    `${backend}: near label is not on top`,
  );
  assert(Number(nearLabel.element.style.zIndex) > Number(farLabel.element.style.zIndex), 'z-index not sorted');
  // Look back along the same line from the other side so the labels still overlap.
  engine.camera.position = [0, -2.25, -9];
  engine.camera.target = [0, 0, 0];
  engine.render();
  const flipped = center(nearLabel.element);
  assert(
    document.elementFromPoint(flipped[0], flipped[1]) === farLabel.element,
    `${backend}: z-order did not follow depth after moving the camera`,
  );
  engine.camera.position = [0, 1.5, 6];
  checks.push(
    `${backend}: labels z-order by depth (hit testing picks the nearer one) and re-sort when the camera moves`,
  );

  // CSS3D: corner markers of a rotated, scaled panel land on the projected world corners.
  const panel = document.createElement('div');
  panel.className = 'panel';
  const corners = [
    [0, 0],
    [100, 0],
    [0, 60],
    [100, 60],
  ].map(([x, y]) => {
    const marker = document.createElement('div');
    marker.className = 'corner';
    marker.style.left = `${x}px`;
    marker.style.top = `${y}px`;
    panel.appendChild(marker);
    return [marker, x, y];
  });
  const holder = engine.createMesh().setPosition([0.4, 0.9, 0.3]).setRotation([0.3, 0.6, 0.15]).setScale([1.4, 1.1, 1]);
  const object = labels.add3D(panel, { mesh: holder, pixelScale: 0.012 });
  engine.render();
  const world = engineRuntime(engine).store.matrices.subarray(holderId(holder) * 16, holderId(holder) * 16 + 16);
  let worst = 0;
  for (const [marker, x, y] of corners) {
    const point = cssPointToWorld(world, object.pixelScale, x - 50, y - 30),
      expectedCorner = pagePoint(engine, point);
    const r = marker.getBoundingClientRect();
    worst = Math.max(worst, Math.hypot(r.left - expectedCorner[0], r.top - expectedCorner[1]));
  }
  measurements.css3dCornerError = worst;
  assert(worst <= 2, `${backend}: CSS3D corners off by ${worst}px`);
  checks.push(`${backend}: CSS3D element corners land on the projected world corners within 2 px`);

  // CSS3D near plane: a tilted panel whose origin is behind the near plane is cut there, not hidden whole. A point of
  // its far half hits it; a point of its near half, in front of the camera but before the near plane, does not.
  farLabel.visible = false;
  nearLabel.visible = false;
  engine.camera.position = [0, 0, 6];
  engine.camera.target = [0, 0, 0];
  engine.camera.near = 2;
  const tilted = document.createElement('div');
  tilted.className = 'panel';
  const angle = Math.PI / 6; // half of 60 degrees about x: the element's top leans toward the camera
  const cut = labels.add3D(tilted, {
    position: [0, 0, 4.1],
    quaternion: [Math.sin(angle), 0, 0, Math.cos(angle)],
    pixelScale: 0.02,
    pointerEvents: 'auto',
  });
  engine.render();
  const at = (x, y) => pagePoint(engine, cssPointToWorld(cut.matrix, cut.pixelScale, x - 50, y - 30));
  const viewDepth = (x, y) => 6 - cssPointToWorld(cut.matrix, cut.pixelScale, x - 50, y - 30)[2];
  assert(viewDepth(50, 30) < 2, `${backend}: the panel origin should be behind the near plane`);
  assert(cut.onScreen && cut.clipped && getComputedStyle(tilted).display !== 'none', `${backend}: cut panel hidden`);
  assert(
    viewDepth(50, 55) > 2.1 && document.elementFromPoint(...at(50, 55)) === tilted,
    `${backend}: far half missing`,
  );
  const nearHalf = at(50, 4);
  assert(viewDepth(50, 4) > 0.5 && viewDepth(50, 4) < 1.9, `${backend}: probe not between camera and near plane`);
  assert(document.elementFromPoint(...nearHalf) !== tilted, `${backend}: the part before the near plane is drawn`);
  measurements.css3dCut = getComputedStyle(tilted).clipPath;
  engine.camera.near = 0.1;
  checks.push(
    `${backend}: a CSS3D panel through the near plane is cut there (hit inside its far half, not its near half)`,
  );

  // Callouts: a label moved off its point gets a line from the projected point to the nearest point of its box, as
  // the browser laid the box out.
  const callouts = new Callouts();
  labels.layout = callouts;
  const note = labels.add(tag('note'), { position: [-0.5, -0.5, 0], screenOffset: [-70, 45] });
  engine.render();
  const line = callouts.svg.querySelector('line'),
    rootBox = root.getBoundingClientRect(),
    noteBox = note.element.getBoundingClientRect(),
    from = pagePoint(engine, [-0.5, -0.5, 0]);
  const value = (name) => Number(line.getAttribute(name));
  const start = [rootBox.left + value('x1'), rootBox.top + value('y1')],
    end = [rootBox.left + value('x2'), rootBox.top + value('y2')],
    nearest = [
      Math.min(Math.max(from[0], noteBox.left), noteBox.right),
      Math.min(Math.max(from[1], noteBox.top), noteBox.bottom),
    ];
  measurements.calloutStartError = Math.hypot(start[0] - from[0], start[1] - from[1]);
  measurements.calloutEndError = Math.hypot(end[0] - nearest[0], end[1] - nearest[1]);
  assert(callouts.lines === 1 && getComputedStyle(line).display !== 'none', `${backend}: no callout line drawn`);
  assert(measurements.calloutStartError <= 1, `${backend}: callout line starts ${start} vs point ${from}`);
  assert(measurements.calloutEndError <= 1, `${backend}: callout line ends ${end} vs box ${nearest}`);
  checks.push(
    `${backend}: a callout line runs from the projected point to the nearest point of the label box within 1 px`,
  );

  const distance = new DistanceLabels();
  // Keep this exact width assertion at an integral screen location. Fractional
  // bounding-box subtraction otherwise introduces float32 cancellation in Chromium.
  note.setPosition(engine.camera.target);
  engine.render();
  const distanceWidth = note.element.getBoundingClientRect().width;
  assert(distanceWidth === note.element.offsetWidth, 'distance fixture must start at an integral pixel');
  labels.layout = distance;
  distance.set(note, {
    opacity: { near: 0, far: 10000, nearValue: 0.5, farValue: 0.5 },
    scale: { near: 0, far: 10000, nearValue: 2, farValue: 2 },
  });
  engine.render();
  assert(note.scale === 2 && getComputedStyle(note.element).opacity === '0.5', 'distance opacity or scale missing');
  assert(note.element.getBoundingClientRect().width === distanceWidth * 2, 'distance scale did not reach DOM geometry');
  distance.set(note, { near: note.distance + 1 });
  engine.render();
  assert(!note.onScreen && getComputedStyle(note.element).display === 'none', 'near distance limit did not hide');
  distance.set(note, { far: 10000 });
  engine.render();
  assert(note.onScreen, 'distance label did not recover');
  distance.dispose();
  checks.push(`${backend}: distance layout scales real DOM geometry, fades, hides and recovers`);

  const clusterLayout = new ClusterLabels({ maxZoom: 2 });
  const clusterRenderer = new LabelRenderer({ name: 'cluster-check', layout: clusterLayout });
  engine.use(clusterRenderer);
  const ca = clusterRenderer.add(tag('a'), { position: engine.camera.target });
  const cb = clusterRenderer.add(tag('b'), { position: engine.camera.target });
  engine.render();
  assert(clusterLayout.clusters.length === 1 && clusterLayout.clusters[0].count === 2, 'cluster count missing');
  assert(!ca.onScreen && !cb.onScreen, 'cluster members were not hidden');
  const bubble = clusterLayout.clusters[0].element;
  const bubbleCenter = center(bubble),
    expectedBubble = pagePoint(engine, engine.camera.target);
  assert(
    Math.hypot(bubbleCenter[0] - expectedBubble[0], bubbleCenter[1] - expectedBubble[1]) <= 1,
    'cluster bubble is not at the projected centroid',
  );
  assert(bubble.textContent === '2' && bubble.getBoundingClientRect().width > 0, 'cluster bubble not drawn');
  clusterLayout.setZoom(3);
  engine.render();
  assert(
    ca.onScreen && cb.onScreen && !bubble.isConnected && clusterLayout.clusters.length === 0,
    'cluster zoom split failed',
  );
  engine.removePlugin(clusterRenderer.name);
  clusterLayout.dispose();
  checks.push(`${backend}: count bubble projects at its centroid, hides members and splits at the zoom limit`);

  const routing = new RoutedCallouts({ side: 'right' });
  const routedRenderer = new LabelRenderer({ name: 'routes-check', layout: routing });
  engine.use(routedRenderer);
  const target = engine.camera.target;
  const routedLabels = [target, [target[0] + 0.3, target[1] + 0.1, target[2]], target].map((position) =>
    routedRenderer.add(tag('route'), { position }),
  );
  engine.render();
  assert(routing.routes.length === 3 && routing.svg.querySelectorAll('polyline').length === 3, 'elbow routes missing');
  const routeRoot = routing.svg.parentElement.getBoundingClientRect();
  for (const route of routing.routes) {
    const label = routedLabels[route.source],
      labelBox = label.element.getBoundingClientRect();
    const p = route.points[2];
    assert(
      Math.hypot(labelBox.left - routeRoot.left - p[0], (labelBox.top + labelBox.bottom) / 2 - routeRoot.top - p[1]) <=
        1,
      'elbow endpoint missed its reordered label box',
    );
    assert(route.points.length === 3 && label.onScreen, 'routed label was hidden or lost its elbow');
  }
  engine.render();
  assert(routing.writes === 0, 'still elbow frame made SVG geometry writes');
  engine.removePlugin(routedRenderer.name);
  routing.dispose();
  checks.push(
    `${backend}: angled elbow SVGs terminate at reordered DOM label ports within 1 px and cache still frames`,
  );

  // Dispose cleans the DOM.
  const elements = [label.element, farLabel.element, nearLabel.element, panel, tilted, note.element, callouts.svg];
  if (device) {
    const error = await device.popErrorScope();
    if (error) gpuErrors.push(error.message);
  }
  engine.removePlugin(labels.name);
  assert(
    !document.querySelector('[data-margoengine-labels]') && elements.every((element) => !element.isConnected),
    'Dispose left overlay elements in the DOM',
  );
  assert(canvas.parentElement.children.length === 1, 'Unexpected siblings after dispose');
  engine.render();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert(gpuErrors.length === 0, `WebGPU validation errors: ${gpuErrors.join('; ')}`);
  checks.push(
    `${backend}: removing the plugin removes the overlay root and every element${device ? '; zero WebGPU validation errors' : ''}`,
  );
  engine.dispose();
  return { checks, measurements };
}
const holderId = (mesh) => meshRuntime(mesh).id;

window.runLabelTests = async () => {
  const webgpu = await scenario('webgpu');
  // A fresh canvas for the WebGL2 backend (a canvas keeps the first context type it was given).
  const old = document.getElementById('view'),
    fresh = document.createElement('canvas');
  fresh.id = 'view';
  fresh.setAttribute('aria-label', 'Label test scene');
  old.replaceWith(fresh);
  const webgl2 = await scenario('webgl2');
  return {
    checks: [...webgpu.checks, ...webgl2.checks],
    measurements: { webgpu: webgpu.measurements, webgl2: webgl2.measurements },
  };
};
