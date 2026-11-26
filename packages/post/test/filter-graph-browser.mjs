// Real-GPU check of the image filter graph runtime, built packages, with no engine or scene (WebGPU, or the WebGL2 layer
// with --compat). Every built-in block compiles and draws; each graph drawn merged equals the same graph drawn one pass
// a block within 1 code of 255; live values change the picture with no new pipeline; and canvas, texture, URL, video
// stream and camera inputs, caller targets, a restore and a block that does not compile behave as documented.
import assert from 'node:assert/strict';
import { launchBrowser } from '../../../scripts/lib/browser.mjs';
import { postBrowser } from './post-browser.mjs';
import { compatRun } from '../../../scripts/support/compat-shim.js';

await postBrowser(
  'post-filter-graph' + (compatRun() ? '-compat' : ''),
  compatRun() ? 5421 : 5420,
  () => launchBrowser({ headless: true }),
  async (page, shot) => {
    const result = await page.evaluate(async () => {
      const fg = await import('/packages/post/dist/filter-graph.js');
      const W = 96,
        H = 64;
      const picture = (shift) => {
        const data = new ImageData(W, H);
        for (let y = 0; y < H; y++)
          for (let x = 0; x < W; x++)
            data.data.set(
              [(x * 5 + shift) % 256, (y * 7 + shift * 3) % 256, ((x ^ y) * 11) % 256, x > 80 ? 128 : 255],
              (y * W + x) * 4,
            );
        return data;
      };
      const a = picture(0),
        b = picture(97);
      const image = { type: 'image' };
      const run = async (graph, options = {}, frame) => {
        const filter = await fg.ImageFilterGraph.create(graph, options);
        for (const [name, input] of Object.entries(graph.inputs))
          if (input.type === 'image') filter.setImage(name, name === 'a' ? a : b);
        if (!filter.render(frame)) throw new Error('not drawn');
        const pixels = await filter.read();
        return { filter, pixels };
      };
      const compare = (one, two) => {
        let max = 0,
          over = 0;
        for (let i = 0; i < one.data.length; i++) {
          const d = Math.abs(one.data[i] - two.data[i]);
          if (d > max) max = d;
          if (d > 1) over++;
        }
        return { max, over };
      };

      // 1. Every built-in block compiles and draws, alone.
      const blocks = [];
      for (const block of fg.filterBlocks) {
        const names = block.graph
          ? Object.keys(block.graph.inputs).filter((n) => block.graph.inputs[n].type === 'image')
          : Object.keys(block.images ?? {});
        const graph = {
          inputs: { a: image, b: image },
          nodes: [
            {
              id: 'n',
              type: block.type,
              images: Object.fromEntries(names.map((n, i) => [n, i ? 'b' : 'a'])),
            },
          ],
          output: 'n',
        };
        try {
          const { filter, pixels } = await run(graph, { size: [W, H] });
          blocks.push([block.type, pixels.data.some((v) => v !== 0)]);
          filter.dispose();
        } catch (error) {
          blocks.push([block.type, error.message]);
        }
      }

      // 2. Merged against one pass a block.
      const chain = (types, from = 'a') =>
        types.map(([type, extra], i) => ({
          id: `n${i}`,
          type,
          images: { input: i ? `n${i - 1}` : from },
          ...extra,
        }));
      const pointwise = chain([
        ['black-and-white', { params: { amount: 0.4 } }],
        ['exposure', { params: { stops: 0.7 } }],
        ['brightness-contrast', { params: { brightness: -0.1, contrast: 1.6 } }],
        ['hue', { params: { angle: 1.1 } }],
        ['tint'],
        ['levels', { params: { gamma: 1.7, inWhite: 0.9 } }],
        ['color-matrix', { params: { red: [0.5, 0.5, 0, 0] } }],
        ['saturation', { params: { amount: 2 } }],
        ['vignette'],
        ['noise', { params: { seed: '$time' } }],
        ['green-screen'],
      ]);
      const graphs = {
        pointwise: { inputs: { a: image }, nodes: pointwise, output: 'n10' },
        texel: {
          inputs: { a: image },
          nodes: chain([['saturation'], ['invert'], ['pixelate', { params: { size: 5 } }], ['sepia']]),
          output: 'n3',
        },
        sampled: {
          inputs: { a: image },
          nodes: [
            { id: 'base', type: 'tint', images: { input: 'a' } },
            { id: 'soft', type: 'directional-blur', images: { input: 'base' }, params: { radius: 9, angle: 0.5 } },
            {
              id: 'both',
              type: 'composite',
              images: { background: 'base', foreground: 'soft' },
              consts: { MODE: 'screen' },
            },
            { id: 'end', type: 'sharpen', images: { input: 'both' } },
          ],
          output: 'end',
        },
        tree: {
          inputs: { a: image, b: image },
          nodes: [
            { id: 'l', type: 'brightness-contrast', images: { input: 'a' }, params: { contrast: 1.3 } },
            { id: 'r', type: 'sepia', images: { input: 'b' } },
            {
              id: 'm',
              type: 'composite',
              images: { background: 'l', foreground: 'r' },
              consts: { MODE: 'overlay' },
              params: { opacity: 0.7 },
            },
            { id: 'g', type: 'gradient', params: { start: '#102030', end: '#f0c080', angle: 0.7 } },
            { id: 'w', type: 'wipe', images: { start: 'm', end: 'g' }, params: { softness: 0.2 } },
            { id: 'k', type: 'mask', images: { input: 'w', mask: 'b' }, consts: { CHANNEL: 'red' } },
          ],
          output: 'k',
        },
        scaled: {
          inputs: { a: image },
          nodes: [
            { id: 'soft', type: 'blur', images: { input: 'a' }, params: { radius: 6 } },
            { id: 'v', type: 'vignette', images: { input: 'soft' } },
            { id: 'off1', type: 'pixelate', images: { input: 'v' }, enabled: false },
            { id: 'off2', type: 'kaleidoscope', images: { input: 'off1' }, enabled: false },
            { id: 'edge', type: 'chromatic-aberration', images: { input: 'off2' } },
          ],
          output: 'edge',
        },
        steps: {
          inputs: { a: image },
          nodes: chain([
            ['hue', { params: { angle: 0.3 } }],
            ['posterize', { params: { steps: 5 } }],
            ['pixelate'],
            ['invert'],
          ]),
          output: 'n3',
        },
      };
      const merged = {};
      for (const [name, graph] of Object.entries(graphs)) {
        const fused = await run(graph, {}, { time: 2 }),
          split = await run(graph, { optimize: false }, { time: 2 });
        merged[name] = {
          passes: [fused.filter.passes.length, split.filter.passes.length],
          size: [fused.pixels.width, fused.pixels.height],
          ...compare(fused.pixels, split.pixels),
          varied: new Set(fused.pixels.data).size,
        };
        fused.filter.dispose();
        split.filter.dispose();
      }

      // 3. Exact values and live changes with no new pipeline.
      const live = {};
      {
        const graph = {
          inputs: { a: image, amount: { type: 'float', default: 1, min: 0, max: 1 } },
          nodes: [
            { id: 'flip', type: 'invert', images: { input: 'a' }, params: { amount: '$amount' } },
            { id: 'pix', type: 'pixelate', images: { input: 'flip' }, params: { size: 8 } },
          ],
          output: 'pix',
        };
        const { filter, pixels } = await run(graph);
        let compiled = 0;
        const make = filter.device.createRenderPipelineAsync;
        filter.device.createRenderPipelineAsync = function (d) {
          compiled++;
          return make.call(this, d);
        };
        const at = (p, x, y) => Array.from(p.data.slice((y * W + x) * 4, (y * W + x) * 4 + 4));
        // Pixel (3, 3) lies in the first 8 x 8 cell, whose centre (4, 4) reads texel (4, 4).
        live.inverted = at(pixels, 3, 3);
        live.expected = [
          255 - a.data[(4 * W + 4) * 4],
          255 - a.data[(4 * W + 4) * 4 + 1],
          255 - a.data[(4 * W + 4) * 4 + 2],
          255,
        ];
        filter.set('amount', 0);
        filter.set('pix.enabled', false);
        filter.render();
        const plain = await filter.read();
        live.plain = compare(plain, { data: a.data });
        live.saved = filter.save();
        live.compiled = compiled;
        // A restore on a fresh device draws the same picture.
        const old = filter.device;
        await filter.restore();
        filter.render();
        live.restored = compare(await filter.read(), plain);
        live.newDevice = filter.device !== old;
        filter.dispose();
        const again = await run(fg.parseFilterGraph(JSON.stringify(live.saved)));
        live.loaded = compare(again.pixels, plain);
        again.filter.dispose();
      }

      // 4. Borrowed device, caller textures in and out.
      const io = {};
      {
        const adapter = await navigator.gpu.requestAdapter(),
          device = await adapter.requestDevice(),
          source = device.createTexture({ size: [W, H], format: 'rgba8unorm', usage: 0x2 | 0x4 }),
          target = device.createTexture({ size: [W, H], format: 'rgba8unorm', usage: 0x1 | 0x10 });
        device.queue.writeTexture({ texture: source }, a.data, { bytesPerRow: W * 4 }, [W, H]);
        const graph = {
          inputs: { a: image },
          nodes: [{ id: 'n', type: 'opacity', images: { input: 'a' } }],
          output: 'n',
        };
        const filter = await fg.ImageFilterGraph.create(graph, { device, target });
        filter.setImage('a', source);
        filter.render();
        io.texture = compare(await filter.read(), { data: a.data });
        filter.dispose();
        // The caller's device survives dispose.
        const after = await fg.ImageFilterGraph.create(graph, { device });
        after.setImage('a', source);
        io.reused = after.render();
        after.dispose();
        device.destroy();
      }

      // 5. A canvas source, a URL, a video stream and the camera.
      const solid = document.createElement('canvas');
      solid.width = W;
      solid.height = H;
      const paint = (fill) => {
        const c = solid.getContext('2d');
        c.fillStyle = fill;
        c.fillRect(0, 0, W, H);
      };
      paint('#c04020');
      {
        const graph = {
          inputs: { a: image },
          nodes: [{ id: 'n', type: 'opacity', images: { input: 'a' } }],
          output: 'n',
        };
        const filter = await fg.ImageFilterGraph.create(graph);
        const centre = async () => {
          const p = await filter.read();
          return Array.from(p.data.slice(((H / 2) * W + W / 2) * 4, ((H / 2) * W + W / 2) * 4 + 3));
        };
        io.empty = filter.render();
        filter.setImage('a', solid);
        filter.render();
        io.canvas = await centre();
        paint('#2080c0');
        filter.render();
        io.canvasAgain = await centre();
        const blob = await new Promise((done) => solid.toBlob(done));
        const url = URL.createObjectURL(blob);
        await filter.load('a', url, { kind: 'image' });
        URL.revokeObjectURL(url);
        paint('#000000');
        filter.render();
        io.url = await centre();
        const aborted = new AbortController();
        const loading = filter.load('a', blob, { signal: aborted.signal });
        aborted.abort();
        io.aborted = await loading.then(
          () => 'loaded',
          (error) => error.name,
        );
        const frames = async (load) => {
          paint('#30a050');
          const timer = setInterval(() => paint('#30a050'), 30);
          try {
            await load(solid.captureStream(30));
            filter.render();
            return await centre();
          } finally {
            clearInterval(timer);
          }
        };
        io.stream = await frames((stream) => filter.load('a', stream, { signal: AbortSignal.timeout(20000) }));
        let track;
        io.camera = await frames((stream) => {
          track = stream.getVideoTracks()[0];
          return filter.load(
            'a',
            { camera: true },
            { mediaDevices: { getUserMedia: async () => stream }, signal: AbortSignal.timeout(20000) },
          );
        });
        filter.dispose();
        io.cameraStopped = track.readyState;
      }

      // 6. Custom blocks from an annotated file, and one that does not compile.
      {
        const source = `// filter-block {"type":"swap","images":{"input":"pixel"},"params":{"k":{"type":"float","default":1}}}
struct Pair { x: f32 }
const ONE = 1.0;
fn mixed(c: vec4f, k: f32) -> vec4f { let p = Pair(k * ONE); return mix(c, c.bgra, p.x); }
fn apply(uv: vec2f, color: vec4f, k: f32) -> vec4f { return mixed(color, k); }
`;
        const block = fg.parseFilterBlock(source);
        const graph = {
          inputs: { a: image },
          nodes: [
            { id: 'one', type: 'swap', images: { input: 'a' } },
            { id: 'two', type: 'swap', images: { input: 'one' } },
          ],
          output: 'two',
          blocks: [block],
        };
        const { filter, pixels } = await run(graph);
        io.custom = { passes: filter.passes.length, ...compare(pixels, { data: a.data }) };
        filter.dispose();
        io.bad = await fg.ImageFilterGraph.create({
          ...graph,
          blocks: [{ ...block, wgsl: 'fn apply(uv: vec2f, color: vec4f, k: f32) -> vec4f { return nothing; }' }],
        }).then(
          () => 'made',
          (error) => error.code,
        );
      }

      // 7. On a canvas: premultiplied output, the canvas size followed, drawn by the loop.
      {
        const canvas = document.querySelector('canvas');
        const filter = await fg.ImageFilterGraph.create(
          { nodes: [{ id: 'n', type: 'solid-color', params: { color: '#3366cc' } }], output: 'n' },
          { canvas },
        );
        filter.start();
        await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
        io.canvasSize = [filter.width, filter.height];
        window.filter = filter;
      }
      return { blocks, merged, live, io };
    });
    const screen = await shot();
    await page.evaluate(() => window.filter.dispose());
    console.log(JSON.stringify({ merged: result.merged, io: result.io }));

    for (const [type, drew] of result.blocks) assert.equal(drew, true, `block ${type}: ${drew}`);
    const expected = {
      pointwise: [1, 11],
      texel: [1, 4],
      sampled: [3, 4],
      tree: [1, 6],
      scaled: [5, 6],
      steps: [1, 4],
    };
    for (const [name, passes] of Object.entries(expected)) {
      const got = result.merged[name];
      assert.deepEqual(got.passes, passes, `${name} pass counts`);
      assert.ok(got.max <= 1, `${name}: merged and unmerged differ by ${got.max} codes in ${got.over} channels`);
      assert.ok(got.varied > 4, `${name} draws a picture`);
    }
    const { live, io } = result;
    assert.deepEqual(live.inverted, live.expected);
    assert.equal(live.plain.max, 0, 'amount 0 and a disabled pixelate give the source back');
    assert.equal(live.compiled, 0, 'live values compile nothing');
    assert.equal(live.saved.inputs.amount.default, 0);
    assert.equal(live.saved.nodes[1].enabled, false);
    assert.ok(live.newDevice);
    assert.equal(live.restored.max, 0);
    assert.equal(live.loaded.max, 0);
    assert.equal(io.texture.max, 0);
    assert.equal(io.reused, true);
    assert.equal(io.empty, false);
    const near = (got, want, label, slack = 1) =>
      assert.ok(
        got.every((v, i) => Math.abs(v - want[i]) <= slack),
        `${label}: ${got} against ${want}`,
      );
    near(io.canvas, [192, 64, 32], 'canvas source');
    near(io.canvasAgain, [32, 128, 192], 'canvas source read again');
    near(io.url, [32, 128, 192], 'URL image copied once');
    assert.equal(io.aborted, 'AbortError');
    // Video goes through a YUV round trip in the browser.
    near(io.stream, [48, 160, 80], 'video stream', 12);
    near(io.camera, [48, 160, 80], 'camera', 12);
    assert.equal(io.cameraStopped, 'ended', 'the runtime stops the camera it opened');
    assert.deepEqual(io.custom, { passes: 1, max: 0, over: 0 });
    assert.equal(io.bad, 'failed');
    assert.deepEqual(io.canvasSize, [320, 240]);
    const centre = (120 * screen.width + 160) * 4;
    near(Array.from(screen.data.slice(centre, centre + 3)), [51, 102, 204], 'on the canvas', 2);
  },
  { seconds: 150 },
);
console.log('post filter graph: ok');
