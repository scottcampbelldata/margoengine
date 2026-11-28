// Hand-built JPEG 2000 streams from the marker syntax of Rec. ITU-T T.800 Annex A and the boxes of Annex I.

export const be = (value, bytes) => Array.from({ length: bytes }, (_, i) => (value / 2 ** (8 * (bytes - 1 - i))) & 255);
export const segment = (marker, body) => [...be(marker, 2), ...be(body.length + 2, 2), ...body];
export const box = (type, body) => [...be(body.length + 8, 4), ...[...type].map((c) => c.charCodeAt(0)), ...body];

/** One 8-bit grey tile with `levels` decomposition levels and the reversible filter; `style` is the code-block style. */
export function codestream(width, height, { levels = 0, style = 0 } = {}) {
  const size = [width, height, 0, 0, width, height, 0, 0].flatMap((v) => be(v, 4));
  // One empty packet per resolution: a single zero bit each.
  const packets = new Array(levels + 1).fill(0);
  return Uint8Array.from([
    ...be(0xff4f, 2),
    ...segment(0xff51, [0, 0, ...size, 0, 1, 7, 1, 1]),
    ...segment(0xff52, [0, 0, 0, 1, 0, levels, 4, 4, style, 1]),
    ...segment(0xff5c, [0x20, ...new Array(3 * levels + 1).fill(8 << 3)]),
    ...segment(0xff90, [0, 0, ...be(14 + packets.length, 4), 0, 1]),
    ...be(0xff93, 2),
    ...packets,
    ...be(0xffd9, 2),
  ]);
}

/** The signature and file type boxes every JP2 file opens with. */
export const jp2Opening = () => [
  ...box('jP  ', [0x0d, 0x0a, 0x87, 0x0a]),
  ...box(
    'ftyp',
    [...'jp2 \0\0\0\0jp2 '].map((c) => c.charCodeAt(0)),
  ),
];

/** The enumerated greyscale colour specification box. */
const greyColour = () => box('colr', [1, 0, 0, ...be(17, 4)]);

/** A greyscale ICC profile whose curve is a power of `gamma` (ICC.1: the header, one `kTRC` tag of `curveType`). */
export function greyProfile(gamma) {
  const profile = new Array(128).fill(0);
  profile.splice(16, 4, ...[...'GRAY'].map((c) => c.charCodeAt(0)));
  const curve = [...[...'curv'].map((c) => c.charCodeAt(0)), 0, 0, 0, 0, ...be(1, 4), ...be(gamma * 256, 2)];
  return [...profile, ...be(1, 4), ...[...'kTRC'].map((c) => c.charCodeAt(0)), ...be(144, 4), ...be(14, 4), ...curve];
}

/**
 * A greyscale JP2 file around a codestream; `boxes` are further boxes of the header box and `colour` its colour
 * specification box.
 */
export function jp2(stream, width, height, boxes = [], colour = greyColour()) {
  const header = [...box('ihdr', [...be(height, 4), ...be(width, 4), 0, 1, 7, 7, 0, 0]), ...colour, ...boxes];
  return Uint8Array.from([...jp2Opening(), ...box('jp2h', header), ...box('jp2c', [...stream])]);
}
