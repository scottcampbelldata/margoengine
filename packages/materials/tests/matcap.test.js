// Matcap lookup: the WGSL statement, run on the CPU, against the lit-sphere frame (right = +Y x eye, up = eye x right).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { wgslModule } from './support/wgsl-subset.js';

const source = readFileSync(new URL('../src/built-material.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const statement = /\n {2}matcap:\s*'([^']*)'/.exec(source)[1];
const identity = [
  [1, 0, 0, 0],
  [0, 1, 0, 0],
  [0, 0, 1, 0],
  [0, 0, 0, 1],
];
const unit = (v) => v.map((x) => x / Math.hypot(...v));

/** UV the statement samples, plus its returned colour, for a view-space eye direction and normal (view = identity). */
function lookup(eye, normal, base = [1, 1, 1], view = identity, position) {
  let uv;
  const shader = wgslModule('', {
    mat_out: (c) => c,
    textureSample: (_t, _s, coords) => {
      uv = coords;
      return [0.25, 0.5, 1, 1];
    },
  });
  const color = shader.run(statement, {
    s: { n: normal, base: [...base, 1] },
    i: { position: position ?? unit(eye).map((x) => -3 * x) },
    alpha: 0.75,
    f: { view },
    mat_matcap: 'matcap',
    mat_matcapS: 'sampler',
  });
  return { uv, color };
}

// (eye direction, normal) -> lookup direction d, uv = 0.5 + k d (vectors/matcap.json; binding within 1e-5).
const vectors = [
  [
    [0, 0, 1],
    [0, 0, 1],
    [0, 0],
  ],
  [
    [0, 0, 1],
    [1, 0, 0],
    [1, 0],
  ],
  [
    [0, 0, 1],
    [0, 1, 0],
    [0, 1],
  ],
  [
    [0, 0, 1],
    [-1, 0, 0],
    [-1, 0],
  ],
  [
    [0, 0, 1],
    [0, -1, 0],
    [0, -1],
  ],
  [
    [0, 0, 1],
    [1, 1, 1],
    [0.5773502691896258, 0.5773502691896258],
  ],
  [
    [0.3, 0, 1],
    [0.3, 0, 1],
    [0, 0],
  ],
  [
    [0.3, 0.2, 1],
    [0.3, 0.2, 1],
    [0, 0],
  ],
  [
    [-0.4, 0.3, 1],
    [0, 0, 1],
    [0.37139067635410367, -0.24913643956121984],
  ],
  [
    [0.5, -0.5, 1],
    [0, 1, 0],
    [0, 0.9128709291752769],
  ],
  [
    [0.2, 0.6, 0.8],
    [1, 0, 0],
    [0.9701425001453319, -0.1426954482463482],
  ],
  [
    [0.6, 0, 0.8],
    [0, 0, 1],
    [-0.6, 0],
  ],
];

test('matcap lookup matches the binding lit-sphere vectors with a fixed shrink just under 0.5', () => {
  const k = (lookup([0, 0, 1], [1, 0, 0]).uv[0] - 0.5) / 1;
  assert.ok(k >= 0.48 && k < 0.5, `shrink ${k}`);
  for (const [eye, normal, d] of vectors) {
    const { uv } = lookup(eye, normal);
    assert.ok(
      Math.abs((uv[0] - 0.5) / k - d[0]) < 1e-5 && Math.abs((uv[1] - 0.5) / k - d[1]) < 1e-5,
      `${eye} ${normal}: ${uv}`,
    );
  }
});

test('the disc stays inside the image and the colour is base x matcap with alpha kept', () => {
  for (let i = 0; i < 200; i++) {
    const a = i * 2.399963,
      z = 1 - (2 * i + 1) / 200,
      r = Math.sqrt(1 - z * z),
      normal = [Math.cos(a) * r, Math.sin(a) * r, z];
    for (const eye of [
      [0, 0, 1],
      [0.5, 0.3, 0.8],
      [-0.7, -0.2, 0.4],
    ]) {
      const { uv } = lookup(eye, normal);
      assert.ok(
        uv.every((c) => c > 0.005 && c < 0.995),
        `${normal} ${eye}: ${uv}`,
      );
    }
  }
  const { color } = lookup([0, 0, 1], [0, 0, 1], [0.5, 1, 0.25]);
  assert.deepEqual(color, [0.125, 0.5, 0.25, 0.75]);
});

test('the normal goes to view space and an eye straight above or below stays finite (view-axis frame)', () => {
  // A view turned 90 degrees about Y: world +Z is view +X.
  const turned = [
    [0, 0, -1, 0],
    [0, 1, 0, 0],
    [1, 0, 0, 0],
    [0, 0, 0, 1],
  ];
  const { uv } = lookup([0, 0, 1], [0, 0, 1], [1, 1, 1], turned, [3, 0, 0]);
  assert.ok(Math.abs(uv[0] - 0.5 - 0.49) < 1e-6 && Math.abs(uv[1] - 0.5) < 1e-6, String(uv));
  for (const eye of [
    [0, 1, 0],
    [0, -1, 0],
  ]) {
    const { uv: degenerate } = lookup(eye, [1, 0, 0]);
    assert.ok(degenerate.every(Number.isFinite), String(degenerate));
    assert.ok(Math.abs(degenerate[0] - 0.99) < 1e-6, 'falls back to the view axes');
  }
});
