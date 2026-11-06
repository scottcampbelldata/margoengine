// Real-GPU checks of the optional line features, on a canvas of their own. Each check returns a line for the report.
import { Engine, box } from '@margoengine/core';
import { Lines, Line } from '@margoengine/lines';
import { LinePicking } from '@margoengine/lines/pick';
import { Trail } from '@margoengine/lines/trail';
import { Picking } from '../../selection/dist/index.js';
import { LineBatch, LineBatches } from '@margoengine/lines/batch';
import { EdgesHelper } from '@margoengine/lines/edges';
import { HiddenLine } from '@margoengine/lines/hidden';
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

async function trail() {
  const { engine, lines, frame, done } = await rig();
  const mesh = engine.createMesh().setGeometry(box(0.01, 0.01, 0.01));
  const trailLine = lines.add(
    new Trail({ target: mesh, lifetime: Infinity, maxLength: 6.5, width: 10, color: RED, tailWidth: 0.2, minDistance: 0 }),
  );
  // Walking the mesh along x leaves a line behind it, wide at the head and thin at the far end, faint at the far end.
  for (let x = -3; x <= 3; x += 0.5) {
    mesh.setPosition([x, 0, 0]);
    await frame();
  }
  let image = await frame();
  const head = pixel(2.8, 0, 0),
    tail = pixel(-2.8, 0, 0);
  const rows = (x) => {
    let n = 0;
    for (let y = 100; y < 156; y++) if (image.at(Math.round(x), y)[0] > 40) n++;
    return n;
  };
  assert(image.at(Math.round(head[0]), 128)[0] > 200, 'The head is full colour');
  assert(rows(head[0]) > rows(tail[0]) + 2, `The far end is thinner: ${rows(head[0])} against ${rows(tail[0])}`);
  // Time up: nothing left to draw.
  trailLine.lifetime = 0.5;
  trailLine.update(engine, 1);
  image = await frame();
  assert(lines.stats.lines === 0, 'An aged-out trail draws nothing');
  assert(image.at(Math.round(head[0]), 128)[0] < 40, 'An aged-out trail leaves no pixels');
  done();
  return 'Trail follows a mesh, thins and fades toward its far end, and disappears when aged out';
}

async function batch() {
  const { engine, frame, done } = await rig();
  const batches = LineBatches.attach(engine);
  // Two million segments in one draw: a fan of short ones far from the view, then the two the checks look at.
  const count = 2_000_000,
    positions = new Float32Array(count * 6);
  for (let i = 0; i < count; i++) {
    positions[i * 6] = 40 + (i % 100);
    positions[i * 6 + 3] = 41 + (i % 100);
  }
  positions.set([-3, 0, 0, 3, 0, 0, 0, -3, 1, 0, 3, 1]);
  const colors = new Float32Array(count * 3).fill(1);
  colors.set([1, 0, 0, 0, 1, 0]);
  const lines = batches.add(new LineBatch({ positions, colors, width: 6 }));
  let image = await frame();
  assert(batches.stats.drawCalls === 1 && batches.stats.segments === count, 'Two million segments are one draw');
  assert(isGreen(image.at(128, 128)), 'The later segment covers the crossing');
  assert(isRed(image.at(90, 128)), 'A segment draws its own colour');
  // Pixel width, summed down a column.
  let rows = 0;
  for (let y = 100; y < 156; y++) if (image.at(90, y)[0] > 128) rows++;
  assert(rows === 6, `A 6 px segment covers ${rows} rows`);
  // World width: 1 unit at distance 10 is 22 pixels.
  lines.worldUnits = true;
  lines.width = 1;
  image = await frame();
  rows = 0;
  for (let y = 100; y < 156; y++) if (image.at(90, y)[0] > 128) rows++;
  assert(Math.abs(rows - 22.17) <= 1.5, `A world-unit segment covers ${rows} rows`);
  lines.worldUnits = false;
  lines.width = 6;
  // Depth: a box in front hides the segment, onTop draws over it.
  const mesh = engine.createMesh().setGeometry(box(2, 2, 2));
  mesh.setPosition([-1.5, 0, 3]);
  image = await frame();
  const covered = pixel(-1.5, 0, 0);
  assert(!isRed(image.at(Math.round(covered[0]), 128)), 'A mesh in front hides a batch');
  lines.onTop = true;
  image = await frame();
  assert(isRed(image.at(Math.round(covered[0]), 128)), 'An onTop batch draws over it');
  // A partial update moves one segment and leaves the rest.
  lines.onTop = false;
  mesh.dispose();
  lines.updateSegments(0, [-3, 2, 0, 3, 2, 0]);
  image = await frame();
  const moved = pixel(-2, 2, 0);
  assert(isRed(image.at(Math.round(moved[0]), Math.round(moved[1]))), 'An updated segment moves');
  assert(!isRed(image.at(90, 128)), 'It leaves its old place');
  // A segment crossing the camera plane is cut, not mirrored.
  lines.updateSegments(1, [1, -1, 30, 1, -1, -30]);
  image = await frame();
  let mirrored = 0;
  for (let y = 0; y < 120; y++) for (let x = 0; x < 120; x++) if (isGreen(image.at(x, y))) mirrored++;
  assert(mirrored === 0, `A segment past the camera mirrored ${mirrored} pixels`);
  await engine.rebootDevice?.();
  image = await frame();
  assert(isRed(image.at(Math.round(moved[0]), Math.round(moved[1]))), 'A batch survives a device reboot');
  done();
  return 'LineBatch draws two million segments in one draw at exact widths, depth tested, with partial updates';
}

async function hidden() {
  const { engine, lines, frame, done } = await rig();
  const geometry = box(2, 2, 2);
  const mesh = engine.createMesh().setGeometry(geometry);
  const edges = lines.add(new EdgesHelper(geometry, { mesh, color: RED, width: 3, cap: 'butt' }));
  const back = lines.add(new HiddenLine(edges, { opacity: 1, dashSize: 0.2, gapSize: 0.2 }));
  let image = await frame();
  // Front face edge at z = 1 and back face edge at z = -1, both vertical at x = 1, inside the front face's rows.
  const front = Math.round(pixel(1, 0, 1)[0]) - 1,
    behind = Math.round(pixel(1, 0, -1)[0]);
  const column = (x) => {
    let on = 0,
      runs = 0,
      was = false;
    for (let y = 112; y < 144; y++) {
      const red = isRed(image.at(x, y));
      if (red) on++;
      if (red && !was) runs++;
      was = red;
    }
    return { on, runs };
  };
  const seen = column(front),
    dashed = column(behind);
  assert(seen.on === 32 && seen.runs === 1, `An edge on the surface is solid: ${JSON.stringify(seen)}`);
  assert(dashed.runs >= 3 && dashed.on < 28, `A hidden edge is dashed: ${JSON.stringify(dashed)}`);
  // Faded: the hidden edge is a blend of the box and the line, never full colour, and has no gaps.
  back.material.set({ dashed: false, opacity: 0.3 });
  image = await frame();
  const faded = image.at(behind, 128),
    bare = image.at(behind + 6, 128);
  assert(!isRed(faded) && faded[0] > bare[0] + 10, `A faded edge blends: ${faded} over ${bare}`);
  done();
  return 'HiddenLine draws edges behind a surface dashed or faded while edges on the surface stay solid';
}

window.runLineFeatures = async () => {
  const checks = [];
  for (const check of [depthWrite, picking, trail, batch, hidden]) checks.push(await check());
  return checks;
};
