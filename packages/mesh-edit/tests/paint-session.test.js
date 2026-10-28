import test from 'node:test';
import assert from 'node:assert/strict';
// module.registerHooks exists from Node 22.15; it is read only for the source mode, so the dist run works on 22.12.
if (process.env.MARGO_PAINT_SOURCE === '1')
  (await import('node:module')).registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL?.includes('/mesh-edit/src/'))
        return nextResolve(specifier.slice(0, -3) + '.ts', context);
      return nextResolve(specifier, context);
    },
  });
const K = await import(process.env.MARGO_PAINT_SOURCE === '1' ? '../src/paint-session.ts' : '../dist/index.js');
const P = await import(process.env.MARGO_PAINT_SOURCE === '1' ? '../src/paint.ts' : '../dist/index.js');
const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const base = [30, 60, 90, 255];
const scene = () => ({
  objects: [
    {
      id: 'mesh',
      worldMatrix: [...identity],
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
            [1 / 8, 1 / 6],
            [7 / 8, 1 / 6],
            [7 / 8, 5 / 6],
            [1 / 8, 5 / 6],
          ],
        },
      ],
    },
  ],
  texture: { width: 8, height: 6, pixels: Array.from({ length: 192 }, (_, i) => base[i % 4]) },
});
const hit = (uv = [1.5 / 8, 3.5 / 6]) => ({ objectId: 'mesh', faceId: 'face', uv, distance: 0 });
const create = (input = scene()) => new K.MeshPaintSession(input);
const state = { name: 'MargoError', code: 'state' };
const disposed = { name: 'MargoError', code: 'disposed' };
const rect = (patch) => [patch.x, patch.y, patch.width, patch.height];

test('literal content plus orthogonal halo forms a packed owned dirty rectangle', () => {
  const s = create(),
    h = s.begin(1);
  s.surface(h, hit(), '#ea8041');
  const p = s.flush(h);
  assert.deepEqual(rect(p), [0, 3, 2, 1]);
  assert.deepEqual(p.pixels, [234, 128, 65, 255, 234, 128, 65, 255]);
  assert.equal(p.revision, 1);
  assert.equal(p.sequence, 1);
  assert.equal(s.flush(h), null);
  p.pixels.fill(0);
  const out = s.commit(h, 1);
  assert.deepEqual(out.pixels.slice(96, 104), [234, 128, 65, 255, 234, 128, 65, 255]);
  assert.equal(s.revision, 2);
});

test('flush unions actual writes and leaves untouched bytes literal', () => {
  const s = create(),
    h = s.begin(1);
  s.atlas(h, 3, 2, '#ff0000');
  s.atlas(h, 5, 3, '#00ff00');
  const p = s.flush(h);
  assert.deepEqual(rect(p), [3, 2, 3, 2]);
  assert.deepEqual(p.pixels, [255, 0, 0, 255, ...base, ...base, ...base, ...base, 0, 255, 0, 255]);
  s.atlas(h, 3, 2, '#0000ff');
  assert.equal(s.flush(h).sequence, 2);
});

test('cancel restores all ever changed texels including unflushed and net-zero preview', () => {
  const s = create(),
    h = s.begin(1);
  s.atlas(h, 3, 2, '#ff0000');
  s.flush(h);
  s.atlas(h, 3, 2, '#1e3c5a');
  s.atlas(h, 5, 3, '#00ff00');
  const p = s.cancel(h);
  assert.deepEqual(rect(p), [3, 2, 3, 2]);
  assert.deepEqual(
    p.pixels,
    Array.from({ length: 24 }, (_, i) => base[i % 4]),
  );
  assert.equal(p.sequence, 2);
  assert.equal(s.revision, 1);
  const next = s.begin(1);
  s.atlas(next, 3, 2, '#1e3c5a');
  assert.equal(s.commit(next, 1), null);
});

test('net-zero commit closes handle and does not advance revision', () => {
  const s = create(),
    h = s.begin(1);
  s.atlas(h, 3, 2, '#fff');
  s.flush(h);
  s.atlas(h, 3, 2, '#1e3c5a');
  assert.equal(s.commit(h, 1), null);
  assert.equal(s.revision, 1);
  assert.throws(() => s.flush(h), state);
  const next = s.begin(1);
  assert.equal(s.cancel(next), null);
});

test('owned input snapshot ignores subsequent mutation of every input array and policy', () => {
  const input = scene(),
    expected = scene();
  input.texture.pixels = { ...input.texture.pixels, length: 192 };
  const s = create(input),
    h = s.begin(1);
  input.texture.pixels[0] = 999;
  input.objects[0].vertices[0][0] = NaN;
  input.objects[0].faces[0].uv[0][0] = NaN;
  input.objects[0].faces[0].vertices[0] = 999;
  input.objects[0].worldMatrix[0] = NaN;
  input.objects[0].canPaint = false;
  input.objects.length = 0;
  s.surface(h, hit(), '#f00', 2, true);
  assert.deepEqual(s.commit(h, 1), P.paintMeshSurface(expected, hit(), '#f00', 2, true));
});

test('returned atlas mutation cannot affect a later stroke or replacement', () => {
  const s = create(),
    h = s.begin(1);
  s.atlas(h, 3, 2, '#f00');
  const out = s.commit(h, 1);
  out.pixels.fill(0);
  const next = s.begin(2);
  s.atlas(next, 4, 2, '#0f0');
  const result = s.commit(next, 2);
  assert.deepEqual(result.pixels.slice(76, 84), [255, 0, 0, 255, 0, 255, 0, 255]);
});

test('handles reject foreign forged closed stale and wrong revision without closing valid stroke', () => {
  const s = create(),
    other = create(),
    h = s.begin(1),
    foreign = other.begin(1);
  assert.throws(() => s.begin(1), state);
  assert.throws(() => s.flush({ revision: 1 }), state);
  assert.throws(() => s.atlas(foreign, 3, 2, '#f00'), state);
  assert.throws(() => s.commit(h, 2), state);
  s.atlas(h, 3, 2, '#f00');
  s.commit(h, 1);
  for (const action of [() => s.cancel(h), () => s.flush(h), () => s.commit(h, 1), () => s.surface(h, hit(), '#fff')])
    assert.throws(action, state);
  assert.throws(() => s.begin(1), state);
  const live = s.begin(2);
  assert.equal(s.replace(scene()), 3);
  assert.throws(() => s.cancel(live), state);
  const newer = s.begin(3);
  assert.equal(s.cancel(newer), null);
});

test('invalid commands are atomic and retain previous pending dirty data', () => {
  const s = create(),
    h = s.begin(1);
  s.atlas(h, 3, 2, '#f00');
  for (const action of [
    () => s.surface(h, hit(), 'bad!'),
    () => s.surface(h, hit(), '#fff', 0),
    () => s.surface(h, { ...hit(), worldPoint: [NaN, 0, 0] }, '#fff'),
    () => s.surface(h, hit(), '#fff', 1, 'yes'),
    () => s.atlas(h, NaN, 0, '#fff'),
    () => s.atlas(h, 3, 2, '#fff', 1, { mode: 'other' }),
    () => s.atlas(h, 3, 2, '#fff', 1, { mode: 'dither', secondaryColor: 'bad!' }),
    () => s.atlas(h, 3, 2, '#fff', 1, null),
    () => s.atlas(h, 3, 2, '#fff', 1, []),
  ])
    assert.throws(action);
  assert.deepEqual(s.flush(h).pixels, [255, 0, 0, 255]);
  s.atlas(h, 4, 2, '#0f0');
  assert.ok(s.commit(h, 1));
});

test('failed replacement preserves revision live handle atlas and pending dirty bytes', () => {
  const s = create(),
    h = s.begin(1);
  s.atlas(h, 3, 2, '#f00');
  const invalid = scene();
  invalid.texture.pixels[0] = 300;
  assert.throws(() => s.replace(invalid), TypeError);
  assert.equal(s.revision, 1);
  assert.deepEqual(s.flush(h).pixels, [255, 0, 0, 255]);
  assert.ok(s.commit(h, 1));
});

test('preparation rejects sparse geometry image matrices and malformed nested input', () => {
  for (const mutate of [
    (x) => delete x.objects[0],
    (x) => delete x.objects[0].vertices[0],
    (x) => delete x.texture.pixels[0],
    (x) => delete x.objects[0].worldMatrix[0],
    (x) => delete x.objects[0].faces[0],
    (x) => (x.objects[0].faces[0].uv = [undefined]),
    (x) => (x.texture.width = Infinity),
    (x) => (x.objects[0].faces[0].vertices = null),
  ]) {
    const x = scene();
    mutate(x);
    assert.throws(
      () => create(x),
      (error) => error instanceof TypeError || error instanceof RangeError,
    );
  }
});

test('dispose is idempotent and rejects every subsequent operation', () => {
  const s = create(),
    h = s.begin(1);
  s.dispose();
  s.dispose();
  for (const action of [
    () => s.begin(1),
    () => s.atlas(h, 3, 2, '#fff'),
    () => s.surface(h, hit(), '#fff'),
    () => s.flush(h),
    () => s.commit(h, 1),
    () => s.cancel(h),
    () => s.replace(scene()),
    () => s.revision,
  ])
    assert.throws(action, disposed);
  assert.equal(s.disposed, true);
});

test('Symbol.dispose releases the session like dispose', () => {
  const s = create();
  assert.equal(s.disposed, false);
  s[Symbol.dispose]();
  assert.equal(s.disposed, true);
  assert.throws(() => s.begin(1), disposed);
});

for (const mode of ['surface', 'atlas'])
  test(`multi-dab ${mode} matches complete pure solid dither erase and local symmetry bytes`, () => {
    let input = scene();
    const s = create(input),
      h = s.begin(1);
    for (const [x, y, color, size, options] of [
      [1, 3, '#e89054', 2, {}],
      [4, 2, '#aabbcc', 3, { mode: 'dither', secondaryColor: '#123456' }],
      [6, 4, '#99887700', 2, { mode: 'dither', secondaryColor: '#fff' }],
      [3, 2, '#7ab', 1, {}],
    ]) {
      if (mode === 'surface') {
        const dab = hit([(x + 0.5) / 8, (y + 0.5) / 6]);
        s.surface(h, dab, color, size, true, options);
        input = { ...input, texture: P.paintMeshSurface(input, dab, color, size, true, options) ?? input.texture };
      } else {
        s.atlas(h, x, y, color, size, options);
        input = { ...input, texture: P.paintMeshAtlas(input, x, y, color, size, options) ?? input.texture };
      }
      s.flush(h);
    }
    assert.deepEqual(s.commit(h, 1), input.texture);
  });

test('protected shared owners and mirrored targets match pure ownership reservations', () => {
  const input = scene();
  const owner = structuredClone(input.objects[0]);
  owner.id = 'owner';
  owner.canPaint = false;
  owner.canMirror = false;
  input.objects.push(owner);
  const s = create(input),
    h = s.begin(1);
  s.surface(h, hit(), '#f00', 3, true);
  s.atlas(h, 0, 3, '#0f0', 2);
  assert.equal(s.flush(h), null);
  assert.equal(s.commit(h, 1), null);
});

test('free canvas uses reserved halos and out of bounds commands remain no-ops', () => {
  const input = scene();
  input.objects = [];
  const s = create(input),
    h = s.begin(1);
  s.atlas(h, -1, 2, '#f00');
  assert.equal(s.flush(h), null);
  s.atlas(h, 0, 0, '#1234');
  assert.deepEqual(s.flush(h).pixels, [17, 34, 51, 68]);
  assert.ok(s.commit(h, 1));
});

test('prepared world symmetry honors separate target policy and literal atlas positions', () => {
  for (const [canPaint, canMirror] of [
    [true, true],
    [false, true],
    [true, false],
  ]) {
    const input = scene(),
      left = input.objects[0],
      right = structuredClone(left);
    left.worldMatrix[12] = 4;
    left.canMirror = false;
    left.faces[0].uv = [
      [1 / 8, 1 / 6],
      [3 / 8, 1 / 6],
      [3 / 8, 5 / 6],
      [1 / 8, 5 / 6],
    ];
    right.id = 'right';
    right.worldMatrix[12] = -4;
    right.canPaint = canPaint;
    right.canMirror = canMirror;
    right.faces[0].uv = [
      [5 / 8, 1 / 6],
      [7 / 8, 1 / 6],
      [7 / 8, 5 / 6],
      [5 / 8, 5 / 6],
    ];
    input.objects.push(right);
    const dab = { ...hit([2.5 / 8, 3.5 / 6]), localPoint: [0.5, 0, 0], worldPoint: [4.5, 0, 0] };
    const s = create(input),
      h = s.begin(1);
    s.surface(h, dab, '#fff', 1, true);
    const actual = s.commit(h, 1),
      expected = P.paintMeshSurface(input, dab, '#fff', 1, true);
    assert.deepEqual(actual, expected);
    assert.deepEqual(actual.pixels.slice((3 * 8 + 2) * 4, (3 * 8 + 2) * 4 + 4), [255, 255, 255, 255]);
    assert.deepEqual(
      actual.pixels.slice((3 * 8 + 5) * 4, (3 * 8 + 5) * 4 + 4),
      canPaint && canMirror ? [255, 255, 255, 255] : base,
    );
  }
});

test('preparation validates copied bytes rather than a differently behaving borrowed iterator', () => {
  const input = scene();
  input.texture.pixels = {
    length: 192,
    ...input.texture.pixels,
    *[Symbol.iterator]() {
      for (let i = 0; i < 192; i++) yield i === 191 ? 999 : base[i % 4];
    },
  };
  assert.throws(() => create(input), TypeError);
});

test('prepared commands never reread caller storage after preparation', () => {
  const input = scene();
  let locked = false;
  const guard = {
    get(target, key, receiver) {
      if (locked) throw new Error('Borrowed scene read');
      return Reflect.get(target, key, receiver);
    },
  };
  input.objects = new Proxy(input.objects, guard);
  input.texture.pixels = new Proxy(input.texture.pixels, guard);
  const s = create(input),
    h = s.begin(1);
  locked = true;
  s.surface(h, hit(), '#f00', 2, true);
  assert.ok(s.flush(h));
  assert.ok(s.commit(h, 1));
});

test('successful replacement owns its new snapshot and advances sequence across revisions', () => {
  const s = create(),
    h = s.begin(1);
  s.atlas(h, 3, 2, '#f00');
  assert.equal(s.flush(h).sequence, 1);
  const replacement = scene();
  assert.equal(s.replace(replacement), 2);
  replacement.texture.pixels.fill(0);
  const next = s.begin(2);
  s.atlas(next, 3, 2, '#0f0');
  assert.equal(s.flush(next).sequence, 2);
  const restore = s.cancel(next);
  restore.pixels.fill(0);
  const last = s.begin(2);
  s.atlas(last, 3, 2, '#1e3c5a');
  assert.equal(s.commit(last, 2), null);
});

test('triangle halo patch preserves orthogonal priority and never cascades from padding', () => {
  const input = scene();
  input.objects[0].faces[0].vertices = [0, 1, 3];
  input.objects[0].faces[0].uv = [
    [2 / 8, 1 / 6],
    [6 / 8, 1 / 6],
    [2 / 8, 5 / 6],
  ];
  for (let y = 0; y < 6; y++)
    for (let x = 0; x < 8; x++) input.texture.pixels.splice((y * 8 + x) * 4, 4, x * 20, y * 30, 90, 255);
  const s = create(input),
    h = s.begin(1);
  s.atlas(h, 3, 2, '#f00');
  const actual = s.commit(h, 1);
  assert.deepEqual(actual, P.paintMeshAtlas(input, 3, 2, '#f00'));
  // (5,3) is a diagonal edge halo. Its first valid neighbour is (5,2), not changed (3,2).
  assert.deepEqual(actual.pixels.slice((3 * 8 + 5) * 4, (3 * 8 + 5) * 4 + 4), [100, 60, 90, 255]);
});
