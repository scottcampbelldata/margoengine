// Packed sprite atlases: transparent borders trimmed, rectangles placed by MaxRects with best-short-side-fit (Jylanki
// 2010, "A Thousand Ways to Pack the Bin"), a pivot per frame, one or more pages. Pure CPU code, anywhere, Node included.
import type { Pixels } from './capture.js';

/** One image to pack. */
export interface AtlasSource extends Pixels {
  /** The frame's name in the manifest. Default `frame<index>`. */
  readonly name?: string;
  /** Pivot as fractions of the untrimmed image: `{x: 0, y: 0}` is the top left. Default the `pivot` option. */
  readonly pivot?: { readonly x: number; readonly y: number };
}

/** Options for {@link packAtlasFrames}. */
export interface PackAtlasFramesOptions {
  /** Cut fully transparent borders; a fully transparent image keeps one pixel. Default true. */
  trim?: boolean;
  /** Empty pixels between frames. Default 0. */
  padding?: number;
  /** Pixels each frame's edge repeats outward, to stop filtering bleed. Default 0. */
  extrude?: number;
  /** Pivot of frames without their own, as fractions of the untrimmed image. Default the centre. */
  pivot?: { x: number; y: number };
  /** Largest page side, up to 16384. Default 4096. */
  maxSize?: number;
  /** Round page sides up to powers of two. Default false. */
  powerOfTwo?: boolean;
  /** Most pages to use. Default 1. */
  pages?: number;
}

/** Where a frame landed. */
export interface PackedAtlasFrame {
  name: string;
  /** Index into `pages`. */
  page: number;
  /** The frame's pixels on its page, without padding or extrusion. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Offset of those pixels inside the untrimmed image. */
  offsetX: number;
  offsetY: number;
  /** The untrimmed image's size. */
  sourceWidth: number;
  sourceHeight: number;
  /** Fractions of the untrimmed image. */
  pivot: { x: number; y: number };
}

/** The result of {@link packAtlasFrames}. */
export interface PackedAtlas {
  /** RGBA8 page images, transparent where nothing landed. */
  pages: { data: Uint8Array; width: number; height: number }[];
  /** In the order of the sources. */
  frames: PackedAtlasFrame[];
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const whole = (value: number, name: string, low: number, high = Infinity): void => {
  if (!(Number.isInteger(value) && value >= low && value <= high))
    throw new RangeError(
      `Atlas ${name} ${value} is invalid; pass a whole number from ${low}${high < Infinity ? ` to ${high}` : ' up'}`,
    );
};
const checkPivot = ({ x, y }: { x: number; y: number }, name: string): void => {
  if (!(Number.isFinite(x) && Number.isFinite(y)))
    throw new RangeError(`Atlas pivot of ${name} is invalid; pass finite fractions of the image, {x, y}`);
};

// The opaque part's bounds. A fully transparent image keeps its top-left pixel.
function trimmed({ data, width, height }: Pixels): Rect {
  let left = width,
    top = height,
    right = -1,
    bottom = -1;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      if (data[(y * width + x) * 4 + 3]) {
        left = Math.min(left, x);
        right = Math.max(right, x);
        top = Math.min(top, y);
        bottom = y;
      }
  return right < 0 ? { x: 0, y: 0, w: 1, h: 1 } : { x: left, y: top, w: right - left + 1, h: bottom - top + 1 };
}

// One MaxRects bin: the free rectangles, which may overlap each other.
class Bin {
  free: Rect[];
  constructor(size: number) {
    this.free = [{ x: 0, y: 0, w: size, h: size }];
  }
  // The free rectangle leaving the smallest short side, then long side; the first such in list order.
  fit(w: number, h: number): Rect | undefined {
    let best: Rect | undefined,
      shortest = Infinity,
      longest = Infinity;
    for (const space of this.free) {
      if (space.w < w || space.h < h) continue;
      const a = space.w - w,
        b = space.h - h,
        short = Math.min(a, b),
        long = Math.max(a, b);
      if (short < shortest || (short === shortest && long < longest)) [best, shortest, longest] = [space, short, long];
    }
    return best;
  }
  place(used: Rect): void {
    const next: Rect[] = [];
    for (const space of this.free) {
      if (
        used.x >= space.x + space.w ||
        used.x + used.w <= space.x ||
        used.y >= space.y + space.h ||
        used.y + used.h <= space.y
      ) {
        next.push(space);
        continue;
      }
      const right = used.x + used.w,
        bottom = used.y + used.h;
      if (used.x > space.x) next.push({ ...space, w: used.x - space.x });
      if (right < space.x + space.w) next.push({ ...space, x: right, w: space.x + space.w - right });
      if (used.y > space.y) next.push({ ...space, h: used.y - space.y });
      if (bottom < space.y + space.h) next.push({ ...space, y: bottom, h: space.y + space.h - bottom });
    }
    // Drop every rectangle inside another; of two equal ones the first stays.
    this.free = next.filter(
      (a, i) =>
        !next.some(
          (b, j) =>
            i !== j &&
            a.x >= b.x &&
            a.y >= b.y &&
            a.x + a.w <= b.x + b.w &&
            a.y + a.h <= b.y + b.h &&
            (j < i || a.w !== b.w || a.h !== b.h || a.x !== b.x || a.y !== b.y),
        ),
    );
  }
}

const nextPower = (n: number): number => 2 ** Math.ceil(Math.log2(n));

/**
 * Packs images into one or more atlas pages: optional trimming, padding, extruded edges and a pivot per frame. The
 * first page size tried is the smallest square that could hold the frames, doubling up to `maxSize`; the same sources
 * always give the same pages.
 * @example
 * ```ts
 * import {atlasManifest, packAtlasFrames} from 'margoengine/exporters/atlas';
 * const dot = {name: 'dot', data: new Uint8Array([0, 0, 0, 0, 255, 0, 0, 255]), width: 2, height: 1};
 * const atlas = packAtlasFrames([dot], {padding: 1});
 * const manifest = atlasManifest(atlas, {image: 'hero.png'});
 * console.log(manifest.frames.dot.spriteSourceSize);
 * ```
 * @throws RangeError for an option or image out of range, a duplicate name, a frame larger than `maxSize`, or frames that
 * do not fit in `pages` pages (the message names the fix).
 */
export function packAtlasFrames(sources: readonly AtlasSource[], options: PackAtlasFramesOptions = {}): PackedAtlas {
  const {
    trim = true,
    padding = 0,
    extrude = 0,
    pivot = { x: 0.5, y: 0.5 },
    maxSize = 4096,
    powerOfTwo = false,
    pages = 1,
  } = options;
  whole(padding, 'padding', 0);
  whole(extrude, 'extrude', 0);
  whole(maxSize, 'maxSize', 1, 16384);
  whole(pages, 'pages', 1);
  checkPivot(pivot, 'the option');
  if (!sources?.length) throw new RangeError('Atlas needs at least one frame; pass an array of images');
  const names = new Set<string>(),
    // The gap counts inside each cell, so the bin grows by one gap to leave none at its far edge.
    gap = padding + 2 * extrude,
    items = sources.map((source, index) => {
      const { data, width, height, name = `frame${index}` } = source;
      if (!(Number.isInteger(width) && Number.isInteger(height) && width >= 1 && height >= 1))
        throw new RangeError(`Atlas frame ${name} has size ${width}x${height}; pass whole numbers of pixels >= 1`);
      if (data?.length !== width * height * 4)
        throw new RangeError(
          `Atlas frame ${name} has ${data?.length} bytes, not ${width * height * 4}; pass RGBA8 rows`,
        );
      if (names.has(name)) throw new RangeError(`Atlas frame name ${name} is used twice; give each frame its own name`);
      names.add(name);
      checkPivot(source.pivot ?? pivot, name);
      const bounds = trim ? trimmed(source) : { x: 0, y: 0, w: width, h: height };
      if (bounds.w + 2 * extrude > maxSize || bounds.h + 2 * extrude > maxSize)
        throw new RangeError(
          `Atlas frame ${name} needs ${bounds.w + 2 * extrude}x${bounds.h + 2 * extrude}, over maxSize ${maxSize}; raise maxSize`,
        );
      return { source, index, name, bounds };
    }),
    // Biggest first; ties keep the source order.
    order = [...items].sort(
      (a, b) =>
        Math.max(b.bounds.w, b.bounds.h) - Math.max(a.bounds.w, a.bounds.h) ||
        b.bounds.w * b.bounds.h - a.bounds.w * a.bounds.h ||
        a.index - b.index,
    );
  const fill = (size: number): { bins: number; at: (Rect & { page: number })[] } | undefined => {
      const bins: Bin[] = [],
        at: (Rect & { page: number })[] = [];
      for (const { bounds, index } of order) {
        const w = bounds.w + gap,
          h = bounds.h + gap;
        let page = bins.findIndex((bin) => bin.fit(w, h));
        if (page < 0) {
          if (bins.length === pages) return undefined;
          page = bins.push(new Bin(size + padding)) - 1;
        }
        const space = bins[page].fit(w, h);
        if (!space) return undefined;
        const used = { x: space.x, y: space.y, w, h };
        bins[page].place(used);
        at[index] = { ...used, page };
      }
      return { bins: bins.length, at };
    },
    area = items.reduce((sum, { bounds }) => sum + (bounds.w + gap) * (bounds.h + gap), 0),
    widest = items.reduce((most, { bounds }) => Math.max(most, bounds.w + 2 * extrude, bounds.h + 2 * extrude), 1);
  let size = Math.min(maxSize, Math.max(nextPower(Math.ceil(Math.sqrt(area))), nextPower(widest))),
    packed = fill(size);
  // A smaller single page beats spilling onto more; only maxSize may spill.
  while (size < maxSize && (!packed || packed.bins > 1)) {
    size = Math.min(maxSize, size * 2);
    packed = fill(size);
  }
  if (!packed)
    throw new RangeError(
      `Atlas frames do not fit ${pages} page(s) of ${maxSize}x${maxSize}; raise pages or maxSize, or trim the frames`,
    );
  const out: PackedAtlas['pages'] = [],
    sized = Array.from({ length: packed.bins }, (_, page) => {
      let w = 1,
        h = 1;
      for (const rect of packed!.at)
        if (rect.page === page) {
          w = Math.max(w, rect.x + rect.w - padding);
          h = Math.max(h, rect.y + rect.h - padding);
        }
      if (powerOfTwo) [w, h] = [nextPower(w), nextPower(h)];
      return [w, h];
    });
  for (const [width, height] of sized) out.push({ data: new Uint8Array(width * height * 4), width, height });
  const frames = items.map(({ source, name, bounds, index }): PackedAtlasFrame => {
    const cell = packed!.at[index],
      page = out[cell.page];
    // Rows and columns past the edge read the nearest edge pixel.
    for (let y = -extrude; y < bounds.h + extrude; y++) {
      const fromY = bounds.y + Math.min(bounds.h - 1, Math.max(0, y)),
        toRow = (cell.y + extrude + y) * page.width + cell.x;
      for (let x = -extrude; x < bounds.w + extrude; x++) {
        const fromX = bounds.x + Math.min(bounds.w - 1, Math.max(0, x)),
          from = (fromY * source.width + fromX) * 4,
          to = (toRow + extrude + x) * 4;
        page.data.set(source.data.subarray(from, from + 4), to);
      }
    }
    return {
      name,
      page: cell.page,
      x: cell.x + extrude,
      y: cell.y + extrude,
      width: bounds.w,
      height: bounds.h,
      offsetX: bounds.x,
      offsetY: bounds.y,
      sourceWidth: source.width,
      sourceHeight: source.height,
      pivot: { ...(source.pivot ?? pivot) },
    };
  });
  return { pages: out, frames };
}

/** A frame of an {@link AtlasManifest}, in the JSON hash layout 2D engines read. */
export interface AtlasManifestFrame {
  frame: { x: number; y: number; w: number; h: number };
  rotated: false;
  trimmed: boolean;
  spriteSourceSize: { x: number; y: number; w: number; h: number };
  sourceSize: { w: number; h: number };
  pivot: { x: number; y: number };
  /** Index into `meta.pages`. */
  page: number;
}
/** The JSON that {@link atlasManifest} writes. */
export interface AtlasManifest {
  frames: Record<string, AtlasManifestFrame>;
  meta: {
    app: string;
    version: string;
    /** The first page's image name. */
    image: string;
    format: 'RGBA8888';
    /** The first page's size. */
    size: { w: number; h: number };
    scale: '1';
    pages: { image: string; size: { w: number; h: number } }[];
  };
}

/**
 * The manifest of a packed atlas, in the JSON hash layout 2D engines read: `frame`, `spriteSourceSize`, `sourceSize` and
 * `pivot` per frame, plus `page` and `meta.pages` for more than one page.
 * @param image A page's image name, or a function from page index to name. A plain name gets `-<page>` before its
 * extension on pages after the first. Default `'atlas.png'`.
 */
export function atlasManifest(
  atlas: PackedAtlas,
  { image = 'atlas.png' }: { image?: string | ((page: number) => string) } = {},
): AtlasManifest {
  const pages = atlas.pages.map(({ width, height }, page) => ({
    image:
      typeof image === 'function'
        ? image(page)
        : page
          ? image.replace(/(\.[^./]*)?$/, (ext) => `-${page}${ext}`)
          : image,
    size: { w: width, h: height },
  }));
  return {
    frames: Object.fromEntries(
      atlas.frames.map((f) => [
        f.name,
        {
          frame: { x: f.x, y: f.y, w: f.width, h: f.height },
          rotated: false as const,
          trimmed: f.width !== f.sourceWidth || f.height !== f.sourceHeight,
          spriteSourceSize: { x: f.offsetX, y: f.offsetY, w: f.width, h: f.height },
          sourceSize: { w: f.sourceWidth, h: f.sourceHeight },
          pivot: { ...f.pivot },
          page: f.page,
        },
      ]),
    ),
    meta: {
      app: 'margoengine',
      version: '1',
      image: pages[0].image,
      format: 'RGBA8888',
      size: pages[0].size,
      scale: '1',
      pages,
    },
  };
}
