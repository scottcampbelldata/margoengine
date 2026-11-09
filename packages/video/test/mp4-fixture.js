// Generated sample-table stand-in, not a playable AVC bitstream. No imported media or library code.
const cat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};
const u32 = (n) => {
  const a = new Uint8Array(4);
  new DataView(a.buffer).setUint32(0, n);
  return a;
};
const text = (s) => new TextEncoder().encode(s);
const box = (s, ...parts) => {
  const b = cat(...parts);
  return cat(u32(b.length + 8), text(s), b);
};
const full = (s, ...parts) => box(s, u32(0), ...parts);
export function mp4Fixture({
  co64 = false,
  signed = true,
  edit = false,
  constant = false,
  chunked = false,
  timeScale = 1000,
  sampleDelta = 100,
  movieScale = 1000,
  editStart = 100,
  editLead = 50,
  editLength = 250,
  composition,
} = {}) {
  // Decode IDs 0,1,2,3,4; PTS 0,300,100,200,400 (B-frame reorder). Two GOPs.
  const payload = box('mdat', new Uint8Array([0, 1, 2, 3, 4]));
  const visual = new Uint8Array(78);
  visual[7] = 1;
  const timing =
    composition ??
    (signed ? [0, 2 * sampleDelta, -sampleDelta, -sampleDelta, 0] : [sampleDelta, 3 * sampleDelta, 0, 0, sampleDelta]);
  const stbl = box(
    'stbl',
    full('stsd', u32(1), box('avc1', visual, box('avcC', new Uint8Array([1, 66, 0, 30, 255, 225, 0])))),
    full('stts', u32(1), u32(5), u32(sampleDelta)),
    box('ctts', u32(signed ? 0x1000000 : 0), u32(5), ...timing.flatMap((t) => [u32(1), u32(t)])),
    full('stss', u32(2), u32(1), u32(5)),
    full(
      'stsc',
      u32(chunked ? 2 : 1),
      u32(1),
      u32(chunked ? 2 : 5),
      u32(1),
      ...(chunked ? [u32(3), u32(1), u32(1)] : []),
    ),
    full('stsz', u32(constant ? 1 : 0), u32(5), ...(constant ? [] : Array.from({ length: 5 }, () => u32(1)))),
    full(
      co64 ? 'co64' : 'stco',
      u32(chunked ? 3 : 1),
      ...(chunked ? [8, 10, 12] : [8]).flatMap((n) => (co64 ? [u32(0), u32(n)] : [u32(n)])),
    ),
  );
  const mdia = box(
    'mdia',
    full('mdhd', u32(0), u32(0), u32(timeScale), u32(5 * sampleDelta)),
    full('hdlr', u32(0), text('vide')),
    box('minf', box('dinf', full('dref', u32(1), box('url ', u32(1)))), stbl),
  );
  return cat(
    payload,
    box(
      'moov',
      full('mvhd', u32(0), u32(0), u32(movieScale), u32(500)),
      box(
        'trak',
        ...(edit
          ? [
              box(
                'edts',
                full(
                  'elst',
                  u32(2),
                  u32(editLead),
                  u32(0xffffffff),
                  u32(65536),
                  u32(editLength),
                  u32(editStart),
                  u32(65536),
                ),
              ),
            ]
          : []),
        mdia,
      ),
    ),
  ).buffer;
}
