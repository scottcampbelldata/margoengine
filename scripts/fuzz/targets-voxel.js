// Fuzz targets for @margoengine/voxel's codecs (design phase 8): chunk bytes (raw and deflated), block-change lists
// and entity deltas against a baseline. Seeds are the codecs' own output across index widths, light kinds and
// compression. Besides the harness oracle, each decoded result is encoded again and must decode to the same thing.
let V, C;
const load = async () => {
  V ??= await import('@margoengine/voxel');
  C ??= await import('@margoengine/voxel/codec');
};
const cell = (i) => [i & 31, i >> 10, (i >> 5) & 31];
const equal = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const schema = { p: 'position', r: 'rotation', h: 'u8', s: 'u16', f: 'f32' };
const angle = (p, q) => 2 * Math.acos(Math.min(1, Math.abs(p[0] * q[0] + p[1] * q[1] + p[2] * q[2] + p[3] * q[3])));
let baseline;

export default [
  {
    name: 'voxel/chunk',
    setup: load,
    async seeds() {
      const sparse = new V.VoxelChunk(),
        mixed = new V.VoxelChunk(),
        wide = new V.VoxelChunk();
      for (let i = 0; i < 40; i++) sparse.set(...cell(i * 811), 2);
      for (let i = 0; i < 32768; i++) {
        mixed.set(...cell(i), (i * 7919) % 13);
        mixed.setLight(...cell(i), i % 251);
        wide.set(...cell(i), (i * 2654435761) % 600);
      }
      return [
        await C.encodeChunk(new V.VoxelChunk(), { compress: false }),
        await C.encodeChunk(sparse, { compress: false }),
        await C.encodeChunk(sparse),
        await C.encodeChunk(mixed, { compress: false }),
        await C.encodeChunk(mixed),
        await C.encodeChunk(wide, { light: false }),
      ];
    },
    async run(bytes) {
      const chunk = await C.decodeChunk(bytes),
        again = await C.decodeChunk(await C.encodeChunk(chunk, { compress: false })),
        [a, b] = [chunk.pack(), again.pack()];
      if (a.bits !== b.bits || !equal(a.palette, b.palette) || !equal(a.words, b.words))
        throw new Error('GARBAGE: a decoded chunk changes when encoded again');
      if (typeof a.light === 'number' ? a.light !== b.light : !equal(a.light, b.light))
        throw new Error('GARBAGE: decoded light changes when encoded again');
    },
  },
  {
    name: 'voxel/changes',
    setup: load,
    seeds() {
      const list = [];
      for (let i = 0; i < 400; i++) list.push(((i * 37) % 200) - 100, (i * 13) % 90, -((i * 101) % 300), i * 977);
      return [C.encodeBlockChanges(list), C.encodeBlockChanges([0, 0, 0, 1, -1, -1, -1, 0x80000000])];
    },
    run(bytes) {
      const changes = C.decodeBlockChanges(bytes);
      if (!equal(C.decodeBlockChanges(C.encodeBlockChanges(changes)), changes))
        throw new Error('GARBAGE: decoded block changes change when encoded again');
    },
  },
  {
    name: 'voxel/entities',
    setup: load,
    seeds() {
      const codec = new C.EntityCodec(schema),
        raw = new Map(),
        later = new Map();
      for (let id = 0; id < 40; id++) {
        const t = id / 7;
        raw.set(id * 5, { p: [t * 100, t, -t * 50], r: [Math.sin(t), 0, 0, Math.cos(t)], h: id, s: id * 999, f: t });
        if (id % 3) later.set(id * 5, { ...raw.get(id * 5), p: [t, t, t], h: 255 - id });
      }
      baseline = codec.decode(codec.encode(raw)); // the receiver's (quantized) copy
      return [codec.encode(raw), codec.encode(later, baseline), codec.encode(new Map(), baseline)];
    },
    run(bytes) {
      const codec = new C.EntityCodec(schema),
        state = codec.decode(bytes, baseline),
        again = codec.decode(codec.encode(state, baseline), baseline);
      if (state.size !== again.size) throw new Error('GARBAGE: decoded entities change when encoded again');
      for (const [id, e] of state) {
        const o = again.get(id);
        // A damaged rotation word may re-encode as another word: two smallest-three steps apart at most.
        if (!o || !equal(e.p, o.p) || e.h !== o.h || e.s !== o.s || e.f !== o.f || angle(e.r, o.r) > 0.01)
          throw new Error(`GARBAGE: decoded entity ${id} changes when encoded again`);
        if (![...e.p, ...e.r, e.f].every(Number.isFinite)) throw new Error(`GARBAGE: entity ${id} decoded non-finite`);
      }
    },
  },
];
