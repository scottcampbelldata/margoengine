import { margoError } from '../../shared/errors.js';

// Margo's own 5 x 7 dot glyphs for printable ASCII (32..126), drawn for this package. Seven base-32 digits a glyph,
// one row each from the top; bit 4 is the left column. Each sits at the top left of a 6 x 8 box (one column and one row
// of spacing), so the strokes stay sharp at every whole multiple of 6 x 8.
const FONT =
  '00000004444404aa00000aavavaa4fke5u4pq248bjcik8lid44000002488842842224804lel40044v4400000448000v0000000004' +
  '11248ggehjlphe4c4444eeh168gvu11e11u26aiv22vgu11he68guhhev124444ehhehheehhf12c00400400040448248g84200v0v00' +
  '8421248eh12404ehnlngfehhvhhhuhhuhhuehggghesihhhisvgguggvvggugggehgnhhfhhhvhhhe44444e72222ichikokihggggggv' +
  'hrllhhhhppljjhehhhhheuhhugggehhhliduhhukihfgge11uv444444hhhhhhehhhhha4hhhllrhhha4ahhhha4444v1248gve88888e' +
  'gg84211e22222e4ah0000000000v840000000e1fhfgguhhhu00egghe11fhhhf00ehvge698s8880fhhf1egguhhhh40c444e20622ic' +
  'ggikokic44444e00qllll00uhhhh00ehhhe00uhugg00fhf1100mpggg00fge1u88s889600hhhjd00hhha400hhlla00ha4ah00hhf1e' +
  '00v248v34484434444444o44244o008l200';

/** Coverage atlas: glyph i fills the cell at column i % 16, row floor(i / 16). */
export function glyphAtlas(
  glyphs: readonly string[],
  width: number,
  height: number,
  font?: string,
  fontSize = height,
): { data: Uint8Array<ArrayBuffer>; width: number; height: number } {
  const w = 16 * width,
    h = Math.ceil(glyphs.length / 16) * height,
    data = new Uint8Array(w * h);
  if (font !== undefined) {
    const context =
      typeof OffscreenCanvas === 'function'
        ? new OffscreenCanvas(w, h).getContext('2d', { willReadFrequently: true })
        : null;
    if (!context)
      throw margoError(
        'unsupported',
        'ASCII font needs a 2D OffscreenCanvas; leave font unset for the built-in glyphs',
      );
    context.fillStyle = '#fff';
    context.font = `${fontSize}px ${font}`;
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    glyphs.forEach((glyph, i) => {
      const x = (i % 16) * width,
        y = Math.floor(i / 16) * height;
      context.save();
      context.beginPath();
      context.rect(x, y, width, height);
      context.clip();
      context.fillText(glyph, x + width / 2, y + height / 2);
      context.restore();
    });
    const pixels = context.getImageData(0, 0, w, h).data;
    for (let i = 0; i < data.length; i++) data[i] = pixels[4 * i + 3];
    return { data, width: w, height: h };
  }
  // Exact box filter: the share of a cell pixel's footprint in the 6 x 8 box that is ink.
  const overlap = (pixel: number, size: number, box: number, dot: number) =>
    Math.max(0, Math.min(((pixel + 1) * box) / size, dot + 1) - Math.max((pixel * box) / size, dot));
  const area = (6 / width) * (8 / height);
  glyphs.forEach((glyph, i) => {
    const first = (glyph.charCodeAt(0) - 32) * 7;
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        let sum = 0;
        for (let row = 0; row < 7; row++) {
          const high = overlap(y, height, 8, row),
            bits = parseInt(FONT[first + row], 32);
          if (high) for (let c = 0; c < 5; c++) if (bits & (16 >> c)) sum += high * overlap(x, width, 6, c);
        }
        data[(Math.floor(i / 16) * height + y) * w + (i % 16) * width + x] = Math.round((255 * sum) / area);
      }
  });
  return { data, width: w, height: h };
}
