// Clean-room binary fixtures from the OpenType and Adobe CFF/Type 2 specifications.
import { buildColorFont } from './color-font.js';

export const u16 = (v) => [(v >> 8) & 255, v & 255];
export const u32 = (v) => [...u16(v >>> 16), ...u16(v)];
export function tables(buffer) {
  const bytes = new Uint8Array(buffer),
    view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const result = new Map();
  for (let i = 0; i < view.getUint16(4); i++) {
    const p = 12 + i * 16;
    const tag = String.fromCharCode(...bytes.subarray(p, p + 4));
    const offset = view.getUint32(p + 8),
      length = view.getUint32(p + 12);
    result.set(tag, bytes.slice(offset, offset + length));
  }
  return result;
}
export function sfnt(entries, cff = false) {
  const header = [...u32(cff ? 0x4f54544f : 0x10000), ...u16(entries.size), ...Array(6).fill(0)];
  const data = [];
  let offset = 12 + 16 * entries.size;
  for (const [tag, bytes] of entries) {
    header.push(...Array.from(tag, (c) => c.charCodeAt(0)), ...u32(0), ...u32(offset), ...u32(bytes.length));
    for (const byte of bytes) data.push(byte);
    while (data.length % 4) data.push(0);
    offset = 12 + 16 * entries.size + data.length;
  }
  return Uint8Array.from([...header, ...data]);
}
export function simple(points) {
  const bytes = [...u16(1), ...Array(8).fill(0), ...u16(points.length - 1), ...u16(0)];
  bytes.push(...points.map((p) => (p[2] ? 1 : 0)));
  for (let axis = 0; axis < 2; axis++) {
    let prev = 0;
    for (const p of points) {
      bytes.push(...u16(p[axis] - prev));
      prev = p[axis];
    }
  }
  return bytes;
}
export const component = (glyph, flags = 3, arg1 = 0, arg2 = 0, transform = []) => [
  ...u16(flags),
  ...u16(glyph),
  ...(flags & 1 ? [...u16(arg1), ...u16(arg2)] : [arg1 & 255, arg2 & 255]),
  ...transform.flatMap(u16),
];
export const composite = (...components) => [...u16(-1), ...Array(8).fill(0), ...components.flat()];
export function ttf(glyphs) {
  const entries = tables(buildColorFont()),
    glyf = [],
    loca = [];
  for (const g of glyphs) {
    loca.push(...u32(glyf.length));
    glyf.push(...g);
    if (glyf.length % 2) glyf.push(0);
  }
  loca.push(...u32(glyf.length));
  entries.set('glyf', glyf);
  entries.set('loca', loca);
  entries.set('maxp', [...u32(0x10000), ...u16(glyphs.length)]);
  entries.set(
    'hmtx',
    glyphs.flatMap(() => [...u16(1000), ...u16(0)]),
  );
  const hhea = entries.get('hhea');
  hhea.set(u16(glyphs.length), 34);
  // The fixture maps the emoji to glyph 1; no mapping may refer beyond maxp.
  entries.set('cmap', [
    ...u16(0),
    ...u16(1),
    ...u16(3),
    ...u16(10),
    ...u32(12),
    ...u16(12),
    ...u16(0),
    ...u32(28),
    ...u32(0),
    ...u32(1),
    ...u32(0x1f600),
    ...u32(0x1f600),
    ...u32(Math.min(1, glyphs.length - 1)),
  ]);
  return sfnt(entries);
}
export const number = (n) => (n >= -107 && n <= 107 ? [n + 139] : [28, ...u16(n)]);
export const program = (...tokens) => tokens.flatMap((t) => (typeof t === 'number' ? number(t) : t));
export function index(items) {
  if (!items.length) return [0, 0];
  let offset = 1;
  const offsets = [offset];
  for (const item of items) {
    offset += item.length;
    offsets.push(offset);
  }
  return [...u16(items.length), 4, ...offsets.flatMap(u32), ...items.flat()];
}
export function otf(charstrings, local = [], global = [], extra = []) {
  const entries = tables(ttf(charstrings.map(() => [])));
  entries.delete('glyf');
  entries.delete('loca');
  const names = index([[84]]),
    strings = index([]),
    globals = index(global);
  const dictInt = (n) => [29, ...u32(n)];
  const privateDict = [...dictInt(6), 19];
  // All DICT offsets use fixed-width long integers, so sizes are stable.
  const topLength = index([Array(17 + extra.length).fill(0)]).length;
  const charsOffset = 4 + names.length + topLength + strings.length + globals.length;
  const chars = index(charstrings);
  const privateOffset = charsOffset + chars.length;
  const top = index([
    [...dictInt(charsOffset), 17, ...dictInt(privateDict.length), ...dictInt(privateOffset), 18, ...extra],
  ]);
  entries.set('CFF ', [
    1,
    0,
    4,
    4,
    ...names,
    ...top,
    ...strings,
    ...globals,
    ...chars,
    ...privateDict,
    ...index(local),
  ]);
  return sfnt(entries, true);
}
