import type { Figure, Timeline } from '@margoengine/sciviz';
import { fault, rangeError, typeError } from '../../shared/errors.js';
import { mediaDimensions, mediaProvenance, renderMediaTiles, type MediaImageOptions } from './media-tiles.js';
import { tiledPNG, webpMetadata, mediaZIP } from './media-containers.js';
export { mediaDimensions, renderMediaTiles } from './media-tiles.js';
export type { MediaImageOptions, MediaTile } from './media-tiles.js';

/** Raster file options. */
export interface MediaExportOptions extends MediaImageOptions {
  /** Default png. WebP dimensions must not exceed 16383. */
  readonly format?: 'png' | 'webp';
  /** WebP quality, 0..1. Default 0.95. PNG is lossless. */
  readonly quality?: number;
}

/** Real tiled rendering at the requested scale or physical dimensions, including alpha and provenance. */
export async function exportImage(figure: Figure, options: MediaExportOptions = {}): Promise<Blob> {
  options.signal?.throwIfAborted();
  const { format = 'png', quality = 0.95, maxBytes = 256 * 1024 * 1024 } = options;
  if (format !== 'png' && format !== 'webp') throw typeError('Image format must be png or webp', 'sciviz');
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || !Number.isFinite(quality) || quality < 0 || quality > 1)
    throw rangeError('maxBytes must be positive and quality must be in [0, 1]', 'sciviz');
  const canvas = figure.engine.canvas,
    { width, height, dpi } = mediaDimensions(
      canvas.clientWidth || canvas.width,
      canvas.clientHeight || canvas.height,
      options,
    );
  if (format === 'webp' && (width > 16383 || height > 16383 || width * height * 4 > maxBytes))
    throw rangeError('WebP exceeds its dimension or maxBytes limit; use PNG or reduce the size', 'sciviz');
  const record = await mediaProvenance(figure, options),
    provenance = record ? JSON.stringify(record) : undefined;
  if (format === 'png') return tiledPNG(renderMediaTiles(figure, options), width, height, dpi, maxBytes, provenance);
  const surface = new OffscreenCanvas(width, height),
    g = surface.getContext('2d');
  if (!g) throw fault('unsupported', 'This browser cannot allocate the WebP output canvas', 'sciviz');
  for await (const tile of renderMediaTiles(figure, options))
    g.putImageData(new ImageData(tile.pixels, tile.width, tile.height), tile.x, tile.y);
  options.signal?.throwIfAborted();
  return webpMetadata(await surface.convertToBlob({ type: 'image/webp', quality }), width, height, dpi, provenance);
}

/** Timeline export options; one deterministic frame per selected timeline step. */
export interface TimelineMediaOptions extends MediaExportOptions {
  /** Playback frames per second, independent of wall clock. Default 10. */
  readonly fps?: number;
  /** Timeline frame indices, inclusive. Defaults to the whole timeline. */
  readonly start?: number;
  readonly end?: number;
  /** Video target bits per second. Default 8000000. */
  readonly bitrate?: number;
  /** Resume a previously playing timeline after restoring its initial frame. Default false. */
  readonly resume?: boolean;
}
const timelineRange = (timeline: Timeline, options: TimelineMediaOptions): [number, number, number] => {
  const start = options.start ?? 0,
    end = options.end ?? timeline.times.length - 1,
    fps = options.fps ?? 10;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end < start ||
    end >= timeline.times.length ||
    !Number.isFinite(fps) ||
    fps <= 0 ||
    fps > 1_000_000
  )
    throw rangeError('Timeline export needs an inclusive valid frame range and fps in (0, 1000000]', 'sciviz');
  return [start, end, fps];
};

async function withTimeline<T>(
  timeline: Timeline,
  options: TimelineMediaOptions,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = timeline.index,
    playing = timeline.playing;
  timeline.pause();
  try {
    return await operation();
  } finally {
    if (previous >= 0) await timeline.seek(previous);
    if (playing && options.resume) void timeline.play({ fps: options.fps ?? 10 }).catch(reportError);
  }
}

/** Exports timestamped PNG/WebP files plus manifest.json in a standard ZIP. Restores the selected timeline frame. */
export async function exportImageSequence(
  figure: Figure,
  timeline: Timeline,
  options: TimelineMediaOptions = {},
): Promise<Blob> {
  options.signal?.throwIfAborted();
  const [start, end, fps] = timelineRange(timeline, options),
    maxBytes = options.maxBytes ?? 256 * 1024 * 1024;
  if (end - start + 2 > 65535) throw rangeError('Image sequence exceeds classic ZIP entry limit', 'sciviz');
  return withTimeline(timeline, options, async () => {
    const files: { name: string; bytes: Uint8Array<ArrayBuffer> }[] = [],
      frames: { file: string; time: number; timestamp: number }[] = [];
    let length = 0;
    for (let index = start; index <= end; index++) {
      options.signal?.throwIfAborted();
      await timeline.seek(index);
      const blob = await exportImage(figure, options),
        name = `frame-${String(index - start).padStart(6, '0')}.${options.format ?? 'png'}`;
      const bytes = new Uint8Array(await blob.arrayBuffer());
      length += bytes.length;
      if (length > maxBytes) throw rangeError('Image sequence exceeds maxBytes', 'sciviz');
      files.push({ name, bytes });
      frames.push({
        file: name,
        time: timeline.times[index],
        timestamp: Math.round(((index - start) * 1_000_000) / fps),
      });
    }
    files.push({
      name: 'manifest.json',
      bytes: new TextEncoder().encode(
        JSON.stringify({ fps, frames, provenance: await mediaProvenance(figure, options) }, null, 2),
      ),
    });
    return mediaZIP(files);
  });
}

/** Encodes timeline frames offline through the video package's WebCodecs API, then muxes WebM or MP4. */
export async function exportVideo(
  figure: Figure,
  timeline: Timeline,
  options: Omit<TimelineMediaOptions, 'format'> & { readonly format?: 'webm' | 'mp4' } = {},
): Promise<Blob> {
  const { format = 'webm', ...imageOptions } = options;
  options.signal?.throwIfAborted();
  const [start, end, fps] = timelineRange(timeline, imageOptions),
    canvas = figure.engine.canvas;
  const { width, height } = mediaDimensions(
    canvas.clientWidth || canvas.width,
    canvas.clientHeight || canvas.height,
    imageOptions,
  );
  const { encodeVideo } = await import('@margoengine/headless/video');
  const frames = async function* () {
    for (let index = start; index <= end; index++) {
      options.signal?.throwIfAborted();
      await timeline.seek(index);
      if (width * height * 4 > (options.maxBytes ?? 256 * 1024 * 1024))
        throw rangeError('Video frame exceeds maxBytes; reduce output dimensions', 'sciviz');
      const surface = new OffscreenCanvas(width, height),
        g = surface.getContext('2d')!;
      for await (const tile of renderMediaTiles(figure, imageOptions))
        g.putImageData(new ImageData(tile.pixels, tile.width, tile.height), tile.x, tile.y);
      const pixels = g.getImageData(0, 0, width, height).data;
      yield { width, height, data: new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength) };
    }
  };
  return withTimeline(timeline, imageOptions, async () => {
    const result = await encodeVideo(frames(), {
      fps,
      format,
      bitrate: options.bitrate,
      maxBytes: options.maxBytes,
      signal: options.signal,
      provenance: await mediaProvenance(figure, imageOptions),
    });
    return new Blob([result.bytes], { type: `video/${format}` });
  });
}
