import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MeshRegionInsetPreview,
  MeshRegionInsetSession,
  allocateMeshFaceUV,
  fillMeshPaintFaces,
  compilePolygonMesh,
} from '../dist/index.js';
const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
function grid(w = 3, h = 2, omit = () => false) {
  const vertices = [],
    faces = [];
  for (let y = 0; y <= h; y++) for (let x = 0; x <= w; x++) vertices.push([x, y, 0]);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      if (omit(x, y)) continue;
      const a = y * (w + 1) + x;
      faces.push({
        id: `f${x}-${y}`,
        vertices: [a, a + 1, a + w + 2, a + w + 1],
        uv: [
          [0.2, 0.2],
          [0.4, 0.2],
          [0.4, 0.4],
          [0.2, 0.4],
        ],
      });
    }
  return { vertices, faces };
}
function scene(mesh = grid(), size = 128) {
  const objects = [
    { ...mesh, id: 'body', worldMatrix: [...identity], canPaint: true, canProject: true, canMirror: true },
    { ...grid(1, 1), id: 'peer', worldMatrix: [...identity], canPaint: false, canProject: false, canMirror: false },
  ];
  objects[1].faces[0].uv = [
    [0.7, 0.7],
    [0.8, 0.7],
    [0.8, 0.8],
    [0.7, 0.8],
  ];
  return {
    objects,
    texture: {
      width: size,
      height: size,
      pixels: Array.from({ length: size * size * 4 }, (_, i) => [19, 43, 71, 255][i % 4]),
    },
  };
}
const chosen = (s) => s.objects[0].faces.map((f) => f.id);
const ids = () => {
  let i = 0;
  return { createId: () => `b${++i}` };
};
function legacy(s, k, width, options = {}) {
  const topology = k.inset(width),
    object = s.objects[0];
  let geometry = topology.mesh,
    texture = null;
  if (topology.changed) {
    geometry = allocateMeshFaceUV(
      { ...object, ...geometry },
      object.faces.map((f) => f.id),
      s.objects,
      options.pixelsPerUnit ?? 16,
      [s.texture.width, s.texture.height],
    );
    if (options.color !== undefined)
      texture = fillMeshPaintFaces(
        { ...s, objects: s.objects.map((o) => (o.id === object.id ? { ...o, ...geometry } : o)) },
        topology.borderFaces.map((f) => ({ objectId: object.id, faceId: f.faceId })),
        options.color,
        { mode: options.mode, secondaryColor: options.secondaryColor },
      );
  }
  return { topology, geometry, texture };
}
const freeze = (v) => {
  for (const x of Object.values(v)) if (x && typeof x === 'object') freeze(x);
  return Object.freeze(v);
};

test('owned inset preview matches the checked full pipeline byte-for-byte through widths,densities,fill and dither', () => {
  for (const mesh of [grid(), grid(4, 4, (x, y) => x === 1 && y === 1), grid(3, 3, (x, y) => x > 0 && y > 0)]) {
    const s = scene(mesh, 256),
      preview = new MeshRegionInsetPreview(s, 'body', chosen(s), ids()),
      k = new MeshRegionInsetSession(s.objects[0], chosen(s), ids());
    for (const [width, options] of [
      [0.1, { color: '#e89054', pixelsPerUnit: 8 }],
      [0.2, { pixelsPerUnit: 12 }],
      [0.2, { color: '#de603c', mode: 'dither', secondaryColor: '#314b78', pixelsPerUnit: 12 }],
      [0.08, { color: '#aabbcc00', mode: 'dither', secondaryColor: '#ffffff', pixelsPerUnit: 6 }],
      [0, { color: 'ignored', pixelsPerUnit: 0 }],
    ])
      assert.deepEqual(preview.inset(width, options), legacy(s, k, width, options));
    preview.dispose();
    k.dispose();
  }
});
test('projection and atlas remain exact under captured reflection,shear,translation and nonuniform scale', () => {
  const s = scene(grid(), 256);
  s.objects[0].worldMatrix = [-2, 0.2, 0.3, 0, 0.6, 3, 0.1, 0, 0, 0.2, 0.5, 0, 4, -3, 1, 1];
  const p = new MeshRegionInsetPreview(s, 'body', chosen(s), ids()),
    k = new MeshRegionInsetSession(s.objects[0], chosen(s), { ...ids(), worldMatrix: s.objects[0].worldMatrix });
  for (const width of [0.05, 0.2, 0.4])
    assert.deepEqual(
      p.inset(width, { color: '#9483db', pixelsPerUnit: 8 }),
      legacy(s, k, width, { color: '#9483db', pixelsPerUnit: 8 }),
    );
});
test('constructor captures source pixels,geometry,UVs,policy,metric,selection and ID generator', () => {
  const s = scene(),
    saved = structuredClone(s),
    faces = chosen(s),
    options = ids(),
    p = new MeshRegionInsetPreview(s, 'body', faces, options);
  s.texture.pixels.fill(0);
  s.objects[0].vertices[0][0] = 999;
  s.objects[0].faces[0].uv[0][0] = 0.99;
  s.objects[0].worldMatrix.fill(0);
  s.objects[1].canPaint = true;
  faces.length = 0;
  options.createId = () => '';
  const expected = legacy(saved, new MeshRegionInsetSession(saved.objects[0], chosen(saved), ids()), 0.1, {
    color: '#ee7934',
    pixelsPerUnit: 8,
  });
  assert.deepEqual(p.inset(0.1, { color: '#ee7934', pixelsPerUnit: 8 }), expected);
});
test('all returned arrays are independent of cached source/frame and prior results', () => {
  const s = scene(),
    p = new MeshRegionInsetPreview(s, 'body', chosen(s), ids()),
    a = p.inset(0.1, { color: '#123456', pixelsPerUnit: 8 }),
    expected = structuredClone(a);
  freeze(a);
  assert.deepEqual(p.inset(0.1, { color: '#123456', pixelsPerUnit: 8 }), expected);
  const b = p.inset(0.1, { color: '#abcd67', pixelsPerUnit: 8 });
  b.geometry.vertices[0][0] = 999;
  b.geometry.faces[0].uv[0][0] = 0.99;
  b.topology.vertexMap[0].length = 0;
  b.topology.regions[0].boundaryLoops[0].length = 0;
  b.texture.pixels.fill(1);
  assert.deepEqual(p.inset(0.1, { color: '#123456', pixelsPerUnit: 8 }), expected);
  assert.deepEqual(s, scene());
});
test('fill variants always derive from the base atlas and keep cap and locked-peer texels plus halos untouched', () => {
  const s = scene(),
    p = new MeshRegionInsetPreview(s, 'body', chosen(s), ids());
  for (const color of ['#d97760', '#3187dc', '#ff000000']) {
    const out = p.inset(0.1, { color, pixelsPerUnit: 8 });
    for (const [l, r] of [
      [24, 52],
      [88, 104],
    ])
      for (let y = l; y <= r; y++)
        for (let x = l; x <= r; x++) {
          const at = (y * 128 + x) * 4;
          assert.deepEqual(out.texture.pixels.slice(at, at + 4), s.texture.pixels.slice(at, at + 4));
        }
  }
  assert.equal(p.inset(0.1, { pixelsPerUnit: 8 }).texture, null);
  assert.equal(p.inset(0, { color: '#ffffff' }).texture, null);
});
test('atlas-anchored checker pixels are exact and new border texels get a one-pixel dilation halo', () => {
  const s = scene(),
    p = new MeshRegionInsetPreview(s, 'body', chosen(s), ids()),
    out = p.inset(0.1, { color: '#d97760', mode: 'dither', secondaryColor: '#3187dc', pixelsPerUnit: 8 });
  let checked = 0;
  for (const created of out.topology.borderFaces) {
    const f = out.geometry.faces.find((f) => f.id === created.faceId),
      x = Math.floor(f.uv.reduce((n, p) => n + p[0] / f.uv.length, 0) * 128),
      y = Math.floor(f.uv.reduce((n, p) => n + p[1] / f.uv.length, 0) * 128),
      at = (y * 128 + x) * 4;
    assert.deepEqual(out.texture.pixels.slice(at, at + 4), (x + y) % 2 ? [49, 135, 220, 255] : [217, 119, 96, 255]);
    checked++;
  }
  assert(checked > 0);
  // First row-major island starts at0,0 with its content beginning1,1; top halo copies a content neighbour.
  assert.notDeepEqual(out.texture.pixels.slice(4, 8), s.texture.pixels.slice(4, 8));
  assert.deepEqual(out.texture.pixels.slice(4, 8), out.texture.pixels.slice((128 + 1) * 4, (128 + 1) * 4 + 4));
});
test('changed width or density cannot reuse stale geometry,UV layout or raster masks', () => {
  const s = scene(),
    p = new MeshRegionInsetPreview(s, 'body', chosen(s), ids()),
    k = new MeshRegionInsetSession(s.objects[0], chosen(s), ids());
  const variants = [
    [0.1, 8],
    [0.10001, 8],
    [0.1, 16],
    [0.2, 8],
    [0.1, 8],
  ];
  for (const [w, d] of variants)
    assert.deepEqual(
      p.inset(w, { color: '#72ba84', pixelsPerUnit: d }),
      legacy(s, k, w, { color: '#72ba84', pixelsPerUnit: d }),
    );
});
test('collapse,invalid options/colors and allocation exhaustion publish no result and preserve later valid previews', () => {
  const s = scene(),
    p = new MeshRegionInsetPreview(s, 'body', chosen(s), ids()),
    first = p.inset(0.1, { color: '#e89054', pixelsPerUnit: 8 });
  for (const [width, options] of [
    [99, { color: '#aabbcc' }],
    [0.1, { pixelsPerUnit: 0 }],
    [0.1, { pixelsPerUnit: NaN }],
    [0.1, { color: 'bad-color', pixelsPerUnit: 8 }],
    [0.1, { color: '#ffffff', mode: 'bad', pixelsPerUnit: 8 }],
    [0.1, { pixelsPerUnit: 128 }],
    [0.1, null],
  ]) {
    assert.throws(() => p.inset(width, options));
    assert.deepEqual(p.inset(0.1, { color: '#e89054', pixelsPerUnit: 8 }), first);
  }
});
test('ineligible paint policy keeps allocation exact but cannot write hidden or locked pixels', () => {
  const s = scene();
  s.objects[0].canPaint = false;
  const p = new MeshRegionInsetPreview(s, 'body', chosen(s), ids()),
    out = p.inset(0.1, { color: '#f34511', pixelsPerUnit: 8 });
  assert(out.topology.changed);
  assert.equal(out.texture, null);
  assert.notDeepEqual(out.geometry.faces.at(-1).uv, out.topology.mesh.faces.at(-1).uv);
  compilePolygonMesh({ ...out.geometry, faces: out.geometry.faces });
});
test('zero/empty/no-op geometry allocates no IDs and options do not fabricate invalid source UVs', () => {
  const s = scene(),
    p = new MeshRegionInsetPreview(s, 'body', chosen(s), {
      createId: () => {
        throw Error('no ids');
      },
    });
  assert(!p.inset(0).topology.changed);
  assert.deepEqual(p.inset(0).geometry.vertices, s.objects[0].vertices);
  const empty = new MeshRegionInsetPreview(s, 'body', [], ids());
  assert(!empty.inset(1).topology.changed);
  s.objects[0].faces[0].uv[0].push(3);
  assert.throws(() => new MeshRegionInsetPreview(s, 'body', chosen(s)), /corner UV/);
});
test('dispose,callback reentry and callback disposal cannot leak a cached candidate', () => {
  const s = scene();
  let p,
    n = 0;
  p = new MeshRegionInsetPreview(s, 'body', chosen(s), {
    createId: () => {
      assert.throws(
        () => p.inset(0.2),
        (e) => e.code === 'state',
      );
      return `a${++n}`;
    },
  });
  p.inset(0.1);
  p[Symbol.dispose]();
  p.dispose();
  assert(p.disposed);
  assert.throws(
    () => p.inset(0),
    (e) => e.code === 'disposed',
  );
  let q;
  q = new MeshRegionInsetPreview(s, 'body', chosen(s), {
    createId: () => {
      q.dispose();
      return `z${++n}`;
    },
  });
  assert.throws(
    () => q.inset(0.1),
    (e) => e.code === 'disposed',
  );
  assert(q.disposed);
});
test('malformed inputs reject before state capture and property callbacks cannot publish after disposal', () => {
  const s = scene();
  for (const args of [
    [null, 'body', []],
    [s, 'missing', []],
    [s, 'body', ['missing']],
    [s, 'body', [], null],
  ])
    assert.throws(() => new MeshRegionInsetPreview(...args));
  const p = new MeshRegionInsetPreview(s, 'body', chosen(s), ids());
  assert.throws(
    () =>
      p.inset(0.1, {
        get color() {
          p.dispose();
          return '#e89054';
        },
      }),
    (e) => e.code === 'disposed',
  );
});
