import { openIndexedVideo, type DecodedVideo, type VideoDecodingOptions } from './decoding.js';
import { readMP4 } from './mp4.js';
import { readFragments } from './fragments.js';
import { readWebM } from './webm.js';
export type { DecodedVideo, VideoDecodingOptions } from './decoding.js';

/**
 * Frame-accurate access to a complete MP4 (including fragmented AVC) or WebM (VP8, VP9, AV1).
 * Pass initialization plus media segments as one file. First video track is selected; audio is ignored.
 * Reuses codecs' frame/seek/step, AbortSignal and disposal contract. No playback clock or rate is guessed.
 */
export function openDemuxedVideo(
  source: string | URL | Blob | ArrayBuffer,
  options: VideoDecodingOptions = {},
): Promise<DecodedVideo> {
  return openIndexedVideo(source, options, (bytes) =>
    bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3
      ? readWebM(bytes)
      : readMP4(bytes, readFragments),
  );
}
