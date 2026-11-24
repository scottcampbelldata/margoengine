import { maxBytes } from './container.js';

/** Writes a .margo container: the manifest, then `sections` in order, with header `flags` (FORMAT.md). */
export function writeMargo(
  manifest: unknown,
  sections: readonly { type: number; flags: number; bytes: Uint8Array }[],
  flags: number,
): Uint8Array<ArrayBuffer> {
  const json = new TextEncoder().encode(JSON.stringify(manifest)),
    all = [{ type: 1, flags: 0, bytes: json }, ...sections],
    pad = (n: number) => (n + 3) & ~3;
  let length = 64 + all.length * 16;
  for (const s of all) length += pad(s.bytes.byteLength);
  if (length > maxBytes || json.byteLength > 1024 * 1024)
    throw new RangeError(".margo exceeds 256 MiB or its 1 MiB manifest after compression; split the scene");
  const out = new Uint8Array(length),
    view = new DataView(out.buffer);
  [0x4f47524d, 1, length, all.length, 64, flags, 80].forEach((v, i) => view.setUint32(i * 4, v, true));
  let at = 64 + all.length * 16;
  all.forEach((s, i) => {
    view.setUint32(64 + i * 16, s.type, true);
    view.setUint32(68 + i * 16, at, true);
    view.setUint32(72 + i * 16, s.bytes.byteLength, true);
    view.setUint32(76 + i * 16, s.flags, true);
    out.set(s.bytes, at);
    at += pad(s.bytes.byteLength);
  });
  return out;
}

