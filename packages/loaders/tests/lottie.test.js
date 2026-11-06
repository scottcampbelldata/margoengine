// parseLottie: keyframes, layers, precompositions, shapes, paints and the canvas draw, on animations the test writes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseLottie } from '../dist/lottie.js';
import { LoaderError } from '../dist/common.js';

const refuses = (fn, code) =>
  assert.throws(fn, (error) => error instanceof LoaderError && error.format === 'Lottie' && error.code === code);
const near = (a, b, tolerance = 1e-6) => assert.ok(Math.abs(a - b) <= tolerance, `${a} is not near ${b}`);
const k = (value) => ({ a: 0, k: value });
const fill = (rgb = [1, 0, 0], opacity = 100) => ({ ty: 'fl', c: k(rgb), o: k(opacity) });
const rect = (w = 10, h = 10, x = 0, y = 0) => ({ ty: 'rc', p: k([x, y]), s: k([w, h]), r: k(0) });
const stroke = (extra = {}) => ({ ty: 'st', c: k([0, 0, 0]), o: k(100), w: k(1), ...extra });
const shapeLayer = (shapes, extra = {}) => ({ ty: 4, ks: {}, ip: 0, op: 100, st: 0, shapes, ...extra });
const anim = (layers, extra = {}) => ({ v: '5.7.4', nm: 'n', fr: 30, ip: 0, op: 60, w: 100, h: 50, layers, ...extra });
const linear = { o: { x: 0, y: 0 }, i: { x: 1, y: 1 } };
const box = (path) => {
  const points = path.commands.filter((c) => c[0] !== 'Z').map((c) => c.slice(-2)),
    xs = points.map((p) => p[0]),
    ys = points.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
};
const one = (layers, frame = 0, extra) => parseLottie(JSON.stringify(anim(layers, extra))).frame(frame);

function recorder(calls) {
  const record =
    (name) =>
    (...args) => {
      calls.push([name, ...args]);
    };
  const gradient =
    (kind) =>
    (...args) => {
      calls.push([kind, ...args]);
      return { addColorStop: record('stop') };
    };
  const context = { createLinearGradient: gradient('linear'), createRadialGradient: gradient('radial') };
  for (const name of [
    'save',
    'restore',
    'beginPath',
    'moveTo',
    'lineTo',
    'bezierCurveTo',
    'quadraticCurveTo',
    'closePath',
    'fill',
    'stroke',
    'transform',
    'setLineDash',
    'drawImage',
  ])
    context[name] = record(name);
  return context;
}

test('the header reads, from text or bytes, with assets and markers', () => {
  const body = anim([], {
    markers: [{ cm: 'intro', tm: 5, dr: 10 }],
    assets: [
      { id: 'i', w: 8, h: 4, u: 'images/', p: 'a.png', e: 0 },
      { id: 'd', w: 1, h: 1, u: '', p: 'data:image/png;base64,AA', e: 1 },
    ],
  });
  for (const input of [JSON.stringify(body), new TextEncoder().encode(JSON.stringify(body))]) {
    const animation = parseLottie(input);
    assert.equal(animation.version, '5.7.4');
    assert.equal(animation.name, 'n');
    assert.deepEqual([animation.width, animation.height, animation.frameRate], [100, 50, 30]);
    assert.deepEqual([animation.inFrame, animation.outFrame, animation.duration], [0, 60, 2]);
    assert.deepEqual(animation.markers, [{ name: 'intro', time: 5, duration: 10 }]);
    assert.deepEqual(animation.images, [
      { id: 'i', width: 8, height: 4, path: 'images/a.png', embedded: false },
      { id: 'd', width: 1, height: 1, path: 'data:image/png;base64,AA', embedded: true },
    ]);
    assert.deepEqual(animation.unsupported, []);
  }
});

test('a filled rectangle comes out as one closed path around its centre', () => {
  const [path] = one([shapeLayer([rect(10, 4, 20, 30), fill([0, 1, 0], 50)])]);
  assert.equal(path.kind, 'path');
  assert.deepEqual(path.fill, [0, 1, 0]);
  assert.equal(path.stroke, null);
  assert.equal(path.opacity, 0.5);
  assert.deepEqual(box(path), [15, 28, 25, 32]);
  assert.deepEqual(path.commands.at(-1), ['Z']);
  assert.equal(path.toShapes().length, 1);
});

test('toShapes can flip y for a y-up world', () => {
  const [path] = one([shapeLayer([rect(2, 2, 0, 10), fill()])]);
  const points = path.toShapes({ flipY: true })[0].getPoints();
  assert.ok(points.every((p) => p[1] < 0));
});

test('a rounded rectangle, an ellipse and stars keep their extents', () => {
  const rounded = one([shapeLayer([{ ty: 'rc', p: k([0, 0]), s: k([10, 10]), r: k(2) }, fill()])])[0];
  assert.deepEqual(box(rounded), [-5, -5, 5, 5]);
  const ellipse = one([shapeLayer([{ ty: 'el', p: k([1, 2]), s: k([10, 4]) }, fill()])])[0];
  assert.deepEqual(box(ellipse), [-4, 0, 6, 4]);
  const polygon = one([shapeLayer([{ ty: 'sr', sy: 2, p: k([0, 0]), pt: k(4), r: k(0), or: k(10) }, fill()])])[0];
  assert.equal(polygon.commands.filter((c) => c[0] === 'L').length, 4);
  near(polygon.commands[0][2], -10);
  const star = one([
    shapeLayer([{ ty: 'sr', sy: 1, p: k([0, 0]), pt: k(5), r: k(0), or: k(10), ir: k(4) }, fill()]),
  ])[0];
  assert.equal(star.commands.filter((c) => c[0] === 'L').length, 10);
});

test('a bezier shape keeps its handles, closed or open', () => {
  const ks = k({
    c: false,
    v: [
      [0, 0],
      [10, 0],
    ],
    o: [
      [1, 2],
      [0, 0],
    ],
    i: [
      [0, 0],
      [-3, 4],
    ],
  });
  const [path] = one([shapeLayer([{ ty: 'sh', ks }, fill()])]);
  assert.deepEqual(path.commands, [
    ['M', 0, 0],
    ['C', 1, 2, 7, 4, 10, 0],
  ]);
});

test('layer transforms: anchor, scale, rotation, opacity, and parents', () => {
  const [path] = one([
    shapeLayer([rect(2, 2), fill()], {
      ks: { a: k([1, 1, 0]), p: k([10, 20, 0]), s: k([200, 300, 100]), r: k(0), o: k(50) },
    }),
  ]);
  assert.deepEqual(box(path), [6, 14, 10, 20]);
  assert.equal(path.opacity, 0.5);
  const [turned] = one([shapeLayer([rect(2, 4, 3, 0), fill()], { ks: { r: k(90) } })]);
  const area = box(turned);
  near(area[0], -2);
  near(area[1], 2);
  near(area[2], 2);
  near(area[3], 4);
  const [child] = one([
    shapeLayer([rect(2, 2), fill()], { parent: 7, ks: { p: k([1, 0, 0]) } }),
    { ty: 3, ind: 7, ks: { p: k([100, 0, 0]), s: k([200, 200, 100]) }, ip: 0, op: 100, st: 0 },
  ]);
  assert.deepEqual(box(child), [100, -2, 104, 2]);
});

test('parent loops end instead of hanging', () => {
  const items = one([
    shapeLayer([rect(), fill()], { ind: 1, parent: 2 }),
    shapeLayer([rect(), fill()], { ind: 2, parent: 1 }),
  ]);
  assert.equal(items.length, 2);
});

test('separated position axes read', () => {
  const [path] = one([shapeLayer([rect(2, 2), fill()], { ks: { p: { s: true, x: k(10), y: k(20) } } })]);
  assert.deepEqual(box(path), [9, 19, 11, 21]);
});

test('groups nest their transforms and opacity; a paint covers the paths before it', () => {
  const items = one([
    shapeLayer([
      { ty: 'gr', it: [rect(2, 2), fill([1, 0, 0]), { ty: 'tr', p: k([5, 0]), s: k([100, 100]), o: k(50) }] },
      rect(4, 4),
      fill([0, 0, 1]),
    ]),
  ]);
  // The last paint is drawn first, and it covers the group's path as well as the rectangle.
  assert.deepEqual(
    items.map((item) => item.fill),
    [
      [0, 0, 1],
      [1, 0, 0],
    ],
  );
  assert.equal(items[0].commands.filter((c) => c[0] === 'M').length, 2);
  assert.equal(items[1].opacity, 0.5);
  assert.deepEqual(box(items[1]), [4, -1, 6, 1]);
});

test('stacking: the first layer and the first paint are on top, so they come last', () => {
  const items = one([
    shapeLayer([rect(), fill([1, 0, 0])]),
    shapeLayer([rect(), fill([0, 1, 0]), stroke({ c: k([0, 0, 1]), w: k(3), lc: 2, lj: 3, ml: 7 })]),
  ]);
  assert.deepEqual(
    items.map((item) => item.stroke ?? item.fill),
    [
      [0, 0, 1],
      [0, 1, 0],
      [1, 0, 0],
    ],
  );
  assert.equal(items[0].strokeWidth, 3);
  assert.equal(items[0].lineCap, 'round');
  assert.equal(items[0].lineJoin, 'bevel');
  assert.equal(items[0].miterLimit, 7);
});

test('a stroke scales with its transform, and its dashes with it', () => {
  const dashes = [
    { n: 'd', v: k(4) },
    { n: 'g', v: k(1) },
    { n: 'o', v: k(3) },
  ];
  const [path] = one([shapeLayer([rect(), stroke({ w: k(2), d: dashes })], { ks: { s: k([300, 300, 100]) } })]);
  assert.equal(path.strokeWidth, 6);
  assert.deepEqual(path.dash, { pattern: [12, 3], offset: 9 });
});

test('a fill rule of 2 is even-odd; a shape drawn the other way runs reversed', () => {
  const [path] = one([shapeLayer([rect(), { ...fill(), r: 2 }])]);
  assert.equal(path.fillRule, 'evenodd');
  const forward = one([shapeLayer([rect(10, 10), fill()])])[0].commands[0];
  const back = one([shapeLayer([{ ...rect(10, 10), d: 3 }, fill()])])[0].commands[0];
  assert.deepEqual(forward, ['M', 5, -5]);
  assert.deepEqual(back, ['M', -5, -5]);
});

test('keyframes interpolate, ease, hold and clamp', () => {
  const p = {
    a: 1,
    k: [
      { t: 0, s: [0, 0, 0], ...linear },
      { t: 10, s: [100, 0, 0], h: 1 },
      { t: 20, s: [200, 0, 0] },
    ],
  };
  const animation = parseLottie(JSON.stringify(anim([shapeLayer([rect(2, 2), fill()], { ks: { p }, ip: -10 })])));
  const x = (frame) => box(animation.frame(frame)[0])[0] + 1;
  assert.equal(x(-5), 0);
  near(x(5), 50);
  near(x(2.5), 25);
  near(x(10), 100);
  assert.equal(x(15), 100);
  assert.equal(x(20), 200);
  assert.equal(x(50), 200);
});

test('bezier easing bends the curve, per dimension when the file gives one', () => {
  const key = (o, i) => ({
    a: 1,
    k: [
      { t: 0, s: [0, 0], o, i },
      { t: 10, s: [100, 100] },
    ],
  });
  const size = (s) => box(one([shapeLayer([{ ty: 'rc', p: k([0, 0]), s, r: k(0) }, fill()])], 5)[0]);
  const easeIn = size(key({ x: 0.9, y: 0 }, { x: 1, y: 1 }));
  assert.ok(easeIn[2] * 2 < 30, `${easeIn}`);
  const split = size(key({ x: [0, 0.9], y: [0, 0] }, { x: [1, 1], y: [1, 1] }));
  near(split[2] * 2, 50);
  assert.ok(split[3] * 2 < 30);
});

test('the old form of keys, with e on each key and a bare last key, reads', () => {
  const ks = { o: { a: 1, k: [{ t: 0, s: [0], e: [100], ...linear }, { t: 10 }] } };
  const animation = parseLottie(JSON.stringify(anim([shapeLayer([rect(), fill()], { ks })])));
  near(animation.frame(5)[0].opacity, 0.5);
  near(animation.frame(30)[0].opacity, 1);
});

test('a position key with spatial handles follows the curve', () => {
  const p = {
    a: 1,
    k: [
      { t: 0, s: [0, 0, 0], to: [0, 30, 0], ti: [0, 30, 0], ...linear },
      { t: 10, s: [10, 0, 0] },
    ],
  };
  const area = box(one([shapeLayer([rect(2, 2), fill()], { ks: { p } })], 5)[0]);
  near(area[0] + 1, 5);
  near(area[1] + 1, 22.5);
});

test('shape paths blend between keys', () => {
  const path = (x) => ({
    c: true,
    v: [
      [0, 0],
      [x, 0],
      [x, x],
    ],
    i: [
      [0, 0],
      [0, 0],
      [0, 0],
    ],
    o: [
      [0, 0],
      [0, 0],
      [0, 0],
    ],
  });
  const ks = {
    a: 1,
    k: [
      { t: 0, s: [path(10)], ...linear },
      { t: 10, s: [path(20)] },
    ],
  };
  const [item] = one([shapeLayer([{ ty: 'sh', ks }, fill()])], 5);
  box(item).forEach((value, n) => near(value, [0, 0, 15, 15][n]));
});

test('a layer shows only from its in frame up to its out frame, and its time shifts and stretches', () => {
  const ks = {
    o: {
      a: 1,
      k: [
        { t: 0, s: [0], ...linear },
        { t: 10, s: [100] },
      ],
    },
  };
  const animation = parseLottie(
    JSON.stringify(anim([shapeLayer([rect(), fill()], { ks, ip: 10, op: 30, st: 10, sr: 2 })])),
  );
  assert.equal(animation.frame(9).length, 0);
  assert.equal(animation.frame(30).length, 0);
  near(animation.frame(20)[0].opacity, 0.5);
  near(animation.frame(29)[0].opacity, 0.95);
  assert.equal(one([shapeLayer([rect(), fill()], { hd: true })]).length, 0);
  assert.equal(one([shapeLayer([{ ...rect(), hd: true }, fill()])]).length, 0);
});

test('a solid layer is a filled rectangle from the top left', () => {
  const [path] = one([{ ty: 1, ks: {}, ip: 0, op: 9, st: 0, sw: 20, sh: 10, sc: '#ff8000' }]);
  assert.deepEqual(box(path), [0, 0, 20, 10]);
  near(path.fill[1], 128 / 255);
});

test('precompositions nest with their own layers, and time remapping picks their time', () => {
  const p = {
    a: 1,
    k: [
      { t: 0, s: [0, 0, 0], ...linear },
      { t: 30, s: [30, 0, 0] },
    ],
  };
  const assets = [{ id: 'c', layers: [shapeLayer([rect(2, 2), fill()], { ks: { p } })] }];
  const layer = { ty: 0, refId: 'c', ks: { p: k([100, 0, 0]), o: k(50) }, ip: 0, op: 60, st: 0 };
  const plain = one([layer], 10, { assets })[0];
  near(box(plain)[0] + 1, 110);
  assert.equal(plain.opacity, 0.5);
  const remapped = one([{ ...layer, tm: k(0.5) }], 0, { assets })[0];
  near(box(remapped)[0] + 1, 115);
});

test('image layers report their asset and transform, and draw needs the image', () => {
  const calls = [];
  const animation = parseLottie(
    JSON.stringify(
      anim([{ ty: 2, refId: 'i', ks: { p: k([5, 6, 0]), o: k(25) }, ip: 0, op: 9, st: 0 }], {
        assets: [{ id: 'i', w: 8, h: 4, u: '', p: 'a.png' }],
      }),
    ),
  );
  const [item] = animation.frame(0);
  assert.deepEqual(item, { kind: 'image', asset: 'i', matrix: [1, 0, 0, 1, 5, 6], opacity: 0.25, width: 8, height: 4 });
  const context = recorder(calls);
  animation.draw(context, 0);
  assert.equal(calls.length, 0);
  animation.draw(context, 0, { images: { i: 'bitmap' } });
  assert.ok(calls.some((call) => call[0] === 'drawImage' && call[1] === 'bitmap'));
  assert.ok(calls.some((call) => call[0] === 'transform' && call[5] === 5));
});

test('gradients keep their stops and alpha; a radial one says so', () => {
  const g = { p: 2, k: k([0, 1, 0, 0, 1, 0, 0, 1, 0, 0.5, 1, 1]) };
  const paint = { ty: 'gf', t: 2, s: k([0, 0]), e: k([10, 0]), g, o: k(100), r: 1 };
  const [path] = one([shapeLayer([rect(), paint], { ks: { p: k([1, 2, 0]) } })]);
  assert.equal(path.fill, null);
  assert.equal(path.gradient.kind, 'radial');
  assert.deepEqual(path.gradient.start, [1, 2]);
  assert.deepEqual(path.gradient.end, [11, 2]);
  assert.deepEqual(path.gradient.stops, [
    [0, 1, 0, 0, 0.5],
    [1, 0, 0, 1, 1],
  ]);
  const [line] = one([shapeLayer([rect(), { ty: 'gs', t: 1, s: k([0, 0]), e: k([1, 0]), g, o: k(100), w: k(2) }])]);
  assert.equal(line.gradient.kind, 'linear');
  assert.equal(line.strokeWidth, 2);
});

const straight = k({
  c: false,
  v: [
    [0, 0],
    [100, 0],
  ],
  i: [
    [0, 0],
    [0, 0],
  ],
  o: [
    [0, 0],
    [0, 0],
  ],
});
const trimmed = (s, e, o = 0) =>
  one([shapeLayer([{ ty: 'sh', ks: straight }, { ty: 'tm', s: k(s), e: k(e), o: k(o) }, stroke()])])[0];

test('trim paths cut a path by length, wrap over the end, and vanish when empty', () => {
  const area = (path) => box(path).forEach((value, n) => near(value, [25, 0, 75, 0][n], 0.01));
  area(trimmed(25, 75));
  area(trimmed(75, 25));
  assert.deepEqual(box(trimmed(0, 100)), [0, 0, 100, 0]);
  const wrapped = trimmed(0, 50, 270);
  assert.equal(wrapped.commands.filter((c) => c[0] === 'M').length, 2);
  assert.equal(
    one([shapeLayer([{ ty: 'sh', ks: straight }, { ty: 'tm', s: k(40), e: k(40), o: k(0) }, stroke()])]).length,
    0,
  );
});

test('a trim measures length along a curve, not its parameter', () => {
  // All the bend is at the start: a third of the parameter is far less than a third of the length.
  const ks = k({
    c: false,
    v: [
      [0, 0],
      [90, 0],
    ],
    o: [
      [0, 0],
      [0, 0],
    ],
    i: [
      [0, 0],
      [-90, 0],
    ],
  });
  const [path] = one([shapeLayer([{ ty: 'sh', ks }, { ty: 'tm', s: k(0), e: k(50), o: k(0) }, stroke()])]);
  near(box(path)[2], 45, 0.01);
});

test('a trimmed closed shape comes out open', () => {
  const [path] = one([shapeLayer([rect(10, 10), { ty: 'tm', s: k(0), e: k(50), o: k(0) }, stroke()])]);
  assert.ok(path.commands.length > 1);
  assert.ok(!path.commands.some((c) => c[0] === 'Z'));
});

test('what frames leave out is named', () => {
  const { unsupported } = parseLottie(
    JSON.stringify(
      anim([
        { ty: 5, ks: {}, ip: 0, op: 9, st: 0 },
        shapeLayer(
          [
            { ty: 'rp' },
            { ty: 'sr', sy: 1, p: k([0, 0]), pt: k(5), r: k(0), or: k(10), ir: k(4), is: k(10), os: k(0) },
            { ty: 'tm', s: k(0), e: k(50), o: k(0), m: 2 },
          ],
          { masksProperties: [{}], tt: 1, ef: [{}], ddd: 1, bm: 1 },
        ),
        { ty: 99, ks: {} },
      ]),
    ),
  );
  assert.deepEqual(unsupported.sort(), [
    '3D layer',
    'blend mode',
    'effect',
    'layer type 99',
    'mask',
    'shape item rp',
    'star roundness',
    'text layer',
    'track matte',
    'trim paths one by one',
  ]);
});

test('draw paints each path with its fill, stroke, dash, alpha and gradient', () => {
  const g = { p: 1, k: k([0, 1, 0, 0]) };
  const dashes = [
    { n: 'd', v: k(4) },
    { n: 'o', v: k(1) },
  ];
  const animation = parseLottie(
    JSON.stringify(
      anim([
        shapeLayer([
          rect(2, 2),
          { ...fill([1, 0, 0], 50), r: 2 },
          stroke({ c: k([0, 1, 0]), w: k(2), d: dashes }),
          { ty: 'gf', t: 1, s: k([0, 0]), e: k([1, 0]), g, o: k(100), r: 1 },
          { ty: 'gf', t: 2, s: k([0, 0]), e: k([0, 3]), g, o: k(100), r: 1 },
        ]),
      ]),
    ),
  );
  const calls = [],
    context = recorder(calls);
  animation.draw(context, 0);
  const names = calls.map((call) => call[0]);
  assert.equal(names.filter((name) => name === 'save').length, 4);
  assert.equal(names.filter((name) => name === 'restore').length, 4);
  assert.ok(calls.some((call) => call[0] === 'fill' && call[1] === 'evenodd'));
  assert.ok(names.includes('stroke'));
  assert.ok(calls.some((call) => call[0] === 'setLineDash' && call[1][0] === 4));
  assert.equal(context.lineDashOffset, 1);
  assert.equal(context.lineWidth, 2);
  assert.ok(calls.some((call) => call[0] === 'linear'));
  assert.deepEqual(
    calls.find((call) => call[0] === 'radial'),
    ['radial', 0, 0, 0, 0, 0, 3],
  );
  assert.deepEqual(
    calls.find((call) => call[0] === 'stop'),
    ['stop', 0, 'rgba(255,0,0,1)'],
  );
  assert.equal(context.fillStyle, 'rgba(255,0,0,1)');
});

test('what is not an animation is refused with its code', () => {
  refuses(() => parseLottie('{'), 'syntax');
  refuses(() => parseLottie('[]'), 'header');
  refuses(() => parseLottie('{"fr":30}'), 'header');
  refuses(() => parseLottie('{"layers":[]}'), 'header');
  refuses(() => parseLottie('{"layers":[],"fr":0}'), 'header');
  refuses(() => parseLottie(JSON.stringify(anim([{ ty: 0, refId: 'none', ks: {} }]))), 'syntax');
  refuses(() => parseLottie(JSON.stringify(anim([shapeLayer([]), shapeLayer([])])), { maxLayers: 1 }), 'limit');
});

test('a precomposition that contains itself, and nesting without end, are refused', () => {
  const layer = (refId) => ({ ty: 0, refId, ks: {}, ip: 0, op: 9, st: 0 });
  const circle = [
    { id: 'a', layers: [layer('b')] },
    { id: 'b', layers: [layer('a')] },
  ];
  refuses(() => parseLottie(JSON.stringify(anim([layer('a')], { assets: circle }))), 'range');
  const assets = Array.from({ length: 70 }, (_, n) => ({ id: `${n}`, layers: n < 69 ? [layer(`${n + 1}`)] : [] }));
  refuses(() => parseLottie(JSON.stringify(anim([layer('0')], { assets }))), 'range');
  let group = { ty: 'gr', it: [] };
  for (let n = 0; n < 70; n++) group = { ty: 'gr', it: [group] };
  refuses(() => parseLottie(JSON.stringify(anim([shapeLayer([group])]))), 'range');
});

test('a malformed value falls to its default instead of NaN', () => {
  const [path] = one([shapeLayer([{ ty: 'rc', p: k('nope'), s: k([4, 'x']), r: {} }, fill(['a', 0, 0])])]);
  assert.ok(path.commands.flat().every((v) => typeof v === 'string' || Number.isFinite(v)));
  assert.deepEqual(path.fill, [0, 0, 0]);
});
