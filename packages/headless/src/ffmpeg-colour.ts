// The engine's colour handling for ffmpeg, shared by the ffmpeg and ffmpeg-files entries. ffmpeg's scaler converts RGB
// with the BT.601 matrix unless told otherwise, and players read HD video as BT.709. The scaler tags the frames with
// their matrix and range only; setparams tags their primaries and transfer too, because ffmpeg 9 writes the frames' own
// tags into the stream over the -color_primaries and -color_trc options. The transfer is sRGB (ITU-T H.273 code 13),
// as encodeVideo states it, since the frames are sRGB-encoded renders; chroma is made on the left column between rows
// (H.273 chroma_sample_loc_type 0, the H.264 default), as encodeVideo makes it.

/** The filter that turns RGB(A) frames into `format` with the engine's matrix, range, chroma siting and tags. */
export const colourFilter = (format: string): string =>
  `scale=out_color_matrix=bt709:out_range=tv:out_chroma_loc=left,format=${format},setparams=color_primaries=bt709:color_trc=iec61966-2-1:colorspace=bt709:range=tv:chroma_location=left`;

/** The output options that tag the stream as the filter made it. */
export const COLOUR_TAGS: readonly string[] = [
  '-colorspace',
  'bt709',
  '-color_primaries',
  'bt709',
  '-color_trc',
  'iec61966-2-1',
  '-color_range',
  'tv',
  '-chroma_sample_location',
  'left',
];
