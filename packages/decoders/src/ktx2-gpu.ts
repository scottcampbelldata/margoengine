// Transcoding Basis Universal KTX2 files with compute shaders (`@margoengine/decoders/ktx2-gpu`): no Wasm, no worker, and
// none of the 527 KB transcoder download. UASTC blocks decode on the GPU; ETC1S streams are Huffman coded, so the CPU
// reads them to codebook indices and the GPU expands those. The output is RGBA8, byte for byte the texels of the Wasm
// `rgba8` target, which costs 4 bytes a texel on the GPU where BC7 costs 1.
import { decodeFailed, deviceUnsupported } from './errors.js';
import { readBasisLZ, readETC1SSlice, type BasisLZTables } from './etc1s.js';
import { ETC1S_SHADER, UASTC_SHADER, uastcMode, uastcTables } from './ktx2-gpu-shaders.js';
import { levelData, readKTX2Index, type KTX2Index } from './ktx2-file.js';

declare const GPUBufferUsage: { UNIFORM: number; STORAGE: number; COPY_SRC: number; COPY_DST: number };
declare const GPUTextureUsage: { TEXTURE_BINDING: number; COPY_DST: number };

const SRGB_TRANSFER = 2,
  ROW_ALIGNMENT = 256,
  JOB_WORDS = 8,
  GROUP = 8;

/** Options of {@link KTX2GPUDecoder}. */
export interface KTX2GPUDecoderOptions {
  device: GPUDevice;
}

/** Options of {@link KTX2GPUDecoder.createTexture}. */
export interface KTX2GPUTextureOptions {
  signal?: AbortSignal;
  label?: string;
  /** Default TEXTURE_BINDING | COPY_DST; COPY_DST is always added. */
  usage?: number;
}

// One dispatch: whole layers, or some block rows of one layer.
interface Band {
  layers: number;
  firstLayer: number;
  rows: number;
  firstRow: number;
}

function bandsOf(blocksY: number, layers: number, rowBytes: number, limit: number): Band[] {
  const blockRow = rowBytes * 4;
  if (blockRow * blocksY * layers <= limit) return [{ layers, firstLayer: 0, rows: blocksY, firstRow: 0 }];
  const rows = Math.max(1, Math.floor(limit / blockRow)),
    bands: Band[] = [];
  for (let layer = 0; layer < layers; layer++)
    for (let row = 0; row < blocksY; row += rows)
      bands.push({ layers: 1, firstLayer: layer, rows: Math.min(rows, blocksY - row), firstRow: row });
  return bands;
}

/**
 * Transcodes Basis Universal KTX2 files on the GPU to RGBA8 textures, 2D, array and cube, every level.
 *
 * @example
 * const decoder = new KTX2GPUDecoder({device});
 * const texture = await decoder.createTexture(await (await fetch('/rock.ktx2')).arrayBuffer());
 */
export class KTX2GPUDecoder {
  readonly device: GPUDevice;
  private uastc?: Promise<GPUComputePipeline>;
  private etc1s?: Promise<GPUComputePipeline>;
  private tables?: GPUBuffer;

  constructor(options: KTX2GPUDecoderOptions) {
    if (!options?.device) throw new TypeError('KTX2GPUDecoder needs a device; pass one in KTX2GPUDecoderOptions.device');
    this.device = options.device;
  }

  private pipeline(code: string): Promise<GPUComputePipeline> {
    const { device } = this;
    return device.createComputePipelineAsync({
      layout: 'auto',
      compute: { module: device.createShaderModule({ code }), entryPoint: 'main' },
    });
  }

  private storage(data: ArrayBufferView): GPUBuffer {
    const buffer = this.device.createBuffer({
      size: Math.max(16, (data.byteLength + 3) & ~3),
      usage: GPUBufferUsage.STORAGE,
      mappedAtCreation: true,
    });
    new Uint8Array(buffer.getMappedRange()).set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    buffer.unmap();
    return buffer;
  }

  /**
   * Transcodes a whole file into a new texture: an array layer per image, six per cube, level by level.
   *
   * @throws TypeError `KTX2: invalid file (...)` on a damaged header or level index.
   * @throws MargoError `failed` for a file that holds no Basis data, 3D files, texture video and damaged blocks.
   */
  async createTexture(data: ArrayBuffer | ArrayBufferView, options: KTX2GPUTextureOptions = {}): Promise<GPUTexture> {
    const bytes = ArrayBuffer.isView(data)
        ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
        : new Uint8Array(data),
      index = readKTX2Index(bytes);
    if (index.vkFormat)
      throw decodeFailed('KTX2 holds a GPU format, not Basis data; read it with parseKTX2 from decoders/ktx2-layers');
    if (index.depth > 1 || !index.height)
      throw decodeFailed('KTX2: 3D and 1D textures are not supported; re-encode the file as a 2D array');
    options.signal?.throwIfAborted();
    const { device } = this,
      layers = Math.max(1, index.layerCount) * index.faceCount,
      srgb = bytes[index.dfd.offset + 14] === SRGB_TRANSFER,
      basisLZ = index.supercompression === 1,
      format: GPUTextureFormat = srgb ? 'rgba8unorm-srgb' : 'rgba8unorm';
    if (Math.max(index.width, index.height) > device.limits.maxTextureDimension2D)
      throw new RangeError(`Texture ${index.width}x${index.height} exceeds the device's maxTextureDimension2D; request a higher limit`);
    const pipeline = await (basisLZ
      ? (this.etc1s ??= this.pipeline(ETC1S_SHADER))
      : (this.uastc ??= this.pipeline(UASTC_SHADER)));
    const tables = basisLZ
        ? readBasisLZ(
            bytes.subarray(index.globalData.offset, index.globalData.offset + index.globalData.length),
            index.levels.length * layers,
          )
        : undefined,
      codebooks = tables && [this.storage(tables.endpoints), this.storage(tables.selectors)],
      texture = device.createTexture({
        label: options.label,
        size: [index.width, index.height, layers],
        mipLevelCount: index.levels.length,
        format,
        usage: (options.usage ?? GPUTextureUsage.TEXTURE_BINDING) | GPUTextureUsage.COPY_DST,
      });
    try {
      for (let level = 0; level < index.levels.length; level++) {
        options.signal?.throwIfAborted();
        if (tables) this.levelETC1S(pipeline, texture, bytes, index, tables, codebooks!, level, layers);
        else await this.levelUASTC(pipeline, texture, bytes, index, level, layers, options.signal);
      }
    } catch (error) {
      texture.destroy();
      throw error;
    } finally {
      for (const buffer of codebooks ?? []) buffer.destroy();
    }
    return texture;
  }

  private async levelUASTC(
    pipeline: GPUComputePipeline,
    texture: GPUTexture,
    bytes: Uint8Array,
    index: KTX2Index,
    level: number,
    layers: number,
    signal?: AbortSignal,
  ): Promise<void> {
    const width = Math.max(1, index.width >> level),
      height = Math.max(1, index.height >> level),
      blocksX = (width + 3) >> 2,
      blocksY = (height + 3) >> 2,
      blocks = await levelData(bytes, index, level, signal);
    if (blocks.length !== blocksX * blocksY * layers * 16)
      throw decodeFailed(`KTX2 level ${level} holds ${blocks.length} bytes of UASTC, not whole blocks; re-export the file`);
    for (let at = 0; at < blocks.length; at += 16)
      if (uastcMode(blocks[at]) === 19) throw decodeFailed('KTX2: a UASTC block uses a reserved mode; re-export the file');
    this.tables ??= this.storage(uastcTables());
    const table = this.tables;
    this.run(pipeline, texture, level, width, height, layers, (band) => {
      const blockBytes = blocksX * 16,
        at = (band.firstLayer * blocksY + band.firstRow) * blockBytes,
        input = this.storage(blocks.subarray(at, at + band.layers * band.rows * blockBytes));
      return { inputs: [input], bindings: [input, table], hasAlpha: 0 };
    });
  }

  private levelETC1S(
    pipeline: GPUComputePipeline,
    texture: GPUTexture,
    bytes: Uint8Array,
    index: KTX2Index,
    tables: BasisLZTables,
    codebooks: GPUBuffer[],
    level: number,
    layers: number,
  ): void {
    const width = Math.max(1, index.width >> level),
      height = Math.max(1, index.height >> level),
      blocksX = (width + 3) >> 2,
      blocksY = (height + 3) >> 2,
      layerBlocks = blocksX * blocksY,
      color = new Uint32Array(layerBlocks * layers),
      alpha = new Uint32Array(layerBlocks * layers),
      data = bytes.subarray(index.levels[level].offset, index.levels[level].offset + index.levels[level].length);
    let hasAlpha = 0;
    for (let layer = 0; layer < layers; layer++) {
      const image = tables.images[level * layers + layer],
        target = color.subarray(layer * layerBlocks, (layer + 1) * layerBlocks);
      if (image.rgbAt + image.rgbLength > data.length || image.alphaAt + image.alphaLength > data.length)
        throw decodeFailed('KTX2: a BasisLZ image lies outside its level; re-export the file');
      readETC1SSlice(tables, data.subarray(image.rgbAt, image.rgbAt + image.rgbLength), blocksX, blocksY, target);
      if (image.alphaLength) {
        hasAlpha = 1;
        readETC1SSlice(
          tables,
          data.subarray(image.alphaAt, image.alphaAt + image.alphaLength),
          blocksX,
          blocksY,
          alpha.subarray(layer * layerBlocks, (layer + 1) * layerBlocks),
        );
      }
    }
    this.run(pipeline, texture, level, width, height, layers, (band) => {
      const at = (band.firstLayer * blocksY + band.firstRow) * blocksX,
        length = band.layers * band.rows * blocksX,
        rgb = this.storage(color.subarray(at, at + length)),
        a = hasAlpha ? this.storage(alpha.subarray(at, at + length)) : rgb;
      return { inputs: hasAlpha ? [rgb, a] : [rgb], bindings: [rgb, a, ...codebooks], hasAlpha };
    });
  }

  // Decodes one level band by band into a row-aligned buffer and copies that into the texture: sRGB textures cannot be
  // storage textures, so a buffer is the one path all formats share.
  private run(
    pipeline: GPUComputePipeline,
    texture: GPUTexture,
    level: number,
    width: number,
    height: number,
    layers: number,
    prepare: (band: Band) => { inputs: GPUBuffer[]; bindings: GPUBuffer[]; hasAlpha: number },
  ): void {
    const { device } = this,
      rowBytes = Math.ceil((width * 4) / ROW_ALIGNMENT) * ROW_ALIGNMENT,
      blocksX = (width + 3) >> 2,
      blocksY = (height + 3) >> 2,
      limit = device.limits.maxStorageBufferBindingSize;
    if (rowBytes * 4 > limit) throw deviceUnsupported(`A row of ${width} texels exceeds the device's storage buffer limit; use KTX2LayerDecoder`);
    for (const band of bandsOf(blocksY, layers, rowBytes, limit)) {
      const { inputs, bindings, hasAlpha } = prepare(band),
        rows = band.rows * 4,
        pixels = device.createBuffer({
          size: rowBytes * rows * band.layers,
          usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
        }),
        job = device.createBuffer({
          size: JOB_WORDS * 4,
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
      device.queue.writeBuffer(
        job,
        0,
        Uint32Array.of(blocksX, band.rows, band.firstRow, width, height, rowBytes / 4, hasAlpha, 0),
      );
      const encoder = device.createCommandEncoder(),
        pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(
        0,
        device.createBindGroup({
          layout: pipeline.getBindGroupLayout(0),
          entries: [job, pixels, ...bindings].map((buffer, binding) => ({ binding, resource: { buffer } })),
        }),
      );
      pass.dispatchWorkgroups(Math.ceil(blocksX / GROUP), Math.ceil(band.rows / GROUP), band.layers);
      pass.end();
      encoder.copyBufferToTexture(
        { buffer: pixels, bytesPerRow: rowBytes, rowsPerImage: rows },
        { texture, mipLevel: level, origin: [0, band.firstRow * 4, band.firstLayer] },
        [width, Math.min(rows, height - band.firstRow * 4), band.layers],
      );
      device.queue.submit([encoder.finish()]);
      // Work already submitted finishes first; destroy only frees the memory afterwards.
      for (const buffer of [pixels, job, ...inputs]) buffer.destroy();
    }
  }

  /** Frees the shader tables. Textures already made stay. */
  dispose(): void {
    this.tables?.destroy();
    this.tables = undefined;
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
