// Link appearance probe for the graph scene (KB2594b): the brightest interior link pixel of an RGBA frame against
// the background and the asked colour. The interior disc leaves out the node ring and any corner watermark.
export function linkPeak(frame, asked, background, interior = 0.35) {
  const { width, height, rgba } = frame;
  let peak = background,
    pixels = 0;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      if (Math.hypot(x + 0.5 - width / 2, y + 0.5 - height / 2) > interior * width) continue;
      const i = (y * width + x) * 4;
      if (rgba[i + 1] - background[1] <= 12) continue;
      pixels++;
      if (rgba[i + 1] > peak[1]) peak = [rgba[i], rgba[i + 1], rgba[i + 2]];
    }
  // Share of the asked colour reached over the background, per channel with the largest contrast (green and blue).
  const share = [1, 2].map((k) => (peak[k] - background[k]) / (asked[k] - background[k]));
  return { pixels, peak, share: Math.min(...share) };
}
