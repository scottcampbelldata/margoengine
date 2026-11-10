// Real-GPU checks of @margoengine/sciviz/bricks: the same volume drawn whole and from bricks, compared pixel by pixel,
// with and without brick borders; volumes past the GPU's 3D texture limit and past the memory budget; failed reads;
// aborts; time steps. `measureBricks` times frames at a volume far larger than fits one texture.
import { Figure } from '@margoengine/sciviz';
import { arraySource, brickedVolume } from '@margoengine/sciviz/bricks';

const errors = [];

async function figureOn(width, height, camera) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.style.cssText = `width:${width}px;height:${height}px`;
  document.querySelector('#host').append(canvas);
  const figure = await Figure.create(canvas, { controls: false, axes: false });
  figure.engine.stop?.();
  figure.renderer.device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  place(figure, camera);
  return figure;
}

function place(figure, camera = [1.9, 1.3, 2.1]) {
  figure.engine.camera.position = camera;
  figure.engine.camera.target = [0, 0, 0];
  figure.engine.camera.up = [0, 1, 0];
}

function gone(figure) {
  const canvas = figure.engine.canvas;
  figure.dispose();
  canvas.remove();
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

// Draws frames until `promise` settles: bricks are chosen and started as frames draw, and this engine is stopped.
async function pump(figure, promise) {
  let done = false;
  const finished = promise.finally(() => {
    done = true;
  });
  // The rejection is observed below, after the pump.
  finished.catch(() => {});
  while (!done) {
    figure.engine.render();
    await figure.renderer.device.queue.onSubmittedWorkDone();
    await tick();
  }
  return finished;
}

// The canvas's pixels after a rendered frame.
async function capture(figure) {
  const engine = figure.engine;
  // A new drawing buffer: WebKit answers every read of one buffer in a task from the first read.
  engine.canvas.setAttribute('width', engine.canvas.width);
  engine.render();
  const bitmap = await createImageBitmap(engine.canvas),
    copy = new OffscreenCanvas(bitmap.width, bitmap.height),
    g = copy.getContext('2d', { willReadFrequently: true });
  g.drawImage(bitmap, 0, 0);
  return g.getImageData(0, 0, bitmap.width, bitmap.height).data;
}

function compare(a, b) {
  let differing = 0,
    max = 0,
    total = 0;
  for (let i = 0; i < a.length; i += 4) {
    const d = Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2]));
    if (d) differing++;
    if (d > max) max = d;
    total += d;
  }
  return { pixels: a.length / 4, differing, max, mean: total / (a.length / 4) };
}

function lit(data) {
  const r = data[0],
    g = data[1],
    b = data[2];
  let n = 0;
  for (let i = 0; i < data.length; i += 4)
    if (Math.abs(data[i] - r) + Math.abs(data[i + 1] - g) + Math.abs(data[i + 2] - b) > 24) n++;
  return n;
}

// A field with detail at brick scale: smooth blobs plus waves about 7 voxels long, so a wrong voxel at a brick edge
// shows in both the value and the lighting.
const fieldAt = (nx, ny, nz, x, y, z) => {
  const u = x / nx - 0.5,
    v = y / ny - 0.5,
    w = z / nz - 0.5,
    blob = Math.exp(-(u * u + v * v + w * w) * 14);
  return blob * (0.62 + 0.38 * Math.sin(x * 0.9) * Math.sin(y * 0.8 + 1) * Math.sin(z * 0.85 + 2));
};

function field(nx, ny, nz, shift = 0) {
  const data = new Float32Array(nx * ny * nz);
  for (let z = 0, i = 0; z < nz; z++)
    for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++, i++) data[i] = fieldAt(nx, ny, nz, x + shift, y, z);
  return data;
}

const LOOK = { colormap: 'ember', range: [0, 1], opacity: (t) => t * t * 0.9 };
const DIMS = [96, 80, 64];
const WIDTH = 480;
const HEIGHT = 360;

// One whole and one bricked draw of the same data under `options`.
async function whole(data, options = {}, dims = DIMS) {
  const figure = await figureOn(WIDTH, HEIGHT);
  const layer = figure.volume(data, { dims, ...LOOK, ...options });
  const image = await capture(figure);
  layer.dispose();
  gone(figure);
  return image;
}

async function bricked(data, options = {}, dims = DIMS) {
  const figure = await figureOn(WIDTH, HEIGHT);
  const layer = brickedVolume(figure, arraySource(data, dims), { brickSize: 16, detail: 0, ...LOOK, ...options });
  await pump(figure, layer.ready());
  const image = await capture(figure),
    stats = layer.stats;
  gone(figure);
  return { image, stats };
}

window.runBrickTests = async () => {
  const checks = [],
    numbers = {};
  const check = async (name, run) => {
    try {
      await run();
    } catch (error) {
      throw new Error(`${name}: ${error.message}\n${error.stack}`);
    }
    if (errors.length) throw new Error(`${name}: WebGPU errors: ${errors.join('; ')}`);
    checks.push(name);
  };
  const assert = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  const data = field(...DIMS);

  await check(
    'bricked draws as whole: no seams in composite, lit composite, maximum intensity or clipped',
    async () => {
      for (const [name, options] of [
        ['composite', { shading: false }],
        ['lit', { shading: true }],
        ['mip', { mode: 'mip' }],
        // The smallest sample of each ray lies near the box faces, about 0.005 to 0.05 here, where the shared look is
        // transparent black: MinIP takes an opaque map with a coloured low end, over the same [0, 1] range as the rest.
        ['minip', { mode: 'minip', colormap: 'viridis', opacity: () => 0.9 }],
        ['clipped', { clip: [{ normal: [-1, 0, 0], offset: 0.5 }] }],
      ]) {
        const a = await whole(data, options),
          { image, stats } = await bricked(data, options),
          result = compare(a, image);
        numbers[name] = { ...result, bricks: stats.resident, finestLevel: stats.finestLevel };
        assert(stats.finestLevel === 0, `${name}: finest level ${stats.finestLevel}`);
        assert(lit(a) > 5000, `${name}: whole drew ${lit(a)} pixels`);
        // Hardware filtering rounds its weights by position in the texture, so whole and atlas may differ by the last
        // bit: 2 of 255 at most, and on few pixels.
        assert(result.max <= 2, `${name}: largest difference ${result.max}: ${JSON.stringify(result)}`);
        assert(result.differing / result.pixels <= 0.02, `${name}: ${JSON.stringify(result)}`);
      }
    },
  );

  await check('without the border the same comparison shows the seams', async () => {
    const a = await whole(data, { shading: true }),
      { image } = await bricked(data, { shading: true, border: 0 }),
      result = compare(a, image);
    numbers.noBorder = result;
    assert(result.max > 16, `expected visible seams, got ${JSON.stringify(result)}`);
    assert(result.differing > 20 * numbers.lit.differing, JSON.stringify(result));
  });

  await check('two brick sizes and a grid that is not a multiple of them draw alike', async () => {
    const dims = [71, 53, 37],
      odd = field(...dims),
      a = await whole(odd, { shading: true }, dims);
    for (const brickSize of [8, 32]) {
      const { image } = await bricked(odd, { shading: true, brickSize }, dims),
        result = compare(a, image);
      numbers[`odd${brickSize}`] = result;
      assert(result.max <= 2, `brick ${brickSize}: ${JSON.stringify(result)}`);
    }
  });

  await check('a small volume that fits one brick draws as whole', async () => {
    const dims = [40, 40, 40],
      small = field(...dims),
      result = compare(
        await whole(small, { shading: true }, dims),
        (await bricked(small, { shading: true, brickSize: 64 }, dims)).image,
      );
    numbers.oneBrick = result;
    assert(result.max <= 2, JSON.stringify(result));
  });

  await check('slices from bricks match slices of a whole volume', async () => {
    const figureA = await figureOn(WIDTH, HEIGHT),
      layerA = figureA.volume(data, { dims: DIMS, ...LOOK, opacity: () => 0 });
    layerA.slice('z', 0.4);
    const a = await capture(figureA);
    gone(figureA);
    const figureB = await figureOn(WIDTH, HEIGHT),
      layerB = brickedVolume(figureB, arraySource(data, DIMS), { brickSize: 16, detail: 0, ...LOOK, opacity: () => 0 }),
      slice = layerB.slice('z', 0.4);
    layerB.visible = false;
    await pump(figureB, layerB.ready());
    const b = await capture(figureB),
      result = compare(a, b);
    numbers.slice = result;
    assert(slice.transparent === false, 'opaque slice');
    assert(lit(a) > 5000, `whole slice drew ${lit(a)} pixels`);
    assert(result.max <= 2, JSON.stringify(result));
    gone(figureB);
  });

  await check(
    'a volume past the 3D texture limit loads by bricks, and the error for whole names this entry',
    async () => {
      const figure = await figureOn(WIDTH, HEIGHT),
        device = figure.renderer.device,
        max = device.limits.maxTextureDimension3D,
        dims = [max + 512, 256, 256];
      let refused;
      try {
        figure.volume(new Float32Array(16), { dims: [16, 1, 1] });
      } catch (error) {
        refused = error;
      }
      assert(refused instanceof RangeError, 'bad dims refused');
      try {
        figure.volume(new Float32Array((max + 1) * 4), { dims: [max + 1, 2, 2] });
        refused = undefined;
      } catch (error) {
        refused = error;
      }
      assert(/@margoengine\/sciviz\/bricks/.test(refused?.message), `message: ${refused?.message}`);
      const reads = [];
      const layer = brickedVolume(
        figure,
        {
          dims,
          range: [0, 1],
          read({ level, origin, size }) {
            reads.push(level);
            const s = 2 ** level,
              out = new Float32Array(size[0] * size[1] * size[2]);
            for (let z = 0, i = 0; z < size[2]; z++)
              for (let y = 0; y < size[1]; y++)
                for (let x = 0; x < size[0]; x++, i++)
                  out[i] = fieldAt(
                    dims[0],
                    dims[1],
                    dims[2],
                    (origin[0] + x) * s,
                    (origin[1] + y) * s,
                    (origin[2] + z) * s,
                  );
            return out;
          },
        },
        LOOK,
      );
      await pump(figure, layer.ready());
      const image = await capture(figure);
      numbers.pastLimit = { dims, max, reads: reads.length, ...layer.stats, lit: lit(image) };
      assert(lit(image) > 5000, `drew ${lit(image)} pixels`);
      assert(Math.min(...reads) >= 0 && Math.max(...reads) === layer.plan.levels.length - 1, 'root read');
      gone(figure);
    },
  );

  await check('a small budget holds: coarser bricks cover the box, no holes against the whole draw', async () => {
    const budget = 40 * 18 ** 3 * 2 + 6 * 5 * 4 * 8,
      a = await whole(data, { shading: false }),
      { image, stats } = await bricked(data, { shading: false, memoryBudget: budget }),
      result = compare(a, image);
    numbers.smallBudget = { budget, ...stats, ...result, litWhole: lit(a), litBricked: lit(image) };
    assert(stats.memoryBytes <= budget, `${stats.memoryBytes} > ${budget}`);
    assert(stats.resident <= stats.capacity && stats.capacity <= 40, JSON.stringify(stats));
    assert(Math.abs(lit(a) - lit(image)) / lit(a) < 0.05, JSON.stringify(numbers.smallBudget));
  });

  await check('moving the camera evicts within the budget and aborts reads no longer wanted', async () => {
    const figure = await figureOn(WIDTH, HEIGHT),
      source = arraySource(data, DIMS),
      aborted = [];
    const gate = {
      dims: DIMS,
      range: [0, 1],
      read: (request) =>
        new Promise((resolve, reject) => {
          request.signal.addEventListener('abort', () => {
            aborted.push(request.level);
            reject(request.signal.reason);
          });
          setTimeout(() => resolve(source.read(request)), 2);
        }),
    };
    const layer = brickedVolume(figure, gate, {
      ...LOOK,
      brickSize: 16,
      detail: 0,
      memoryBudget: 30 * 18 ** 3 * 2 + 960,
    });
    await pump(figure, layer.ready());
    for (const camera of [
      [-1.9, 1.3, 2.1],
      [1.9, -1.3, -2.1],
      [0.3, 0.2, 0.9],
      [-2.6, 0.2, 0],
    ]) {
      place(figure, camera);
      figure.engine.render();
      await tick();
      assert(layer.stats.resident <= layer.stats.capacity, JSON.stringify(layer.stats));
    }
    await pump(figure, layer.ready());
    numbers.moved = { ...layer.stats, aborted: aborted.length };
    assert(layer.stats.loading === 0, JSON.stringify(layer.stats));
    gone(figure);
  });

  await check(
    'a failed read rejects ready with a coded error, coarser bricks keep drawing, ready reads it again',
    async () => {
      const figure = await figureOn(WIDTH, HEIGHT),
        source = arraySource(data, DIMS);
      let broken = true;
      const layer = brickedVolume(
        figure,
        {
          dims: DIMS,
          range: [0, 1],
          read: (request) => {
            if (broken && request.level === 0) throw new Error('disk on fire');
            return source.read(request);
          },
        },
        { ...LOOK, brickSize: 16, detail: 0 },
      );
      const heard = [];
      layer.addEventListener('error', (event) => {
        event.preventDefault();
        heard.push(event.detail.error.code);
      });
      let failure;
      await pump(
        figure,
        layer.ready().catch((error) => {
          failure = error;
        }),
      );
      assert(failure?.code === 'failed' && /disk on fire/.test(failure.message), `error: ${failure}`);
      assert(heard[0] === 'failed', 'error event');
      const partial = await capture(figure);
      assert(lit(partial) > 5000, `coarse levels draw: ${lit(partial)}`);
      broken = false;
      await pump(figure, layer.ready());
      const a = await whole(data, { shading: true }),
        result = compare(a, await capture(figure));
      numbers.afterFailure = result;
      assert(result.max <= 2, JSON.stringify(result));
      // A wrong length is a failure too, not a garbled brick.
      gone(figure);
      const short = await figureOn(WIDTH, HEIGHT),
        wrong = brickedVolume(short, { dims: DIMS, range: [0, 1], read: () => new Float32Array(3) }, LOOK);
      wrong.addEventListener('error', (event) => event.preventDefault());
      let shortError;
      await pump(
        short,
        wrong.ready().catch((error) => {
          shortError = error;
        }),
      );
      assert(/returned 3 values/.test(shortError?.message), `error: ${shortError}`);
      gone(short);
    },
  );

  await check('ready and setFrame take an AbortSignal; dispose rejects and aborts', async () => {
    const figure = await figureOn(WIDTH, HEIGHT);
    let abortedRead = false;
    const layer = brickedVolume(
      figure,
      {
        dims: DIMS,
        range: [0, 1],
        frames: 2,
        read: ({ signal }) =>
          new Promise((_, reject) => {
            signal.addEventListener('abort', () => {
              abortedRead = true;
              reject(signal.reason);
            });
          }),
      },
      LOOK,
    );
    const reason = new Error('stop');
    await layer.ready({ signal: AbortSignal.abort(reason) }).then(
      () => assert(false, 'resolved'),
      (error) => assert(error === reason, 'aborted signal'),
    );
    const controller = new AbortController(),
      waiting = layer.setFrame(1, { signal: controller.signal });
    figure.engine.render();
    await tick();
    controller.abort(reason);
    await waiting.then(
      () => assert(false, 'resolved'),
      (error) => assert(error === reason, 'signal reason'),
    );
    await layer.setFrame(9).then(
      () => assert(false, 'resolved'),
      (error) => assert(error instanceof RangeError, 'frame range'),
    );
    const last = layer.ready();
    figure.engine.render();
    await tick();
    layer.dispose();
    await last.then(
      () => assert(false, 'resolved'),
      (error) => assert(error.code === 'disposed', 'disposed'),
    );
    assert(abortedRead, 'read aborted on dispose');
    await layer.ready().then(
      () => assert(false, 'resolved'),
      (error) => assert(error.code === 'disposed', 'disposed again'),
    );
    gone(figure);
  });

  await check(
    'time steps: the old step stays until the new one is in, then matches a whole draw; a timeline waits',
    async () => {
      const second = field(...DIMS, 6),
        figure = await figureOn(WIDTH, HEIGHT),
        source = arraySource([data, second], DIMS);
      let hold;
      const held = new Promise((resolve) => {
        hold = resolve;
      });
      const layer = brickedVolume(
        figure,
        {
          dims: DIMS,
          range: [0, 1],
          frames: 2,
          read: async (request) => {
            if (request.frame === 1) await held;
            return source.read(request);
          },
        },
        { ...LOOK, brickSize: 16, detail: 0, shading: false },
      );
      await pump(figure, layer.ready());
      const first = await capture(figure);
      const moved = layer.setFrame(1);
      figure.engine.render();
      await tick();
      const during = compare(first, await capture(figure));
      assert(layer.frame === 0 && during.max === 0, `old step on screen: ${JSON.stringify(during)}`);
      hold();
      await pump(figure, moved);
      assert(layer.frame === 1, 'frame swapped');
      const result = compare(await whole(second, { shading: false }), await capture(figure));
      numbers.frame1 = result;
      assert(result.max <= 2, JSON.stringify(result));
      const timeline = figure.timeline([0, 1], (index) => layer.setFrame(index), { controls: false });
      await pump(figure, timeline.seek(0));
      assert(layer.frame === 0 && timeline.index === 0, 'timeline moved the layer');
      const back = compare(first, await capture(figure));
      numbers.frame0Again = back;
      assert(back.max === 0, JSON.stringify(back));
      const observed = [];
      const toOne = layer.setFrame(1).then(() => observed.push(layer.frame));
      const toZero = layer.setFrame(0).then(() => observed.push(layer.frame));
      await pump(figure, Promise.all([toOne, toZero]));
      assert(observed.join(',') === '1,0', `each overlapping request resolves for its own frame: ${observed}`);
      const final = compare(first, await capture(figure));
      assert(final.max === 0, `overlapping frames end on the original data: ${JSON.stringify(final)}`);
      gone(figure);
    },
  );

  await check('removing a bricked layer from the figure frees it, and its bounds join the figure', async () => {
    const figure = await figureOn(WIDTH, HEIGHT),
      layer = brickedVolume(figure, arraySource(data, DIMS), { ...LOOK, bounds: [0, 9, 0, 5, 0, 3] });
    assert(figure.bounds[1] === 9 && figure.layers.includes(layer), 'bounds and layers');
    figure.remove(layer);
    assert(!figure.layers.includes(layer), 'removed');
    figure.engine.render();
    gone(figure);
  });

  await check('a ray longer than 2048 steps reaches the far side of a whole volume (regression)', async () => {
    // Quality 64 over 64 voxels asks for 4096 steps along x; the march used to stop at step 2048, half way.
    const dims = [64, 2, 2],
      far = new Float32Array(256);
    for (let i = 0; i < 256; i++) far[i] = i % 64 >= 48 ? 1 : 0;
    const figure = await figureOn(WIDTH, HEIGHT, [-3, 0, 0]);
    figure.volume(far, { dims, range: [0, 1], quality: 64, shading: false, colormap: 'gray', opacity: (t) => t });
    const image = await capture(figure);
    numbers.longRay = lit(image);
    assert(lit(image) > 1000, `drew ${lit(image)} pixels`);
    gone(figure);
  });

  return { checks, numbers };
};

// Frame times at a volume far larger than fits one texture: a procedural field read brick by brick, so the voxels exist
// only while a brick is built. GPU time per frame: render to onSubmittedWorkDone.
window.measureBricks = async ({ dims, memoryBudget, width = 1280, height = 720, frames = 40 }) => {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.style.cssText = `width:${width}px;height:${height}px`;
  document.querySelector('#host').append(canvas);
  const figure = await Figure.create(canvas, { controls: false, axes: false, aspect: [1, 0.5, 0.5] });
  figure.engine.stop?.();
  figure.renderer.device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  let readMs = 0,
    reads = 0;
  const layer = brickedVolume(
    figure,
    {
      dims,
      range: [0, 1],
      read({ level, origin, size }) {
        const start = performance.now(),
          s = 2 ** level,
          out = new Float32Array(size[0] * size[1] * size[2]);
        for (let z = 0, i = 0; z < size[2]; z++)
          for (let y = 0; y < size[1]; y++)
            for (let x = 0; x < size[0]; x++, i++)
              out[i] = fieldAt(
                dims[0],
                dims[1],
                dims[2],
                (origin[0] + x) * s,
                (origin[1] + y) * s,
                (origin[2] + z) * s,
              );
        readMs += performance.now() - start;
        reads++;
        return out;
      },
    },
    { ...LOOK, memoryBudget },
  );
  const device = figure.renderer.device,
    views = [];
  for (const camera of [
    [1.9, 1.3, 2.1],
    [-2.4, 0.6, 1.2],
    [0.6, 2.2, 1.4],
    [1.1, 0.4, 0.9],
  ]) {
    place(figure, camera);
    const started = performance.now();
    await pump(figure, layer.ready());
    const loadMs = performance.now() - started,
      times = [];
    for (let i = 0; i < frames; i++) {
      const t = performance.now();
      figure.engine.render();
      await device.queue.onSubmittedWorkDone();
      times.push(performance.now() - t);
      await tick();
    }
    times.sort((a, b) => a - b);
    views.push({
      camera,
      loadMs: Math.round(loadMs),
      frameMs: {
        median: +times[frames >> 1].toFixed(2),
        p5: +times[Math.floor(frames * 0.05)].toFixed(2),
        p95: +times[Math.floor(frames * 0.95)].toFixed(2),
      },
      ...layer.stats,
    });
  }
  const image = await capture(figure),
    result = {
      dims,
      width,
      height,
      voxels: dims[0] * dims[1] * dims[2],
      wholeBytesHalfFloat: dims[0] * dims[1] * dims[2] * 2,
      memoryBudget: layer.budget.atlasBytes + layer.budget.pageBytes,
      atlasBytes: layer.budget.atlasBytes,
      pageBytes: layer.budget.pageBytes,
      maxTextureDimension3D: device.limits.maxTextureDimension3D,
      reads,
      readMsPerBrick: +(readMs / reads).toFixed(1),
      views,
      lit: lit(image),
      errors: [...errors],
    };
  gone(figure);
  return result;
};
