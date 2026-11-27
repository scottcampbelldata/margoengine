// A lossless JPEG writer for the cases cjpeg does not make: sampling factors, one scan per component with its own
// predictor and table, long Huffman codes, two-component camera tiles and damaged input. Written from ITU-T T.81
// Annex C (Huffman tables), Annex B (markers) and Annex H. A file it writes is a stand-in: interoperability is proved by
// the libjpeg-turbo and DICOM fixtures.

/** Code counts by length (1 to 16) for the 17 difference categories. */
export const TABLES = {
  // Every code 5 bits long.
  flat: [0, 0, 0, 0, 17, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  // Codes of 2 to 16 bits, so most are longer than a decoder's first lookup.
  long: [0, 1, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
};

function codes(counts) {
  const out = [];
  let code = 0;
  counts.forEach((count, i) => {
    for (let k = 0; k < count; k++) out.push([code++, i + 1]);
    code <<= 1;
  });
  return out;
}

const segment = (marker, body) => [0xff, marker, (body.length + 2) >> 8, (body.length + 2) & 255, ...body];

const predictors = [
  null,
  (a) => a,
  (_, b) => b,
  (_, __, c) => c,
  (a, b, c) => a + b - c,
  (a, b, c) => a + ((b - c) >> 1),
  (a, b, c) => b + ((a - c) >> 1),
  (a, b) => (a + b) >> 1,
];

/**
 * `components` are `{h, v, samples}`, each sample array ceil(width h / maxH) by ceil(height v / maxV). `scans` are
 * `{components, predictor, transform, table, rows}`: the component indexes, the selection value, the point transform,
 * a {@link TABLES} name and the MCU rows per restart interval. Default one interleaved scan with selection value 1.
 */
export function encodeLossless({ width, height, precision, components, scans, jfif = false, marker = 0xc3 }) {
  const maxH = Math.max(...components.map((c) => c.h ?? 1)),
    maxV = Math.max(...components.map((c) => c.v ?? 1)),
    plans = scans ?? [{ components: components.map((_, i) => i) }],
    bytes = [0xff, 0xd8];
  if (jfif) bytes.push(...segment(0xe0, [0x4a, 0x46, 0x49, 0x46, 0, 1, 2, 0, 0, 1, 0, 1, 0, 0]));
  const frame = [precision, height >> 8, height & 255, width >> 8, width & 255, components.length];
  components.forEach((c, i) => frame.push(i + 1, ((c.h ?? 1) << 4) | (c.v ?? 1), 0));
  bytes.push(...segment(marker, frame));
  for (const [number, plan] of plans.entries()) {
    const { predictor = 1, transform = 0, table = 'flat', rows = 0 } = plan,
      counts = TABLES[table],
      huffman = codes(counts),
      id = number & 3,
      single = plan.components.length === 1;
    bytes.push(...segment(0xc4, [id, ...counts, ...Array.from({ length: 17 }, (_, i) => i)]));
    const parts = plan.components.map((index) => {
      const c = components[index],
        h = c.h ?? 1,
        v = c.v ?? 1,
        ownW = Math.ceil((width * h) / maxH),
        ownH = Math.ceil((height * v) / maxV),
        across = single ? ownW : Math.ceil(width / maxH) * h,
        down = single ? ownH : Math.ceil(height / maxV) * v,
        // Padded to whole MCUs by repeating the last column and row.
        values = new Int32Array(across * down);
      for (let y = 0; y < down; y++)
        for (let x = 0; x < across; x++)
          values[y * across + x] = c.samples[Math.min(y, ownH - 1) * ownW + Math.min(x, ownW - 1)] >> transform;
      return { index, h: single ? 1 : h, v: single ? 1 : v, across, values };
    });
    const mcusWide = single ? parts[0].across : Math.ceil(width / maxH),
      mcusHigh = single ? parts[0].values.length / parts[0].across : Math.ceil(height / maxV);
    // The restart interval holds until another DRI, so every scan states its own.
    bytes.push(...segment(0xdd, [(rows * mcusWide) >> 8, (rows * mcusWide) & 255]));
    const head = [plan.components.length];
    for (const index of plan.components) head.push(index + 1, id << 4);
    bytes.push(...segment(0xda, [...head, predictor, 0, transform]));
    let buffer = 0,
      count = 0;
    const put = (value, length) => {
      for (let bit = length - 1; bit >= 0; bit--) {
        buffer = (buffer << 1) | ((value >> bit) & 1);
        if (++count === 8) {
          bytes.push(buffer);
          if (buffer === 255) bytes.push(0);
          buffer = 0;
          count = 0;
        }
      }
    };
    const flush = () => {
      if (count) put(255, 8 - count);
    };
    for (let row = 0; row < mcusHigh; row++) {
      if (rows && row && row % rows === 0) {
        flush();
        bytes.push(0xff, 0xd0 + ((row / rows - 1) & 7));
      }
      for (let mcu = 0; mcu < mcusWide; mcu++)
        for (const { h, v, across, values } of parts)
          for (let j = 0; j < v; j++)
            for (let i = 0; i < h; i++) {
              const x = mcu * h + i,
                y = row * v + j,
                at = y * across + x,
                firstLine = j === 0 && (rows ? row % rows === 0 : row === 0);
              let prediction;
              if (firstLine) prediction = x ? values[at - 1] : 1 << (precision - transform - 1);
              else if (!x) prediction = values[at - across];
              else prediction = predictors[predictor](values[at - 1], values[at - across], values[at - across - 1]);
              let difference = (values[at] - prediction) & 0xffff;
              if (difference > 32768) difference -= 65536;
              const category = 32 - Math.clz32(Math.abs(difference));
              put(...huffman[category]);
              if (category && category < 16)
                put(difference < 0 ? difference + (1 << category) - 1 : difference, category);
            }
    }
    flush();
  }
  bytes.push(0xff, 0xd9);
  return Uint8Array.from(bytes);
}
