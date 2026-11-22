// /scene on a real GPU, native WebGPU and (MARGO_COMPAT=1) the WebGL2 layer: an instanced geometry placed three times,
// a batched triangle and a translucent pane draw; isolate, hide, colour overrides, ghosting and a section box change the
// pixels as they should; HitDetails picks resolve to elements through the instance index and the batch's UV0 slot. A scene
// streamed in three chunks shows the first chunk at once and ends drawing and picking exactly as the whole load.
// /section: a box cut by nine planes (past the 8 the rasterizer takes) shows its cap and its cut edges.
// node scripts/run-with-timeout.mjs -- node packages/ifc/tests/scene-gpu-check.mjs
import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';

const browser = await openBrowser({ port: 'free' });
try {
  const errors = [];
  browser.page.on('pageerror', (e) => errors.push(e.message));
  const result = await browser.page.evaluate(async () => {
    const [
      { Engine },
      { readPixels, createHeadlessCanvas },
      { createIFCScene },
      { HitDetails },
      { IFCSectionView },
      { Lines, Line },
    ] = await Promise.all([
      import('/packages/core/dist/index.js'),
      import('/packages/headless/dist/index.js'),
      import('/packages/ifc/dist/scene.js'),
      import('/packages/selection/dist/hit-details.js'),
      import('/packages/ifc/dist/section.js'),
      import('/packages/lines/dist/index.js'),
    ]);
    const size = 96;
    const engine = await Engine.create(createHeadlessCanvas({ width: size, height: size }), {
      camera: { position: [2.5, 2.5, 9], target: [2.5, 2.5, 0], near: 0.1, far: 100 },
    });
    const device = engine.gpu;
    device.pushErrorScope('validation');
    const t = (x, y) => Float64Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, 0, 1]);
    const quad = {
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0]),
      normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
      indices: new Uint32Array([0, 1, 2, 2, 1, 3]),
    };
    const sceneGeometries = new Map([
        [1, quad],
        [2, { positions: quad.positions.slice(), normals: quad.normals.slice(), indices: quad.indices.slice() }],
      ]),
      placements = [
        { element: 10, geometry: 1, matrix: t(0, 0), color: [1, 0, 0, 1] },
        { element: 11, geometry: 1, matrix: t(2, 0), color: [0, 1, 0, 1] },
        { element: 12, geometry: 1, matrix: t(4, 0), color: [0, 0, 1, 1] },
        { element: 20, geometry: 2, matrix: t(0, 3), color: [0.8, 0.8, 0.8, 1] },
        { element: 30, geometry: 2, matrix: t(4, 3), color: [1, 1, 0, 0.4] },
      ];
    const scene = createIFCScene(engine, {
      schema: 'IFC4',
      origin: [0, 0, 0],
      geometries: sceneGeometries,
      placements,
    });
    const frame = async () => {
      engine.render();
      await device.queue.onSubmittedWorkDone();
      return (await readPixels(engine)).data;
    };
    scene.hide(scene.elements);
    const background = await frame();
    // The pixels that differ from the empty frame, their count and mean colour, and one of them.
    const look = async () => {
      const data = await frame();
      let n = 0,
        r = 0,
        g = 0,
        b = 0,
        at;
      for (let i = 0; i < data.length; i += 4)
        if (
          Math.abs(data[i] - background[i]) +
            Math.abs(data[i + 1] - background[i + 1]) +
            Math.abs(data[i + 2] - background[i + 2]) >
          24
        ) {
          n++;
          r += data[i];
          g += data[i + 1];
          b += data[i + 2];
          at ??= [(i / 4) % size, Math.floor(i / 4 / size)];
        }
      return { n, mean: n ? [r / n, g / n, b / n] : [0, 0, 0], at };
    };
    const out = {};
    scene.showAll();
    out.all = await look();
    const whole = await frame();
    out.red = await (scene.isolate([10]), look());
    out.yellow = await (scene.setColor([10], [1, 1, 0]), look());
    scene.setColor([10], null);
    out.green = await (scene.isolate([11]), look());
    out.batched = await (scene.isolate([20]), look());
    out.pane = await (scene.isolate([30]), look());
    out.ghost = await (scene.isolate([10], { ghost: true }), look());
    scene.showAll();
    scene.sectionBox([-1, -1, -1], [3.5, 10, 1]);
    out.cut = await look();
    scene.clippingPlanes = [];
    const picker = HitDetails.attach(engine),
      pick = async (id) => {
        scene.isolate([id]);
        const { at } = await look();
        engine.render();
        return scene.elementAt(await picker.pick(at[0] + 0.5, at[1] + 0.5));
      };
    out.picked = [await pick(12), await pick(20), await pick(30)];
    scene.dispose();
    // Streamed: the same placements in three chunks. The first draws on its own (a first frame before the rest is
    // read); the third places geometry 1 again without sending it, so element 10 moves from its batch into the group.
    const geometries = sceneGeometries,
      chunk = (keys, ids) => ({
        geometries: new Map(keys.map((k) => [k, geometries.get(k)])),
        placements: placements.filter((p) => ids.includes(p.element)),
      });
    const streamed = createIFCScene(engine, { schema: 'IFC4', origin: [0, 0, 0], ...chunk([1], [10]) });
    const first = await frame();
    streamed.add(chunk([2], [20])).add(chunk([], [11, 12, 30]));
    const last = await frame(),
      differs = (a) => {
        let n = 0;
        for (let i = 0; i < a.length; i += 4)
          if (Math.abs(a[i] - whole[i]) + Math.abs(a[i + 1] - whole[i + 1]) + Math.abs(a[i + 2] - whole[i + 2]) > 6)
            n++;
        return n;
      };
    out.stream = { first: differs(first), last: differs(last), draws: streamed.meshes.length };
    out.streamPicked = [];
    for (const id of [10, 12, 20, 30]) {
      streamed.isolate([id]);
      const { at } = await look();
      engine.render();
      out.streamPicked.push(streamed.elementAt(await picker.pick(at[0] + 0.5, at[1] + 0.5)));
    }
    picker.dispose();
    streamed.dispose();
    // A box from (1.5, 1.5, -0.5) to (3.5, 3.5, 0.5), red, cut at z = 0 facing the camera, with eight planes that cut
    // nothing around it: the cap (blue) closes the cut, white edges ring it; without caps the inside shows red.
    const cube = { positions: [], normals: [], indices: [] };
    for (let axis = 0; axis < 3; axis++)
      for (const side of [0, 1]) {
        const u = (axis + 1) % 3,
          v = (axis + 2) % 3,
          base = cube.positions.length / 3;
        for (const [a, b] of [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 1],
        ]) {
          const p = [0, 0, 0],
            n = [0, 0, 0];
          p[axis] = side ? 1 : -1;
          p[u] = a ? 1 : -1;
          p[v] = b ? 1 : -1;
          n[axis] = side ? 1 : -1;
          cube.positions.push(p[0], p[1], p[2] * 0.5);
          cube.normals.push(...n);
        }
        cube.indices.push(
          ...(side
            ? [base, base + 1, base + 2, base, base + 2, base + 3]
            : [base, base + 2, base + 1, base, base + 3, base + 2]),
        );
      }
    const box = createIFCScene(engine, {
      origin: [0, 0, 0],
      geometries: new Map([
        [
          1,
          {
            positions: new Float32Array(cube.positions),
            normals: new Float32Array(cube.normals),
            indices: new Uint32Array(cube.indices),
          },
        ],
      ]),
      placements: [{ element: 40, geometry: 1, matrix: t(2.5, 2.5), color: [1, 0, 0, 1] }],
    });
    const far = Array.from({ length: 8 }, (_, i) => [Math.cos(i), Math.sin(i), 0, 50]);
    box.clippingPlanes = [...far, [0, 0, -1, 0]];
    const lines = Lines.attach(engine),
      view = new IFCSectionView(engine, box, {
        capColor: [0, 0, 1],
        edges: { lines, Line },
        edgeColor: [1, 1, 1],
        edgeWidth: 3,
      });
    out.capped = await look();
    const data = await frame(),
      centre = (size / 2) * size * 4 + (size / 2) * 4;
    out.capCentre = [data[centre], data[centre + 1], data[centre + 2]];
    out.white = 0;
    for (let i = 0; i < data.length; i += 4) if (data[i] > 200 && data[i + 1] > 200 && data[i + 2] > 200) out.white++;
    out.cuts = view.cuts.length;
    view.dispose();
    out.uncapped = await look();
    const bare = await frame();
    out.bareCentre = [bare[centre], bare[centre + 1], bare[centre + 2]];
    box.dispose();
    out.error = (await device.popErrorScope())?.message;
    out.compat = !!device.gl;
    engine.dispose();
    return out;
  });
  console.log(JSON.stringify(result));
  assert.equal(result.error, undefined);
  assert.deepEqual(errors, []);
  const {
    all,
    red,
    yellow,
    green,
    batched,
    pane,
    ghost,
    cut,
    picked,
    capped,
    uncapped,
    white,
    cuts,
    capCentre,
    bareCentre,
  } = result;
  for (const one of [red, green, batched, pane])
    assert.ok(one.n > 50 && one.n < all.n, `an isolated element draws alone: ${one.n} of ${all.n}`);
  assert.ok(red.mean[0] > 2 * red.mean[1] && red.mean[0] > 2 * red.mean[2], `the instance keeps its red: ${red.mean}`);
  assert.ok(green.mean[1] > 2 * green.mean[0], `the second instance keeps its green: ${green.mean}`);
  assert.ok(
    yellow.mean[1] > 2 * red.mean[1] && yellow.n === red.n,
    `a colour override tints the instance: ${yellow.mean}`,
  );
  assert.ok(Math.abs(batched.mean[0] - batched.mean[2]) < 24, `the batched quad keeps its grey: ${batched.mean}`);
  assert.ok(ghost.n > red.n, `ghosts draw around the isolated element: ${ghost.n} > ${red.n}`);
  assert.ok(cut.n < all.n && cut.n > red.n, `the section box cuts the right-hand elements away: ${cut.n} of ${all.n}`);
  assert.deepEqual(picked, [12, 20, 30]);
  assert.equal(cuts, 1, 'one plane of nine cuts the box');
  assert.ok(capCentre[2] > 60 && capCentre[2] > 4 * capCentre[0], `the cap closes the cut in its colour: ${capCentre}`);
  assert.ok(
    bareCentre[0] > 60 && bareCentre[0] > 4 * bareCentre[2],
    `without the cap the red inside shows: ${bareCentre}`,
  );
  assert.ok(capped.n >= uncapped.n, `cap and edges cover the cut box: ${capped.n} >= ${uncapped.n}`);
  assert.ok(white > 40, `white cut edges ring the cap: ${white} pixels`);
  const { stream, streamPicked } = result;
  assert.ok(
    stream.first > 50,
    `the first chunk draws before the rest arrives: ${stream.first} pixels short of the whole model`,
  );
  assert.equal(stream.last, 0, 'the streamed scene draws the same pixels as the whole load');
  assert.equal(stream.draws, 3, 'one instance group, one opaque and one translucent batch, as a whole load');
  assert.deepEqual(streamPicked, [10, 12, 20, 30], 'picking ids survive the move into the group');
  console.log(`ifc scene GPU check passed (${result.compat ? 'WebGL2 layer' : 'native WebGPU'})`);
} finally {
  await browser.close();
}
