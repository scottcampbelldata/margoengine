// Fuzz target for @margoengine/voxel/vox (MagicaVoxel .vox): parseVox on hostile bytes. Seeds are files writeVox
// builds (version 150 with PACK, version 200 with every decoded chunk and kept unknown ones); generators add deep
// node chains and wide groups. Besides the harness oracle: a parsed scene must write (writeVox never rejects what
// parseVox returned), the written file must reach a fixed point (write(parse(write(s))) === write(s)), a parse of
// the same bytes inside a larger buffer must agree, and pasting it into a world may only fail on the world's bounds.

const scene200 = () => ({
  version: 200,
  models: [
    { size: [4, 5, 6], voxels: Uint8Array.of(0, 0, 0, 1, 3, 4, 5, 255, 1, 2, 3, 9) },
    { size: [1, 1, 1], voxels: Uint8Array.of(0, 0, 0, 2) },
  ],
  palette: Uint8Array.from({ length: 1024 }, (_, i) => i * 13),
  materials: [
    { id: 1, type: 'metal', weight: 0.5, rough: 0.2, ior: 1.5, flux: 2 },
    { id: 2, type: 'glass', weight: 1, attributes: new Map([['_trans', '0.4']]) },
  ],
  layers: [
    { id: 0, name: 'base' },
    { id: 1, name: 'off', hidden: true },
  ],
  nodes: [
    { id: 0, type: 'transform', child: 1, layer: -1, frames: [{}], name: 'root' },
    { id: 1, type: 'group', children: [2, 4] },
    {
      id: 2,
      type: 'transform',
      child: 3,
      layer: 0,
      frames: [
        { rotation: [0, 1, 0, 0, 0, -1, -1, 0, 0], translation: [3, -4, 5] },
        { translation: [1, 1, 1], frame: 7 },
      ],
    },
    { id: 3, type: 'shape', models: [{ model: 0 }, { model: 1, frame: 7 }] },
    { id: 4, type: 'transform', child: 5, layer: 1, frames: [{ rotation: [-1, 0, 0, 0, 1, 0, 0, 0, 1] }] },
    { id: 5, type: 'shape', models: [{ model: 1 }] },
  ],
  chunks: [
    ...['SIZE', 'SIZE', 'nTRN', 'nGRP', 'nTRN', 'nSHP', 'nTRN', 'nSHP', 'LAYR', 'LAYR', 'RGBA'].map((id) => ({ id })),
    { id: 'rOBJ', content: Uint8Array.of(1, 0, 0, 0, 2, 0, 0, 0, 95, 120, 1, 0, 0, 0, 49) },
    { id: 'MATL' },
    { id: 'MATL' },
    { id: 'ZZZZ', content: Uint8Array.of(1, 2, 3), children: Uint8Array.of(78, 79, 84, 69, 0, 0, 0, 0, 0, 0, 0, 0) },
  ],
});
const scene150 = () => ({
  version: 150,
  models: [
    { size: [2, 2, 2], voxels: Uint8Array.of(0, 0, 0, 1, 1, 1, 1, 2) },
    { size: [3, 1, 2], voxels: Uint8Array.of(2, 0, 1, 3) },
  ],
  palette: new Uint8Array(1024).fill(200),
  materials: [],
  layers: [],
  nodes: [],
  chunks: [{ id: 'PACK' }, { id: 'SIZE' }, { id: 'SIZE' }, { id: 'RGBA' }, { id: 'MATT', content: new Uint8Array(16) }],
});

export default [
  {
    name: 'voxel/vox',
    description:
      'voxel parseVox: chunk tree, SIZE/XYZI, RGBA, MATL, nTRN/nGRP/nSHP, LAYR, kept chunks; writeVox round trip',
    // Each input is parsed and written twice or three times (and maybe pasted): a 20,000-node chain takes about 1 s.
    timeMs: 4000,
    async setup() {
      this.V = await import('@margoengine/voxel/vox');
      this.W = await import('@margoengine/voxel');
    },
    seeds() {
      return [this.V.writeVox(scene200()), this.V.writeVox(scene150())];
    },
    generators: [
      // A transform/group chain thousands deep: graph checks and the paste walk must stay linear and iterative.
      function deepChain(r) {
        const depth = r.pick([100, 2000, 20000]),
          nodes = [];
        for (let i = 0; i < depth; i++) {
          nodes.push({
            id: 2 * i,
            type: 'transform',
            child: 2 * i + 1,
            layer: -1,
            frames: [{ translation: [1, 0, 0] }],
          });
          nodes.push(
            i === depth - 1
              ? { id: 2 * i + 1, type: 'shape', models: [{ model: 0 }] }
              : { id: 2 * i + 1, type: 'group', children: [2 * i + 2] },
          );
        }
        return this.V.writeVox({ ...scene200(), nodes, layers: [], chunks: undefined });
      },
      // One group with many children, each a transform over a shape.
      function wideGroup(r) {
        const width = r.pick([10, 2000]),
          nodes = [{ id: 0, type: 'group', children: [] }];
        for (let i = 0; i < width; i++) {
          nodes[0].children.push(1 + 2 * i);
          nodes.push({
            id: 1 + 2 * i,
            type: 'transform',
            child: 2 + 2 * i,
            layer: 0,
            frames: [{ translation: [i, 0, 0] }],
          });
          nodes.push({ id: 2 + 2 * i, type: 'shape', models: [{ model: i % 2 }] });
        }
        return this.V.writeVox({ ...scene200(), nodes, chunks: undefined });
      },
    ],
    generatorRate: 0.1,
    run(bytes) {
      const { parseVox, writeVox, pasteVoxModel } = this.V,
        scene = parseVox(bytes);
      let once;
      try {
        once = writeVox(scene);
      } catch (error) {
        throw new Error(`GARBAGE: writeVox rejected what parseVox returned: ${error.message}`);
      }
      const twice = writeVox(parseVox(once));
      if (!Buffer.from(once).equals(Buffer.from(twice))) throw new Error('GARBAGE: write(parse(write(s))) differs');
      const h = bytes.reduce((a, b) => Math.imul(a ^ b, 16777619), 2166136261) >>> 0;
      if (h % 4 === 0) {
        const wide = new Uint8Array(bytes.length + 11);
        wide.set(bytes, 7);
        if (!Buffer.from(writeVox(parseVox(wide.subarray(7, 7 + bytes.length)))).equals(Buffer.from(once)))
          throw new Error('GARBAGE: the result changes with the bytes around the input');
      }
      if (h % 4 === 1) {
        const blocks = new this.W.BlockTypes();
        blocks.define('a');
        try {
          pasteVoxModel(new this.W.VoxelWorld({ blocks }), scene, [0, 0, 0], new Uint32Array(256).fill(1));
        } catch (error) {
          if (!(error instanceof RangeError && /^Vox paste box/.test(error.message)))
            throw new Error(`GARBAGE: pasting a parsed scene failed: ${error.message}`);
        }
      }
    },
  },
];
