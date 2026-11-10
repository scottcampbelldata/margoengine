import { readMP4 } from './mp4.js';
import { openIndexedVideo, type DecodedVideo, type VideoDecodingOptions } from './decoding.js';
export type { DecodedVideo, VideoDecodingOptions } from './decoding.js';

/**
 * Open nonfragmented, unencrypted AVC MP4, demuxed locally and decoded with WebCodecs.
 * Needs a secure browser context with a supported VideoDecoder. Renderer independent, including WebGL2.
 * A whole GOP is decoded per request so reordered frames can be selected by exact presentation timestamp.
 */
export async function openVideo(
  source: string | URL | Blob | ArrayBuffer,
  options: VideoDecodingOptions = {},
): Promise<DecodedVideo> {
  return openIndexedVideo(source, options, readMP4);
}
