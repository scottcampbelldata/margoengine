/// <reference lib="esnext.disposable" preserve="true" />
declare const GPUTextureUsage: { TEXTURE_BINDING: number; COPY_DST: number };

/** `DensityBrush` settings. */
export interface DensityBrushOptions {
  /** World rectangle `[minX, minZ, maxX, maxZ]`, the `bounds` of the `Scatter` that reads it. */
  bounds: readonly [number, number, number, number];
  /** Texels per side, 1 to 8192: one integer, or `[width, height]`. Default 256. */
  resolution?: number | readonly [number, number];
  /** Density everywhere at the start, 0 to 1. Default 0. */
  fill?: number;
}
/** One brush stroke. */
export interface DensityStroke {
  /** World units. */
  radius: number;
  /** Density added at the centre per stroke, -1 to 1; below 0 erases. Default 1. */
  strength?: number;
  /** Fraction of the radius at full strength, 0 to 1, fading to nothing at the edge. Default 0.5. */
  hardness?: number;
}

/**
 * A paintable density map for `Scatter`'s `densityMap`: paint it with a brush, or fill it from a splat map, and it uploads
 * only the changed rectangle when the texture is next read: `densityMap: () => brush.texture(device)`.
 * @throws RangeError for empty `bounds`, a size outside 1 to 8192 or a `fill` outside 0 to 1.
 */
export class DensityBrush {
  readonly width: number;
  readonly height: number;
  /** One byte per texel, row 0 at `minZ`. After writing here yourself, call {@link touch}. */
  readonly data: Uint8Array;
  private readonly bounds: readonly [number, number, number, number];
  private gpu?: GPUTexture;
  private device?: GPUDevice;
  private left = 0;
  private top = 0;
  private right = 0;
  private bottom = 0;

  constructor({ bounds, resolution = 256, fill = 0 }: DensityBrushOptions) {
    const [width, height] = typeof resolution === 'number' ? [resolution, resolution] : resolution;
    if (
      !(bounds?.[2] > bounds?.[0] && bounds[3] > bounds[1]) ||
      !Number.isInteger(width) ||
      !Number.isInteger(height) ||
      width < 1 ||
      height < 1 ||
      width > 8192 ||
      height > 8192 ||
      !(fill >= 0 && fill <= 1)
    )
      throw new RangeError(
        'Invalid DensityBrush; pass bounds with max above min, a resolution from 1 to 8192 and a fill from 0 to 1',
      );
    this.bounds = bounds;
    this.width = width;
    this.height = height;
    this.data = new Uint8Array(width * height).fill(Math.round(fill * 255));
    this.touch();
  }
  /** Marks a texel rectangle `[left, right)` by `[top, bottom)` as changed; the default is all of it. */
  touch(left = 0, top = 0, right = this.width, bottom = this.height): void {
    if (this.right > this.left) {
      left = Math.min(left, this.left);
      top = Math.min(top, this.top);
      right = Math.max(right, this.right);
      bottom = Math.max(bottom, this.bottom);
    }
    this.left = left;
    this.top = top;
    this.right = right;
    this.bottom = bottom;
  }
  /**
   * One stroke at world `(x, z)`.
   * @throws RangeError when `radius` is not positive, or `strength` or `hardness` is out of range.
   */
  paint(x: number, z: number, { radius, strength = 1, hardness = 0.5 }: DensityStroke): void {
    if (
      !(radius > 0) ||
      !Number.isFinite(radius) ||
      !Number.isFinite(x) ||
      !Number.isFinite(z) ||
      !(Math.abs(strength) <= 1) ||
      !(hardness >= 0 && hardness <= 1)
    )
      throw new RangeError(
        'Invalid density stroke; pass a finite position, radius > 0, strength from -1 to 1 and hardness from 0 to 1',
      );
    const [minX, minZ, maxX, maxZ] = this.bounds,
      sx = this.width / (maxX - minX),
      sz = this.height / (maxZ - minZ),
      left = Math.max(Math.floor((x - radius - minX) * sx), 0),
      right = Math.min(Math.ceil((x + radius - minX) * sx), this.width),
      top = Math.max(Math.floor((z - radius - minZ) * sz), 0),
      bottom = Math.min(Math.ceil((z + radius - minZ) * sz), this.height);
    if (right <= left || bottom <= top) return;
    for (let row = top; row < bottom; row++)
      for (let column = left; column < right; column++) {
        const d = Math.hypot((column + 0.5) / sx + minX - x, (row + 0.5) / sz + minZ - z) / radius;
        if (d >= 1) continue;
        const fade = d <= hardness ? 1 : (1 - d) / (1 - hardness),
          at = row * this.width + column;
        // Uint8Array wraps, so clamp by hand.
        this.data[at] = Math.min(255, Math.max(0, Math.round(this.data[at] + fade * strength * 255)));
      }
    this.touch(left, top, right, bottom);
  }
  /**
   * Sets the density from an RGBA8 splat map of any size (nearest texel): each channel times its weight, summed and clamped.
   * `[0, 1, 0, 0]` makes the green layer the density.
   * @throws RangeError when `pixels` is not `width * height * 4` bytes.
   */
  fromSplat(
    pixels: ArrayLike<number>,
    width: number,
    height: number,
    weights: readonly [number, number, number, number],
  ): void {
    if (!(width > 0 && height > 0) || pixels?.length !== width * height * 4)
      throw new RangeError('Invalid splat map; pass width * height * 4 RGBA bytes');
    for (let row = 0; row < this.height; row++)
      for (let column = 0; column < this.width; column++) {
        const at =
          (Math.floor(((row + 0.5) * height) / this.height) * width +
            Math.floor(((column + 0.5) * width) / this.width)) *
          4;
        this.data[row * this.width + column] = Math.min(
          255,
          Math.max(
            0,
            Math.round(
              pixels[at] * weights[0] +
                pixels[at + 1] * weights[1] +
                pixels[at + 2] * weights[2] +
                pixels[at + 3] * weights[3],
            ),
          ),
        );
      }
    this.touch();
  }
  /** The density at world `(x, z)`, 0 to 1; 0 outside the bounds. For placing things by the same map. */
  at(x: number, z: number): number {
    const [minX, minZ, maxX, maxZ] = this.bounds,
      column = Math.floor(((x - minX) / (maxX - minX)) * this.width),
      row = Math.floor(((z - minZ) / (maxZ - minZ)) * this.height);
    return column < 0 || row < 0 || column >= this.width || row >= this.height
      ? 0
      : this.data[row * this.width + column] / 255;
  }
  /** The r8unorm texture on `device`, made on first use, with changes since the last call uploaded. */
  texture(device: GPUDevice): GPUTexture {
    if (this.device !== device) {
      this.gpu?.destroy();
      this.device = device;
      this.gpu = device.createTexture({
        label: 'scatter:density',
        size: [this.width, this.height],
        format: 'r8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });
      this.touch();
    }
    if (this.right > this.left) {
      const width = this.right - this.left,
        height = this.bottom - this.top;
      device.queue.writeTexture(
        { texture: this.gpu!, origin: [this.left, this.top] },
        this.data as Uint8Array<ArrayBuffer>,
        { offset: this.top * this.width + this.left, bytesPerRow: this.width, rowsPerImage: height },
        [width, height],
      );
      this.left = this.right = 0;
    }
    return this.gpu!;
  }
  /** Frees the texture; the next `texture()` makes it again. */
  dispose(): void {
    this.gpu?.destroy();
    this.gpu = this.device = undefined;
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
