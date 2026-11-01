/// <reference lib="esnext.disposable" preserve="true" />
import type { Stats } from './index.js';

/** One group of live GPU objects. */
export interface GPUMemoryGroup {
  count: number;
  bytes: number;
}
/** What {@link GPUMemory.toJSON} returns. */
export interface GPUMemoryReport {
  buffers: GPUMemoryGroup;
  textures: GPUMemoryGroup;
  bytes: number;
  /** The same per object label; objects without one are under `''`. */
  labels: Record<string, GPUMemoryGroup>;
}
/** What {@link statsReport} returns; safe for `JSON.stringify`. */
export interface StatsReport {
  fps: number;
  frameTime: number;
  drawCalls: number;
  dispatches: number;
  gpuTime: number | null;
  /** Frame times in milliseconds, oldest first. */
  frames: number[];
  memory?: GPUMemoryReport;
}

const SIZES: readonly [RegExp, number][] = [
  [/^(r8|stencil8)/, 1],
  [/^(r16|rg8|depth16)/, 2],
  [/^(rgba16|rg32|depth32float-stencil8)/, 8],
  [/^rgba32/, 16],
];
/** Bytes of one texel of a format, or of one 4x4 block of a compressed one (`block` true). */
function texel(format: string): { size: number; block: boolean } {
  if (/^(bc1|bc4|etc2-rgb|etc2-rgb8|eac-r11)/.test(format)) return { size: 8, block: true };
  if (/^(bc|etc2|eac|astc)/.test(format)) return { size: 16, block: true };
  return { size: SIZES.find(([test]) => test.test(format))?.[1] ?? 4, block: false };
}
/** The bytes a texture holds, every mip and sample; drivers may pad it. */
export function textureBytes(descriptor: GPUTextureDescriptor): number {
  const size = descriptor.size as number[] | { width: number; height?: number; depthOrArrayLayers?: number },
    [w, h = 1, d = 1] = Array.isArray(size)
      ? size
      : [
          (size as { width: number }).width,
          (size as { height?: number }).height,
          (size as { depthOrArrayLayers?: number }).depthOrArrayLayers,
        ],
    { size: bytes, block } = texel(descriptor.format as string),
    volume = descriptor.dimension === '3d';
  let total = 0;
  for (let mip = 0; mip < (descriptor.mipLevelCount ?? 1); mip++) {
    const x = Math.max(w >> mip, 1),
      y = Math.max(h >> mip, 1),
      z = volume ? Math.max(d >> mip, 1) : d;
    total += (block ? Math.ceil(x / 4) * Math.ceil(y / 4) : x * y) * z * bytes;
  }
  return total * (descriptor.sampleCount ?? 1);
}

/**
 * Counts the GPU memory a device's buffers and textures hold, from when it is attached: objects made earlier are not
 * seen. It wraps the device's `createBuffer` and `createTexture` until `dispose()`. Sizes are what the descriptors ask
 * for; drivers may pad them, and depth24plus counts as 4 bytes. `view` shows the totals in a {@link Stats} panel.
 */
export class GPUMemory {
  private readonly groups = {
    buffers: { count: 0, bytes: 0 },
    textures: { count: 0, bytes: 0 },
  };
  private readonly labels = new Map<string, GPUMemoryGroup>();
  private readonly restore: () => void;
  private timer?: ReturnType<typeof setInterval>;
  private row?: HTMLElement;

  static attach(device: GPUDevice): GPUMemory {
    return new GPUMemory(device);
  }
  constructor(device: GPUDevice) {
    const createBuffer = device.createBuffer,
      createTexture = device.createTexture;
    device.createBuffer = (descriptor) =>
      this.count(createBuffer.call(device, descriptor), this.groups.buffers, descriptor.size, descriptor.label);
    device.createTexture = (descriptor) =>
      this.count(
        createTexture.call(device, descriptor),
        this.groups.textures,
        textureBytes(descriptor),
        descriptor.label,
      );
    this.restore = () => {
      device.createBuffer = createBuffer;
      device.createTexture = createTexture;
    };
  }
  private count<T extends { destroy(): void }>(object: T, group: GPUMemoryGroup, bytes: number, label = ''): T {
    let labelled = this.labels.get(label);
    if (!labelled) this.labels.set(label, (labelled = { count: 0, bytes: 0 }));
    const add = (sign: number) => {
      group.count += sign;
      group.bytes += sign * bytes;
      labelled.count += sign;
      labelled.bytes += sign * bytes;
    };
    add(1);
    const destroy = object.destroy;
    let live = true;
    object.destroy = () => {
      if (live) add(-1);
      live = false;
      destroy.call(object);
    };
    return object;
  }
  /** Live bytes in all buffers and textures. */
  get bytes(): number {
    return this.groups.buffers.bytes + this.groups.textures.bytes;
  }
  /** A copy of the current totals. */
  toJSON(): GPUMemoryReport {
    return {
      buffers: { ...this.groups.buffers },
      textures: { ...this.groups.textures },
      bytes: this.bytes,
      labels: Object.fromEntries([...this.labels].map(([label, group]) => [label, { ...group }])),
    };
  }
  /** Shows the totals in a row of the Stats panel, refreshed twice a second until `dispose()`. */
  view(stats: Stats): this {
    if (this.row) return this;
    const row = (this.row = stats.element.ownerDocument.createElement('div')),
      show = () => {
        const { buffers, textures } = this.groups;
        row.textContent = `GPU ${(this.bytes / 1048576).toFixed(1)} MB, ${buffers.count} buffers, ${textures.count} textures`;
      };
    stats.element.append(row);
    show();
    this.timer = setInterval(show, 500);
    return this;
  }
  /** Stops counting and removes the view; objects keep working. */
  dispose(): void {
    clearInterval(this.timer);
    this.row?.remove();
    this.row = undefined;
    this.restore();
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}

/** The numbers of a `Stats`, and optionally a {@link GPUMemory}, as a plain object: `JSON.stringify(statsReport(stats))`. */
export function statsReport(stats: Stats, memory?: GPUMemory): StatsReport {
  const frames: number[] = [],
    length = stats.samples.length;
  for (let i = 0; i < stats.sampleCount; i++)
    frames.push(stats.samples[(stats.sampleIndex - stats.sampleCount + i + length) % length]);
  return {
    fps: stats.fps,
    frameTime: stats.frameTime,
    drawCalls: stats.drawCalls,
    dispatches: stats.dispatches,
    gpuTime: stats.gpuTime,
    frames,
    ...(memory && { memory: memory.toJSON() }),
  };
}
