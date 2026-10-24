import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

// Source verification avoids rebuilding shared dist while another author works on UV operations.
if (process.env.MARGO_PAINT_SOURCE === '1')
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL?.includes('/mesh-edit/src/'))
        return nextResolve(specifier.slice(0, -3) + '.ts', context);
      return nextResolve(specifier, context);
    },
  });
const K = await import(process.env.MARGO_PAINT_SOURCE === '1' ? '../src/paint.ts' : '../dist/index.js');
const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const fixture = () => ({
  objects: ['left', 'right'].map((id, i) => ({
    id,
    worldMatrix: [...identity.slice(0, 12), i ? 8 : 4, 0, 0, 1],
    canPaint: true,
    canProject: true,
    canMirror: true,
    vertices: [
      [-1, -1, 0],
      [1, -1, 0],
      [1, 1, 0],
      [-1, 1, 0],
    ],
    faces: [
      {
        id: 'face',
        vertices: [0, 1, 2, 3],
        uv: [
          [(i * 8 + 1) / 16, 1 / 8],
          [(i * 8 + 7) / 16, 1 / 8],
          [(i * 8 + 7) / 16, 7 / 8],
          [(i * 8 + 1) / 16, 7 / 8],
        ],
      },
    ],
  })),
  texture: { width: 16, height: 8, pixels: Array.from({ length: 512 }, (_, i) => [30, 60, 90, 255][i % 4]) },
});
const hit = (uv = [5.5 / 16, 3.5 / 8]) => ({
  objectId: 'left',
  faceId: 'face',
  uv,
  distance: 1,
  localPoint: [0.5, -1 / 6, 0],
  worldPoint: [4.5, -1 / 6, 0],
});
const pixel = (atlas, x, y) => Array.from(atlas.pixels).slice((y * atlas.width + x) * 4, (y * atlas.width + x) * 4 + 4);
const api = () => {
  for (const name of ['meshPaintTexel', 'paintMeshSurface', 'paintMeshAtlas', 'mirrorMeshPaintHit'])
    assert.equal(typeof K[name], 'function', `public ${name}`);
};
const freeze = (value) => {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
};

test('public CPU paint resolves top-left floor/clamp texels without GPU state', () => {
  api();
  for (const [uv, expected] of [
    [
      [5.99 / 16, 3.99 / 8],
      [5, 3],
    ],
    [
      [1, 1],
      [15, 7],
    ],
    [
      [-0.1, -0.1],
      [0, 0],
    ],
  ])
    assert.deepEqual(K.meshPaintTexel(uv, 16, 8), expected);
  assert.throws(() => K.meshPaintTexel([NaN, 0], 16, 8));
  assert.throws(() => K.meshPaintTexel(new Array(2), 16, 8));
  assert.throws(() => K.meshPaintTexel([0, 0], 0, 8));
});

test('surface and atlas dabs match complete bytes and refresh nearest interior halo', () => {
  api();
  const scene = freeze(fixture());
  const actual = K.paintMeshSurface(scene, hit([1.2 / 16, 3.2 / 8]), '#ea8041');
  assert.deepEqual(actual, K.paintMeshAtlas(scene, 1, 3, '#ea8041'));
  const expected = [...scene.texture.pixels];
  for (const [x, y] of [
    [1, 3],
    [0, 3],
  ])
    expected.splice((y * 16 + x) * 4, 4, 234, 128, 65, 255);
  assert.deepEqual(actual.pixels, expected);
  assert.deepEqual(pixel(actual, 0, 2), [30, 60, 90, 255]);
});

test('size rounding and maximum UV keep a square inside face content', () => {
  api();
  const scene = fixture();
  const actual = K.paintMeshSurface(scene, hit([7 / 16, 3.2 / 8]), '#fff', 2.5);
  for (const [x, y] of [
    [5, 2],
    [6, 3],
    [7, 3],
  ])
    assert.deepEqual(pixel(actual, x, y), [255, 255, 255, 255]);
  assert.deepEqual(pixel(actual, 4, 3), [30, 60, 90, 255]);
  assert.deepEqual(pixel(actual, 8, 3), [30, 60, 90, 255]);
  assert.throws(() => K.paintMeshSurface(scene, hit(), '#fff', 129));
});

test('dither uses atlas parity and halo repeats interior while transparent RGBA replaces bytes', () => {
  api();
  const scene = fixture(),
    opts = { mode: 'dither', secondaryColor: '#102030' };
  const actual = K.paintMeshSurface(scene, hit([2.5 / 16, 2.5 / 8]), '#f0a050', 3, false, opts);
  assert.deepEqual(pixel(actual, 1, 1), [240, 160, 80, 255]);
  assert.deepEqual(pixel(actual, 1, 2), [16, 32, 48, 255]);
  assert.deepEqual(pixel(actual, 0, 2), [16, 32, 48, 255]);
  const erased = K.paintMeshSurface(scene, hit([1.5 / 16, 2.5 / 8]), '#abc0', 3, false, opts);
  assert.deepEqual(pixel(erased, 1, 2), [170, 187, 204, 0]);
  assert.deepEqual(pixel(erased, 0, 2), [170, 187, 204, 0]);
  assert.deepEqual(pixel(K.paintMeshSurface(scene, hit(), '#1234'), 5, 3), [17, 34, 51, 68]);
});

test('local symmetry owns coordinates and falls back to eligible world reflected limb', () => {
  api();
  const scene = fixture(),
    source = hit(),
    actual = K.mirrorMeshPaintHit(scene, source);
  assert.equal(actual.objectId, 'left');
  assert.ok(Math.abs(actual.uv[0] - 2.5 / 16) < 1e-10);
  assert.deepEqual(actual.localPoint, [-0.5, -1 / 6, 0]);
  assert.deepEqual(actual.worldPoint, [3.5, -1 / 6, 0]);
  actual.uv[0] = 0;
  actual.localPoint[0] = 0;
  actual.worldPoint[0] = 0;
  assert.deepEqual(source, hit());
  scene.objects[1].worldMatrix[12] = -4;
  const center = { ...hit([4 / 16, 4 / 8]), localPoint: [0, 0, 0], worldPoint: [4, 0, 0] };
  assert.equal(K.mirrorMeshPaintHit(scene, center).objectId, 'right');
  scene.objects[1].canMirror = false;
  assert.equal(K.mirrorMeshPaintHit(scene, center).objectId, 'left');
  const noPoint = { objectId: 'left', faceId: 'face', uv: [5.5 / 16, 3.5 / 8], distance: 1 };
  assert.deepEqual(K.meshPaintTexel(K.mirrorMeshPaintHit(scene, noPoint).uv, 16, 8), [2, 3]);
});

test('symmetric dither uses each target atlas coordinate', () => {
  api();
  const actual = K.paintMeshSurface(fixture(), hit(), '#f0a050', 1, true, {
    mode: 'dither',
    secondaryColor: '#102030',
  });
  assert.deepEqual(pixel(actual, 5, 3), [240, 160, 80, 255]);
  assert.deepEqual(pixel(actual, 2, 3), [16, 32, 48, 255]);
});

test('local reflected targets require canMirror while the source dab remains paintable', () => {
  api();
  const scene = fixture();
  scene.objects[0].canMirror = false;
  assert.equal(K.mirrorMeshPaintHit(scene, hit()), null);
  const actual = K.paintMeshSurface(scene, hit(), '#fff', 1, true);
  assert.deepEqual(pixel(actual, 5, 3), [255, 255, 255, 255]);
  assert.deepEqual(pixel(actual, 2, 3), [30, 60, 90, 255]);
});

test('a source ineligible as local mirror target can still mirror onto an eligible separate object', () => {
  api();
  const scene = fixture();
  scene.objects[0].canMirror = false;
  scene.objects[1].worldMatrix[12] = -4;
  const mirrored = K.mirrorMeshPaintHit(scene, hit());
  assert.equal(mirrored.objectId, 'right');
  for (const [axis, expected] of [-0.5, -1 / 6, 0].entries())
    assert.ok(Math.abs(mirrored.localPoint[axis] - expected) < 1e-12);
  assert.deepEqual(mirrored.worldPoint, [-4.5, -1 / 6, 0]);
  assert.deepEqual(K.meshPaintTexel(mirrored.uv, 16, 8), [10, 3]);
  const actual = K.paintMeshSurface(scene, hit(), '#fff', 1, true);
  assert.deepEqual(pixel(actual, 5, 3), [255, 255, 255, 255]);
  assert.deepEqual(pixel(actual, 10, 3), [255, 255, 255, 255]);
  assert.deepEqual(pixel(actual, 2, 3), [30, 60, 90, 255]);
  scene.objects[1].canPaint = false;
  const protectedTarget = K.paintMeshSurface(scene, hit(), '#fff', 1, true);
  assert.deepEqual(pixel(protectedTarget, 5, 3), [255, 255, 255, 255]);
  assert.deepEqual(pixel(protectedTarget, 10, 3), [30, 60, 90, 255]);
  scene.objects[0].canPaint = false;
  scene.objects[0].canMirror = true;
  assert.equal(K.mirrorMeshPaintHit(scene, hit()), null);
  assert.equal(K.paintMeshSurface(scene, hit(), '#fff', 1, true), null);
});

test('ineligible direct surface and atlas sources produce no edit', () => {
  api();
  const scene = fixture();
  scene.objects[0].canPaint = false;
  assert.equal(K.paintMeshSurface(scene, hit(), '#fff'), null);
  assert.equal(K.paintMeshAtlas(scene, 5, 3, '#fff'), null);
});

test('ineligible shared UV owner protects content and halo independent of object order', () => {
  api();
  for (const reverse of [false, true]) {
    const scene = fixture();
    scene.objects[1].faces[0].uv = structuredClone(scene.objects[0].faces[0].uv);
    scene.objects[1].canPaint = false;
    if (reverse) scene.objects.reverse();
    assert.equal(K.paintMeshSurface(scene, hit([1.2 / 16, 3.2 / 8]), '#ff0000', 3), null);
    assert.equal(K.paintMeshAtlas(scene, 1, 3, '#ff0000', 3), null);
  }
});

test('partially overlapping ineligible halo blocks only reserved texels', () => {
  api();
  const scene = fixture();
  scene.objects[1].faces[0].uv = [
    [5 / 16, 1 / 8],
    [11 / 16, 1 / 8],
    [11 / 16, 7 / 8],
    [5 / 16, 7 / 8],
  ];
  scene.objects[1].canPaint = false;
  const actual = K.paintMeshSurface(scene, hit([3.5 / 16, 3.5 / 8]), '#ff0000', 5);
  assert.deepEqual(pixel(actual, 3, 3), [255, 0, 0, 255]);
  for (const x of [4, 5, 6, 7, 8, 9, 10, 11]) assert.deepEqual(pixel(actual, x, 3), [30, 60, 90, 255]);
});

test('gutter dabs reserve every face halo including eligible and ineligible owners', () => {
  api();
  const scene = fixture();
  scene.objects = [scene.objects[0]];
  scene.objects[0].faces[0].uv = [
    [4 / 16, 2 / 8],
    [8 / 16, 2 / 8],
    [8 / 16, 6 / 8],
    [4 / 16, 6 / 8],
  ];
  for (const canPaint of [false, true]) {
    scene.objects[0].canPaint = canPaint;
    const actual = K.paintMeshAtlas(scene, 3, 4, '#f00', 5, { mode: 'dither', secondaryColor: '#00f' });
    assert.deepEqual(pixel(actual, 1, 4), [0, 0, 255, 255]);
    assert.deepEqual(pixel(actual, 2, 4), [255, 0, 0, 255]);
    for (const x of [3, 4, 5]) assert.deepEqual(pixel(actual, x, 4), [30, 60, 90, 255]);
  }
});

test('out-of-bounds atlas center never aliases another row', () => {
  api();
  const scene = fixture();
  for (const [x, y] of [
    [16, 0],
    [-1, 2],
    [0, -1],
    [0, 8],
  ])
    assert.equal(K.paintMeshAtlas(scene, x, y, '#fff', 128), null);
  assert.throws(() => K.paintMeshAtlas(scene, Infinity, 1, '#fff'));
});

test('paint validates identities, geometry, matrices and byte dimensions before exposing output', () => {
  api();
  for (const breakScene of [
    (s) => s.objects.push(s.objects[0]),
    (s) => s.objects[0].faces.push(s.objects[0].faces[0]),
    (s) => (s.objects[0].vertices[0][0] = NaN),
    (s) => (s.objects[0].faces[0].vertices[0] = 99),
    (s) => (s.objects[0].worldMatrix[0] = NaN),
    (s) => s.texture.pixels.pop(),
  ]) {
    const scene = fixture();
    breakScene(scene);
    assert.throws(() => K.paintMeshSurface(scene, hit(), '#fff'));
  }
  const scene = fixture();
  scene.objects[1].faces[0].uv = [];
  assert.deepEqual(pixel(K.paintMeshSurface(scene, hit(), '#fff'), 5, 3), [255, 255, 255, 255]);
});

test('repeated calls observe changed UVs and policies without retaining caller arrays', () => {
  api();
  const scene = fixture();
  const first = K.paintMeshSurface(scene, hit(), '#fff');
  first.pixels.fill(1);
  assert.equal(scene.texture.pixels[0], 30);
  scene.objects[0].canPaint = false;
  assert.equal(K.paintMeshSurface(scene, hit(), '#fff'), null);
  scene.objects[0].canPaint = true;
  scene.objects[0].faces[0].uv = [
    [2 / 16, 1 / 8],
    [4 / 16, 1 / 8],
    [4 / 16, 7 / 8],
    [2 / 16, 7 / 8],
  ];
  assert.deepEqual(pixel(K.paintMeshSurface(scene, hit([3 / 16, 3 / 8]), '#f00'), 3, 3), [255, 0, 0, 255]);
});

const triangleScene = () => {
  const scene = fixture();
  scene.objects = [scene.objects[0]];
  scene.objects[0].faces = [
    {
      id: 'face',
      vertices: [0, 1, 3],
      uv: [
        [2 / 16, 2 / 8],
        [6 / 16, 2 / 8],
        [2 / 16, 6 / 8],
      ],
    },
  ];
  return scene;
};

test('triangle edge-touch coverage retains closed-cell diagonal pixels in either winding', () => {
  api();
  for (const reverse of [false, true]) {
    const scene = triangleScene();
    if (reverse) {
      scene.objects[0].faces[0].vertices.reverse();
      scene.objects[0].faces[0].uv.reverse();
    }
    const rows = ['1111', '1111', '1110', '1100'];
    for (let y = 2; y < 6; y++)
      for (let x = 2; x < 6; x++) {
        const actual = K.paintMeshAtlas(scene, x, y, '#f00');
        if (rows[y - 2][x - 2] === '1') assert.deepEqual(pixel(actual, x, y), [255, 0, 0, 255]);
        else assert.equal(actual, null, `reserved diagonal halo ${x},${y}`);
      }
  }
});

test('halo prefers up over left and diagonal copies never cascade padding', () => {
  api();
  const scene = triangleScene();
  scene.texture.pixels = Array.from({ length: 512 }, (_, i) => {
    const texel = Math.floor(i / 4),
      x = texel % 16,
      y = Math.floor(texel / 16);
    return [y * 10 + x, 0, 0, 255][i % 4];
  });
  const actual = K.paintMeshAtlas(scene, 2, 2, '#fff');
  assert.deepEqual(pixel(actual, 5, 4), [35, 0, 0, 255], 'up wins over left');
  assert.deepEqual(pixel(actual, 4, 5), [44, 0, 0, 255], 'up wins over left on next diagonal');
  assert.deepEqual(pixel(actual, 6, 4), [35, 0, 0, 255], 'diagonal interior source');
  assert.deepEqual(pixel(actual, 6, 5), [56, 0, 0, 255], 'no interior neighbour means no cascading halo');
});

test('local reflection uses the current compound nonuniform mirrored matrix', () => {
  api();
  const scene = fixture();
  scene.objects[0].worldMatrix = [0, 2, 0, 0, -3, 0, 0, 0, 0, 0, -4, 0, 4, 5, 6, 1];
  const actual = K.mirrorMeshPaintHit(scene, hit());
  assert.deepEqual(actual.worldPoint, [4.5, 4, 6]);
  scene.objects[0].worldMatrix[12] = 14;
  assert.deepEqual(K.mirrorMeshPaintHit(scene, hit()).worldPoint, [14.5, 4, 6]);
});

test('byte-identical dabs return no edit and sparse UV drafts are never mapped paint sources', () => {
  api();
  const scene = fixture();
  assert.equal(K.paintMeshSurface(scene, hit(), '#1e3c5a'), null);
  scene.objects[0].faces[0].uv[0] = new Array(2);
  assert.throws(() => K.paintMeshSurface(scene, hit(), '#fff'));
});

test('cached raster masks invalidate dimensions and derive shared-owner policy freshly', () => {
  api();
  const scene = fixture();
  scene.objects[1].faces[0].uv = structuredClone(scene.objects[0].faces[0].uv);
  assert.deepEqual(pixel(K.paintMeshSurface(scene, hit(), '#f00'), 5, 3), [255, 0, 0, 255]);
  scene.objects[1].canPaint = false;
  assert.equal(K.paintMeshSurface(scene, hit(), '#f00'), null);
  scene.objects[1].canPaint = true;
  assert.deepEqual(pixel(K.paintMeshSurface(scene, hit(), '#f00'), 5, 3), [255, 0, 0, 255]);
  scene.texture.width = 32;
  scene.texture.pixels = Array.from({ length: 1024 }, (_, i) => [30, 60, 90, 255][i % 4]);
  assert.deepEqual(pixel(K.paintMeshSurface(scene, hit(), '#f00'), 11, 3), [255, 0, 0, 255]);
});

test('pure paint validates options and secondary colours like a session, even in solid mode', () => {
  const scene = fixture();
  for (const options of [{ mode: 'other' }, { secondaryColor: 'bad!' }, null, []]) {
    assert.throws(() => K.paintMeshSurface(scene, hit(), '#f00', 1, false, options), TypeError);
    assert.throws(() => K.paintMeshAtlas(scene, 3, 2, '#f00', 1, options), TypeError);
  }
  assert.throws(() => K.paintMeshSurface(scene, hit(), '#f00', 1, 'yes'), TypeError);
  assert.throws(() => K.paintMeshAtlas(scene, 3, 2, '#f00', 0), RangeError);
});
