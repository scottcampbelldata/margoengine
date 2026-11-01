// Clips from packed atlas manifests. Its own entry, so an app that plays plain sheets does not carry it.
import type { SpriteClip, SpriteFrame } from './animation.js';

/** A frame of an atlas manifest (`atlasManifest` from @margoengine/exporters/atlas, or any JSON hash sheet). */
export interface AtlasClipEntry {
  frame: { x: number; y: number; w: number; h: number };
  spriteSourceSize?: { x: number; y: number; w: number; h: number };
  sourceSize?: { w: number; h: number };
  pivot?: { x: number; y: number };
  page?: number;
}
/** A frame of {@link clipFromAtlas}: its rect, and where it sits in the untrimmed image, for drawing it unmoved. */
export interface AtlasClipFrame extends SpriteFrame {
  /** Offset of the rect inside the untrimmed image. */
  offset: readonly [number, number];
  /** The untrimmed image's size. */
  sourceSize: readonly [number, number];
  /** Fractions of the untrimmed image. Default the centre. */
  pivot: { readonly x: number; readonly y: number };
  /** The atlas page. Default 0. */
  page: number;
}

/**
 * A clip from named frames of a packed atlas, in the given order. A trimmed frame's rect is smaller than the image it
 * came from, so each clip frame also carries its `offset`, `sourceSize`, `pivot` and `page`.
 * @example
 * ```ts
 * import {clipFromAtlas} from 'margoengine/sprites/atlas';
 * const manifest = {frames: {a: {frame: {x: 0, y: 0, w: 8, h: 8}}, b: {frame: {x: 8, y: 0, w: 8, h: 8}}}};
 * const walk = clipFromAtlas(manifest, ['a', 'b'], {fps: 8, mode: 'pingpong'});
 * ```
 * @param durations Seconds per frame, in place of `fps`.
 * @throws TypeError for a name the manifest does not have, or no names; RangeError for durations of another length.
 */
export function clipFromAtlas(
  manifest: { readonly frames: Readonly<Record<string, AtlasClipEntry>> },
  names: readonly string[],
  options: Pick<SpriteClip, 'fps' | 'mode' | 'events'> & { durations?: readonly number[] } = {},
): SpriteClip & { frames: readonly AtlasClipFrame[] } {
  const { durations, ...clip } = options;
  if (!names?.length) throw new TypeError('clipFromAtlas needs frame names; pass the names in play order');
  if (durations && durations.length !== names.length)
    throw new RangeError(`clipFromAtlas has ${durations.length} durations for ${names.length} frames; pass one each`);
  return {
    ...clip,
    frames: names.map((name, i) => {
      if (!Object.hasOwn(manifest?.frames ?? {}, name))
        throw new TypeError(`Atlas has no frame ${name}; pass a key of manifest.frames`);
      const {
        frame: f,
        spriteSourceSize: at,
        sourceSize: size,
        pivot = { x: 0.5, y: 0.5 },
        page = 0,
      } = manifest.frames[name];
      return {
        rect: [f.x, f.y, f.w, f.h],
        ...(durations ? { duration: durations[i] } : {}),
        offset: [at?.x ?? 0, at?.y ?? 0],
        sourceSize: [size?.w ?? f.w, size?.h ?? f.h],
        pivot,
        page,
      };
    }),
  };
}
