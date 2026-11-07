// export3MF: `parse3MF` here is a stand-in reader; PrusaSlicer and lib3mf read real files by hand (claims.md, reproduce.md).
import test from 'node:test';
import assert from 'node:assert/strict';
import { parse3MF, readZipDirectory, readZipEntry } from '@margoengine/loaders';
import { exportGLB } from '@margoengine/exporters';
import { export3MF } from '@margoengine/exporters/threemf';

// A closed box 2 x 3 x 4 m with its corner at the origin and its faces outward.
const box = (() => {
  const positions = [],
    add = (corners) => positions.push(...corners.flat());
  const p = (x, y, z) => [x * 2, y * 3, z * 4];
  const faces = [
    [p(0, 0, 0), p(0, 1, 0), p(1, 1, 0), p(1, 0, 0)],
    [p(0, 0, 1), p(1, 0, 1), p(1, 1, 1), p(0, 1, 1)],
    [p(0, 0, 0), p(1, 0, 0), p(1, 0, 1), p(0, 0, 1)],
    [p(0, 1, 0), p(0, 1, 1), p(1, 1, 1), p(1, 1, 0)],
    [p(0, 0, 0), p(0, 0, 1), p(0, 1, 1), p(0, 1, 0)],
    [p(1, 0, 0), p(1, 1, 0), p(1, 1, 1), p(1, 0, 1)],
  ];
  const indices = [];
  faces.forEach((corners, f) => {
    add(corners);
    indices.push(f * 4, f * 4 + 1, f * 4 + 2, f * 4, f * 4 + 2, f * 4 + 3);
  });
  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(positions.length),
    indices: new Uint32Array(indices),
  };
})();

const model = async (file) => {
  const entries = readZipDirectory(file),
    entry = entries.find(({ name }) => name === '3D/3dmodel.model');
  return new TextDecoder().decode(await readZipEntry(file, entry));
};
const count = (text, pattern) => (text.match(pattern) ?? []).length;

/** Signed volume of a closed mesh by the divergence theorem: positive when its faces point out. */
function volume({ positions, indices }) {
  let sum = 0;
  for (let i = 0; i < indices.length; i += 3) {
    const [a, b, c] = [0, 1, 2].map((k) => positions.subarray(indices[i + k] * 3, indices[i + k] * 3 + 3));
    sum += a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0]);
  }
  return sum / 6;
}

test('a box is welded to its 8 corners, in the file unit, and stands on Z', async () => {
  const file = await export3MF({ nodes: [{ geometry: box }] }),
    text = await model(file);
  assert.match(text, /<model unit="millimeter"/);
  assert.equal(count(text, /<vertex /g), 8);
  assert.equal(count(text, /<triangle /g), 12);
  assert.equal(count(text, /<item /g), 1);
  // Y up to Z up: scene Y becomes Z and scene Z becomes -Y. The item's rows are the images of the axes.
  assert.match(text, /transform="1 0 0 0 0 1 0 -1 0 0 0 0"/);
  assert.match(text, /x="2000" y="3000" z="4000"/);
  const parsed = await parse3MF(file, { units: 'file' });
  // 2 x 3 x 4 m in cubic millimetres; positions are exact in Float32, the sum runs in Float64 over values up to 4e3.
  assert.ok(Math.abs(volume(parsed) - 24e9) < 1, 'closed, outward and to scale');
});

test('every unit converts and the file says which', async () => {
  // Each length is the shortest decimal that reads back as the same Float32.
  for (const [unit, side] of [
    ['micron', '2000000'],
    ['millimeter', '2000'],
    ['centimeter', '200'],
    ['meter', '2'],
    ['inch', '78.74016'],
    ['foot', '6.56168'],
  ]) {
    const text = await model(await export3MF({ nodes: [{ geometry: box }] }, { unit }));
    assert.match(text, new RegExp(`<model unit="${unit}"`));
    assert.ok(text.includes(`x="${side}"`), `${unit}: ${text.match(/x="[^"]+"/g).slice(0, 8)}`);
  }
  const text = await model(
    await export3MF({ nodes: [{ translation: [1, 0, 0], geometry: box }] }, { unit: 'centimeter' }),
  );
  assert.match(text, /transform="1 0 0 0 0 1 0 -1 0 100 0 0"/, 'the translation is converted too');
});

test("upAxis 'z' leaves the axes as they are", async () => {
  const text = await model(await export3MF({ nodes: [{ geometry: box }] }, { upAxis: 'z' }));
  assert.match(text, /transform="1 0 0 0 1 0 0 0 1 0 0 0"/);
});

test('with assembly off, one geometry and material is one object placed many times', async () => {
  const material = { color: [1, 0, 0, 1] },
    text = await model(
      await export3MF(
        {
          nodes: [
            { translation: [0, 0, 0], geometry: box, material },
            { translation: [5, 0, 0], geometry: box, material },
            { translation: [10, 0, 0], geometry: box, material: { color: [0, 1, 0, 1] } },
          ],
        },
        { assembly: false },
      ),
    );
  assert.equal(count(text, /<object /g), 2);
  assert.equal(count(text, /<item /g), 3);
  assert.equal(count(text, /<base /g), 2);
});

test('colours are sRGB, with alpha only when not opaque', async () => {
  const text = await model(
    await export3MF({
      nodes: [
        // Linear 0.5 is sRGB 0.7354, byte 188.
        { geometry: box, material: { color: [0.5, 0, 1, 1] } },
        { translation: [5, 0, 0], geometry: box, material: { color: [1, 1, 1, 0.5] } },
      ],
    }),
  );
  assert.match(text, /displaycolor="#BC00FF"/);
  assert.match(text, /displaycolor="#FFFFFF80"/);
});

test('vertex colours become a colour group, corner by corner', async () => {
  const painted = {
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      normals: new Float32Array(9),
      colors: new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]),
      indices: new Uint32Array([0, 1, 2]),
    },
    text = await model(await export3MF({ nodes: [{ geometry: painted }] }));
  assert.match(
    text,
    /<m:colorgroup id="\d+"><m:color color="#FF0000"\/><m:color color="#00FF00"\/><m:color color="#0000FF"\/>/,
  );
  assert.match(text, /<triangle v1="0" v2="1" v3="2" pid="\d+" p1="0" p2="1" p3="2"\/>/);
});

test('parts that overlap are one object on one build item, so a slicer cannot pull them apart', async () => {
  // PrusaSlicer 2.9.7 read each build item, and each component too, as an object of its own: overlapping ones crashed it
  // (0xC0000005 after "gcode path conflicts") and --scale-to-fit sized each on its own.
  const file = await export3MF(
      { nodes: [{ geometry: box }, { translation: [1, 0, 0], geometry: box }, { translation: [2, 0, 0], geometry: box }] },
      { title: 'Stack' },
    ),
    text = await model(file);
  assert.equal(count(text, /<object /g), 1);
  assert.equal(count(text, /<item /g), 1);
  assert.equal(count(text, /<components>/g), 0);
  assert.equal(count(text, /<triangle /g), 36);
  assert.match(text, /<object id="\d+" type="model" pid="1" pindex="0" name="Stack">/);
  assert.match(text, /<item objectid="\d+"\/>/);
  // Placed in the mesh, in file units, Y up turned to Z up: the third box ends at X = 2 + 2 m and at Y = -4 m.
  assert.match(text, /x="4000" y="-4000" z="3000"/);
  const parsed = await parse3MF(file, { units: 'file' });
  assert.ok(Math.abs(volume(parsed) - 3 * 24e9) < 3, 'each part closed and outward');
});

test('parts that touch stay separate shells: a shared corner would leave edges of four triangles', async () => {
  const text = await model(
    await export3MF({ nodes: [{ geometry: box }, { translation: [2, 0, 0], geometry: box }] }),
  );
  assert.equal(count(text, /<vertex /g), 16);
  const uses = new Map();
  for (const [, a, b, c] of text.matchAll(/<triangle v1="(\d+)" v2="(\d+)" v3="(\d+)"/g))
    for (const [u, v] of [[a, b], [b, c], [c, a]]) {
      const edge = [+u, +v].sort((x, y) => x - y).join();
      uses.set(edge, (uses.get(edge) ?? 0) + 1);
    }
  assert.deepEqual([...new Set(uses.values())], [2], 'every edge has two triangles');
});

test('a mirrored part of an assembly stays outward, and the file holds no reflection', async () => {
  const file = await export3MF({ nodes: [{ geometry: box }, { translation: [5, 0, 0], scale: [-1, 1, 1], geometry: box }] }),
    text = await model(file);
  assert.ok(!text.includes('transform='));
  assert.match(text, /x="3000" y="-4000"/, 'the reflection runs back from X = 5 m to 3 m');
  const parsed = await parse3MF(file, { units: 'file' });
  assert.ok(Math.abs(volume(parsed) - 2 * 24e9) < 2);
});

test('parts of an assembly keep their colours triangle by triangle', async () => {
  const painted = {
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      normals: new Float32Array(9),
      colors: new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]),
      indices: new Uint32Array([0, 1, 2]),
    },
    text = await model(
      await export3MF({
        nodes: [
          { geometry: box, material: { color: [1, 0, 0, 1] } },
          { translation: [5, 0, 0], geometry: box, material: { color: [0, 1, 0, 1] } },
          { translation: [9, 0, 0], geometry: painted },
        ],
      }),
    );
  assert.match(text, /<object id="\d+" type="model" pid="1" pindex="0"/);
  assert.equal(count(text, /pid="1" p1="1"\/>/g), 12, 'the second part names its colour, the first takes the object\'s');
  assert.match(text, /<triangle v1="16" v2="17" v3="18" pid="\d+" p1="0" p2="1" p3="2"\/>/);
});

test('with assembly off, mirrored nodes share a reflected object, and no item keeps a reflection', async () => {
  const mirrored = (x) => ({ translation: [x, 0, 0], scale: [-1, 1, 1], geometry: box }),
    file = await export3MF({ nodes: [{ geometry: box }, mirrored(5), mirrored(9)] }, { assembly: false }),
    text = await model(file);
  assert.equal(count(text, /<object /g), 2, 'the geometry and its reflection');
  for (const [, values] of text.matchAll(/transform="([^"]+)"/g)) {
    const [a, b, c, d, e, f, g, h, i] = values.split(' ').map(Number);
    assert.ok(a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g) > 0, values);
  }
  const parsed = await parse3MF(file, { units: 'file' });
  // Each of the three stays closed and outward, so the volumes add up. Same bound as above, three times.
  assert.ok(Math.abs(volume(parsed) - 3 * 24e9) < 3);
});

test('a vertex colour multiplies the base colour', async () => {
  const painted = {
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      normals: new Float32Array(9),
      colors: new Float32Array([1, 1, 1, 1, 1, 1, 1, 1, 1]),
      indices: new Uint32Array([0, 1, 2]),
    },
    text = await model(await export3MF({ nodes: [{ geometry: painted, material: { color: [0.5, 0.5, 0.5, 1] } }] }));
  // Linear 0.5 is sRGB byte 188, as above.
  assert.match(text, /<m:color color="#BCBCBC"\/>/);
});

test('a mirrored painted geometry keeps each corner on its colour', async () => {
  const painted = {
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      normals: new Float32Array(9),
      colors: new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]),
      indices: new Uint32Array([0, 1, 2]),
    },
    text = await model(await export3MF({ nodes: [{ scale: [-1, 1, 1], geometry: painted }] }));
  assert.match(text, /<triangle v1="0" v2="2" v3="1" pid="\d+" p1="0" p2="1" p3="2"\/>/);
  assert.match(text, /<m:color color="#FF0000"\/><m:color color="#0000FF"\/><m:color color="#00FF00"\/>/);
});

test('names and titles are escaped, and a triangle welded to nothing goes', async () => {
  const flat = {
      positions: new Float32Array([0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0]),
      normals: new Float32Array(12),
      indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
    },
    text = await model(await export3MF({ nodes: [{ name: 'a<b>&"c', geometry: flat }] }, { title: 'Bracket & <1>' }));
  assert.equal(count(text, /<triangle /g), 1);
  assert.ok(!text.includes('a<b'));
  assert.match(text, /<metadata name="Title">Bracket &#38; &#60;1&#62;<\/metadata>/);
});

test('GLB bytes go in as they are, with their colours', async () => {
  const glb = exportGLB({ nodes: [{ translation: [1, 0, 0], geometry: box, material: { color: [1, 0, 0, 1] } }] }),
    text = await model(await export3MF(glb));
  assert.equal(count(text, /<triangle /g), 12);
  assert.match(text, /displaycolor="#FF0000"/);
  assert.match(text, /transform="1 0 0 0 0 1 0 -1 0 1000 0 0"/);
});

test('what it cannot write is refused', async () => {
  await assert.rejects(
    export3MF({ nodes: [{ scale: [1e-120, 1e-120, 1e-120], geometry: box }] }),
    /non-zero determinant/,
  );
  await assert.rejects(export3MF({ nodes: [{ name: 'empty' }] }), RangeError);
  await assert.rejects(export3MF({ nodes: [{ geometry: box }] }, { unit: 'parsec' }), RangeError);
  await assert.rejects(export3MF({ nodes: [{ geometry: box }] }, { unit: 'toString' }), /3MF unit must be one of/);
  await assert.rejects(export3MF({ nodes: [{ geometry: box }] }, { upAxis: 'x' }), RangeError);
  const huge = { ...box, positions: box.positions.map((v) => v * 3e36) };
  await assert.rejects(export3MF({ nodes: [{ geometry: huge }] }, { unit: 'micron' }), /Float32/);
  const stop = new AbortController();
  stop.abort(new Error('stopped'));
  await assert.rejects(export3MF({ nodes: [{ geometry: box }] }, { signal: stop.signal }), /stopped/);
});
