// Saving the demo's exports: a browser download of one file, and a plain ustar archive (stored, no compression) for
// the per-biome masks, which every desktop archive tool opens. The PNG files themselves come from
// @margoengine/biomes/io.

/** Starts a browser download of `data` as `name`. */
export function download(name: string, data: Uint8Array | string, type: string): void {
  const blob = new Blob([data as BlobPart], { type }),
    url = URL.createObjectURL(blob),
    link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

const encoder = new TextEncoder();

/** A ustar archive of `files` (names up to 100 ASCII bytes). */
export function tar(files: readonly (readonly [string, Uint8Array])[]): Uint8Array {
  const size = files.reduce((n, [, data]) => n + 512 + Math.ceil(data.length / 512) * 512, 1024),
    out = new Uint8Array(size),
    mtime = Math.floor(Date.now() / 1000);
  let at = 0;
  const field = (offset: number, text: string) => out.set(encoder.encode(text), at + offset);
  const octal = (offset: number, length: number, value: number) =>
    field(offset, `${value.toString(8).padStart(length - 1, '0')}\0`);
  for (const [name, data] of files) {
    field(0, name.slice(0, 100));
    octal(100, 8, 0o644);
    octal(108, 8, 0);
    octal(116, 8, 0);
    octal(124, 12, data.length);
    octal(136, 12, mtime);
    field(148, '        '); // the checksum counts its own field as spaces
    field(156, '0');
    field(257, 'ustar\0');
    field(263, '00');
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += out[at + i];
    field(148, `${sum.toString(8).padStart(6, '0')}\0 `);
    out.set(data, at + 512);
    at += 512 + Math.ceil(data.length / 512) * 512;
  }
  return out; // the two closing zero blocks are already zero
}
