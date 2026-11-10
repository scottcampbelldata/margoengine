// Independent format writers for structural tests, from the ISO and EBML specifications.
export const cat = (...parts) => Uint8Array.from(parts.flatMap((p) => Array.from(p)));
const u32 = (n) => {
  const a = new Uint8Array(4);
  new DataView(a.buffer).setUint32(0, n);
  return a;
};
const text = (s) => new TextEncoder().encode(s);
const box = (s, ...parts) => {
  const data = cat(...parts);
  return cat(u32(data.length + 8), text(s), data);
};
const full = (s, ...parts) => box(s, u32(0), ...parts);

export function fragmentFixture({
  samples,
  description = [1, 66, 0, 30, 255, 225, 0],
  scale = 1000,
  defaults = false,
  signed = true,
  edit = false,
} = {}) {
  samples ??= [0, 1, 2, 3, 4].map((id) => ({
    data: new Uint8Array([id]),
    pts: [0, 300, 100, 200, 400][id],
    dts: id * 100,
    duration: 100,
    key: id === 0 || id === 4,
  }));
  const visual = new Uint8Array(78);
  visual[7] = 1;
  const init = box(
    'moov',
    full('mvhd', u32(0), u32(0), u32(scale), u32(0)),
    box(
      'trak',
      full('tkhd', u32(0), u32(0), u32(1)),
      // A number is the edit's media time in track ticks (an encoder's B-frame shift); true means 0.
      ...(edit !== false ? [box('edts', full('elst', u32(1), u32(0), u32(edit === true ? 0 : edit), u32(65536)))] : []),
      box(
        'mdia',
        full('mdhd', u32(0), u32(0), u32(scale), u32(0)),
        full('hdlr', u32(0), text('vide')),
        box(
          'minf',
          box('dinf', full('dref', u32(1), box('url ', u32(1)))),
          box('stbl', full('stsd', u32(1), box('avc1', visual, box('avcC', new Uint8Array(description))))),
        ),
      ),
    ),
    box('mvex', full('trex', u32(1), u32(1), u32(defaults ? 100 : 0), u32(defaults ? 1 : 0), u32(0x10000))),
  );
  const fragments = [];
  for (let start = 0; start < samples.length; ) {
    let end = start + 1;
    while (end < samples.length && !samples[end].key) end++;
    const selected = samples.slice(start, end),
      flags = (signed ? 0x1000000 : 0) | 0x801 | (defaults ? 4 : 0x700);
    const make = (offset) =>
      box(
        'moof',
        full('mfhd', u32(fragments.length + 1)),
        box(
          'traf',
          box('tfhd', u32(0x20000), u32(1)),
          box('tfdt', u32(0x1000000), u32(0), u32(selected[0].dts)),
          box(
            'trun',
            u32(flags),
            u32(selected.length),
            u32(offset),
            ...(defaults ? [u32(0)] : []),
            ...selected.flatMap((s) => [
              ...(defaults ? [] : [u32(s.duration), u32(s.data.length), u32(s.key ? 0 : 0x10000)]),
              u32(s.pts - s.dts),
            ]),
          ),
        ),
      );
    const moof = make(make(0).length + 8);
    fragments.push(cat(moof, box('mdat', ...selected.map((s) => s.data))));
    start = end;
  }
  return cat(init, ...fragments).buffer;
}

const id = (n) => {
  const hex = n.toString(16).padStart(Math.ceil(n.toString(16).length / 2) * 2, '0');
  return Uint8Array.from(hex.match(/../g).map((s) => parseInt(s, 16)));
};
const vint = (n) => {
  let width = 1;
  while (n >= 2 ** (7 * width) - 1) width++;
  const a = new Uint8Array(width);
  for (let i = width - 1; i >= 0; i--) {
    a[i] = n % 256;
    n = Math.floor(n / 256);
  }
  a[0] |= 1 << (8 - width);
  return a;
};
const elem = (n, ...data) => {
  const b = cat(...data);
  return cat(id(n), vint(b.length), b);
};
const uint = (n, value) => elem(n, id(value));
export function webmFixture({
  lacing = 0,
  unknown = false,
  blockGroup = false,
  codec = 'V_VP8',
  malformed = false,
  lastDuration,
} = {}) {
  const header = elem(0x1a45dfa3, elem(0x4282, text('webm'))),
    info = elem(0x1549a966, uint(0x2ad7b1, 1000000)),
    track = elem(
      0x1654ae6b,
      elem(
        0xae,
        uint(0xd7, 1),
        uint(0x83, 1),
        elem(0x86, text(codec)),
        uint(0x23e383, 100000000),
        elem(0xe0, uint(0xb0, 2), uint(0xba, 2)),
      ),
    );
  const block = (timestamp, values) =>
    cat(
      vint(1),
      new Uint8Array([timestamp >>> 8, timestamp & 255, (blockGroup ? 0 : 128) | (lacing * 2)]),
      ...(lacing
        ? [
            new Uint8Array([values.length - 1]),
            ...(lacing === 1
              ? [new Uint8Array(values.slice(0, -1).map(() => (malformed ? 255 : 1)))]
              : lacing === 3
                ? [vint(1), ...values.slice(1, -1).map(() => vint(63))]
                : []),
          ]
        : []),
      new Uint8Array(values),
    );
  const content = cat(
    uint(0xe7, 0),
    ...(lacing
      ? [blockGroup ? elem(0xa0, elem(0xa1, block(0, [10, 11, 12]))) : elem(0xa3, block(0, [10, 11, 12]))]
      : [0, 100, 200].map((t, i) =>
          blockGroup
            ? elem(0xa0, elem(0xa1, block(t, [10 + i])), ...(i === 2 && lastDuration ? [uint(0x9b, lastDuration)] : []))
            : elem(0xa3, block(t, [10 + i])),
        )),
  );
  const cluster = unknown ? cat(id(0x1f43b675), new Uint8Array([255]), content) : elem(0x1f43b675, content),
    segment = unknown
      ? cat(id(0x18538067), new Uint8Array([255]), info, track, cluster, elem(0x1c53bb6b))
      : elem(0x18538067, info, track, cluster);
  return cat(header, segment).buffer;
}
