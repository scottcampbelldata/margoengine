// Browser half of scripts/sciviz-density-attribution.mjs: the rivals' and Margo's renderers behind one call, and the
// probes. Rivals are driven only through their public APIs with the settings of scripts/sciviz-density-pixels.mjs.
import * as model from './density-raster-model.mjs';

export const SIZE = 256;
export const OPACITY = 0.08;

const canvas = () => {
  const c = document.createElement('canvas');
  c.width = c.height = SIZE;
  c.style.cssText = `width:${SIZE}px;height:${SIZE}px`;
  document.body.append(c);
  return c;
};
// The composited image on black, red channel, top row first.
const red = (source) => {
  const context = new OffscreenCanvas(SIZE, SIZE).getContext('2d');
  context.fillStyle = '#000';
  context.fillRect(0, 0, SIZE, SIZE);
  context.drawImage(source, 0, 0);
  const bytes = context.getImageData(0, 0, SIZE, SIZE).data;
  return Uint8Array.from({ length: SIZE * SIZE }, (_, i) => bytes[i * 4]);
};

async function renderers(url) {
  const { createScatterplot, Deck, OrthographicView, COORDINATE_SYSTEM, ScatterplotLayer } = await import(url);
  return {
    async 'regl-scatterplot'(x, y) {
      const target = canvas();
      const plot = createScatterplot({
        canvas: target,
        width: SIZE,
        height: SIZE,
        pointSize: 1,
        pointColor: '#ffffff',
        backgroundColor: '#000000',
        opacity: OPACITY,
        renderPointsAsSquares: true,
        disableAlphaBlending: false,
        pointScaleMode: 'constant',
        cameraIsFixed: true,
      });
      try {
        await plot.draw({ x, y });
        return red(target);
      } finally {
        plot.destroy();
        target.remove();
      }
    },
    async 'deck.gl'(x, y) {
      const target = canvas();
      const positions = new Float32Array(x.length * 3);
      for (let i = 0; i < x.length; i++) {
        positions[i * 3] = (x[i] * SIZE) / 2;
        positions[i * 3 + 1] = (y[i] * SIZE) / 2;
      }
      let done, fail;
      const ready = new Promise((resolve, reject) => {
        done = resolve;
        fail = reject;
      });
      const deck = new Deck({
        canvas: target,
        width: SIZE,
        height: SIZE,
        useDevicePixels: false,
        views: new OrthographicView({ flipY: false }),
        initialViewState: { target: [0, 0, 0], zoom: 0 },
        controller: false,
        deviceProps: { type: 'webgl', webgl: { preserveDrawingBuffer: true, antialias: false } },
        onAfterRender: () => done(),
        onError: fail,
        layers: [
          new ScatterplotLayer({
            id: 'all-points',
            data: { length: x.length, attributes: { getPosition: { value: positions, size: 3 } } },
            coordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
            getRadius: 0.5,
            radiusUnits: 'pixels',
            getFillColor: [255, 255, 255, Math.round(OPACITY * 255)],
            stroked: false,
            antialiasing: false,
            parameters: { depthWriteEnabled: false, depthCompare: 'always' },
          }),
        ],
      });
      try {
        await ready;
        deck.redraw(true);
        await new Promise(requestAnimationFrame);
        return red(target);
      } finally {
        deck.finalize();
        target.remove();
      }
    },
  };
}

// Normalized coordinates of window position (px, py), top-left origin, y down.
const nx = (px) => px / (SIZE / 2) - 1;
const ny = (py) => 1 - py / (SIZE / 2);

/** k coincident points at the centre of one pixel for every k: the accumulation law of each renderer. */
async function stacks(render) {
  const counts = [...Array.from({ length: 96 }, (_, i) => i + 1), 128, 256, 1024, 4096];
  const x = [],
    y = [];
  const at = counts.map((count, i) => {
    const px = 2 + (i % 50) * 4,
      py = 2 + Math.floor(i / 50) * 4;
    for (let k = 0; k < count; k++) {
      x.push(nx(px + 0.5));
      y.push(ny(py + 0.5));
    }
    return py * SIZE + px;
  });
  const image = await render(Float32Array.from(x), Float32Array.from(y));
  return counts.map((count, i) => [count, image[at[i]]]);
}

export const OFFSETS = [
  0,
  1 / 4096,
  1 / 1024,
  3 / 2048,
  1 / 512,
  5 / 2048,
  1 / 256,
  1 / 64,
  1 / 8,
  1 / 4,
  1 / 2,
  3 / 4,
  7 / 8,
  63 / 64,
  255 / 256,
  511 / 512,
  1023 / 1024,
  4095 / 4096,
];

/** One point per cell at every sub-pixel offset pair: which pixels each renderer lights. */
async function sweep(render, base) {
  const x = [],
    y = [],
    cells = [];
  for (let j = 0; j < OFFSETS.length; j++)
    for (let i = 0; i < OFFSETS.length; i++) {
      const px = base + i * 4,
        py = base + j * 4;
      x.push(nx(px + OFFSETS[i]));
      y.push(ny(py + OFFSETS[j]));
      cells.push([px, py, OFFSETS[i], OFFSETS[j]]);
    }
  const image = await render(Float32Array.from(x), Float32Array.from(y));
  return cells.map(([px, py, ox, oy]) => {
    const lit = [];
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) if (image[(py + dy) * SIZE + px + dx]) lit.push([dx, dy]);
    return [ox, oy, lit];
  });
}

// The two comparison datasets of scripts/sciviz-density-pixels.mjs: real observations tiled to the point count.
async function datasets() {
  const { readCSV } = await import('/packages/sciviz/dist/table.js');
  const values = new Float32Array(
    await new Response(
      (await fetch('/examples/assets/sciviz/stars.bin')).body.pipeThrough(new DecompressionStream('gzip')),
    ).arrayBuffer(),
  );
  const taxi = readCSV(await (await fetch('/examples/assets/sciviz/limits/taxi.csv')).text());
  const stars = values.length / 2;
  return {
    'regl-scatterplot': {
      points: 20000000,
      base: Math.min(stars, 1000000),
      at: (a) => [values[a] / 180 - 1, values[1000000 + a] / 90],
    },
    'deck.gl': {
      points: 10000000,
      base: taxi.length,
      at: (a) => [
        (Number(taxi.value('pickup_longitude', a)) + 75) / 1.5 - 1,
        Number(taxi.value('pickup_latitude', a)) - 40 - 1,
      ],
    },
  };
}

async function margo(positions) {
  const { Figure } = await import('/packages/sciviz/dist/index.js');
  const { densityScatter } = await import('/packages/sciviz/dist/density.js');
  const target = canvas();
  const figure = await Figure.create(target, {
    mode: '2d',
    axes: false,
    controls: false,
    theme: 'dark',
    limits: [-1, 1, -1, 1],
    margin: { top: 0, bottom: 0, left: 0, right: 0 },
  });
  try {
    figure.engine.stop();
    figure.engine.scene.background = '#000000';
    const density = densityScatter(figure, positions, { opacity: OPACITY, color: '#ffffff' });
    await figure.ready();
    figure.render();
    await figure.renderer.device.queue.onSubmittedWorkDone();
    const bitmap = await createImageBitmap(await figure.toPNG({ overlays: false }));
    const image = red(bitmap);
    bitmap.close();
    return { image, counts: await density.readCounts() };
  } finally {
    figure.dispose();
    target.remove();
  }
}

// What is left: for every pixel where `a` and `b` differ, the smallest distance in pixels from a boundary of a
// nearby observation. A tiny distance says rounding of that observation's position decides its pixel.
function nearestBoundary(a, b, base, shiftX, shiftY) {
  const window = base.map(([u, v]) => [(u + 1) * (SIZE / 2), (1 - v) * (SIZE / 2)]);
  const distances = [];
  for (let i = 0; i < a.length; i++) {
    if (a[i] === b[i]) continue;
    const px = i % SIZE,
      py = Math.floor(i / SIZE);
    let best = Infinity;
    for (const [x, y] of window) {
      if (Math.abs(x - px - 0.5) > 1.6 || Math.abs(y - py - 0.5) > 1.6) continue;
      const dx = Math.abs(x - shiftX - Math.round(x - shiftX)),
        dy = Math.abs(y - shiftY - Math.round(y - shiftY));
      best = Math.min(best, dx, dy);
    }
    distances.push(best);
  }
  return distances.sort((m, n) => m - n);
}

/**
 * Real data: rebuild each rival's image from the measured rules one cause at a time, and compare every step with the
 * image the rival really drew.
 */
async function attribute(name, render, data) {
  const x = new Float32Array(data.points),
    y = new Float32Array(data.points),
    positions = new Float32Array(data.points * 3),
    base = [];
  for (let a = 0; a < data.base; a++) base.push(data.at(a));
  for (let i = 0; i < data.points; i++) {
    const [u, v] = base[i % data.base];
    positions[i * 3] = x[i] = u;
    positions[i * 3 + 1] = y[i] = v;
  }
  const ours = await margo(positions),
    theirs = await render(x, y),
    rules = model.RIVAL_RULES[name];
  const histogram = (pixel) => {
    const counts = new Uint32Array(SIZE * SIZE);
    let dropped = 0;
    for (let i = 0; i < data.points; i++) {
      const u = x[i],
        v = y[i];
      if (!(Math.abs(u) <= 1 && Math.abs(v) <= 1)) continue;
      const at = pixel((u + 1) * (SIZE / 2), (1 - v) * (SIZE / 2));
      if (!at) dropped++;
      else if (at[0] >= 0 && at[1] >= 0 && at[0] < SIZE && at[1] < SIZE) counts[at[1] * SIZE + at[0]]++;
    }
    return { counts, dropped };
  };
  const exact = histogram(model.containingPixel),
    covered = histogram(rules.pixel);
  const shade = (counts, blend, alpha) => {
    const cache = new Map();
    return Uint8Array.from(counts, (count) => {
      let byte = cache.get(count);
      if (byte === undefined) cache.set(count, (byte = blend(count, alpha)));
      return byte;
    });
  };
  const steps = {
    'Margo as drawn': ours.image,
    'rival coverage': shade(covered.counts, model.exactOverByte, OPACITY),
    'rival coverage and opacity byte': shade(covered.counts, model.exactOverByte, rules.alpha),
    'full rival model': shade(covered.counts, rules.blend, rules.alpha),
  };
  const alone = {
    'coverage alone': steps['rival coverage'],
    'opacity byte alone': shade(exact.counts, model.exactOverByte, rules.alpha),
    'blend law alone': shade(exact.counts, rules.blend, OPACITY),
  };
  const margoExact = shade(exact.counts, model.exactOverByte, OPACITY);
  let countPixels = 0,
    countPoints = 0;
  for (let i = 0; i < exact.counts.length; i++) {
    const d = Math.abs(exact.counts[i] - ours.counts[i]);
    if (d) countPixels++;
    countPoints += d;
  }
  const lit = (image) => image.reduce((sum, byte) => sum + (byte > 0), 0);
  return {
    points: data.points,
    observations: data.base,
    droppedByRivalRule: covered.dropped,
    litPixels: { margo: lit(ours.image), rival: lit(theirs), model: lit(steps['full rival model']) },
    margoBoundaryDistances: nearestBoundary(exact.counts, ours.counts, base, 0, 0),
    residualBoundaryDistances: nearestBoundary(steps['full rival model'], theirs, base, 1 / 512, -1 / 512),
    margoAgainstBinary64Bins: {
      pixels: countPixels,
      countDifference: countPoints,
      image: model.compareBytes(ours.image, margoExact),
    },
    againstRival: Object.fromEntries(
      Object.entries(steps).map(([step, image]) => [step, model.compareBytes(image, theirs)]),
    ),
    againstMargo: Object.fromEntries(
      Object.entries(alone).map(([step, image]) => [step, model.compareBytes(image, margoExact)]),
    ),
  };
}

export async function run(url) {
  const render = await renderers(url);
  const result = {};
  for (const name of Object.keys(render))
    result[name] = {
      stacks: await stacks(render[name]),
      sweepLow: await sweep(render[name], 8),
      sweepHigh: await sweep(render[name], 176),
    };
  const data = await datasets();
  for (const name of Object.keys(render)) result[name].real = await attribute(name, render[name], data[name]);
  return result;
}
