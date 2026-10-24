import test from 'node:test';
import assert from 'node:assert/strict';
import {
  lookAtView,
  cssPerspective,
  cameraCSSTransform,
  orthographicCSSTransform,
  objectCSSTransform,
  cssPointToWorld,
  composeMatrix,
} from '../dist/index.js';

// CSS3D construction vectors (labels-css3d spec). Strings are not compared; the matrix a browser builds from each
// string is, so any valid formatting passes.
const lookAt = [
  [[0, 0, 5], [0, 0, 0], null, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, -5, 1]],
  [
    [3, 2, 7],
    [-1, 0.5, 0],
    null,
    [
      0.868243142, -0.090750375, 0.487768609, 0, 0, 0.983129061, 0.182913228, 0, -0.496138938, -0.158813156,
      0.853595065, 0, 0.868243142, -0.582314905, -7.804297739, 1,
    ],
  ],
  [
    [2, 1.5, 4],
    [0, 0.25, 0],
    null,
    [
      0.894427191, -0.120385853, 0.430705522, 0, 0, 0.963086825, 0.269190951, 0, -0.447213595, -0.240771706,
      0.861411043, 0, 0, -0.240771706, -4.710841643, 1,
    ],
  ],
  [
    [0, 0, 5],
    [0, 0, 0],
    [1, 0, 0],
    [0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, 0, 0, -5, 1],
  ],
  [
    [1, 1, 1],
    [0, 0, 0],
    [0, 0, 1],
    [
      -0.707106781, -0.40824829, 0.577350269, 0, 0.707106781, -0.40824829, 0.577350269, 0, 0, 0.816496581, 0.577350269,
      0, 0, 0, -1.732050808, 1,
    ],
  ],
];
const perspectives = [
  [60, 400, 346.410161514],
  [55, 360, 345.776782855],
  [90, 1000, 500],
  [1, 100, 5729.432506465],
  [179, 100, 0.43634339],
];
const cameras = [
  [
    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, -5, 1],
    346.4101615137755,
    800,
    400,
    [1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1, 0, 400, 200, 341.410162, 1],
  ],
  [
    [
      0.894427191, -0.120385853, 0.430705522, 0, 0, 0.963086825, 0.269190951, 0, -0.447213595, -0.240771706,
      0.861411043, 0, 0, -0.240771706, -4.710841643, 1,
    ],
    345.7767828548099,
    640,
    360,
    [
      0.894427, 0.120386, 0.430706, 0, 0, -0.963087, 0.269191, 0, -0.447214, 0.240772, 0.861411, 0, 320, 180.240772,
      341.065941, 1,
    ],
  ],
  [
    [
      0.868243142, -0.090750375, 0.487768609, 0, 0, 0.983129061, 0.182913228, 0, -0.496138938, -0.158813156,
      0.853595065, 0, 0.868243142, -0.582314905, -7.804297739, 1,
    ],
    333.3333333,
    1001,
    501,
    [
      0.868243, 0.09075, 0.487769, 0, 0, -0.983129, 0.182913, 0, -0.496139, 0.158813, 0.853595, 0, 501.368243,
      251.082315, 325.529035, 1,
    ],
  ],
];
const orthographics = [
  [
    [0.25, 0, 0, 0, 0, 0.5, 0, 0, 0, 0, 0.028571429, 0, 0, 0, 0.571428571, 1],
    800,
    400,
    'webgpu',
    [100, 0, 0, 0, 0, -100, 0, 0, 0, 0, 100, 0, 400, 200, 2000, 1],
  ],
  [
    [0.25, 0, 0, 0, 0, 0.5, 0, 0, 0, 0, 0.028571429, 0, 0, 0, 0.571428571, 1],
    800,
    400,
    'webgl2',
    [100, 0, 0, 0, 0, -100, 0, 0, 0, 0, -100, 0, 400, 200, -2000, 1],
  ],
  [
    [
      0.173526402, -0.075733131, 0.005824969, 0, 0, 0.310505836, 0.003640605, 0, -0.138821122, -0.094666413,
      0.007281211, 0, 0, -0.155252918, 0.930373255, 1,
    ],
    600,
    400,
    'webgpu',
    [
      52.057921, 15.146626, 38.794292, 0, 0, -62.101167, 24.246432, 0, -41.646337, 18.933283, 48.492864, 0, 300,
      231.050584, 6196.285881, 1,
    ],
  ],
  [
    [
      0.173526402, -0.075733131, 0.005824969, 0, 0, 0.310505836, 0.003640605, 0, -0.138821122, -0.094666413,
      0.007281211, 0, 0, -0.155252918, 0.930373255, 1,
    ],
    600,
    400,
    'webgl2',
    [
      52.057921, 15.146626, -38.794292, 0, 0, -62.101167, -24.246432, 0, -41.646337, 18.933283, -48.492864, 0, 300,
      231.050584, -6196.285881, 1,
    ],
  ],
];
const objects = [
  [
    [
      1.195863747, -0.097323601, -0.900243309, 0, 0.246553122, 0.718896999, 0.249797242, 0, 0.519059205, -0.433901054,
      0.736415247, 0, 0.3, 0.2, -0.4, 1,
    ],
    0.01,
    120,
    80,
    [
      0.011959, -0.000973, -0.009002, 0, -0.002466, -0.007189, -0.002498, 0, 0.005191, -0.004339, 0.007364, 0, -0.3189,
      0.54594, 0.24004, 1,
    ],
  ],
  [
    [0, 0, -1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 1, 0, 0, 1],
    0.01,
    100,
    60,
    [0, 0, -0.01, 0, 0, -0.01, 0, 0, 0.01, 0, 0, 0, 1, 0.3, 0.5, 1],
  ],
  [
    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    0.02,
    50,
    50,
    [0.02, 0, 0, 0, 0, -0.02, 0, 0, 0, 0, 0.02, 0, -0.5, 0.5, 0, 1],
  ],
  [
    [2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 5, -2, 3, 1],
    undefined,
    10,
    20,
    [2, 0, 0, 0, 0, -2, 0, 0, 0, 0, 2, 0, -5, 18, 3, 1],
  ],
];
const points = [
  [
    [
      1.195863747, -0.097323601, -0.900243309, 0, 0.246553122, 0.718896999, 0.249797242, 0, 0.519059205, -0.433901054,
      0.736415247, 0, 0.3, 0.2, -0.4, 1,
    ],
    0.01,
    0,
    0,
    [0.3, 0.2, -0.4],
  ],
  [
    [
      1.195863747, -0.097323601, -0.900243309, 0, 0.246553122, 0.718896999, 0.249797242, 0, 0.519059205, -0.433901054,
      0.736415247, 0, 0.3, 0.2, -0.4, 1,
    ],
    0.01,
    -60,
    -40,
    [-0.318896999, 0.54595296, 0.240064882],
  ],
  [
    [
      1.195863747, -0.097323601, -0.900243309, 0, 0.246553122, 0.718896999, 0.249797242, 0, 0.519059205, -0.433901054,
      0.736415247, 0, 0.3, 0.2, -0.4, 1,
    ],
    0.01,
    60,
    40,
    [0.918896999, -0.14595296, -1.040064882],
  ],
  [
    [
      1.195863747, -0.097323601, -0.900243309, 0, 0.246553122, 0.718896999, 0.249797242, 0, 0.519059205, -0.433901054,
      0.736415247, 0, 0.3, 0.2, -0.4, 1,
    ],
    0.01,
    10,
    -5,
    [0.431914031, 0.22621249, -0.477534469],
  ],
];
const composed = [
  [[1, 2, 3], undefined, undefined, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1, 2, 3, 1]],
  [
    [0.3, 0.2, -0.4],
    [0.2, 0.3, -0.1, 0.92],
    [1.5, 0.8, 1],
    [
      1.195863747, -0.097323601, -0.900243309, 0, 0.246553122, 0.718896999, 0.249797242, 0, 0.519059205, -0.433901054,
      0.736415247, 0, 0.3, 0.2, -0.4, 1,
    ],
  ],
  [
    [0, 0, 0],
    [0, 0, 2, 0],
    [1, 1, 1],
    [-1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
  ],
  [
    [0, 0, 0],
    [0, 0, 0, 0],
    [1, 1, 1],
    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
  ],
];

const near = (a, b, epsilon) => Math.abs(a - b) <= epsilon;
const assertArray = (actual, expected, tolerance, message) => {
  assert.equal(actual.length, expected.length, message);
  for (let i = 0; i < expected.length; i++)
    assert.ok(near(actual[i], expected[i], tolerance(expected[i])), `${message}[${i}]: ${actual[i]} vs ${expected[i]}`);
};
const exact = () => 1e-9;
// 1e-6 relative, 1e-6 absolute for entries below 1, plus float slack for the sums of rounded numbers.
const css = (x) => 1e-6 * Math.max(1, Math.abs(x)) + 1e-12;

const product = (a, b) => {
  const out = new Array(16).fill(0);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) out[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return out;
};
const shift = (x, y, z = 0) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];

/** The matrix a browser builds for `transform` on a `width` x `height` element with a centre transform-origin. */
function evaluate(transform, width, height) {
  const length = (text, size) => {
    const value = Number.parseFloat(text);
    if (text.endsWith('%')) return (value / 100) * size;
    assert.match(text, /px$/, `length ${text} needs a unit`);
    return value;
  };
  let m = shift(0, 0);
  for (const [, name, list] of transform.matchAll(/([a-zA-Z0-9]+)\(([^)]*)\)/g)) {
    const args = list.split(',').map((s) => s.trim());
    for (const arg of args) assert.doesNotMatch(arg, /e|NaN|Infinity|^-0(px|%)?$/i, `plain finite number: ${arg}`);
    if (name === 'translateZ') m = product(m, shift(0, 0, length(args[0], 0)));
    else if (name === 'translate') m = product(m, shift(length(args[0], width), length(args[1], height)));
    else if (name === 'matrix3d') {
      assert.equal(args.length, 16);
      m = product(m, args.map(Number));
    } else assert.fail(`unexpected transform function ${name}`);
  }
  return product(product(shift(width / 2, height / 2), m), shift(-width / 2, -height / 2));
}

test('lookAtView matches the vectors, honours up, writes into out and rejects degenerate views', () => {
  for (const [position, target, up, expected] of lookAt) {
    const view = up ? lookAtView(position, target, undefined, up) : lookAtView(position, target);
    assertArray(view, expected, exact, `lookAtView ${position} -> ${target}`);
    // The rotation is orthonormal: each row has unit length.
    for (let r = 0; r < 3; r++) assert.ok(near(Math.hypot(view[r], view[4 + r], view[8 + r]), 1, 1e-12));
  }
  const out = new Float64Array(16);
  assert.equal(lookAtView([1, 2, 3], [0, 0, 0], out), out);
  assert.throws(() => lookAtView([1, 1, 1], [1, 1, 1]), RangeError);
  assert.throws(() => lookAtView([0, 5, 0], [0, 0, 0]), RangeError);
  assert.throws(() => lookAtView([0, 0, 0], [0, 0, 3], undefined, [0, 0, -2]), RangeError);
});

test('cssPerspective is half the height over tan(fov / 2)', () => {
  for (const [fov, height, expected] of perspectives)
    assert.ok(near(cssPerspective(fov, height), expected, 1e-9 * Math.max(1, expected)), `${fov} ${height}`);
});

test('camera, orthographic and object transforms evaluate to the vector matrices', () => {
  for (const [view, perspective, width, height, expected] of cameras)
    assertArray(evaluate(cameraCSSTransform(view, perspective, width, height), width, height), expected, css, 'camera');
  for (const [matrix, width, height, backend, expected] of orthographics)
    assertArray(
      evaluate(orthographicCSSTransform(matrix, width, height, backend), width, height),
      expected,
      css,
      `ortho ${backend}`,
    );
  assert.equal(
    orthographicCSSTransform(orthographics[0][0], 800, 400),
    orthographicCSSTransform(orthographics[0][0], 800, 400, 'webgpu'),
  );
  for (const [world, pixelScale, width, height, expected] of objects)
    assertArray(
      evaluate(objectCSSTransform(world, pixelScale), width, height),
      expected,
      css,
      `object ${width}x${height}`,
    );
});

test('cssPointToWorld and composeMatrix match the vectors', () => {
  for (const [world, pixelScale, x, y, expected] of points)
    assertArray(cssPointToWorld(world, pixelScale, x, y), expected, exact, `point ${x},${y}`);
  for (const [position, quaternion, scale, expected] of composed)
    assertArray(composeMatrix(position, quaternion, scale), expected, exact, `compose ${quaternion}`);
  const out = new Float64Array(16);
  assert.equal(composeMatrix([0, 0, 0], undefined, undefined, out), out);
});

test('object pixels land on cssPointToWorld through the evaluated object transform', () => {
  const world = composeMatrix([0.3, -1, 2], [0.1, -0.4, 0.2, 0.8], [2, 0.5, 1.5]);
  for (const pixelScale of [1, 0.01, 0.37]) {
    const width = 90,
      height = 50,
      m = evaluate(objectCSSTransform(world, pixelScale), width, height);
    for (const [px, py] of [
      [0, 0],
      [width, 0],
      [0, height],
      [width, height],
      [13, 41],
    ]) {
      // The object element sits at the camera element's origin: element pixel (px, py) maps through m.
      const p = [0, 1, 2].map((r) => m[r] * px + m[4 + r] * py + m[12 + r]);
      assertArray(
        p,
        cssPointToWorld(world, pixelScale, px - width / 2, py - height / 2),
        () => 1e-4, // 1e-6 rounding of entries times up to ~100 px
        `pixel ${px},${py}`,
      );
    }
  }
});

test('strings are stable: float noise, -0 and tiny values do not change the text', () => {
  const base = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const noisy = base.map((v, i) => (i === 3 ? -0 : v + (i % 2 ? 1e-12 : -1e-12)));
  assert.equal(objectCSSTransform(noisy), objectCSSTransform(base));
  const tiny = objectCSSTransform([1e-9, -0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -1e-9, 0, 0, 1]);
  // Keep only the argument lists, so function names and units do not look like exponents.
  const numbers = (text) => [...text.matchAll(/\(([^)]*)\)/g)].map((m) => m[1].replace(/px|%/g, '')).join(',');
  assert.doesNotMatch(numbers(tiny), /e|-0(?![.\d])/i);
  assert.equal(evaluate(tiny, 10, 10)[0], 0);
  const huge = cameraCSSTransform(
    base.map((v) => v * 123456789.123),
    1e7,
    1e6,
    3e5,
  );
  assert.doesNotMatch(numbers(huge), /e/i);
});
