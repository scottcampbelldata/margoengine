import assert from 'node:assert/strict';
// --- An independent GIF89a decoder (spec sections 17-23 and appendix F). ---
function lzwDecode(data, minimum, count) {
  const clear = 1 << minimum,
    end = clear + 1,
    out = [];
  let size,
    next,
    table,
    previous,
    bit = 0,
    clears = 0;
  const reset = () => {
    table = Array.from({ length: clear }, (_, i) => [i]);
    next = clear + 2;
    size = minimum + 1;
    previous = null;
  };
  reset();
  for (;;) {
    assert.ok(bit + size <= data.length * 8, 'LZW data ends before the end code');
    let code = 0;
    for (let i = 0; i < size; i++, bit++) code |= ((data[bit >> 3] >> (bit & 7)) & 1) << i;
    if (code === clear) {
      clears++;
      reset();
      continue;
    }
    if (code === end) break;
    let entry;
    if (code < next && table[code]) entry = table[code];
    else if (code === next && previous) entry = [...previous, previous[0]];
    else assert.fail(`LZW code ${code} is not in the table (next ${next}, width ${size})`);
    out.push(...entry);
    if (previous && next < 4096) {
      table[next++] = [...previous, entry[0]];
      if (next === 1 << size && size < 12) size++;
    }
    previous = entry;
  }
  assert.equal(Math.ceil(bit / 8), data.length, 'only padding bits follow the end code');
  assert.equal(out.length, count, 'one index per pixel');
  return { indices: out, clears };
}
export function decodeGIF(bytes) {
  let p = 0;
  const u8 = () => bytes[p++],
    u16 = () => bytes[p++] | (bytes[p++] << 8),
    text = (n) => String.fromCharCode(...bytes.subarray(p, (p += n))),
    blocks = () => {
      const out = [];
      for (let n = u8(); n; n = u8()) out.push(...bytes.subarray(p, (p += n)));
      return out;
    };
  assert.equal(text(6), 'GIF89a');
  const width = u16(),
    height = u16(),
    packed = u8();
  p += 2;
  const global = packed & 0x80 ? bytes.slice(p, (p += 3 << ((packed & 7) + 1))) : null,
    frames = [];
  let loop = null,
    control = null;
  for (;;) {
    const introducer = u8();
    if (introducer === 0x3b) break;
    if (introducer === 0x21) {
      const label = u8();
      if (label === 0xf9) {
        assert.equal(u8(), 4);
        const flags = u8();
        control = { disposal: (flags >> 2) & 7, hasTransparency: !!(flags & 1), delay: u16(), transparentIndex: u8() };
        assert.equal(u8(), 0);
      } else if (label === 0xff) {
        const id = text(u8()),
          data = blocks();
        if (id === 'NETSCAPE2.0') loop = data[1] | (data[2] << 8);
      } else blocks();
    } else {
      assert.equal(introducer, 0x2c, `block introducer at byte ${p - 1}`);
      const left = u16(),
        top = u16(),
        w = u16(),
        h = u16(),
        flags = u8(),
        colors = flags & 0x80 ? bytes.slice(p, (p += 3 << ((flags & 7) + 1))) : global;
      assert.deepEqual([left, top, w, h, flags & 0x40], [0, 0, width, height, 0], 'full-frame, not interlaced');
      const minimum = u8(),
        { indices, clears } = lzwDecode(blocks(), minimum, w * h),
        rgba = new Uint8Array(w * h * 4);
      indices.forEach((index, i) => {
        if (control?.hasTransparency && index === control.transparentIndex) return;
        assert.ok(index * 3 < colors.length, 'index inside the colour table');
        rgba.set([colors[index * 3], colors[index * 3 + 1], colors[index * 3 + 2], 255], i * 4);
      });
      frames.push({ ...control, colors: colors.length / 3, clears, rgba, used: new Set(indices).size });
      control = null;
    }
  }
  assert.equal(p, bytes.length, 'nothing after the trailer');
  return { width, height, loop, frames };
}

