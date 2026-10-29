/**
 * A tiny colour font built in memory for the emoji checks, so they never depend on the machine's fonts (a headless
 * Linux server has no colour emoji font). Written clean room from the OpenType specification
 * (https://learn.microsoft.com/typography/opentype/spec/).
 *
 * TrueType outlines, 1000 units per em, five glyphs: 0 .notdef (empty), 1 and 2 the base glyphs for U+1F600 and
 * U+1F680, 3 an outer square (100..900 x 0..800), 4 an inner square (300..700 x 200..600).
 *
 * Tables: head, hhea, hmtx, maxp, OS/2 (version 4), name (format 0), post (format 3), cmap (3/1 format 4 with only
 * the 0xFFFF end segment, 3/10 format 12 with the two emoji), glyf and loca (long offsets), COLR version 0 and
 * CPAL version 0. COLR draws U+1F600 as one yellow square (palette entry 0) and U+1F680 as a green square
 * (palette entry 1) with a yellow square inside it. Both colours are flat, so a check can tell this font's pixels
 * from any system emoji font's.
 */

/** Family name the font registers under. */
export const COLOR_FONT_FAMILY = 'MargoTestColor';
/** Palette colours as sRGB bytes: entry 0 yellow, entry 1 green. */
export const COLOR_FONT_PALETTE = [
  [255, 204, 0],
  [0, 230, 0],
];

const UPEM = 1000;
const OUTER = [100, 0, 900, 800];
const INNER = [300, 200, 700, 600];

class Writer {
  bytes = [];
  u8(v) {
    this.bytes.push(v & 0xff);
    return this;
  }
  u16(v) {
    return this.u8(v >> 8).u8(v);
  }
  i16(v) {
    return this.u16(v & 0xffff);
  }
  u32(v) {
    return this.u16(v >>> 16).u16(v & 0xffff);
  }
  tag(s) {
    for (const c of s) this.u8(c.charCodeAt(0));
    return this;
  }
  done() {
    return Uint8Array.from(this.bytes);
  }
}

// One closed square contour, all points on the curve, coordinates as 16-bit deltas.
function square([x0, y0, x1, y1]) {
  const w = new Writer().i16(1).i16(x0).i16(y0).i16(x1).i16(y1).u16(3).u16(0);
  for (let i = 0; i < 4; i++) w.u8(0x01);
  const points = [
    [x0, y0],
    [x0, y1],
    [x1, y1],
    [x1, y0],
  ];
  let px = 0,
    py = 0;
  for (const [x] of points) w.i16(x - px), (px = x);
  for (const [, y] of points) w.i16(y - py), (py = y);
  while (w.bytes.length % 4) w.u8(0);
  return w.bytes;
}

function nameTable() {
  const names = [
    [1, COLOR_FONT_FAMILY],
    [2, 'Regular'],
    [3, `${COLOR_FONT_FAMILY}-Regular-1.0`],
    [4, `${COLOR_FONT_FAMILY} Regular`],
    [6, `${COLOR_FONT_FAMILY}-Regular`],
  ];
  const w = new Writer()
    .u16(0)
    .u16(names.length)
    .u16(6 + 12 * names.length);
  let offset = 0;
  for (const [id, text] of names) {
    w.u16(3)
      .u16(1)
      .u16(0x409)
      .u16(id)
      .u16(text.length * 2)
      .u16(offset);
    offset += text.length * 2;
  }
  for (const [, text] of names) for (const c of text) w.u16(c.charCodeAt(0));
  return w.done();
}

function checksum(bytes) {
  let sum = 0;
  for (let i = 0; i < bytes.length; i += 4)
    sum = (sum + (((bytes[i] << 24) | (bytes[i + 1] << 16) | (bytes[i + 2] << 8) | bytes[i + 3]) >>> 0)) >>> 0;
  return sum;
}

/** Builds the font file. Returns a fresh ArrayBuffer each call, ready for `new FontFace(family, buffer)`. */
export function buildColorFont() {
  const glyphs = [[], square(OUTER), square(OUTER), square(OUTER), square(INNER)];
  const lsb = [0, OUTER[0], OUTER[0], OUTER[0], INNER[0]];
  const glyf = new Writer(),
    loca = new Writer();
  for (const g of glyphs) {
    loca.u32(glyf.bytes.length);
    glyf.bytes.push(...g);
  }
  loca.u32(glyf.bytes.length);

  const head = new Writer()
    .u32(0x00010000)
    .u32(0x00010000)
    .u32(0) // checkSumAdjustment, set below
    .u32(0x5f0f3cf5)
    .u16(0x000b)
    .u16(UPEM)
    .u32(0)
    .u32(0)
    .u32(0)
    .u32(0)
    .i16(OUTER[0])
    .i16(OUTER[1])
    .i16(OUTER[2])
    .i16(OUTER[3])
    .u16(0)
    .u16(8)
    .i16(2)
    .i16(1)
    .i16(0);
  const hhea = new Writer().u32(0x00010000).i16(800).i16(-200).i16(0).u16(UPEM).i16(0).i16(100).i16(900);
  hhea.i16(1).i16(0).i16(0).i16(0).i16(0).i16(0).i16(0).i16(0).u16(glyphs.length);
  const hmtx = new Writer();
  for (const x of lsb) hmtx.u16(UPEM).i16(x);
  const maxp = new Writer().u32(0x00010000).u16(glyphs.length).u16(4).u16(1).u16(0).u16(0).u16(2);
  for (let i = 0; i < 8; i++) maxp.u16(0);
  const os2 = new Writer().u16(4).i16(UPEM).u16(400).u16(5).u16(0);
  for (const v of [650, 600, 0, 75, 650, 600, 0, 350, 50, 300, 0]) os2.i16(v);
  for (let i = 0; i < 10; i++) os2.u8(0); // PANOSE
  os2.u32(0).u32(0).u32(0).u32(0).tag('NONE').u16(0x0040).u16(0xffff).u16(0xffff);
  os2.i16(800).i16(-200).i16(0).u16(800).u16(200).u32(1).u32(0).i16(500).i16(700).u16(0).u16(32).u16(0);
  const post = new Writer().u32(0x00030000).u32(0).i16(-100).i16(50).u32(0).u32(0).u32(0).u32(0).u32(0);
  const format4 = new Writer().u16(4).u16(24).u16(0).u16(2).u16(2).u16(0).u16(0);
  format4.u16(0xffff).u16(0).u16(0xffff).i16(1).u16(0);
  const groups = [
    [0x1f600, 1],
    [0x1f680, 2],
  ];
  const format12 = new Writer()
    .u16(12)
    .u16(0)
    .u32(16 + 12 * groups.length)
    .u32(0)
    .u32(groups.length);
  for (const [code, glyph] of groups) format12.u32(code).u32(code).u32(glyph);
  const cmap = new Writer()
    .u16(0)
    .u16(2)
    .u16(3)
    .u16(1)
    .u32(20)
    .u16(3)
    .u16(10)
    .u32(20 + 24);
  cmap.bytes.push(...format4.bytes, ...format12.bytes);
  // COLR v0: base glyph records sorted by glyph id, then layer records bottom to top.
  const colr = new Writer().u16(0).u16(2).u32(14).u32(26).u16(3);
  colr.u16(1).u16(0).u16(1).u16(2).u16(1).u16(2);
  colr.u16(3).u16(0).u16(3).u16(1).u16(4).u16(0);
  // CPAL v0: one palette of two BGRA colour records.
  const cpal = new Writer().u16(0).u16(2).u16(1).u16(2).u32(14).u16(0);
  for (const [r, g, b] of COLOR_FONT_PALETTE) cpal.u8(b).u8(g).u8(r).u8(255);

  const tables = {
    COLR: colr,
    CPAL: cpal,
    'OS/2': os2,
    cmap,
    glyf,
    head,
    hhea,
    hmtx,
    loca,
    maxp,
    name: { done: nameTable },
    post,
  };
  const tags = Object.keys(tables).sort();
  const count = tags.length,
    log = Math.floor(Math.log2(count));
  const out = new Writer()
    .u32(0x00010000)
    .u16(count)
    .u16(16 << log)
    .u16(log)
    .u16(count * 16 - (16 << log));
  let offset = 12 + 16 * count;
  const bodies = [];
  let headOffset = 0;
  for (const tag of tags) {
    const data = tables[tag].done();
    const padded = new Uint8Array(Math.ceil(data.length / 4) * 4);
    padded.set(data);
    if (tag === 'head') headOffset = offset;
    out.tag(tag).u32(checksum(padded)).u32(offset).u32(data.length);
    bodies.push(padded);
    offset += padded.length;
  }
  for (const body of bodies) out.bytes.push(...body);
  const font = out.done();
  const adjust = (0xb1b0afba - checksum(font)) >>> 0;
  new DataView(font.buffer).setUint32(headOffset + 8, adjust);
  return font.buffer;
}
