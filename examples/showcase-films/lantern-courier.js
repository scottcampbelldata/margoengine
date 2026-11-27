import { LayerCompositor, PixelCamera } from '@margoengine/pixel';
import { SpriteLayer } from '@margoengine/sprites';
import { Lighting2D } from '@margoengine/lighting2d';
import { mix, ramp, rng } from './film.js';

const W = 320,
  H = 180,
  length = 1340;
const ink = '#15232f';
function art(width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const rect = (x, y, w, h, c) => {
    ctx.fillStyle = c;
    ctx.fillRect(Math.floor(x), Math.floor(y), Math.round(w), Math.round(h));
  };
  // Scan-convert the polygon to opaque integer pixels. The palette is the authored colour set.
  function poly(points, color) {
    const min = Math.max(0, Math.floor(Math.min(...points.map((p) => p[1]))));
    const max = Math.min(height, Math.ceil(Math.max(...points.map((p) => p[1]))));
    ctx.fillStyle = color;
    for (let y = min; y < max; y++) {
      const hits = [];
      for (let i = 0; i < points.length; i++) {
        const [a, b] = [points[i], points[(i + 1) % points.length]];
        const sample = y + 0.5;
        if ((a[1] <= sample && b[1] > sample) || (b[1] <= sample && a[1] > sample))
          hits.push(a[0] + ((b[0] - a[0]) * (sample - a[1])) / (b[1] - a[1]));
      }
      hits.sort((a, b) => a - b);
      for (let j = 0; j < hits.length; j += 2) {
        const left = Math.ceil(hits[j] - 0.5),
          right = Math.ceil(hits[j + 1] - 0.5);
        ctx.fillRect(left, y, right - left, 1);
      }
    }
  }
  return {
    ctx,
    rect,
    poly,
    image: () => ({ width, height, data: new Uint8Array(ctx.getImageData(0, 0, width, height).data.buffer) }),
  };
}

const ground = (x) =>
  Math.floor(
    138 - 0.009 * x - 6 * Math.sin(x / 108) - 3 * Math.sin(x / 42) + 7 * ramp(x, 535, 690) - 19 * ramp(x, 715, 905),
  );
const landmarks = [
  [65, 37, 42, 0],
  [189, 56, 60, 2],
  [274, 39, 49, 1],
  [371, 60, 55, 0],
  [442, 48, 64, 2],
  [523, 45, 50, 0],
  [617, 57, 63, 1],
  [678, 46, 56, 2],
  [815, 55, 54, 0],
  [890, 68, 76, 2],
  [965, 49, 58, 1],
  [1039, 83, 81, 2],
  [1141, 60, 60, 0],
];
const duskPalettes = [
  ['#273b51', '#4e6170', '#344858', '#768196', '#b47a64'],
  ['#293f45', '#537765', '#3f5c52', '#799182', '#9a775e'],
  ['#473e54', '#796477', '#54475f', '#8a7991', '#a77b72'],
];

function skyline() {
  const stars = art(length, H);
  const row = ['#1b294b', '#282f56', '#3e3e66', '#594d71', '#785979', '#976a7c', '#b7797c', '#cc897d', '#d39380'];
  row.forEach((c, i) => stars.rect(0, i * 20, length, 20, c));
  const r = rng(1504);
  for (let i = 0; i < 240; i++)
    stars.rect(r() * length, r() * 79, 1, i % 11 === 0 ? 2 : 1, i % 3 === 0 ? '#ab89a3' : '#6d658b');
  for (let y = -15; y <= 15; y++)
    for (let x = -15; x <= 15; x++) {
      if (x * x + y * y > 208) continue;
      const color = x + y > -2 ? '#f2c198' : '#ffdab0';
      stars.rect(258 + x, 43 + y, 1, 1, color);
    }
  const ridges = art(length, H);
  for (const [base, amp, color, period] of [
    [123, 38, '#706385', 94],
    [140, 42, '#4f587a', 71],
    [156, 38, '#374d67', 51],
  ]) {
    const shape = [];
    for (let x = 0; x <= length; x += 3)
      shape.push([x, base - amp * (0.51 + 0.34 * Math.sin(x / period) + 0.16 * Math.sin(x / (period * 0.31)))]);
    ridges.poly([...shape, [length, H], [0, H]], color);
  }
  for (let i = 0; i < 200; i++) {
    const x = r() * length,
      y = 113 + r() * 54;
    ridges.rect(x, y, 1 + r() * 4, 1, i % 5 === 0 ? '#ce936c' : '#515d77');
  }
  return [stars.image(), ridges.image()];
}

function street() {
  const layer = art(length, H),
    { rect, poly } = layer,
    r = rng(62);
  const shadowEdges = [];
  for (let x = 0; x < length; x++) {
    const y = ground(x);
    rect(x, y, 1, H - y, '#273b43');
    rect(x, y, 1, 5, '#a49182');
    rect(x, y + 5, 1, 4, '#625d64');
    rect(x, y + 9, 1, 3, '#3c4d53');
    if (x % 6 === 0) rect(x, y + 2, 1, 4, '#65606b');
  }
  const gate = ground(346) - 1;
  for (const x of [337, 359]) {
    rect(x, gate - 33, 7, 34, '#293442');
    for (let i = 0; i < 7; i++) rect(x + 1 + (i % 2), gate - 30 + i * 4, 4, 1, '#85828d');
  }
  poly(
    [
      [334, gate - 30],
      [340, gate - 39],
      [356, gate - 43],
      [369, gate - 34],
      [369, gate - 28],
      [362, gate - 30],
      [358, gate - 34],
      [346, gate - 34],
      [342, gate - 29],
    ],
    '#45516a',
  );
  poly(
    [
      [335, gate - 32],
      [344, gate - 40],
      [356, gate - 43],
      [364, gate - 38],
      [356, gate - 41],
      [343, gate - 37],
    ],
    '#b38d84',
  );
  rect(351, gate - 32, 4, 6, '#a97054');
  rect(352, gate - 31, 2, 3, '#e2ae73');
  shadowEdges.push({ shape: 'segment', from: [360, gate - 29], to: [360, gate - 5] });
  for (let i = 0; i < 3500; i++) {
    const x = r() * length,
      y = ground(x) + 2 + r() * 38;
    rect(x, y, 1 + r() * 3, 1, ['#394c50', '#4e585b', '#758078', '#333f4c'][i % 4]);
  }
  for (const [x, width, h, type] of landmarks) {
    const c = duskPalettes[type],
      floor = ground(x + width * 0.5) + 1,
      top = floor - h,
      front = x + 5,
      depth = 8;
    poly(
      [
        [x, top + 9],
        [front, top + 2],
        [front + width, top + 2],
        [front + width, floor],
        [x, floor],
      ],
      ink,
    );
    rect(front, top + 13, width - 2, h - 13, c[1]);
    poly(
      [
        [front + width - 11, top + 9],
        [front + width, top + 4],
        [front + width, floor],
        [front + width - 11, floor],
      ],
      c[2],
    );
    const peak = top - 14 - (type === 2 ? 8 : 0);
    poly(
      [
        [x - 5, top + 15],
        [front + width * 0.43, peak],
        [front + width + 8, top + 11],
        [front + width, top + 18],
        [x - 3, top + 19],
      ],
      ink,
    );
    poly(
      [
        [x - 2, top + 14],
        [front + width * 0.43, peak + 3],
        [front + width + 4, top + 11],
        [front + width - 10, top + 14],
      ],
      c[4],
    );
    poly(
      [
        [x - 2, top + 15],
        [front + width * 0.43, peak + 4],
        [front + width * 0.36, top + 15],
      ],
      c[0],
    );
    rect(x - 3, top + 15, width + 12, 2, c[0]);
    for (let k = 0; k < h - 18; k += 6) {
      for (let xx = front + 3 + (k % 4); xx < front + width - 13; xx += 8) {
        rect(xx, top + 19 + k, 4 + r() * 3, 1, c[3]);
        if (r() > 0.7) rect(xx - 2, top + 20 + k, 1, 3, c[2]);
      }
    }
    for (let xx = front + 8; xx < front + width - 18; xx += 13) {
      rect(xx - 1, top + 24, 8, 13, ink);
      rect(xx, top + 25, 6, 10, c[2]);
      if (r() > 0.23) {
        rect(xx + 1, top + 27, 4, 6, '#d49254');
        rect(xx + 1, top + 26, 4, 2, '#f1bd70');
        rect(xx + 3, top + 26, 1, 8, '#8a5b51');
      }
      rect(xx - 2, top + 36, 10, 2, c[0]);
    }
    const door = front + Math.round(width * 0.61);
    rect(door - 2, floor - 21, 12, 22, ink);
    rect(door, floor - 19, 8, 20, c[0]);
    rect(door + 1, floor - 17, 1, 15, c[3]);
    rect(door + 6, floor - 8, 2, 1, '#c99769');
    rect(door - 3, floor - 1, 14, 2, c[3]);
    if (type === 2) {
      rect(front + width - depth, peak + 6, 7, 14, c[0]);
      rect(front + width - depth - 1, peak + 4, 9, 3, c[2]);
    }
    shadowEdges.push({ shape: 'segment', from: [front + width - 11, floor - 19], to: [front + width - 11, floor - 2] });
  }
  // Near silhouette, stone holding walls and rail posts outline the climb.
  for (const [start, end] of [
    [0, 141],
    [395, 434],
    [745, 806],
    [974, 1022],
    [1222, 1339],
  ]) {
    for (let x = start; x < end; x++) {
      const y = ground(x) + 7;
      rect(x, y, 1, 3, '#59515a');
      rect(x, y + 3, 1, H - y - 3, '#24323d');
      if (x % 9 < 2) rect(x, y - 11, 2, 14, '#334354');
      if (x % 5 === 0) rect(x, y + 7, 3, 1, '#384857');
    }
  }
  // A bridge passes in front of the lower roofs. The stone arch leaves the ravine visible below the deck.
  const lower = 721,
    upper = 809;
  for (let x = lower; x < upper; x++) {
    const y = ground(x) + 4,
      center = x - (lower + upper) / 2;
    const arch = Math.abs(center) < 29 ? y + 17 - 10 * Math.sqrt(1 - (center / 29) ** 2) : H;
    rect(x, y, 1, H - y, '#242c3e');
    rect(x, y, 1, arch - y, '#465064');
    rect(x, y - 3, 1, 3, '#b59e94');
    if ((x - lower) % 7 < 2) rect(x, y - 9, 2, 8, '#5f6471');
    if (x % 3 === 0 && arch < H) rect(x, arch - 1, 1, 3, '#706878');
    if (x % 11 === 0) rect(x, y + 2, 3, 1, '#9a8084');
  }
  const towerX = 926,
    base = ground(towerX),
    eave = base - 82;
  rect(towerX - 11, eave, 24, 84, '#3e445b');
  rect(towerX - 9, eave + 5, 15, 75, '#82727b');
  rect(towerX + 6, eave + 5, 6, 75, '#5b5970');
  poly(
    [
      [towerX - 15, eave + 5],
      [towerX + 1, eave - 19],
      [towerX + 16, eave + 5],
    ],
    '#715769',
  );
  poly(
    [
      [towerX - 15, eave + 6],
      [towerX + 1, eave - 19],
      [towerX - 1, eave + 3],
    ],
    '#b28d84',
  );
  for (let y = eave + 8; y < base - 12; y += 6) rect(towerX - 7 + (y % 3), y, 7, 1, '#9c8591');
  for (let i = 0; i < 2; i++) {
    rect(towerX - 8 + i * 8, eave + 12, 6, 13, '#303444');
    rect(towerX - 7 + i * 8, eave + 13, 4, 10, '#aaa285');
    rect(towerX - 6 + i * 8, eave + 15, 2, 5, '#f4c989');
  }
  rect(towerX - 12, eave + 28, 25, 4, '#54485c');
  const delivery = 1093,
    floor = ground(delivery) + 1;
  rect(delivery - 15, floor - 52, 35, 8, '#252831');
  // Coloured tiles stand for painted sign lettering in the low-resolution sprite sheet.
  for (let i = 0; i < 7; i++) rect(delivery - 11 + 4 * i, floor - 50, 2, 3, '#d1af83');
  return { image: layer.image(), shadowEdges };
}

function courierAtlas() {
  const a = art(32 * 8, 38),
    { poly, rect } = a;
  for (let frame = 0; frame < 8; frame++) {
    const u = frame * 32,
      phase = (frame * Math.PI) / 4,
      lift = Math.floor((1 + Math.sin(phase * 2)) * 0.6);
    const draw = (points, color) =>
      poly(
        points.map(([x, y]) => [x + u, y - lift]),
        color,
      );
    const step = frame === 7 ? 0 : Math.round(5 * Math.sin(phase));
    for (const [shift, c] of [
      [-step, '#2a354e'],
      [step, '#4b5270'],
    ]) {
      draw(
        [
          [10, 24],
          [16, 24],
          [16 + shift, 33],
          [15 + shift, 35],
          [10 + shift, 35],
          [9 + shift, 31],
        ],
        c,
      );
      draw(
        [
          [10 + shift, 33],
          [15 + shift, 33],
          [18 + shift, 37],
          [9 + shift, 37],
        ],
        '#161d2b',
      );
    }
    draw(
      [
        [8, 11],
        [18, 12],
        [20, 25],
        [17, 28],
        [9, 27],
        [6, 31],
        [5, 29],
      ],
      '#742f40',
    );
    draw(
      [
        [10, 12],
        [17, 13],
        [16, 23],
        [11, 24],
        [7, 28],
        [8, 17],
      ],
      '#bd5f52',
    );
    draw(
      [
        [9, 15],
        [15, 17],
        [13, 24],
        [7, 24],
        [5, 21],
      ],
      '#a47959',
    );
    draw(
      [
        [7, 16],
        [11, 15],
        [13, 20],
        [12, 23],
        [6, 23],
      ],
      '#644958',
    );
    draw(
      [
        [11, 1],
        [18, 1],
        [21, 6],
        [23, 7],
        [23, 9],
        [20, 10],
        [19, 13],
        [12, 12],
        [8, 8],
      ],
      '#1e2a42',
    );
    draw(
      [
        [12, 4],
        [18, 3],
        [19, 6],
        [21, 8],
        [18, 10],
        [15, 11],
        [13, 9],
      ],
      '#a65f57',
    );
    draw(
      [
        [15, 4],
        [18, 5],
        [18, 7],
        [20, 8],
        [18, 9],
        [16, 9],
      ],
      '#e2a173',
    );
    rect(u + 17, 6 - lift, 1, 1, '#3b3045');
    draw(
      [
        [10, 10],
        [20, 10],
        [20, 12],
        [15, 13],
        [7, 15],
        [5, 14],
        [11, 11],
      ],
      '#ed9574',
    );
    draw(
      [
        [17, 13],
        [20, 15],
        [22, 20],
        [26, 18],
        [27, 20],
        [22, 23],
        [18, 20],
      ],
      '#a7514c',
    );
    const ly = frame === 7 ? 17 : 18 + Math.round(Math.cos(phase));
    rect(u + 25, ly - lift, 3, 1, ink);
    rect(u + 24, ly + 1 - lift, 5, 7, ink);
    rect(u + 25, ly + 2 - lift, 3, 4, '#f19553');
    rect(u + 26, ly + 2 - lift, 1, 3, '#ffdfa3');
    rect(u + 23, ly + 7 - lift, 7, 1, '#523b49');
  }
  return a.image();
}

const move = [
  [0, 84],
  [4.5, 133],
  [13, 238],
  [22, 323],
  [28, 323],
  [40, 496],
  [52, 678],
  [61, 746],
  [66, 771],
  [76, 1007],
  [82, 1096],
  [90, 1096],
];
function xAt(t) {
  const i = Math.max(
    1,
    move.findIndex(([end]) => end >= t),
  );
  const [[start, a], [end, b]] = move.slice(i - 1, i + 1);
  return mix(a, b, Math.max(0, Math.min(1, (t - start) / (end - start))));
}
export function buildCourier(engine) {
  const camera = new PixelCamera({ width: W, height: H, smooth: true });
  const compositor = LayerCompositor.attach(engine, { camera, order: 48 });
  const [sky, ridge] = skyline(),
    world = street();
  compositor.addLayer({ anchor: 'world', width: length, height: H, parallax: 0.16, z: 0 }).write(sky);
  compositor.addLayer({ anchor: 'world', width: length, height: H, parallax: 0.46, z: 1 }).write(ridge);
  compositor.addLayer({ anchor: 'world', width: length, height: H, parallax: 1, z: 2 }).write(world.image);
  const actors = compositor.addLayer({ z: 3 });
  const sprites = SpriteLayer.attach(engine, { atlas: courierAtlas(), target: actors.target, camera: actors.camera });
  const courier = sprites.add({ rect: [0, 0, 32, 38], pivotX: 0.5, pivotY: 1 });
  const shade = compositor.addLayer({ z: 4, blend: 'multiply', opacity: 0.85 });
  const lights = Lighting2D.attach(engine, {
    target: shade.target,
    camera: shade.camera,
    ambient: '#aca7c3',
    occluders: world.shadowEdges,
  });
  const lantern = lights.addLight({ radius: 43, height: 23, color: '#ffd29a', intensity: 2.5 });
  lights.addLight({ x: 353, y: ground(346) - 32, radius: 39, height: 28, color: '#efaa70', intensity: 0.89 });
  const door = lights.addLight({
    x: 1094,
    y: ground(1094) - 12,
    radius: 76,
    height: 41,
    color: '#ffd08e',
    intensity: 0.35,
    shadows: false,
  });
  return {
    apply(time) {
      const x = xAt(time),
        y = ground(x) + 4,
        stopped = Math.abs(xAt(Math.min(90, time + 0.025)) - x) < 0.02;
      const anticipation = time < 4.5 ? 0.21 : time < 26 ? 0.34 : time < 52 ? 0.28 : time < 75 ? 0.39 : 0.43;
      const close = (time >= 22 && time < 28) || (time >= 77 && time < 83);
      const fittingZoom = Math.ceil(Math.max(engine.canvas.width / W, engine.canvas.height / H));
      camera.zoom = close ? Math.ceil(fittingZoom * 1.28) : fittingZoom;
      camera.x = Math.max(0, Math.min(length - W, x - W * anticipation));
      courier.x = x;
      courier.y = y;
      courier.rect = [32 * (stopped ? 7 : Math.floor(x / 2.85) % 7), 0, 32, 38];
      lantern.x = x + 11;
      lantern.y = y - 17;
      lantern.intensity = 1.8 + 0.13 * Math.sin(time * 5.4) + 0.16 * Math.sin(time * 14.9);
      door.intensity = 0.35 + 1.7 * ramp(time, 81.5, 83);
      return { position: [0, 2, 5], target: [0, 1, 0], fov: 42 };
    },
    cues: [
      [6, 12, 'One last delivery before the hill goes dark.'],
      [21.9, 27, 'The courier pauses at the lower gate.'],
      [35, 41, 'The lantern moves with each step.'],
      [51.5, 58, 'Nearby walls cut shadows across the path.'],
      [60, 65, 'The bridge crosses the ravine.'],
      [68, 74, 'One more climb to the workshop.'],
      [79.5, 82.8, 'The workshop light comes on.'],
    ],
    inspection: { courier, lantern, camera },
    dispose() {
      lights.dispose();
      sprites.dispose();
      compositor.dispose();
    },
  };
}
