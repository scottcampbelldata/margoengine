// The colour space of a film capture and the ffmpeg filter that brings it to the export's BT.709 limited range.
//
// capture.mjs encodes the canvas with the browser's VideoEncoder. WebCodecs gives no way to ask for a range, and
// Chromium's encoder writes full-range Y'CbCr (0 to 255) while leaving the stream's VUI range unset. export.mjs tags its
// output limited range (16 to 235, what players expect of H.264), so copying the samples through under that tag decodes
// every level below 16 as black and stretches the rest: a night film came out darker than its stills (median level 14
// against 29 on the Last Tram hook, KB-FILM-RANGE1). The capture records the encoder's own `decoderConfig.colorSpace`
// beside the stream, and the export converts from it.

/** Where capture.mjs records the colour space of a raw H.264 capture. */
export const colourSidecar = (stream) => stream + '.colour.json';

const MATRICES = { bt709: 'bt709', bt470bg: 'bt470bg', smpte170m: 'smpte170m', bt2020ncl: 'bt2020' };

/**
 * The ffmpeg video filter that turns a capture in `colorSpace` into BT.709 limited-range 4:2:0.
 * @param {{fullRange?: boolean | null, matrix?: string | null}} colorSpace A WebCodecs VideoColorSpaceInit, as the
 *   encoder reported it in `decoderConfig.colorSpace`.
 * @returns {string}
 */
export function toLimitedBt709(colorSpace) {
  if (!colorSpace || typeof colorSpace !== 'object')
    throw new TypeError('toLimitedBt709 needs the encoder colour space recorded by capture.mjs; capture again');
  if (typeof colorSpace.fullRange !== 'boolean')
    throw new RangeError('the capture did not record its range (fullRange); capture again');
  const matrix = MATRICES[colorSpace.matrix ?? 'bt709'];
  if (!matrix) throw new RangeError(`unsupported capture matrix: ${String(colorSpace.matrix)}`);
  return (
    `scale=in_range=${colorSpace.fullRange ? 'full' : 'tv'}:in_color_matrix=${matrix}` +
    ':out_range=tv:out_color_matrix=bt709,format=yuv420p'
  );
}
