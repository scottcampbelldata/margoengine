import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { convertFBX } from '../dist/index.js';
import { legacyFBX } from '../dist/legacy.js';
import { largeFBX } from '../dist/large.js';
import { readGLB } from './native-scene-helper.js';
import { binary, ascii } from './fixtures.js';
import { runParseWorker } from '../../../tests/support/parse-worker.js';
import validator from 'gltf-validator';
const input = (name) => readFile(new URL(`./fixtures/real/${name}.fbx`, import.meta.url));
const convert = async (bytes) => readGLB(await convertFBX(bytes, { extensions: [legacyFBX] }));

for (const name of ['max2009_cube_anim', 'maya_transformed_skin', 'maya_blend_shape_cube', 'maya_interpolation_modes'])
  test(`real 6.1 ${name} preserves matching ASCII and binary mesh, attributes and animation`, async () => {
    const results = [];
    for (const format of ['ascii', 'binary']) {
      const bytes = await convertFBX(await input(`${name}_6100_${format}`), { extensions: [legacyFBX] });
      const report = await validator.validateBytes(new Uint8Array(bytes));
      assert.equal(report.issues.numErrors, 0, JSON.stringify(report.issues.messages));
      results.push(readGLB(bytes));
    }
    const [a, b] = results;
    assert.deepEqual(a.doc.meshes, b.doc.meshes);
    assert.equal(a.doc.animations.length, 1);
    assert.equal(a.doc.accessors.length, b.doc.accessors.length);
    for (let k = 0; k < a.doc.accessors.length; k++) {
      const x = a.accessor(k),
        y = b.accessor(k);
      assert.equal(x.length, y.length);
      for (let i = 0; i < x.length; i++)
        assert.ok(
          Math.abs(x[i] - y[i]) <= 1e-5 * Math.max(1, Math.abs(x[i])),
          `accessor ${k} value ${i}: ${x[i]} vs ${y[i]}`,
        );
    }
    if (name.includes('skin')) {
      assert.equal(a.doc.skins.length, 1);
      assert.ok(a.doc.skins[0].joints.length > 1);
      assert.ok(a.doc.meshes[0].primitives[0].attributes.JOINTS_0 !== undefined);
    }
    if (name.includes('shape')) {
      assert.equal(a.doc.meshes[0].primitives[0].targets.length, 2);
      assert.ok(a.doc.animations[0].channels.some((c) => c.target.path === 'weights'));
    }
    if (name.includes('cube_anim')) {
      const animation = a.doc.animations[0];
      const c = animation.channels.find((c) => c.target.path === 'translation'),
        sampler = animation.samplers[c.sampler];
      const values = a.accessor(sampler.output);
      assert.equal(values[0], 0);
      assert.ok(Math.abs(values[values.length - 3] - 70 * 0.0254) < 1e-6);
    }
  });

test('Blender old multiline Key values, Properties60 material and inline geometry import', async () => {
  const { doc } = await convert(await input('blender_279_default_6100_ascii'));
  assert.equal(doc.meshes.length, 1);
  assert.equal(doc.materials[0].name, 'Material');
  assert.equal(doc.animations.length, 1);
});

export const legacyTree = (key = [0, 0, 'L', 46186158000, 2, 'L']) => [
  [
    'Objects',
    [],
    [
      ['Model', ['Model::Parent', 'Null']],
      [
        'Model',
        ['Model::Mesh', 'Mesh'],
        [
          ['Properties60', [], [['Property', ['Lcl Translation', 'Vector3D', '', 1, 2, 3]]]],
          ['Vertices', [0, 0, 0, 1, 0, 0, 0, 1, 0]],
          ['PolygonVertexIndex', [0, 1, -3]],
        ],
      ],
    ],
  ],
  [
    'Connections',
    [],
    [
      ['Connect', ['OO', 'Model::Mesh', 'Model::Parent']],
      ['Connect', ['OO', 'Model::Parent', 'Model::Scene']],
    ],
  ],
  [
    'Takes',
    [],
    [
      [
        'Take',
        ['Take::Move'],
        [
          [
            'Model',
            ['Model::Mesh'],
            [
              [
                'Channel',
                ['Transform'],
                [
                  [
                    'Channel',
                    ['T'],
                    [
                      [
                        'Channel',
                        ['X'],
                        [
                          ['Default', [0]],
                          ['KeyCount', [2]],
                          ['Key', key],
                        ],
                      ],
                    ],
                  ],
                ],
              ],
            ],
          ],
        ],
      ],
    ],
  ],
];
const encode = (tree, version, format) =>
  format === 'binary'
    ? binary(tree, { version })
    : new TextEncoder().encode(ascii(tree).replaceAll('7.4.0', '6.1.0').replace('7400', String(version)));

test('6.x is opt-in, supports both front ends and preserves model hierarchy', async () => {
  for (const version of [6000, 6100, 6900])
    for (const format of ['ascii', 'binary']) {
      const bytes = encode(legacyTree(), version, format);
      await assert.rejects(convertFBX(bytes), /unsupported version/);
      const { doc } = await convert(bytes);
      const parent = doc.nodes.find((n) => n.name === 'Parent'),
        child = doc.nodes.find((n) => n.name === 'Mesh');
      assert.ok(parent.children.includes(doc.nodes.indexOf(child)));
      assert.deepEqual(child.translation, [1, 2, 3]);
      assert.equal(doc.meshes[0].primitives[0].indices !== undefined, true);
    }
});

test('mixed legacy interpolation and weighted user tangents retain their values and refuse malformed streams', async () => {
  for (const key of [
    [0, 0, 'C', 's', 46186158000, 2, 'L'],
    [0, 0, 'U', 'b', 0, 0, 'a', 0.2, 0.4, 46186158000, 2, 'U', 's', 0, 0, 'n'],
    [0, 0, 'T', 0, 0, 0, 46186158000, 2, 'T', 0, 0, 0],
    [0, 0, 'A', 'a', 0, 0, 'n', 46186158000, 2, 'A', 'a', 0, 0, 'n'],
  ])
    for (const format of ['ascii', 'binary']) {
      const { doc, accessor } = await convert(encode(legacyTree(key), 6100, format));
      const a = doc.animations[0],
        c = a.channels.find((c) => c.target.path === 'translation'),
        s = a.samplers[c.sampler],
        v = accessor(s.output);
      assert.equal(v[0], 0);
      assert.equal(v[v.length - 3], 2);
    }
  for (const key of [
    [0, 0, 'L'],
    [0, 0, 'Q', 46186158000, 2, 'L'],
    [0, 0, 'U', 's', 0, 0, 'a', -1, 0.4, 46186158000, 2, 'L'],
  ])
    await assert.rejects(convert(encode(legacyTree(key), 6100, 'ascii')), /legacy/);
});

test('normalization observes abort and cumulative import caps', async () => {
  const bytes = encode(legacyTree(), 6100, 'ascii'),
    controller = new AbortController();
  controller.abort(new Error('stop legacy'));
  await assert.rejects(convertFBX(bytes, { extensions: [legacyFBX], signal: controller.signal }), /stop legacy/);
  await assert.rejects(convertFBX(bytes, { extensions: [legacyFBX, largeFBX({ nodes: 1 })] }), /node budget/);
  const tree = legacyTree();
  tree[1][2].push(['Connect', ['OO', 'Model::Parent', 'Model::Mesh']]);
  await assert.rejects(convert(encode(tree, 6100, 'binary')), /hierarchy cycle/);
});

test('actual parse worker recognizes legacy by name and prepares animated mesh', async () => {
  const prepared = await runParseWorker(new URL('../dist/workers/fbx.js', import.meta.url), {
    input: Uint8Array.from(await input('max2009_cube_anim_6100_binary')).buffer,
    extensions: ['legacy'],
  });
  assert.ok(prepared.doc.nodes.length);
  assert.ok(prepared.doc.animations.length);
});
