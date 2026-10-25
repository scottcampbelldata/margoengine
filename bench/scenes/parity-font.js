// The TrueType font of the p-text parity scene (row 4.6, TextGeometry and TTF loading), generated from the OpenType
// table layouts so no font file is read or committed. Glyphs: .notdef, space and A-Z. Each letter is a quadratic ring
// (a rounder or squarer outer contour with a hole, more points for later letters) plus one straight bar, so parsing
// and triangulating it is real work. It has the tables a general TTF reader expects (head, hhea, maxp, hmtx, loca, glyf,
// cmap 4, name, post 3, OS/2 0).

const be = () => {
  const bytes = [];
  const w = {
    bytes,
    u8: (v) => (bytes.push(v & 255), w),
    u16: (v) => w.u8(v >> 8).u8(v),
    i16: (v) => w.u16(v < 0 ? v + 65536 : v),
    u32: (v) => w.u16(Math.floor(v / 65536)).u16(v & 0xffff),
    tag: (s) => ([...s].forEach((c) => w.u8(c.charCodeAt(0))), w),
    pad: (n) => {
      while (bytes.length < n) bytes.push(0);
      return w;
    },
    out: () => Uint8Array.from(bytes),
  };
  return w;
};

/** One glyph from contours of [x, y, onCurve], every coordinate stored as a 16-bit delta (flags 0 or 1). */
function glyph(contours) {
  const pts = contours.flat(),
    xs = pts.map((p) => p[0]),
    ys = pts.map((p) => p[1]),
    w = be()
      .i16(contours.length)
      .i16(Math.min(...xs))
      .i16(Math.min(...ys))
      .i16(Math.max(...xs))
      .i16(Math.max(...ys));
  let last = -1;
  for (const c of contours) w.u16((last += c.length));
  w.u16(0);
  for (const p of pts) w.u8(p[2] ? 1 : 0);
  let x = 0,
    y = 0;
  for (const p of pts) w.i16(p[0] - x), (x = p[0]);
  for (const p of pts) w.i16(p[1] - y), (y = p[1]);
  return w.out();
}

/** Letter k (0-25): a ring of 8 + 2k points alternating on and off the curve, its hole reversed, and a bar. */
function letter(k) {
  const n = 8 + 2 * k,
    ring = (rx, ry, cx, cy, reverse) => {
      const c = Array.from({ length: n }, (_, i) => {
        const a = (i / n) * Math.PI * 2 * (reverse ? 1 : -1),
          r = i % 2 ? 1.15 + 0.1 * Math.sin(k + i) : 1;
        return [Math.round(cx + Math.cos(a) * rx * r), Math.round(cy + Math.sin(a) * ry * r), i % 2 ? 0 : 1];
      });
      return c;
    },
    bar = [
      [60, 330, 1],
      [60, 370, 1],
      [540, 370, 1],
      [540, 330, 1],
    ];
  return glyph([ring(250, 330, 300, 350, false), ring(140, 210, 300, 350, true), bar]);
}

/** The font bytes (about 10 KB). */
export function benchFont() {
  const glyphs = [
    glyph([
      [
        [50, 0, 1],
        [50, 700, 1],
        [450, 700, 1],
        [450, 0, 1],
      ],
    ]),
    new Uint8Array(0),
  ];
  for (let k = 0; k < 26; k++) glyphs.push(letter(k));
  const count = glyphs.length,
    glyf = be(),
    loca = be();
  for (const g of glyphs) {
    loca.u32(glyf.bytes.length);
    glyf.bytes.push(...g);
    while (glyf.bytes.length % 4) glyf.u8(0);
  }
  loca.u32(glyf.bytes.length);
  const head = be().u32(0x10000).u32(0x10000).u32(0).u32(0x5f0f3cf5).u16(0x000b).u16(1000).pad(36);
  head.i16(0).i16(-200).i16(650).i16(1050).u16(0).u16(8).i16(2).i16(1).i16(0);
  const hhea = be()
    .u32(0x10000)
    .i16(800)
    .i16(-200)
    .i16(100)
    .u16(650)
    .i16(0)
    .i16(0)
    .i16(650)
    .i16(1)
    .i16(0)
    .i16(0)
    .pad(34);
  hhea.u16(count);
  const hmtx = be();
  for (let i = 0; i < count; i++) hmtx.u16(i === 1 ? 250 : 650).i16(i === 1 ? 0 : 20);
  // cmap format 4: space -> 1, A-Z -> 2-27 by delta, then the terminator.
  const segs = [
      [32, 32, (1 - 32) & 0xffff],
      [65, 90, (2 - 65) & 0xffff],
      [0xffff, 0xffff, 1],
    ],
    sub = be()
      .u16(4)
      .u16(0)
      .u16(0)
      .u16(segs.length * 2)
      .u16(4)
      .u16(1)
      .u16(2);
  for (const s of segs) sub.u16(s[1]);
  sub.u16(0);
  for (const s of segs) sub.u16(s[0]);
  for (const s of segs) sub.u16(s[2]);
  for (const _ of segs) sub.u16(0);
  sub.bytes[3] = sub.bytes.length & 255;
  sub.bytes[2] = sub.bytes.length >> 8;
  const cmap = be().u16(0).u16(1).u16(3).u16(1).u32(12);
  cmap.bytes.push(...sub.bytes);
  const strings = ['Margo Bench', 'Regular'].map((s) => [...s].flatMap((c) => [0, c.charCodeAt(0)])),
    name = be()
      .u16(0)
      .u16(strings.length)
      .u16(6 + strings.length * 12);
  let at = 0;
  strings.forEach((s, i) => {
    name
      .u16(3)
      .u16(1)
      .u16(0x409)
      .u16(i + 1)
      .u16(s.length)
      .u16(at);
    at += s.length;
  });
  for (const s of strings) name.bytes.push(...s);
  const post = be().u32(0x30000).u32(0).i16(-100).i16(50).u32(0).u32(0).u32(0).u32(0).u32(0),
    os2 = be().u16(0).i16(550).u16(400).u16(5).u16(0).pad(68);
  os2.u16(0).u16(32).u16(90).i16(800).i16(-200).i16(0).u16(1050).u16(200);
  const tables = {
    'OS/2': os2.out(),
    cmap: cmap.out(),
    glyf: glyf.out(),
    head: head.out(),
    hhea: hhea.out(),
    hmtx: hmtx.out(),
    loca: loca.out(),
    maxp: be().u32(0x5000).u16(count).out(),
    name: name.out(),
    post: post.out(),
  };
  const tags = Object.keys(tables).sort(),
    dir = be()
      .u32(0x10000)
      .u16(tags.length)
      .u16(128)
      .u16(3)
      .u16(tags.length * 16 - 128);
  let offset = 12 + tags.length * 16;
  const placed = [];
  for (const tag of tags) {
    const data = tables[tag];
    let sum = 0;
    for (let i = 0; i < data.length; i += 4)
      sum =
        (sum + ((data[i] << 24) | ((data[i + 1] ?? 0) << 16) | ((data[i + 2] ?? 0) << 8) | (data[i + 3] ?? 0))) >>> 0;
    dir.tag(tag).u32(sum).u32(offset).u32(data.length);
    placed.push([offset, data]);
    offset += Math.ceil(data.length / 4) * 4;
  }
  const out = new Uint8Array(offset);
  out.set(dir.out());
  for (const [o, d] of placed) out.set(d, o);
  return out;
}
