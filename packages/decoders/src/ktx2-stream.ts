/// <reference lib="esnext.disposable" preserve="true" />
// Streaming KTX2 mip levels (`@margoengine/decoders/ktx2-stream`). KTX 2.0 stores the smallest level first, so a Range
// read of the head of a file reaches the smallest mips: they go on the GPU at once and finer levels follow, chosen by
// screen size and held inside a memory budget. Each level is wrapped in a one-level KTX2 file and transcoded by the same
// decoders as a whole file. WebGPU textures cannot grow, so a texture is replaced when a level arrives or leaves: the
// levels already there are copied on the GPU, and `onChange` hands over the new texture.
import { decodeFailed } from './errors.js';
import { ASTC_4X4_SFLOAT, readKTX2Index, type KTX2Index } from './ktx2-file.js';
import { KTX2LayerDecoder, type KTX2LayerDecodeOptions } from './ktx2-layers.js';
import { formatBlock, levelBytes, type TextureFile } from './texture-file.js';

declare const GPUTextureUsage: { TEXTURE_BINDING: number; COPY_DST: number; COPY_SRC: number };

/** What the streamer asks of a decoder: one level file to a one-level {@link TextureFile}. */
export interface KTX2LevelDecoder {
  decode(data: Uint8Array, options: KTX2LayerDecodeOptions): Promise<TextureFile>;
  /** The target for files that hold Basis Universal data. */
  target: string;
  dispose?(): void;
}

/** Options of a {@link KTX2Streamer}. */
export interface KTX2StreamerOptions {
  device: GPUDevice;
  /** Most bytes of GPU texture memory all streams may hold. Default 256 MiB. */
  budgetBytes?: number;
  /** Levels loading at once. Default 2. */
  concurrency?: number;
  /** Bytes of a file's first Range read; more follows if its index needs it. Default 64 KiB. */
  headBytes?: number;
  /** Decoder for 8-bit Basis files. Default: a KTX2LayerDecoder on `device`, disposed with the streamer. */
  decoder?: KTX2LevelDecoder;
  /** Decoder for UASTC HDR files. Default: a KTX2HDRDecoder on `device`, loaded when the first HDR file opens. */
  hdrDecoder?: KTX2LevelDecoder;
  /** Default `globalThis.fetch`. */
  fetch?: typeof fetch;
  /** Called when a level of a stream fails to load. The stream keeps the levels it has. */
  onError?: (error: unknown, stream: StreamedKTX2) => void;
}

/** Options of {@link KTX2Streamer.open}. */
export interface KTX2OpenOptions {
  signal?: AbortSignal;
  label?: string;
  /** Texture usage. Default: TEXTURE_BINDING | COPY_DST | COPY_SRC; the copies need the last two, so they are always added. */
  usage?: number;
}

/** Wraps one level in a complete KTX2 file. ETC1S keeps its codebooks and the slice descriptions of that level's images. */
export function ktx2LevelFile(head: Uint8Array, index: KTX2Index, level: number, data: Uint8Array): Uint8Array {
  const { dfd, globalData, supercompression, layerCount, faceCount, levels } = index,
    images = Math.max(1, layerCount) * faceCount,
    basisLZ = supercompression === 1,
    header = 80 + 24,
    dfdAt = header,
    globalAt = (dfdAt + dfd.length + 7) & ~7,
    description = 20,
    prefix = 20,
    globalLength = basisLZ ? globalData.length - (levels.length - 1) * images * description : 0,
    dataAt = (globalAt + globalLength + 15) & ~15,
    out = new Uint8Array(dataAt + data.length),
    view = new DataView(out.buffer);
  out.set(head.subarray(0, 80));
  view.setUint32(20, Math.max(1, index.width >> level), true);
  if (index.height) view.setUint32(24, Math.max(1, index.height >> level), true);
  view.setUint32(40, 1, true);
  view.setUint32(48, dfdAt, true);
  view.setUint32(52, dfd.length, true);
  view.setUint32(56, 0, true);
  view.setUint32(60, 0, true);
  view.setBigUint64(64, BigInt(basisLZ ? globalAt : 0), true);
  view.setBigUint64(72, BigInt(globalLength), true);
  view.setBigUint64(80, BigInt(dataAt), true);
  view.setBigUint64(88, BigInt(data.length), true);
  view.setBigUint64(96, BigInt(index.levels[level].uncompressedLength), true);
  out.set(head.subarray(dfd.offset, dfd.offset + dfd.length), dfdAt);
  if (basisLZ) {
    const at = globalData.offset,
      first = at + prefix + level * images * description,
      tables = at + prefix + levels.length * images * description;
    out.set(head.subarray(at, at + prefix), globalAt);
    out.set(head.subarray(first, first + images * description), globalAt + prefix);
    out.set(head.subarray(tables, at + globalData.length), globalAt + prefix + images * description);
  }
  out.set(data, dataAt);
  return out;
}

/** The coarsest level of a `width` by `height` texture that still covers `pixels` across without magnifying. */
export function levelForPixels(width: number, height: number, pixels: number): number {
  if (!(pixels > 0)) return 32;
  return Math.max(0, Math.floor(Math.log2(Math.max(width, height, 1) / pixels)));
}

/**
 * Streams KTX2 textures: {@link KTX2Streamer.open} resolves as soon as the smallest levels are on the GPU, then
 * {@link StreamedKTX2.want} and {@link KTX2Streamer.update} bring in finer levels by screen size inside `budgetBytes`,
 * dropping levels nothing needs when the budget runs out.
 *
 * @example
 * const streamer = new KTX2Streamer({device, budgetBytes: 128 << 20});
 * const rock = await streamer.open('/rock.ktx2');
 * rock.onChange = (texture) => { material.map = new Texture(texture); };
 * // each frame:
 * rock.want(screenWidthInPixels);
 * streamer.update();
 */
export class KTX2Streamer {
  readonly device: GPUDevice;
  /** Most bytes of GPU texture memory all streams may hold; lower it under memory pressure and call {@link update}. */
  budgetBytes: number;
  private readonly concurrency: number;
  readonly headBytes: number;
  private decoder?: KTX2LevelDecoder;
  private hdrDecoder?: KTX2LevelDecoder;
  private readonly owned: KTX2LevelDecoder[] = [];
  private readonly onError?: KTX2StreamerOptions['onError'];
  readonly fetch: typeof fetch;
  private readonly streams = new Set<StreamedKTX2>();
  private loading = 0;
  private reserved = 0;

  constructor(options: KTX2StreamerOptions) {
    if (!options?.device) throw new TypeError('KTX2Streamer needs a device; pass one in KTX2StreamerOptions.device');
    this.device = options.device;
    this.budgetBytes = options.budgetBytes ?? 256 * 1024 * 1024;
    this.concurrency = options.concurrency ?? 2;
    this.headBytes = options.headBytes ?? 65536;
    if (!(this.budgetBytes > 0)) throw new RangeError('KTX2Streamer budgetBytes must be above 0');
    if (!Number.isSafeInteger(this.concurrency) || this.concurrency < 1)
      throw new RangeError('KTX2Streamer concurrency must be a whole number of at least 1');
    if (!Number.isSafeInteger(this.headBytes) || this.headBytes < 128)
      throw new RangeError('KTX2Streamer headBytes must be a whole number of at least 128');
    this.decoder = options.decoder;
    this.hdrDecoder = options.hdrDecoder;
    this.onError = options.onError;
    this.fetch = options.fetch ?? ((...args) => globalThis.fetch(...args));
  }

  /** GPU bytes the streams hold now. */
  get usedBytes(): number {
    let total = 0;
    for (const stream of this.streams) total += stream.bytes();
    return total;
  }

  /**
   * Opens a KTX2 file by URL (read with Range requests; a server that ignores them sends the whole file, which still
   * works) or from bytes, and uploads its smallest levels.
   *
   * @throws TypeError `KTX2: invalid file (...)` on a damaged header or level index.
   * @throws MargoError `failed` when the file cannot be read or transcoded.
   */
  async open(source: string | URL | Uint8Array, options: KTX2OpenOptions = {}): Promise<StreamedKTX2> {
    const stream = new StreamedKTX2(this, source, options);
    await stream.start();
    this.streams.add(stream);
    return stream;
  }

  /** The decoder for a file, made on first use. */
  async decoderFor(index: KTX2Index): Promise<KTX2LevelDecoder> {
    if (index.vkFormat === ASTC_4X4_SFLOAT) {
      if (!this.hdrDecoder) {
        const { KTX2HDRDecoder } = await import('./ktx2-hdr.js'),
          hdr = new KTX2HDRDecoder({ device: this.device });
        this.hdrDecoder = {
          target: hdr.hdrTarget,
          decode: (data, options) => hdr.decode(data, options),
          dispose: () => hdr.dispose(),
        };
        this.owned.push(this.hdrDecoder);
      }
      return this.hdrDecoder;
    }
    if (!this.decoder) {
      const decoder = new KTX2LayerDecoder({ device: this.device });
      this.decoder = decoder;
      this.owned.push(decoder);
    }
    return this.decoder;
  }

  /**
   * Starts the loads the budget allows, largest on screen first, and drops levels no stream needs to make room. Call it
   * once a frame, or whenever `want` changes; it does nothing while everything is where it should be.
   */
  update(): void {
    let used = this.usedBytes;
    const spare = () =>
      [...this.streams]
        .filter((stream) => !stream.busy && stream.surplus > 0)
        .sort((a, b) => b.surplus - a.surplus || a.pixels - b.pixels)[0];
    const free = (bytes: number) => {
      while (used + this.reserved + bytes > this.budgetBytes) {
        const stream = spare();
        if (!stream) return false;
        used -= stream.shrink();
      }
      return true;
    };
    free(0);
    const wanting = [...this.streams]
      .filter((stream) => !stream.busy && !stream.error && stream.missing > 0)
      .sort((a, b) => b.pixels - a.pixels || b.missing - a.missing);
    for (const stream of wanting) {
      if (this.loading >= this.concurrency) break;
      const cost = stream.nextCost();
      if (!free(cost)) continue;
      this.loading++;
      this.reserved += cost;
      stream.grow().then(
        () => this.finish(cost),
        (error) => {
          if (!stream.signal.aborted) {
            stream.error = error;
            this.onError?.(error, stream);
          }
          this.finish(cost);
        },
      );
    }
  }

  private finish(cost: number): void {
    this.loading--;
    this.reserved -= cost;
    this.update();
  }

  /** Forgets a stream; called by {@link StreamedKTX2.dispose}. */
  release(stream: StreamedKTX2): void {
    this.streams.delete(stream);
  }

  /** Stops every stream, destroys their textures and disposes the decoders this streamer made. */
  dispose(): void {
    for (const stream of [...this.streams]) stream.dispose();
    for (const decoder of this.owned) decoder.dispose?.();
    this.owned.length = 0;
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}

/** One streamed texture. Keep `texture` only until `onChange` replaces it: the old one is destroyed. */
export class StreamedKTX2 {
  /** The current texture; its level 0 is file level {@link residentLevel}. */
  texture!: GPUTexture;
  format!: GPUTextureFormat;
  /** Size of the file's level 0. */
  width = 0;
  height = 0;
  /** Array layers, counting each cube face. */
  layers = 1;
  dimension: TextureFile['dimension'] = '2d';
  /** Mip levels in the file. */
  levels = 0;
  /** The finest file level on the GPU. */
  residentLevel = 0;
  /** The load failure that stopped this stream growing, if any. Clear it to try again. */
  error?: unknown;
  /** Called with the new texture each time it is replaced. */
  onChange?: (texture: GPUTexture) => void;
  /** True while a level is loading. */
  busy = false;
  /** Widest on-screen size in pixels, from {@link want}. */
  pixels = 0;

  private readonly controller = new AbortController();
  private readonly label?: string;
  private readonly usage: number;
  private readonly url?: string;
  private whole?: Uint8Array;
  private head!: Uint8Array;
  private index!: KTX2Index;
  private decoder!: KTX2LevelDecoder;
  private target!: string;
  private block!: NonNullable<ReturnType<typeof formatBlock>>;
  private coarsest = 0;
  private wanted = 0;
  private waiters: (() => void)[] = [];
  private closed = false;

  constructor(
    private readonly owner: KTX2Streamer,
    source: string | URL | Uint8Array,
    options: KTX2OpenOptions,
  ) {
    if (source instanceof Uint8Array) this.whole = source;
    else this.url = String(source);
    this.label = options.label;
    this.usage =
      (options.usage ?? GPUTextureUsage.TEXTURE_BINDING) | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC;
    options.signal?.addEventListener('abort', () => this.controller.abort(options.signal!.reason), { once: true });
    if (options.signal?.aborted) this.controller.abort(options.signal.reason);
  }

  /** Aborts when the stream is disposed. */
  get signal(): AbortSignal {
    return this.controller.signal;
  }
  /** Levels finer than resident that {@link want} asked for. */
  get missing(): number {
    return this.closed ? 0 : Math.max(0, this.residentLevel - this.wanted);
  }
  /** Resident levels finer than wanted. */
  get surplus(): number {
    return this.closed ? 0 : Math.max(0, this.wanted - this.residentLevel);
  }

  /** Asks for enough detail to show `pixels` across. Takes effect on the next {@link KTX2Streamer.update}. */
  want(pixels: number): void {
    this.pixels = pixels;
    this.wanted = Math.min(levelForPixels(this.width, this.height, pixels), this.coarsest);
  }

  /** Resolves with the texture the next time it is replaced; a loop over this is a stream of textures. */
  async *updates(): AsyncGenerator<GPUTexture> {
    while (!this.closed) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
      if (!this.closed) yield this.texture;
    }
  }

  /** GPU bytes this stream holds at base `level`, by default the resident level. */
  bytes(level = this.residentLevel): number {
    let total = 0;
    for (let m = level; m < this.levels; m++) total += this.levelSize(m);
    return total;
  }
  private levelSize(level: number): number {
    return levelBytes(this.block, this.size(this.width, level), this.size(this.height, level))[0] * this.layers;
  }
  private size(value: number, level: number): number {
    return Math.max(1, value >> level);
  }
  /** Bytes the next finer level adds. */
  nextCost(): number {
    return this.levelSize(this.residentLevel - 1);
  }

  private async read(from: number, to: number): Promise<Uint8Array> {
    if (this.whole) return this.whole.subarray(from, to);
    const response = await this.owner.fetch(this.url!, {
      headers: { Range: `bytes=${from}-${to - 1}` },
      signal: this.signal,
    });
    if (response.status === 200) {
      this.whole = new Uint8Array(await response.arrayBuffer());
      return this.whole.subarray(from, to);
    }
    if (response.status !== 206) throw decodeFailed(`KTX2: could not load ${this.url} (${response.status})`);
    return new Uint8Array(await response.arrayBuffer());
  }

  // The first read also learns the file's length from Content-Range.
  private async readHead(): Promise<{ bytes: Uint8Array; total: number }> {
    if (this.whole) return { bytes: this.whole, total: this.whole.length };
    const response = await this.owner.fetch(this.url!, {
      headers: { Range: `bytes=0-${this.owner.headBytes - 1}` },
      signal: this.signal,
    });
    if (!response.ok) throw decodeFailed(`KTX2: could not load ${this.url} (${response.status})`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (response.status === 200) {
      this.whole = bytes;
      return { bytes, total: bytes.length };
    }
    const total = Number(/\/(\d+)$/.exec(response.headers.get('Content-Range') ?? '')?.[1]);
    if (!Number.isSafeInteger(total))
      throw decodeFailed(`KTX2: ${this.url} sent no Content-Range length; serve it with Range support or whole`);
    return { bytes, total };
  }

  /** Reads the index, then uploads the smallest levels a texture of this format can start from. */
  async start(): Promise<void> {
    this.signal.throwIfAborted();
    const { bytes, total } = await this.readHead();
    const index = readKTX2Index(bytes, total),
      end = Math.max(
        index.dfd.offset + index.dfd.length,
        index.keyValues.offset + index.keyValues.length,
        index.globalData.offset + index.globalData.length,
      );
    this.head =
      end <= bytes.length
        ? bytes
        : (() => {
            const all = new Uint8Array(end);
            all.set(bytes);
            return all;
          })();
    if (end > bytes.length) this.head.set(await this.read(bytes.length, end), bytes.length);
    this.index = index;
    if (index.depth > 1) throw decodeFailed('KTX2: 3D textures are not supported; re-encode the file as a 2D array');
    this.width = index.width;
    this.height = Math.max(1, index.height);
    this.levels = index.levels.length;
    this.layers = Math.max(1, index.layerCount) * index.faceCount;
    this.dimension =
      index.faceCount === 6 ? (index.layerCount ? 'cube-array' : 'cube') : index.layerCount ? '2d-array' : '2d';
    this.decoder = await this.owner.decoderFor(index);
    const whole = !(this.width % 4 || this.height % 4);
    this.target = whole ? this.decoder.target : this.decoder.target === 'bc6h' ? 'rgba16float' : 'rgba8';
    // The smallest level names the format, and with it the coarsest level a texture can have as its level 0: WebGPU wants
    // level 0 of a block format to be whole blocks.
    const last = await this.decodeLevel(this.levels - 1);
    this.format = last.format;
    this.block = formatBlock(last.format)!;
    if (!this.block) throw decodeFailed(`KTX2: ${last.format} has no WebGPU texture; decode the file with another target`);
    const [bw, bh] = this.block;
    let coarsest = this.levels - 1;
    while (coarsest > 0 && (this.size(this.width, coarsest) % bw || this.size(this.height, coarsest) % bh)) coarsest--;
    this.coarsest = coarsest;
    this.wanted = coarsest;
    this.residentLevel = coarsest;
    this.texture = this.create(coarsest);
    this.write(this.texture, this.levels - 1 - coarsest, last);
    for (let level = this.levels - 2; level >= coarsest; level--)
      this.write(this.texture, level - coarsest, await this.decodeLevel(level));
  }

  private async decodeLevel(level: number): Promise<TextureFile> {
    const { offset, length } = this.index.levels[level],
      data = await this.read(offset, offset + length),
      file = ktx2LevelFile(this.head, this.index, level, data);
    return this.decoder.decode(file, { signal: this.signal, exactTarget: this.target });
  }

  private create(base: number): GPUTexture {
    return this.owner.device.createTexture({
      label: this.label,
      size: [this.size(this.width, base), this.size(this.height, base), this.layers],
      mipLevelCount: this.levels - base,
      format: this.format,
      usage: this.usage,
    });
  }

  private write(texture: GPUTexture, mipLevel: number, file: TextureFile): void {
    const [bw, bh] = this.block,
      mip = file.mipmaps[0],
      rows = Math.ceil(mip.height / bh);
    this.owner.device.queue.writeTexture(
      { texture, mipLevel },
      mip.data as Uint8Array<ArrayBuffer>,
      { bytesPerRow: levelBytes(this.block, mip.width, mip.height)[1], rowsPerImage: rows },
      [Math.ceil(mip.width / bw) * bw, rows * bh, this.layers],
    );
  }

  // Moves `texture` to a new base level: the levels both share are copied on the GPU, then the old texture goes.
  private rebase(base: number, fill?: TextureFile): void {
    const [bw, bh] = this.block,
      old = this.texture,
      next = this.create(base),
      encoder = this.owner.device.createCommandEncoder(),
      first = Math.max(base, this.residentLevel);
    for (let level = first; level < this.levels; level++)
      encoder.copyTextureToTexture(
        { texture: old, mipLevel: level - this.residentLevel },
        { texture: next, mipLevel: level - base },
        [
          Math.ceil(this.size(this.width, level) / bw) * bw,
          Math.ceil(this.size(this.height, level) / bh) * bh,
          this.layers,
        ],
      );
    this.owner.device.queue.submit([encoder.finish()]);
    if (fill) this.write(next, 0, fill);
    old.destroy();
    this.texture = next;
    this.residentLevel = base;
    this.onChange?.(next);
    for (const resolve of this.waiters.splice(0)) resolve();
  }

  /** Loads the next finer level; the streamer calls this inside its budget. */
  async grow(): Promise<void> {
    this.busy = true;
    try {
      const level = this.residentLevel - 1,
        file = await this.decodeLevel(level);
      if (!this.closed) this.rebase(level, file);
    } finally {
      this.busy = false;
    }
  }

  /** Drops the finest resident level and returns the bytes freed; the streamer calls this to make room. */
  shrink(): number {
    const freed = this.levelSize(this.residentLevel);
    this.rebase(this.residentLevel + 1);
    return freed;
  }

  /** Stops loading, destroys the texture and leaves the streamer. */
  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    this.controller.abort(new DOMException('Disposed', 'AbortError'));
    this.texture?.destroy();
    this.owner.release(this);
    for (const resolve of this.waiters.splice(0)) resolve();
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
