// Malformed JPEG 2000 inputs for the fuzz run, the same on every machine: headers built to ask for far too much, every
// kind of cut, and structure-aware mutations of the OpenJPEG vectors (marker segment lengths and fields set to their
// extremes, segments dropped, repeated and exchanged, bytes flipped). Method after V. J. M. Manes et al., "The Art,
// Science, and Engineering of Fuzzing: A Survey" (IEEE TSE 2019, https://arxiv.org/abs/1812.00140) and V.-T. Pham et
// al., "Smart Greybox Fuzzing" (IEEE TSE 2019, https://arxiv.org/abs/1811.09447): mutate the file's chunks, not only
// its bytes, so that damaged input still reaches the code behind the header checks.
import { readFileSync } from 'node:fs';
import { be, box, codestream, jp2, jp2Opening, segment } from './jpeg2000-streams.js';

const folder = new URL('../fixtures/jpeg2000/', import.meta.url);

/** The vectors the OpenJPEG library encoded: real packet data for the mutations to damage. */
export const vectors = () =>
  JSON.parse(readFileSync(new URL('vectors.json', folder))).vectors.map((vector) => ({
    ...vector,
    bytes: new Uint8Array(readFileSync(new URL(vector.file, folder))),
  }));

/** SIZ: the image and tile sizes, then per component [Ssiz, XRsiz, YRsiz]. */
const siz = ({ width, height, tileWidth = width, tileHeight = height, components = [[7, 1, 1]] }) =>
  segment(0xff51, [
    ...[0, 0],
    ...[width, height, 0, 0, tileWidth, tileHeight, 0, 0].flatMap((v) => be(v, 4)),
    ...be(components.length, 2),
    ...components.flat(),
  ]);
const cod = ({ order = 0, layers = 1, mct = 0, levels = 0, blocks = [4, 4], style = 0, precincts } = {}) =>
  segment(0xff52, [precincts ? 1 : 0, order, ...be(layers, 2), mct, levels, ...blocks, style, 1, ...(precincts ?? [])]);
const qcd = (levels = 0, guard = 1, exponent = 8) =>
  segment(0xff5c, [guard << 5, ...new Array(3 * levels + 1).fill(exponent << 3)]);
const tilePart = (tile, body, header = []) =>
  segment(0xff90, [...be(tile, 2), ...be(14 + header.length + body.length, 4), 0, 1]).concat(
    header,
    be(0xff93, 2),
    body,
  );
const build = (head, parts = [tilePart(0, [0])]) =>
  Uint8Array.from([0xff, 0x4f, ...head.flat(), ...parts.flat(), 0xff, 0xd9]);

/** Headers that ask for far more work or memory than their bytes can carry. */
function* hostile() {
  const huge = 0xffffffff;
  yield [
    '4G x 4G in 1 x 1 tiles',
    build([siz({ width: huge, height: huge, tileWidth: 1, tileHeight: 1 }), cod(), qcd()]),
  ];
  yield ['4G x 4G in one tile', build([siz({ width: huge, height: huge }), cod(), qcd()])];
  yield ['4G x 1', build([siz({ width: huge, height: 1 }), cod(), qcd()])];
  const many = Array.from({ length: 16384 }, () => [7, 255, 255]);
  const grid = siz({ width: 255, height: 255, tileWidth: 1, tileHeight: 1, components: many });
  yield ['65,025 tiles of 16,384 components', build([grid, cod(), qcd()])];
  yield ['16,384 components', build([siz({ width: 8, height: 8, components: many }), cod(), qcd()])];
  const square = siz({ width: 1024, height: 1024 });
  yield ['a precinct for every sample', build([square, cod({ layers: 65535, precincts: [0] }), qcd()])];
  // 65,535 layers whose packets each read one tag tree bit over 65,536 code-blocks.
  yield [
    '65,535 layers over 65,536 code-blocks',
    build([square, cod({ layers: 65535, blocks: [0, 0] }), qcd()], [tilePart(0, new Array(65535).fill(0x80))]),
  ];
  // The same precincts ordered again by thousands of progression changes.
  for (const order of [0, 2]) {
    const change = [0, 0, ...be(65535, 2), 1, 1, order];
    const changes = segment(0xff5f, Array.from({ length: 9000 }, () => change).flat());
    yield [
      `9,000 progression changes of order ${order}`,
      build([square, cod({ layers: 65535, precincts: [0x22] }), qcd(), changes]),
    ];
  }
  yield [
    'many layers of many precincts without data',
    build([square, cod({ layers: 65535, precincts: [0x11] }), qcd()], [tilePart(0, [])]),
  ];
  yield [
    '65,535 empty tiles with a COC each',
    build(
      [siz({ width: 65535, height: 1, tileWidth: 1, tileHeight: 1 }), cod(), qcd()],
      Array.from({ length: 65535 }, (_, t) => tilePart(t, [], segment(0xff53, [0, 0, 0, 4, 4, 0, 1]))),
    ),
  ];
  yield ['32 levels on one sample', build([siz({ width: 1, height: 1 }), cod({ levels: 32 }), qcd(32)])];
  // A block with passes under a region-of-interest shift of 255 planes.
  for (const shift of [31, 32, 255])
    for (const zeroBits of [1, shift + 8, shift + 9])
      yield [
        `RGN ${shift}, ${zeroBits} zero plane bits`,
        build(
          [siz({ width: 4, height: 4 }), cod(), qcd(), segment(0xff5e, [0, 0, shift])],
          [tilePart(0, packet(zeroBits))],
        ),
      ];
  const full = Array.from({ length: 4000 }, (_, i) => (i * 73 + 41) & 127);
  for (const reversible of [1, 0])
    yield [
      `31 bit-planes of noise, ${reversible ? '5-3' : '9-7'} and the component transform`,
      build(
        [
          siz({ width: 16, height: 16, components: new Array(3).fill([37, 1, 1]) }),
          segment(0xff52, [0, 0, 0, 1, 1, 4, 4, 4, 0, reversible]),
          segment(0xff5c, [0xe0 | (reversible ? 0 : 2), ...new Array(reversible ? 13 : 26).fill(25 << 3)]),
        ],
        [tilePart(0, full)],
      ),
    ];
  const grey = codestream(8, 8);
  const xl = [...be(1, 4), ...[...'free'].map((c) => c.charCodeAt(0)), 255, 255, 255, 255, 255, 255, 255, 255];
  yield ['a box of 2^64 - 1 bytes', Uint8Array.from([...jp2Opening(), ...xl, 0, 0])];
  yield ['a header box of 2^64 - 1 bytes', jp2(grey, 8, 8, [...xl, 0, 0])];
  const palette = box('pclr', [0, 1, 1, 7, 9]);
  const mapping = box('cmap', new Array(16000).fill([0, 0, 0, 0]).flat());
  yield ['16,000 mapped channels', jp2(codestream(1024, 1024), 1024, 1024, [...palette, ...mapping])];
  const wide = Array.from({ length: 4096 }, (_, i) => (i ? [7, 255, 255] : [7, 1, 1]));
  yield [
    '4,096 planes resampled to the largest',
    build([siz({ width: 1000, height: 1000, components: wide }), cod(), qcd()]),
  ];
  const empty = new Array(2).fill([7, 255, 255]);
  yield [
    'components that hold no samples',
    build([
      segment(0xff51, [0, 0, ...[3, 3, 2, 2, 1, 1, 2, 2].flatMap((v) => be(v, 4)), 0, 2, ...empty.flat()]),
      cod(),
      qcd(),
    ]),
  ];
}

/** One packet that includes the only block with `zeroBits` leading zero bit-planes, one pass and no bytes. */
function packet(zeroBits) {
  // Non-empty, included at layer 0, zero planes (zeros then a one), one pass, Lblock unchanged, length 0 in 3 bits.
  const bits = [1, 1, ...new Array(zeroBits).fill(0), 1, 0, 0, 0, 0, 0];
  const out = [];
  for (let at = 0; at < bits.length; at += 8)
    out.push(Array.from({ length: 8 }, (_, i) => bits[at + i] ?? 0).reduce((v, bit) => (v << 1) | bit, 0));
  return out;
}

/** The marker segments of a codestream's headers as [start, end), found by walking their lengths. */
function segments(bytes) {
  const start = bytes.findIndex((v, i) => v === 0xff && bytes[i + 1] === 0x4f);
  const found = [];
  let at = start + 2;
  while (start >= 0 && at + 4 <= bytes.length && bytes[at] === 0xff) {
    if (bytes[at + 1] === 0x93) break;
    const end = at + 2 + ((bytes[at + 2] << 8) | bytes[at + 3]);
    if (end > bytes.length) break;
    found.push([at, end]);
    at = end;
  }
  return found;
}

/** mulberry32: a small seeded generator, so a failing case has the same bytes on every run. */
function random(seed) {
  let state = seed >>> 0;
  return (limit) => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), state | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return Math.floor((((t ^ (t >>> 14)) >>> 0) / 2 ** 32) * limit);
  };
}

const EXTREMES = [0, 1, 2, 3, 4, 7, 15, 31, 32, 33, 64, 127, 128, 254, 255];
const MARKERS = [0x51, 0x52, 0x53, 0x5c, 0x5d, 0x5e, 0x5f, 0x60, 0x61, 0x90, 0x91, 0x92, 0x93, 0xd9];

function mutate(bytes, other, next) {
  let data = [...bytes];
  const changes = 1 + next(4);
  for (let n = 0; n < changes; n++) {
    const found = segments(data);
    const kind = next(9);
    if (kind === 0) data[next(data.length)] ^= 1 << next(8);
    else if (kind === 1) data[next(data.length)] = EXTREMES[next(EXTREMES.length)];
    else if (kind < 5 && found.length) {
      // A field of one segment, 1, 2 or 4 bytes wide, set to an extreme; its length field now and then.
      const [at, end] = found[next(found.length)];
      const from = kind === 4 && next(3) === 0 ? at + 2 : at + 4 + next(Math.max(1, end - at - 4));
      const width = [1, 1, 2, 4][next(4)];
      const value = EXTREMES[next(EXTREMES.length)];
      const fill = next(2) ? 255 : 0;
      for (let i = 0; i < width && from + i < data.length; i++) data[from + i] = i === width - 1 ? value : fill;
    } else if (kind === 5 && found.length) {
      const [at, end] = found[next(found.length)];
      if (next(2)) data.splice(at, end - at);
      else data.splice(at, 0, ...data.slice(at, end));
    } else if (kind === 6 && found.length) {
      // A segment of another vector, or a new one with short random contents.
      const [at] = found[next(found.length)];
      const donor = segments(other);
      const [from, to] = donor[next(donor.length)] ?? [0, 0];
      const added = next(2)
        ? [...other.slice(from, to)]
        : segment(
            0xff00 | MARKERS[next(MARKERS.length)],
            Array.from({ length: next(12) }, () => (next(2) ? EXTREMES[next(EXTREMES.length)] : next(256))),
          );
      data.splice(at, 0, ...added);
    } else if (kind === 7) data.length = 1 + next(data.length);
    else {
      const at = next(data.length);
      const length = 1 + next(64);
      for (let i = at; i < Math.min(data.length, at + length); i++) data[i] = next(256);
    }
    if (!data.length) data = [0];
  }
  return Uint8Array.from(data);
}

/**
 * Every case in order: `{ name, bytes, options }`. `mutations` is the number of random mutations; `skip` cases are
 * passed over without being built.
 */
export function* fuzzCases({ mutations, skip = 0, seed = 1 }) {
  let index = 0;
  const wanted = () => index++ >= skip;
  for (const [name, bytes] of hostile()) if (wanted()) yield { name, bytes, options: {} };
  const seeds = vectors();
  // Every cut through the headers, then cuts through the packet data.
  for (const { file, bytes } of seeds)
    for (let length = 1; length < bytes.length; length += length < 200 ? 1 : 97)
      if (wanted()) yield { name: `${file} cut to ${length} bytes`, bytes: bytes.subarray(0, length), options: {} };
  for (let i = 0; i < mutations; i++) {
    if (!wanted()) continue;
    const next = random(seed * 1000003 + i);
    const base = seeds[next(seeds.length)];
    yield {
      name: `mutation ${i} of seed ${seed} (${base.file})`,
      bytes: mutate(base.bytes, seeds[next(seeds.length)].bytes, next),
      options: { reduce: next(8) ? 0 : next(4), layers: next(4) ? 0 : 1 + next(3), depth: next(4) ? 8 : 16 },
    };
  }
}
