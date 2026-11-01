// Aseprite files and JSON sheets, written only from the public .ase file format specification document. Pure CPU code:
// no GPU or DOM, so it runs in Node.
import { margoError } from '../../shared/errors.js';
import type { SpriteClip, SpriteFrame, SpriteRect } from './animation.js';

/** Which way a tag plays. */
export type AsepriteDirection = 'forward' | 'reverse' | 'pingpong' | 'pingpong_reverse';

/** A named frame range of an Aseprite file. */
export interface AsepriteTag {
  name: string;
  /** First frame, 0-based. */
  from: number;
  /** Last frame, inclusive. */
  to: number;
  /** Default `'forward'`. */
  direction?: AsepriteDirection;
  /** Plays this many times, and a ping-pong this many legs; 0 loops forever. Default 0. */
  repeat?: number;
  /** The tag's user data text. */
  data?: string;
}

/** One key of a slice: it applies from `frame` until the next key. */
export interface AsepriteSliceKey {
  frame: number;
  x: number;
  y: number;
  /** 0 hides the slice from this frame on. */
  width: number;
  height: number;
  /** The 9-slice centre, relative to the slice. */
  center?: { x: number; y: number; width: number; height: number };
  /** The pivot, relative to the slice. */
  pivot?: { x: number; y: number };
}

/** A named region of the sprite: a 9-slice, a pivot or a hit box. */
export interface AsepriteSlice {
  name: string;
  keys: AsepriteSliceKey[];
  /** The slice's user data text. */
  data?: string;
}

/** A layer as stored in the file. */
export interface AsepriteLayer {
  name: string;
  /** 0 image, 1 group, 2 tilemap. */
  type: number;
  visible: boolean;
  /** Group nesting depth. */
  level: number;
  /** The stored blend mode: 0 is Normal. {@link parseAseprite} composites every layer as Normal. */
  blend: number;
  /** 0 to 255. */
  opacity: number;
  /** The layer's user data text. */
  data?: string;
}

/** The result of {@link parseAseprite}. */
export interface AsepriteFile {
  width: number;
  height: number;
  /** One composited image per frame: RGBA8, top row first, not premultiplied. */
  frames: Uint8Array[];
  /** Milliseconds per frame. */
  durations: number[];
  /**
   * One clip per tag, by name (a later tag of the same name wins), with rects in a strip of frames left to right, as
   * {@link AsepriteOptions.columns} lays it out; without tags, one clip `default` over every frame.
   */
  clips: Record<string, SpriteClip>;
  tags: AsepriteTag[];
  slices: AsepriteSlice[];
  layers: AsepriteLayer[];
  /** RGBA8 palette entries, 4 bytes each; empty when the file has none. */
  palette: Uint8Array;
  /** The sprite's user data text. */
  data?: string;
}

/** Options for {@link parseAseprite}. */
export interface AsepriteOptions {
  /** Columns of the sheet the clip rects point into. Default: all frames in one row. */
  columns?: number;
  /** The most pixels to decode, over all frames and cels. Default 2^28. */
  maxPixels?: number;
  /** Stops between frames and rejects with its reason. */
  signal?: AbortSignal;
}

const DIRECTIONS: readonly AsepriteDirection[] = ['forward', 'reverse', 'pingpong', 'pingpong_reverse'],
  MAX_CLIP_FRAMES = 1 << 20,
  MAX_PIXELS = 2 ** 28;

const fail = (why: string): never => {
  throw new RangeError(`Not a valid Aseprite file: ${why}; save it again from Aseprite.`);
};

class Reader {
  readonly view: DataView;
  constructor(
    readonly bytes: Uint8Array,
    public at: number,
    public end: number,
  ) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  need(n: number): number {
    const at = this.at;
    if (at + n > this.end) fail('the data ends early');
    this.at = at + n;
    return at;
  }
  u8 = (): number => this.bytes[this.need(1)];
  u16 = (): number => this.view.getUint16(this.need(2), true);
  i16 = (): number => this.view.getInt16(this.need(2), true);
  u32 = (): number => this.view.getUint32(this.need(4), true);
  i32 = (): number => this.view.getInt32(this.need(4), true);
  skip(n: number): void {
    this.need(n);
  }
  string(): string {
    const length = this.u16();
    return new TextDecoder().decode(this.bytes.subarray(this.need(length), this.at));
  }
}

async function inflate(data: Uint8Array, size: number): Promise<Uint8Array> {
  const reader = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate')).getReader(),
    out = new Uint8Array(size);
  let at = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (at + value.length > size) {
      await reader.cancel();
      fail('a compressed cel larger than its size');
    }
    out.set(value, at);
    at += value.length;
  }
  if (at !== size) fail('a compressed cel smaller than its size');
  return out;
}

interface Cel {
  layer: number;
  x: number;
  y: number;
  opacity: number;
  z: number;
  width: number;
  height: number;
  pixels: Uint8Array;
}

// The frames of a tag in play order. Without a repeat, a clip mode loops them; with one, they are written out.
function clipOf(frames: readonly SpriteFrame[], tag: AsepriteTag): SpriteClip {
  const { from, to, direction = 'forward', repeat = 0 } = tag;
  if (!(Number.isInteger(from) && Number.isInteger(to) && from >= 0 && from <= to && to < frames.length))
    fail(`tag ${tag.name} covers frames ${from}..${to} of ${frames.length}`);
  const forward = frames.slice(from, to + 1),
    backward = [...forward].reverse(),
    reversed = direction === 'reverse' || direction === 'pingpong_reverse',
    first = reversed ? backward : forward,
    second = reversed ? forward : backward;
  if (!repeat) return { frames: first, mode: direction.startsWith('pingpong') ? 'pingpong' : 'loop' };
  if (repeat * forward.length > MAX_CLIP_FRAMES)
    throw new RangeError(`Tag ${tag.name} repeats to over ${MAX_CLIP_FRAMES} frames; repeat it less`);
  const out: SpriteFrame[] = [];
  for (let leg = 0; leg < repeat; leg++)
    if (direction.startsWith('pingpong'))
      // Each leg after the first starts past the frame the last one ended on.
      out.push(...(leg % 2 ? second : first).slice(leg ? 1 : 0));
    else out.push(...first);
  return { frames: out, mode: 'once' };
}
const clipsOf = (frames: readonly SpriteFrame[], tags: readonly AsepriteTag[]): Record<string, SpriteClip> =>
  Object.fromEntries(
    tags.length
      ? tags.map((tag) => [tag.name, clipOf(frames, tag)])
      : [['default', clipOf(frames, { name: 'default', from: 0, to: frames.length - 1 })]],
  );

/**
 * Reads an `.aseprite` or `.ase` file: frames composited to RGBA from its visible layers, frame times, tags as
 * `SpriteAnimation` clips, slices with pivots and 9-slice centres, the palette and user data text. Handles RGBA,
 * grayscale and indexed sprites; raw, linked and compressed cels; layer and cel opacity; z-index. Every layer
 * composites as Normal (each layer's stored mode is in `layers[i].blend`), and a group's opacity multiplies into its
 * children. Runs anywhere with DecompressionStream, Node included.
 * @example
 * ```ts
 * import {encodeAseprite, parseAseprite} from 'margoengine/sprites/aseprite';
 * const file = await encodeAseprite({
 *   width: 1,
 *   height: 1,
 *   frames: [new Uint8Array([255, 0, 0, 255]), new Uint8Array([0, 0, 255, 255])],
 *   tags: [{name: 'blink', from: 0, to: 1}],
 * });
 * const {frames, clips} = await parseAseprite(file);
 * console.log(frames.length, Object.keys(clips));
 * ```
 * @throws RangeError for a damaged file or one over `maxPixels`; MargoError `unsupported` for a visible tilemap layer.
 */
export async function parseAseprite(bytes: Uint8Array, options: AsepriteOptions = {}): Promise<AsepriteFile> {
  const { columns, maxPixels = MAX_PIXELS, signal } = options;
  if (!(bytes instanceof Uint8Array)) throw new TypeError('parseAseprite needs a Uint8Array; pass the file bytes');
  if (columns !== undefined && !(Number.isInteger(columns) && columns >= 1))
    throw new RangeError(`Aseprite columns ${columns} is invalid; pass a whole number >= 1`);
  const r = new Reader(bytes, 0, bytes.length);
  r.skip(4);
  if (r.u16() !== 0xa5e0) fail('a bad header magic');
  const count = r.u16(),
    width = r.u16(),
    height = r.u16(),
    depth = r.u16(),
    flags = r.u32(),
    speed = r.u16();
  r.skip(8);
  const transparent = r.u8();
  r.skip(128 - r.at);
  if (depth !== 32 && depth !== 16 && depth !== 8) fail(`a colour depth of ${depth}`);
  if (!count || !width || !height) fail('an empty sprite');
  const channels = depth / 8;
  let budget = maxPixels;
  const spend = (pixels: number): void => {
    budget -= pixels;
    if (budget < 0)
      throw new RangeError(`Aseprite file is over ${maxPixels} pixels; pass a larger maxPixels if you trust it`);
  };
  spend(width * height * count);
  const layers: AsepriteLayer[] = [],
    backgrounds: boolean[] = [],
    tags: AsepriteTag[] = [],
    slices: AsepriteSlice[] = [],
    durations: number[] = [],
    celsByFrame: Cel[][] = [];
  let palette: Uint8Array | undefined,
    oldPalette: Uint8Array | undefined,
    sprite: { data?: string } = {},
    // What the next user data chunks attach to, in order.
    targets: { data?: string }[] = [];
  for (let frame = 0; frame < count; frame++) {
    signal?.throwIfAborted();
    const start = r.at;
    r.end = bytes.length;
    const size = r.u32();
    if (size < 16 || start + size > bytes.length) fail('a frame outside the file');
    if (r.u16() !== 0xf1fa) fail('a bad frame magic');
    const old = r.u16();
    durations.push(r.u16() || speed || 100);
    r.skip(2);
    const chunks = r.u32() || old,
      cels: Cel[] = [];
    celsByFrame.push(cels);
    r.end = start + size;
    for (let c = 0; c < chunks; c++) {
      const chunkStart = r.at,
        chunkSize = r.u32(),
        type = r.u16(),
        chunkEnd = chunkStart + chunkSize;
      if (chunkSize < 6 || chunkEnd > r.end) fail('a chunk outside its frame');
      const frameEnd = r.end;
      r.end = chunkEnd;
      if (type === 0x2004) {
        const layerFlags = r.u16(),
          layerType = r.u16(),
          level = r.u16();
        r.skip(4);
        const blend = r.u16(),
          opacity = r.u8();
        r.skip(3);
        const layer: AsepriteLayer = {
          name: r.string(),
          type: layerType,
          // A reference layer is a guide, never part of the image.
          visible: !!(layerFlags & 1) && !(layerFlags & 64),
          level,
          blend,
          // Without the header's validity flags a layer's stored opacity means nothing; groups have their own flag.
          opacity: flags & (layerType === 1 ? 2 : 1) ? opacity : 255,
        };
        layers.push(layer);
        backgrounds.push(!!(layerFlags & 8));
        targets = [layer];
      } else if (type === 0x2005) {
        const layer = r.u16(),
          x = r.i16(),
          y = r.i16(),
          opacity = r.u8(),
          celType = r.u16(),
          z = r.i16();
        r.skip(5);
        if (layer >= layers.length) fail('a cel on a missing layer');
        targets = [];
        if (celType === 1) {
          const target = r.u16(),
            linked = target < frame ? celsByFrame[target].find((cel) => cel.layer === layer) : undefined;
          if (target >= frame) fail('a linked cel that points forward');
          if (linked) cels.push(linked);
        } else if (celType === 0 || celType === 2) {
          const w = r.u16(),
            h = r.u16(),
            length = w * h * channels;
          spend(w * h);
          const pixels =
            celType === 0
              ? bytes.subarray(r.need(length), r.at)
              : await inflate(bytes.subarray(r.at, chunkEnd), length);
          cels.push({ layer, x, y, opacity, z, width: w, height: h, pixels });
        } else if (celType === 3) {
          if (layers[layer].visible)
            throw margoError(
              'unsupported',
              `Aseprite layer ${layers[layer].name} is a tilemap; flatten it in Aseprite or hide it before parsing`,
            );
        } else fail(`a cel of type ${celType}`);
      } else if (type === 0x2018) {
        const tagCount = r.u16();
        r.skip(8);
        const added: AsepriteTag[] = [];
        for (let t = 0; t < tagCount; t++) {
          const from = r.u16(),
            to = r.u16(),
            direction = DIRECTIONS[r.u8()];
          if (!direction) fail('a tag with an unknown direction');
          const repeat = r.u16();
          r.skip(10);
          added.push({ name: r.string(), from, to, direction, repeat });
        }
        tags.push(...added);
        targets = added.slice();
      } else if (type === 0x2019) {
        const paletteSize = r.u32(),
          first = r.u32(),
          last = r.u32();
        r.skip(8);
        if (paletteSize > 65536 || last < first || last >= paletteSize) fail('a palette range outside its size');
        const grown = new Uint8Array(paletteSize * 4);
        if (palette) grown.set(palette.subarray(0, grown.length));
        palette = grown;
        for (let i = first; i <= last; i++) {
          const named = r.u16() & 1;
          for (let k = 0; k < 4; k++) palette[i * 4 + k] = r.u8();
          if (named) r.string();
        }
        targets = frame === 0 ? [sprite] : [];
      } else if (type === 0x0004 || type === 0x0011) {
        const packets = r.u16(),
          scale = type === 0x0011 ? 255 / 63 : 1;
        oldPalette ??= new Uint8Array(1024);
        for (let p = 0, i = 0; p < packets; p++) {
          i += r.u8();
          const colours = r.u8() || 256;
          if (i + colours > 256) fail('an old palette past 256 colours');
          for (let k = 0; k < colours; k++, i++) {
            for (let channel = 0; channel < 3; channel++) oldPalette[i * 4 + channel] = Math.round(r.u8() * scale);
            oldPalette[i * 4 + 3] = 255;
          }
        }
      } else if (type === 0x2020) {
        const dataFlags = r.u32(),
          target = targets.shift();
        // Colour and properties are skipped with the rest of the chunk.
        if (dataFlags & 1) {
          const text = r.string();
          if (target) target.data = text;
        }
      } else if (type === 0x2022) {
        const keyCount = r.u32(),
          sliceFlags = r.u32();
        r.skip(4);
        const slice: AsepriteSlice = { name: r.string(), keys: [] };
        for (let k = 0; k < keyCount; k++) {
          const key: AsepriteSliceKey = { frame: r.u32(), x: r.i32(), y: r.i32(), width: r.u32(), height: r.u32() };
          if (sliceFlags & 1) key.center = { x: r.i32(), y: r.i32(), width: r.u32(), height: r.u32() };
          if (sliceFlags & 2) key.pivot = { x: r.i32(), y: r.i32() };
          slice.keys.push(key);
        }
        slices.push(slice);
        targets = [slice];
      }
      r.at = chunkEnd;
      r.end = frameEnd;
    }
    r.at = start + size;
  }
  const table = palette ?? oldPalette ?? new Uint8Array(0),
    // A layer's opacity through its groups, and whether all of them show.
    shown: number[] = [],
    parents: number[] = [];
  layers.forEach((layer, i) => {
    parents[layer.level] = i;
    const parent = layer.level ? shown[parents[layer.level - 1]] : 1;
    shown.push(layer.visible ? (parent ?? 0) * (layer.opacity / 255) : 0);
  });
  const frames = celsByFrame.map((cels) => {
    const image = new Uint8Array(width * height * 4);
    // Order: the layer plus the z-index, then the z-index for ties.
    const sorted = cels
      .filter((cel) => shown[cel.layer] > 0 && layers[cel.layer].type !== 1)
      .sort((a, b) => a.layer + a.z - (b.layer + b.z) || a.z - b.z);
    for (const cel of sorted) {
      const scale = (shown[cel.layer] * cel.opacity) / 255,
        { pixels } = cel,
        keepIndex = backgrounds[cel.layer];
      for (let y = Math.max(0, -cel.y); y < cel.height && y + cel.y < height; y++)
        for (let x = Math.max(0, -cel.x); x < cel.width && x + cel.x < width; x++) {
          const from = (y * cel.width + x) * channels;
          let red: number, green: number, blue: number, alpha: number;
          if (depth === 32)
            [red, green, blue, alpha] = [pixels[from], pixels[from + 1], pixels[from + 2], pixels[from + 3]];
          else if (depth === 16)
            [red, green, blue, alpha] = [pixels[from], pixels[from], pixels[from], pixels[from + 1]];
          else {
            const index = pixels[from];
            if (index === transparent && !keepIndex) continue;
            [red, green, blue, alpha] = [
              table[index * 4],
              table[index * 4 + 1],
              table[index * 4 + 2],
              table[index * 4 + 3],
            ];
            // An index past the palette has no colour.
            alpha ??= 0;
          }
          const to = ((y + cel.y) * width + x + cel.x) * 4,
            source = (alpha / 255) * scale,
            under = image[to + 3] / 255,
            result = source + under * (1 - source);
          if (!source) continue;
          const mix = (a: number, b: number): number => Math.round((a * source + b * under * (1 - source)) / result);
          image[to] = mix(red, image[to]);
          image[to + 1] = mix(green, image[to + 1]);
          image[to + 2] = mix(blue, image[to + 2]);
          image[to + 3] = Math.round(result * 255);
        }
    }
    return image;
  });
  const across = columns ?? count,
    sheet: SpriteFrame[] = durations.map((ms, i) => ({
      rect: [(i % across) * width, Math.floor(i / across) * height, width, height],
      duration: ms / 1000,
    }));
  return {
    width,
    height,
    frames,
    durations,
    clips: clipsOf(sheet, tags),
    tags,
    slices,
    layers,
    palette: table,
    ...sprite,
  };
}

/** What {@link encodeAseprite} writes. */
export interface AsepriteSource {
  width: number;
  height: number;
  /** One RGBA8 image per frame, top row first, not premultiplied. */
  frames: readonly (Uint8Array | Uint8ClampedArray)[];
  /** Milliseconds per frame, 1 to 65535. Default 100 each. */
  durations?: readonly number[];
  tags?: readonly AsepriteTag[];
  slices?: readonly AsepriteSlice[];
  /** RGBA8 entries, 4 bytes each, kept for the artist's swatches. Default: one opaque black entry. */
  palette?: Uint8Array;
}

class Writer {
  private bytes: number[] = [];
  u8(v: number): this {
    this.bytes.push(v & 255);
    return this;
  }
  u16(v: number): this {
    return this.u8(v).u8(v >> 8);
  }
  u32(v: number): this {
    return this.u16(v & 0xffff).u16(v >>> 16);
  }
  zeros(n: number): this {
    for (let i = 0; i < n; i++) this.u8(0);
    return this;
  }
  string(text: string): this {
    const utf8 = new TextEncoder().encode(text);
    if (utf8.length > 65535) throw new RangeError('An Aseprite name is over 65535 bytes; shorten it');
    this.u16(utf8.length);
    for (const byte of utf8) this.u8(byte);
    return this;
  }
  done(): Uint8Array {
    return Uint8Array.from(this.bytes);
  }
}

const join = (parts: readonly Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};
const chunk = (type: number, body: Uint8Array): Uint8Array =>
  join([
    new Writer()
      .u32(body.length + 6)
      .u16(type)
      .done(),
    body,
  ]);

/**
 * Writes an `.aseprite` file with one RGBA layer holding `frames`, plus tags, slices and a palette; zlib from
 * CompressionStream, so it runs anywhere, Node included. The result opens in Aseprite and reads back with
 * {@link parseAseprite}.
 * @example
 * ```ts
 * import {encodeAseprite} from 'margoengine/sprites/aseprite';
 * const red = new Uint8Array([255, 0, 0, 255]);
 * const file: Uint8Array = await encodeAseprite({width: 1, height: 1, frames: [red], durations: [250]});
 * ```
 * @throws RangeError for sizes outside 1..65535, a frame of the wrong length, or a duration, tag or palette out of range.
 */
export async function encodeAseprite(source: AsepriteSource): Promise<Uint8Array> {
  const { width, height, frames, durations, tags = [], slices = [] } = source,
    palette = source.palette ?? new Uint8Array([0, 0, 0, 255]),
    side = (n: number): boolean => Number.isInteger(n) && n >= 1 && n <= 65535;
  if (!side(width) || !side(height))
    throw new RangeError(`Aseprite size ${width}x${height} is invalid; pass whole numbers from 1 to 65535`);
  if (!frames?.length || frames.length > 65535)
    throw new RangeError(`Aseprite frame count ${frames?.length} is invalid; pass 1 to 65535 frames`);
  if (tags.length > 65535) throw new RangeError(`${tags.length} Aseprite tags are too many; pass at most 65535`);
  if (!palette.length || palette.length % 4 || palette.length > 262144)
    throw new RangeError(`Aseprite palette of ${palette.length} bytes is invalid; pass 1 to 65536 RGBA entries`);
  const parts: Uint8Array[] = [];
  for (let i = 0; i < frames.length; i++) {
    const pixels = frames[i],
      duration = durations?.[i] ?? 100,
      chunks: Uint8Array[] = [];
    if (pixels.length !== width * height * 4)
      throw new RangeError(
        `Aseprite frame ${i} has ${pixels.length} bytes, not ${width * height * 4}; pass RGBA8 rows`,
      );
    if (!side(duration)) throw new RangeError(`Aseprite duration ${duration} is invalid; pass 1 to 65535 milliseconds`);
    if (!i) {
      const colours = new Writer()
        .u32(palette.length / 4)
        .u32(0)
        .u32(palette.length / 4 - 1)
        .zeros(8);
      for (let k = 0; k < palette.length; k += 4)
        colours
          .u16(0)
          .u8(palette[k])
          .u8(palette[k + 1])
          .u8(palette[k + 2])
          .u8(palette[k + 3]);
      chunks.push(chunk(0x2019, colours.done()));
      chunks.push(
        chunk(0x2004, new Writer().u16(3).u16(0).u16(0).zeros(4).u16(0).u8(255).zeros(3).string('Layer 1').done()),
      );
      if (tags.length) {
        const list = new Writer().u16(tags.length).zeros(8);
        for (const { name, from, to, direction = 'forward', repeat = 0 } of tags) {
          const code = DIRECTIONS.indexOf(direction);
          if (!(Number.isInteger(from) && Number.isInteger(to) && from >= 0 && from <= to && to < frames.length))
            throw new RangeError(
              `Aseprite tag ${name} covers frames ${from}..${to} of ${frames.length}; pass a range inside`,
            );
          if (code < 0)
            throw new RangeError(`Aseprite tag ${name} has direction ${direction}; pass one of ${DIRECTIONS}`);
          if (!(Number.isInteger(repeat) && repeat >= 0 && repeat <= 65535))
            throw new RangeError(`Aseprite tag ${name} repeats ${repeat} times; pass 0 to 65535`);
          list.u16(from).u16(to).u8(code).u16(repeat).zeros(10).string(name);
        }
        chunks.push(chunk(0x2018, list.done()));
      }
      for (const { name, keys } of slices) {
        const nine = keys.some((key) => key.center),
          pivot = keys.some((key) => key.pivot);
        if ((nine && !keys.every((key) => key.center)) || (pivot && !keys.every((key) => key.pivot)))
          throw new RangeError(
            `Aseprite slice ${name} mixes keys with and without a centre or pivot; give all or none`,
          );
        const body = new Writer()
          .u32(keys.length)
          .u32((nine ? 1 : 0) | (pivot ? 2 : 0))
          .u32(0)
          .string(name);
        for (const key of keys) {
          body.u32(key.frame).u32(key.x).u32(key.y).u32(key.width).u32(key.height);
          if (key.center) body.u32(key.center.x).u32(key.center.y).u32(key.center.width).u32(key.center.height);
          if (key.pivot) body.u32(key.pivot.x).u32(key.pivot.y);
        }
        chunks.push(chunk(0x2022, body.done()));
      }
    }
    const zlib = new Uint8Array(
      await new Response(
        new Blob([pixels as BlobPart]).stream().pipeThrough(new CompressionStream('deflate')),
      ).arrayBuffer(),
    );
    chunks.push(
      chunk(
        0x2005,
        join([new Writer().u16(0).u16(0).u16(0).u8(255).u16(2).u16(0).zeros(5).u16(width).u16(height).done(), zlib]),
      ),
    );
    const body = join(chunks);
    parts.push(
      new Writer()
        .u32(body.length + 16)
        .u16(0xf1fa)
        .u16(chunks.length)
        .u16(duration)
        .zeros(2)
        .u32(chunks.length)
        .done(),
      body,
    );
  }
  const header = new Writer()
    .u32(128 + parts.reduce((sum, part) => sum + part.length, 0))
    .u16(0xa5e0)
    .u16(frames.length)
    .u16(width)
    .u16(height)
    .u16(32)
    .u32(1)
    .u16(durations?.[0] ?? 100)
    .zeros(8)
    .zeros(4)
    .u16(palette.length >= 1024 ? 0 : palette.length / 4)
    .u8(1)
    .u8(1)
    .zeros(2)
    .zeros(2)
    .u16(16)
    .u16(16)
    .zeros(84);
  return join([header.done(), ...parts]);
}

/** A frame entry of an Aseprite JSON sheet. */
export interface AsepriteJSONFrame {
  filename?: string;
  frame: { x: number; y: number; w: number; h: number };
  /** Milliseconds. */
  duration?: number;
}
/** The JSON sheet Aseprite exports, in its hash or array layout. */
export interface AsepriteJSON {
  frames: Readonly<Record<string, AsepriteJSONFrame>> | readonly AsepriteJSONFrame[];
  meta?: {
    frameTags?: readonly {
      name: string;
      from: number;
      to: number;
      direction?: string;
      repeat?: string | number;
    }[];
    slices?: readonly {
      name: string;
      data?: string;
      keys: readonly {
        frame: number;
        bounds: { x: number; y: number; w: number; h: number };
        center?: { x: number; y: number; w: number; h: number };
        pivot?: { x: number; y: number };
      }[];
    }[];
  };
}

/**
 * Reads the JSON sheet Aseprite exports, hash or array: the frames' rects and times as `SpriteAnimation` clips by tag
 * name, and its slices. Without tags, one clip `default` over every frame. A frame without a duration shows 100 ms.
 * Pass the parsed JSON; a hash keeps the order of its keys, so frame names must not be plain numbers.
 * @example
 * ```ts
 * import {SpriteAnimation} from 'margoengine/sprites/animation';
 * import {clipsFromAsepriteJSON} from 'margoengine/sprites/aseprite';
 * const {clips} = clipsFromAsepriteJSON({
 *   frames: [{frame: {x: 0, y: 0, w: 8, h: 8}, duration: 100}, {frame: {x: 8, y: 0, w: 8, h: 8}, duration: 100}],
 *   meta: {frameTags: [{name: 'walk', from: 0, to: 1, direction: 'pingpong'}]},
 * });
 * const walk = new SpriteAnimation({clips});
 * walk.play('walk');
 * ```
 * @throws TypeError for a value that is not such a sheet; RangeError for a tag outside the frames or an unknown direction.
 */
export function clipsFromAsepriteJSON(sheet: AsepriteJSON): {
  clips: Record<string, SpriteClip>;
  rects: SpriteRect[];
  slices: AsepriteSlice[];
} {
  const list = Array.isArray(sheet?.frames)
    ? (sheet.frames as readonly AsepriteJSONFrame[])
    : Object.values((sheet?.frames ?? {}) as Record<string, AsepriteJSONFrame>);
  if (!list.length || !list.every((entry) => entry?.frame))
    throw new TypeError('clipsFromAsepriteJSON needs frames with a frame rectangle; pass the parsed sheet JSON');
  const frames: SpriteFrame[] = list.map(({ frame: { x, y, w, h }, duration }) => ({
      rect: [x, y, w, h],
      duration: (duration || 100) / 1000,
    })),
    tags = (sheet.meta?.frameTags ?? []).map(({ name, from, to, direction = 'forward', repeat }): AsepriteTag => {
      if (!DIRECTIONS.includes(direction as AsepriteDirection))
        throw new RangeError(`Aseprite tag ${name} has direction ${direction}; pass one of ${DIRECTIONS}`);
      return { name, from, to, direction: direction as AsepriteDirection, repeat: Number(repeat ?? 0) };
    }),
    rect = ({ x, y, w, h }: { x: number; y: number; w: number; h: number }) => ({ x, y, width: w, height: h });
  return {
    clips: clipsOf(frames, tags),
    rects: frames.map((frame) => frame.rect),
    slices: (sheet.meta?.slices ?? []).map(({ name, data, keys }) => ({
      name,
      ...(data ? { data } : {}),
      keys: keys.map(({ frame, bounds, center, pivot }) => ({
        frame,
        ...rect(bounds),
        ...(center ? { center: rect(center) } : {}),
        ...(pivot ? { pivot: { x: pivot.x, y: pivot.y } } : {}),
      })),
    })),
  };
}
