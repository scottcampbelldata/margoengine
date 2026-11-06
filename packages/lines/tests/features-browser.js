// Real-GPU checks of the optional line features, on a canvas of their own. Each check returns a line for the report.
import { Engine, box } from '@margoengine/core';
import { Lines, Line } from '@margoengine/lines';
import { LinePicking } from '@margoengine/lines/pick';
import { Picking } from '../../selection/dist/index.js';
import { Capture } from './lines-browser.js';

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};
const RED = '#ff0000',
  GREEN = '#00ff00',
  BLUE = '#0000ff';
const isRed = ([r, g, b]) => r > 200 && g < 60 && b < 60;
const isGreen = ([r, g, b]) => g > 200 && r < 60 && b < 60;
const isBlue = ([r, g, b]) => b > 200 && r < 60 && g < 60;

/** A fresh engine on its own 256 px canvas with one `Lines` plugin and pixel capture. */
async function rig() {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 256;
  canvas.style.cssText = 'width:256px;height:256px';
  document.body.append(canvas);
  const engine = await Engine.create(canvas, {
    backend: 'webgpu',
    camera: { position: [0, 0, 10], target: [0, 0, 0], fov: 60, near: 0.1, far: 100 },
  });
  const capture = new Capture(),
    lines = new Lines();
  engine.use(capture).use(lines);
  return {
    engine,
    canvas,
    lines,
    capture,
    frame: async () => {
      engine.render();
      return capture.read();
    },
    done: () => {
      engine.dispose();
      canvas.remove();
    },
  };
}

const horizontal = (z, options) => new Line({ positions: [-3, 0, z, 3, 0, z], width: 20, cap: 'butt', ...options });
const vertical = (z, options) => new Line({ positions: [0, -3, z, 0, 3, z], width: 20, cap: 'butt', ...options });

async function depthWrite() {
  const { lines, engine, frame, done } = await rig();
  // Not writing depth, the later line wins whatever its distance; writing, the nearer one does in either order.
  const near = lines.add(horizontal(1, { color: RED })),
    far = lines.add(vertical(0, { color: GREEN }));
  assert(isGreen((await frame()).at(128, 128)), 'Without depth writing the line drawn last should cover the crossing');
  near.material.depthWrite = far.material.depthWrite = true;
  assert(isRed((await frame()).at(128, 128)), 'The nearer line must win a crossing when it is drawn first');
  lines.clear();
  lines.add(far);
  lines.add(near);
  assert(isRed((await frame()).at(128, 128)), 'The nearer line must win a crossing when it is drawn last');
  // Gaps and clipped parts write nothing: the far line shows through a dash gap of the near one.
  near.material.set({ dashed: true, dashSize: 0.5, gapSize: 1, dashOffset: 1 });
  assert(isGreen((await frame()).at(128, 128)), 'A dash gap must not write depth');
  near.material.set({ dashed: false, clippingPlanes: [[0, 0, 1, 5]] });
  assert(isRed((await frame()).at(128, 128)), 'An uncut part writes depth');
  near.material.clippingPlanes = [[0, 0, -1, 0]];
  assert(isGreen((await frame()).at(128, 128)), 'A clipped part must not write depth');
  near.material.clippingPlanes = [];
  // What draws after respects them: a later plugin's line behind the crossing is hidden, one in front is not.
  const later = new Lines({ name: 'later', order: 25 });
  engine.use(later);
  const behind = later.add(horizontal(-1, { color: BLUE, width: 6 }));
  let image = await frame();
  assert(isRed(image.at(128, 128)), 'A line drawn after must stay behind a nearer depth-writing line');
  assert(!isBlue(image.at(100, 128)), 'The near line covers the later one along its whole length');
  behind.setPositions([-3, 0, 2, 3, 0, 2]);
  assert(isBlue((await frame()).at(128, 128)), 'A line drawn after and nearer stays in front');
  later.clear();
  // The edge keeps its ramp: a half-covered row is neither background nor full colour.
  near.material.width = 9;
  far.visible = false;
  image = await frame();
  const edge = image.at(100, 123)[0];
  assert(edge > 20 && edge < 235, `Depth-writing line lost its antialiased edge: ${edge}`);
  assert(lines.stats.drawCalls === 2, `Solid part and edge ramp are two draws, got ${lines.stats.drawCalls}`);
  // onTop with depth writing wins over the scene and still writes.
  near.material.set({ onTop: true, width: 20 });
  far.visible = true;
  near.setPositions([-3, 0, -2, 3, 0, -2]);
  assert(isRed((await frame()).at(128, 128)), 'onTop depth-writing line draws over a nearer line');
  done();
  return 'Depth-writing lines occlude each other in either order, gaps and cuts write nothing, later passes respect them';
}

/** Canvas pixel of a world point under the rig's camera. */
const pixel = (x, y, z) => [128 + (x * 221.7) / (10 - z), 128 - (y * 221.7) / (10 - z)];

async function picking() {
  for (const capture of [false, true]) {
    const { engine, lines, done } = await rig();
    const picker = Picking.attach(engine, { capture }),
      linePicking = LinePicking.attach(picker, lines),
      mesh = engine.createMesh().setGeometry(box(2, 2, 2));
    const front = lines.add(new Line({ positions: [-3, 0, 3, 0, 0, 3, 3, 0, 3], width: 8 })),
      back = lines.add(new Line({ positions: [-3, 2, -3, 3, 2, -3], width: 8 }));
    engine.render();
    await engine.gpu.queue.onSubmittedWorkDone();
    let hit = await picker.pick(...pixel(1.5, 0, 3));
    assert(hit?.line === front && hit.segment === 1, `Line in front of nothing: ${hit?.segment}`);
    hit = await picker.pick(...pixel(-1.5, 0, 3));
    assert(hit?.line === front && hit.segment === 0, 'First segment');
    hit = await picker.pick(...pixel(0.5, 0.2, 3));
    assert(!hit?.line || hit.line !== front, 'Off the line by more than its width');
    // A line nearer than the mesh wins; behind it the mesh wins.
    hit = await picker.pick(...pixel(0.5, 0, 3));
    assert(hit?.line === front, 'The nearer line wins over the mesh behind it');
    front.visible = false;
    hit = await picker.pick(...pixel(0.5, 0, 3));
    assert(hit?.mesh === mesh && !hit.line, 'A hidden line does not hit: the mesh behind it does');
    front.visible = true;
    back.setPositions([-3, 0.5, -3, 3, 0.5, -3]);
    hit = await picker.pick(...pixel(0, 0.5, 1));
    assert(hit?.mesh === mesh && !hit.line, 'A line behind the mesh is not hit');
    back.material.onTop = true;
    hit = await picker.pick(...pixel(0, 0.5, -3));
    assert(hit?.line === back, 'An onTop line wins over the mesh in front of it');
    back.material.onTop = false;
    hit = await picker.pick(...pixel(3, 0.5, -3 + 0));
    // Clipping planes: a cut part misses, the mesh or nothing answers.
    front.material.clippingPlanes = [[1, 0, 0, 0]];
    hit = await picker.pick(...pixel(-1.5, 0, 3));
    assert(!hit?.line, 'A part cut by a clipping plane does not hit');
    front.material.clippingPlanes = [];
    // Dash gaps hit.
    front.material.set({ dashed: true, dashSize: 0.1, gapSize: 10 });
    hit = await picker.pick(...pixel(1.5, 0, 3));
    assert(hit?.line === front, 'A dash gap hits');
    front.material.dashed = false;
    // engine.pick answers a stand-in, and the mesh of a line that follows one.
    const answer = await engine.pick(...pixel(1.5, 0, 3));
    assert(answer && linePicking.lineOf(answer) === front, 'engine.pick answers the stand-in of a line');
    assert(!answer.geometry, 'A stand-in has no geometry');
    front.attach(mesh);
    const attached = await engine.pick(...pixel(1.5, 0, 3));
    assert(attached === mesh, 'engine.pick answers the mesh a line follows');
    front.attach(null);
    const many = await picker.pickMany([pixel(1.5, 0, 3), pixel(0, 0.5, 1), [2, 2]]);
    assert(many[0]?.line === front && many[1]?.mesh === mesh && many[2] === null, 'pickMany agrees with pick');
    // A newly added line picks before any frame draws it.
    const fresh = lines.add(new Line({ positions: [-3, -3, 3, 3, -3, 3], width: 8 }));
    hit = await picker.pick(...pixel(0, -3, 3));
    assert(hit?.line === fresh, 'A line added since the last frame picks');
    linePicking.dispose();
    hit = await picker.pick(...pixel(1.5, 0, 3));
    assert(!hit?.line, 'After dispose lines do not pick');
    done();
  }
  return 'Lines pick with meshes in one depth test, by segment, through picking.pick, engine.pick and pickMany';
}

window.runLineFeatures = async () => {
  const checks = [];
  for (const check of [depthWrite, picking]) checks.push(await check());
  return checks;
};
