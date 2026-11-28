// Scatter `textures` (KB-SCATTER-TEX1): the option checks, the uv vertex layout and the mip chains uploaded for a
// cut-out base colour map. Before the fix `textures` was ignored: no uvs, no maps, one flat colour a mesh.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Geometry, PbrMaterial } from '../../core/dist/index.js';
import { Scatter } from '../dist/index.js';
import { mockGPU } from '../../../examples/package-benchmarks/proofs/gpu-recorder.js';

const card = () =>
  new Geometry([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0], [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1], [0, 1, 2, 0, 2, 3]);
const uvs = [0, 1, 1, 1, 1, 0, 0, 0];
const options = (textures) => ({ count: 4, material: new PbrMaterial({ color: [1, 1, 1] }), textures });
const bytes = (hex) => Uint8Array.from(Buffer.from(hex.split(':').pop(), 'hex'));

test('textures are checked against the meshes and need a material', () => {
  assert.throws(() => new Scatter(card(), { count: 4, textures: { uvs } }), /material/);
  assert.throws(() => new Scatter(card(), options({ uvs: [0, 0, 1, 1] })), /2 coordinates for 4 vertices/);
  assert.throws(() => new Scatter(card(), options({ uvs, alphaCutoff: 2 })), /alphaCutoff/);
  assert.throws(() => new Scatter(card(), options({ uvs, baseColor: 'leaf.png' })), /baseColor/);
  assert.doesNotThrow(() => new Scatter(card(), options({ uvs })));
});

test('a textured scatter uploads 32-byte vertices with uvs and a full mip chain of each map', () => {
  // An 8 x 8 leaf: a quarter of the texels opaque (alpha 255), the rest cut out. Plain box mips of alpha sink below the
  // cut-off and the leaf vanishes with distance (Castano 2010); the scaled chain keeps the share of drawn texels.
  const data = new Uint8Array(8 * 8 * 4);
  for (let i = 0; i < 64; i++) data.set([30, 120, 30, (i % 8) % 2 === 0 && (i >> 3) % 2 === 0 ? 255 : 0], i * 4);
  const gpu = mockGPU(),
    scatter = new Scatter(card(), options({ uvs, baseColor: { width: 8, height: 8, data } })),
    calls = gpu.record(() => scatter.setup({ gpu: gpu.device }));
  const vertexWrites = calls.filter((c) => c[0] === 'writeBuffer' && c[2] === 0);
  assert.ok(
    vertexWrites.some((c) => bytes(c[3]).byteLength === 4 * 32),
    'four vertices of 32 bytes (position, normal, uv)',
  );
  const writes = calls.filter((c) => c[0] === 'writeTexture' && c[1].mipLevel !== undefined);
  assert.deepEqual(
    writes.map((c) => c[1].mipLevel),
    [0, 1, 2, 3, 0, 0],
    '8 x 8 base colour makes 4 levels; the normal and occlusion-roughness-metal defaults one each',
  );
  const baseLevels = writes.slice(0, 4).map((c) => bytes(c[2]));
  const share = (level) => {
    let n = 0;
    for (let i = 3; i < level.length; i += 4) if (level[i] >= 128) n++;
    return n / (level.length / 4);
  };
  assert.equal(share(baseLevels[0]), 0.25);
  // Level 1 is 4 x 4 texels of alpha 64 each: a plain average drops every one under 0.5; the scaled one keeps them.
  for (const level of baseLevels.slice(1)) assert.ok(share(level) >= 0.25, `coverage kept: ${share(level)}`);
});

// Film look 2026-11-28: "Above the Treeline" shades its boulders with terrain's RockSurface, whose patch of core's lit
// fragment opens a block with `var i` copies and writes `i.color`. The textured scatter (the film's firs) then renamed
// every `i.color` to its maps' `let surfColor`, so the patch's write became an assignment to a let and the pipeline
// failed to compile ("cannot assign to 'let surfColor'"). The maps' colour, roughness and metalness are vars now.
test('texturedFragment keeps a mesh patch that writes i.color compiling: the maps declare vars', async () => {
  const { texturedFragment } = await import('../src/maps.ts');
  const normal = 'let n=normalize(i.normal)*select(-1.0,1.0,facing);';
  const code =
    '@fragment fn fragment(i:Input,@builtin(front_facing) facing:bool)->@location(0) vec4f {\n' +
    ` ${normal}let terrainSource=i;let terrainNormal=n;{var i=terrainSource;var n=terrainNormal;` +
    'i.color=i.color*0.5;i.material.x=0.9;return vec4f(i.color*i.material.x,1.0);}}\n';
  const out = texturedFragment(code, 0, normal);
  assert.match(out, /var surfColor=surfBase\.rgb\*i\.color;var surfRough=[^;]+;var surfMetal=[^;]+;/);
  assert.doesNotMatch(out, /let surf(Color|Rough|Metal)=/);
  // The patch's writes land on the maps' values, which the lighting then reads.
  assert.match(out, /surfColor=surfColor\*0\.5;surfRough=0\.9;return vec4f\(surfColor\*surfRough,1\.0\);/);
});
