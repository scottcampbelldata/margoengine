// Real-GPU checks of the optional line features, on a canvas of their own. Each check returns a line for the report.
import { Engine, box } from '@margoengine/core';
import { Lines, Line, ArrowHelper, PlaneHelper } from '@margoengine/lines';
import { LinePicking } from '@margoengine/lines/pick';
import { TexturedLine, LineTexture, loadLineTexture } from '@margoengine/lines/texture';
import { DebugLines, ArcLine } from '@margoengine/lines/debug';
import { Stroke } from '@margoengine/lines/stroke';
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
    new Trail({
      target: mesh,
      lifetime: Infinity,
      maxLength: 6.5,
      width: 10,
      color: RED,
      tailWidth: 0.2,
      minDistance: 0,
    }),
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

// A tyre track: seen from the side a flat strip is a sliver, where a camera-facing trail keeps its width; from above it
// holds its world width, tapers to the tail, and a pick lands on it.
async function ribbon() {
  const { engine, lines, frame, done } = await rig(),
    make = (normal) =>
      lines.add(new Trail({ normal, width: 2, maxLength: 9, tailWidth: 0.5, fade: 0, color: RED, minDistance: 0 })),
    lay = (trail) => {
      for (const x of [-4, -2, 0, 2, 4]) trail.moveTo(x, 0, 0);
      trail.update(engine, 0);
    },
    rows = (image, x) => {
      let count = 0;
      for (let y = 0; y < 256; y++) if (isRed(image.at(x, y))) count++;
      return count;
    };
  try {
    const flat = make([0, 1, 0]);
    lay(flat);
    engine.camera.position = [0, 10, 0.001];
    engine.camera.target = [0, 0, 0];
    let image = await frame();
    const head = rows(image, 205),
      tail = rows(image, 51),
      expected = (2 / (2 * 10 * Math.tan(Math.PI / 6))) * 256;
    assert(
      Math.abs(Math.max(head, tail) - expected) < 3,
      `A flat trail is 2 world units wide: ${head}, ${tail} of ${expected}`,
    );
    assert(Math.min(head, tail) < 0.75 * Math.max(head, tail), `A flat trail tapers: ${head}, ${tail}`);
    engine.camera.position = [0, 0.01, 10];
    image = await frame();
    assert(rows(image, 128) <= 2, `Seen edge on, a flat trail is a sliver: ${rows(image, 128)}`);
    flat.dispose?.();
    lines.remove(flat);
    const facing = make(undefined);
    lay(facing);
    facing.material.set({ worldUnits: true });
    image = await frame();
    assert(rows(image, 128) > 20, `A trail with no normal still faces the camera: ${rows(image, 128)}`);
  } finally {
    done();
  }
  const { engine: picked, lines: pickLines, done: pickDone } = await rig();
  try {
    const picker = Picking.attach(picked, { capture: false }),
      linePicking = LinePicking.attach(picker, pickLines),
      strip = pickLines.add(new Trail({ normal: [0, 0, 1], width: 2, lifetime: Infinity, fade: 0, minDistance: 0 }));
    for (const x of [-3, 0, 3]) strip.moveTo(x, 0, 0);
    strip.update(picked, 0);
    picked.render();
    await picked.gpu.queue.onSubmittedWorkDone();
    const near = await picker.pick(...pixel(1, 0.8, 0)),
      off = await picker.pick(...pixel(1, 1.4, 0));
    assert(near?.line === strip, 'A pick inside the width of a flat trail lands on it');
    assert(off?.line !== strip, 'A pick past the width of a flat trail misses it');
    linePicking.dispose?.();
  } finally {
    pickDone();
  }
  return 'A flat trail lies in the world at its world width, tapers, shows edge on as a sliver, and picks across its width.';
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

async function coverage() {
  const { lines, capture, frame, done } = await rig();
  lines.add(horizontal(0, { color: RED, opacity: 0.5, alphaToCoverage: true }));
  lines.add(vertical(0, { color: GREEN, opacity: 0.5, alphaToCoverage: true }));
  const crossing = (await frame()).at(128, 128),
    samples = capture.target.samples;
  // With MSAA the later line takes over the same samples; without, it blends and red stays in the mix.
  if (samples > 1) assert(crossing[0] < 30 && crossing[1] > 90, `Coverage replaces at a crossing: ${crossing}`);
  else assert(crossing[0] > 30 && crossing[1] > 90, `Without MSAA lines blend: ${crossing}`);
  // Writing depth too, the nearer line wins in either order, opaque, in one draw each.
  lines.clear();
  lines.add(horizontal(1, { color: RED, depthWrite: true, alphaToCoverage: true }));
  lines.add(vertical(0, { color: GREEN, depthWrite: true, alphaToCoverage: true }));
  assert(isRed((await frame()).at(128, 128)), 'The nearer covered line wins a crossing');
  assert(lines.stats.drawCalls === (samples > 1 ? 2 : 4), `Draw calls: ${lines.stats.drawCalls}`);
  done();
  return `alphaToCoverage at ${samples} samples: crossing ${crossing.slice(0, 3)}`;
}

async function filled() {
  const { lines, frame, done } = await rig();
  const at = (image, x, y, z = 0) => image.at(Math.round(pixel(x, y, z)[0]), Math.round(pixel(x, y, z)[1]));
  const arrow = lines.add(
    new ArrowHelper({
      direction: [1, 0, 0],
      origin: [-3, 0, 0],
      length: 6,
      headLength: 3,
      headWidth: 3,
      color: RED,
      width: 2,
      solidHead: true,
    }),
  );
  // Between the wire spokes of the head, only a fill can be red.
  let image = await frame();
  for (const [x, y] of [
    [1, 0.25],
    [0.5, -0.3],
    [1.5, 0.18],
  ])
    assert(isRed(at(image, x, y)), `The head is solid at ${x},${y}`);
  // It writes depth: a line behind it, drawn later, stays hidden.
  const beside = [1, -3, -1, 1, 3, -1];
  const behind = lines.add(vertical(-1, { color: GREEN, positions: beside, width: 4 }));
  image = await frame();
  assert(isRed(at(image, 1, 0.15, -1)), 'A solid head hides what is behind it');
  lines.remove(behind);
  lines.remove(arrow);
  // A translucent plane facing the camera tints what is under it and writes no depth, and clipping planes cut it.
  const plane = lines.add(new PlaneHelper({ normal: [0, 0, 1], size: 4, color: BLUE, fillOpacity: 0.5 }));
  lines.add(vertical(-1, { color: RED, positions: beside, width: 6 }));
  image = await frame();
  const clear = at(image, -3, 0.7),
    tint = at(image, -1.3, 0.7);
  assert(tint[2] > clear[2] + 40 && tint[2] < 250, `A translucent fill tints: ${tint} over ${clear}`);
  assert(isRed(at(image, 1, 0.7, -1)), 'A translucent fill writes no depth');
  plane.material.clippingPlanes = [[-1, 0, 0, -3]];
  image = await frame();
  const cut = at(image, -1.3, 0.7);
  assert(Math.abs(cut[2] - clear[2]) < 3, `Clipping planes cut a fill: ${cut} over ${clear}`);
  done();
  return 'ArrowHelper solidHead and PlaneHelper fillOpacity fill, write depth when opaque, blend when not, and clip';
}

async function dashCaps() {
  const { lines, frame, done } = await rig();
  // 22.17 pixels a unit at z = 0. A dash of 1 unit with its centre at the screen centre, and a 16 px wide line.
  const line = lines.add(
    new Line({
      positions: [-1.5, 0, 0, 1.5, 0, 0],
      width: 16,
      cap: 'butt',
      color: RED,
      dashed: true,
      dashSize: 1,
      gapSize: 2,
      dashOffset: 2,
    }),
  );
  const end = Math.round(pixel(0.5, 0, 0)[0]);
  const read = async (dashCap) => {
    line.material.dashCap = dashCap;
    const image = await frame();
    return {
      inside: isRed(image.at(end - 3, 128)),
      past: isRed(image.at(end + 5, 128)),
      corner: isRed(image.at(end + 6, 121)),
      beyond: isRed(image.at(end + 11, 128)),
    };
  };
  const butt = await read('butt'),
    square = await read('square'),
    round = await read('round');
  assert(butt.inside && !butt.past, `A butt end stops at the dash: ${JSON.stringify(butt)}`);
  assert(
    square.past && square.corner && !square.beyond,
    `A square end reaches half the width: ${JSON.stringify(square)}`,
  );
  assert(round.past && !round.corner && !round.beyond, `A round end is round: ${JSON.stringify(round)}`);
  // A dot: a dash near zero with round ends is a disc as wide as the line.
  line.material.set({ dashSize: 0.001, gapSize: 3, dashOffset: 1.5, dashCap: 'round' });
  const image = await frame();
  assert(isRed(image.at(128, 128)) && isRed(image.at(134, 128)) && isRed(image.at(128, 134)), 'A dot has its width');
  assert(!isRed(image.at(134, 134)) && !isRed(image.at(138, 128)), 'A dot is round');
  done();
  return 'dashCap draws round and square ends on every dash, and dots';
}

async function stroke() {
  const { lines, engine, frame, done } = await rig();
  try {
    const line = lines.add(
      new Stroke({ positions: [-3, 0, 0, 0, 0, 0, 3, 0, 0], widths: [0.25, 1, 2], width: 16, color: RED, cap: 'butt' }),
    );
    let image = await frame();
    const rows = (x) => {
      let n = 0;
      for (let y = 80; y < 176; y++) if (isRed(image.at(x, y))) n++;
      return n;
    };
    assert(
      rows(80) < rows(175),
      `Per-point widths taper the stroke: ${rows(80)},${rows(175)}, pixels ${image.at(80, 128)},${image.at(175, 128)}`,
    );
    line.progress = 0.25;
    image = await frame();
    assert(isRed(image.at(70, 128)) && !isRed(image.at(110, 128)), 'Reveal follows length and cuts inside a segment');
    const picker = Picking.attach(engine, { capture: false });
    const picking = LinePicking.attach(picker, lines);
    assert((await picker.pick(70, 128))?.line === line, 'Visible stroke picks');
    assert((await picker.pick(110, 128))?.line !== line, 'Unrevealed stroke does not pick');
    line.progress = 0;
    image = await frame();
    assert(!isRed(image.at(70, 128)), 'Zero progress draws nothing');
    line.progress = 1;
    line.material.set({ dashed: true, dashSize: 0.5, gapSize: 0.5, depthWrite: true });
    image = await frame();
    let runs = 0,
      previous = false;
    for (let x = 64; x < 192; x++) {
      const on = isRed(image.at(x, 128));
      if (on && !previous) runs++;
      previous = on;
    }
    assert(runs >= 5, 'Dashes and variable widths compose');
    line.material.dashed = false;
    line.setWidths([1, 1, 1]);
    await engine.rebootDevice?.();
    image = await frame();
    assert(isRed(image.at(128, 128)), 'Stroke resources restore after device reboot');
    picking.dispose();
  } finally {
    done();
  }
  return 'Stroke per-point widths, arc-length reveal, dashes, depth, picking and device restore';
}

async function textured() {
  const { lines, engine, frame, done } = await rig();
  try {
    // Each world unit repeats opaque red for half a tile and transparent for the other half.
    const bytes = new Uint8Array(8 * 4);
    for (let x = 0; x < 8; x++) bytes.set(x < 4 ? [255, 0, 0, 255] : [0, 0, 0, 0], x * 4);
    const texture = new LineTexture(8, 1, bytes);
    const line = lines.add(
      new TexturedLine({ texture, positions: [-3, 0, 0, -2, 0, 0, 3, 0, 0], width: 16, cap: 'butt', depthWrite: true }),
    );
    let image = await frame();
    const at = (x) => image.at(Math.round(pixel(x, 0, 0)[0]), 128);
    assert(isRed(at(-2.75)) && !isRed(at(-2.25)), 'Repeated image has colour and alpha gaps');
    assert(isRed(at(-1.75)) && !isRed(at(-1.25)), 'Repeat continues through unequal segments in world units');
    const picker = Picking.attach(engine, { capture: false }),
      picking = LinePicking.attach(picker, lines);
    assert((await picker.pick(...pixel(-2.75, 0, 0)))?.line === line, 'Opaque texture picks');
    assert((await picker.pick(...pixel(-2.25, 0, 0)))?.line !== line, 'Transparent texel does not pick');
    line.offset[0] = 0.5;
    image = await frame();
    assert(!isRed(at(-2.75)) && isRed(at(-2.25)), 'Live offset moves the pattern');
    line.offset[0] = 0;
    line.progress = 0.25;
    image = await frame();
    assert(isRed(at(-2.75)) && !isRed(at(-0.75)), 'Texture composes with draw-on');
    line.progress = 1;
    line.repeat = 2;
    image = await frame();
    assert(isRed(at(-2.875)) && !isRed(at(-2.625)), 'Live repeat changes tile length');
    await engine.rebootDevice?.();
    image = await frame();
    assert(isRed(at(-2.875)), 'Textured stroke restores its image and mip chain');
    // Exercise the public promise loader with a browser-generated image, without network dependencies.
    const canvas = new OffscreenCanvas(1, 1);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ff0000';
    ctx.fillRect(0, 0, 1, 1);
    const blob = await canvas.convertToBlob(),
      url = URL.createObjectURL(blob);
    try {
      assert((await loadLineTexture(url)).width === 1, 'Image loader decodes RGBA pixels');
    } finally {
      URL.revokeObjectURL(url);
    }
    picking.dispose();
  } finally {
    done();
  }
  return 'Textured strokes: world-length repeat, alpha colour/depth/picks, live UV, draw-on, mip restore and image loading';
}

async function debugLines() {
  const { lines, engine, frame, done } = await rig();
  try {
    const debug = DebugLines.attach(engine);
    debug.drawLine([-3, 0, 0], [3, 0, 0], { color: RED, width: 8 });
    let image = await frame();
    assert(isRed(image.at(100, 128)), 'Immediate line renders this frame');
    image = await frame();
    assert(!isRed(image.at(100, 128)), 'Next zero-delta frame clears the queue');
    // Frame preparation for picking cannot consume pending immediate commands.
    const picker = Picking.attach(engine, { capture: false });
    debug.drawLine([-3, 0, 0], [3, 0, 0], { color: RED, width: 8 });
    await picker.pick(100, 128);
    image = await frame();
    assert(isRed(image.at(100, 128)), 'Picking leaves pending debug work intact');
    const mesh = engine.createMesh().setGeometry(box(2, 2, 2));
    mesh.setPosition([0, 0, 2]);
    debug.drawLine([-3, 0, 0], [3, 0, 0], { color: RED, width: 8 });
    image = await frame();
    assert(!isRed(image.at(128, 128)), 'Debug lines test scene depth');
    debug.drawLine([-3, 0, 0], [3, 0, 0], { color: RED, width: 8, depthTest: false });
    image = await frame();
    assert(isRed(image.at(128, 128)), 'depthTest false draws over scene');
    mesh.dispose();
    debug.drawArc([-3, 0, 0], [3, 0, 0], { height: 2, segments: 64, width: 8, color: RED });
    image = await frame();
    const apex = pixel(0, 2, 0);
    assert(isRed(image.at(Math.round(apex[0]), Math.round(apex[1]))), 'Immediate arc renders at its midpoint height');
    const arc = lines.add(new ArcLine([-3, -2, 0], [3, -2, 0], { height: 1, segments: 64, width: 8, color: GREEN }));
    image = await frame();
    const top = pixel(0, -1, 0);
    assert(isGreen(image.at(Math.round(top[0]), Math.round(top[1]))), 'Persistent arc renders');
    image = await frame();
    assert(isGreen(image.at(Math.round(top[0]), Math.round(top[1]))), 'Persistent arc survives the next frame');
    const linePicking = LinePicking.attach(picker, lines);
    assert((await picker.pick(...top))?.line === arc, 'Persistent arc picks');
    linePicking.dispose();
    // Consume once for the whole frame, retaining the batch in every view.
    const camera = engine.camera;
    debug.drawLine([-3, 0, 0], [3, 0, 0], { color: RED, width: 8 });
    engine.render({
      views: [
        { camera, viewport: [0, 0, 128, 256], pixels: true },
        { camera, viewport: [128, 0, 128, 256], pixels: true },
      ],
    });
    assert(debug.stats.segments === 1, 'Every view retains the same immediate batch');
    image = await frame();
    assert(!isRed(image.at(100, 128)), 'A multi-view frame also clears on the next render');
    await engine.rebootDevice?.();
    debug.drawLine([-3, 0, 0], [3, 0, 0], { color: RED, width: 8 });
    image = await frame();
    assert(isRed(image.at(100, 128)), 'Debug queue renders after device restore');
  } finally {
    done();
  }
  return 'Immediate debug queue: zero-delta clear, depth, picks, arcs, multi-view and device restore; persistent arcs pick';
}

window.runLineFeatures = async () => {
  const checks = [];
  for (const check of [
    depthWrite,
    picking,
    trail,
    ribbon,
    batch,
    hidden,
    coverage,
    filled,
    dashCaps,
    stroke,
    textured,
    debugLines,
  ])
    checks.push(await check());
  return checks;
};
