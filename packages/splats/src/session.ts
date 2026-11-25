// @margoengine/splats/session: an interactive editing session over a splat cloud's data, the tools of a splat editor
// (selection by brush, rectangle, lasso, sphere, box, colour or opacity; invert, hide, delete, move/rotate/scale the
// selection, colour adjust, undo and redo, export) on the CPU, so it works headless, in tests and in tools. Selection
// by a screen region projects each centre by the view-projection matrix, as the GPU brush (`./edit`) does with the last
// frame. The tool list follows the public feature lists of SuperSplat (PlayCanvas) and the editing tasks in
// Chen et al. 2024, "GaussianEditor: Swift and Controllable 3D Editing with Gaussian Splatting" (arXiv:2311.14521);
// the renderer is Kerbl et al. 2023, "3D Gaussian Splatting for Real-Time Radiance Field Rendering".
// History keeps, per step, only the rows the step changed (a swap patch), so undo and redo cost the edit, not the cloud.
import { validateSplats, type SplatData } from './data.js';
import { transformSplats } from './edit.js';
import type { Splats } from './index.js';

const HIDDEN = 1,
  DELETED = 2,
  C0 = 0.2820947918;

/** How a selection tool combines its hits with the current selection. */
export type SelectionMode = 'replace' | 'add' | 'subtract';
/** A camera and viewport for screen-space selection: `viewProjection` column-major 4x4, pixels from the top left. */
export interface SelectionView {
  viewProjection: ArrayLike<number>;
  width: number;
  height: number;
}
/** Colour changes of {@link SplatEditSession.adjustColor}; each defaults to no change. */
export interface ColorAdjust {
  /** Linear multiplier of RGB. Default 1. */
  brightness?: number;
  /** Scale about mid grey 0.5. Default 1. */
  contrast?: number;
  /** 0 grey, 1 unchanged, above 1 more vivid. Default 1. */
  saturation?: number;
  /** Hue turn in degrees about the grey axis. Default 0. */
  hue?: number;
  /** Multiplier of opacity (result kept within 0 to 1.5625). Default 1. */
  opacity?: number;
}
/** Export formats of {@link SplatEditSession.encode}. */
export type SplatExportFormat = 'ply' | 'spz' | 'splat' | 'sog';

interface Patch {
  selection?: Uint8Array;
  indices?: Uint32Array;
  positions?: Float32Array;
  covariances?: Float32Array;
  colors?: Float32Array;
  sh?: Float32Array;
  state?: Uint8Array;
}

const finite = (v: ArrayLike<number>, n: number) => v?.length === n && Array.from(v).every(Number.isFinite);

/**
 * `new SplatEditSession(data)` (the data is copied), then select, edit and `toData()` / `encode('ply')`. Hidden and
 * deleted splats are never selected. Selection tools return `this` and are undoable like every edit.
 * @throws TypeError / RangeError when `data` is invalid (`validateSplats`).
 */
export class SplatEditSession {
  readonly count: number;
  private readonly positions: Float32Array;
  private readonly covariances: Float32Array;
  private readonly colors: Float32Array;
  private readonly sh: Float32Array | undefined;
  private readonly per: number;
  private selected: Uint8Array;
  private readonly state: Uint8Array;
  private undoStack: Patch[] = [];
  private redoStack: Patch[] = [];
  /** Steps kept for undo. Default 64. */
  maxHistory = 64;
  constructor(data: SplatData) {
    this.count = validateSplats(data);
    this.positions = data.positions.slice();
    this.covariances = data.covariances.slice();
    this.colors = data.colors.slice();
    this.sh = data.sphericalHarmonics?.slice();
    this.per = this.sh ? this.sh.length / this.count / 3 : 0;
    this.selected = new Uint8Array(this.count);
    this.state = new Uint8Array(this.count);
  }
  /** A session over a cloud's current data, GPU edits included (`Splats.read`). */
  static async fromCloud(cloud: Splats): Promise<SplatEditSession> {
    return new SplatEditSession(await cloud.read());
  }
  /** Splats selected. */
  get selectedCount(): number {
    let n = 0;
    for (let i = 0; i < this.count; i++) n += this.selected[i];
    return n;
  }
  /** Indices of the selected splats, ascending. */
  get selection(): Uint32Array {
    return Uint32Array.from({ length: this.count }, (_, i) => i).filter((i) => this.selected[i]);
  }
  /** Splats neither hidden nor deleted. */
  get visibleCount(): number {
    let n = 0;
    for (let i = 0; i < this.count; i++) n += this.state[i] === 0 ? 1 : 0;
    return n;
  }
  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }
  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  // ---- selection -------------------------------------------------------------------------------------------------

  /** Selects the visible splats `hit(index)` accepts, combined by `mode`. */
  private pickWhere(hit: (i: number) => boolean, mode: SelectionMode): this {
    if (!['replace', 'add', 'subtract'].includes(mode))
      throw new RangeError("Selection mode must be 'replace', 'add' or 'subtract'");
    const next = this.selected.slice();
    for (let i = 0; i < this.count; i++) {
      const h = this.state[i] === 0 && hit(i);
      if (mode === 'replace') next[i] = h ? 1 : 0;
      else if (h) next[i] = mode === 'add' ? 1 : 0;
    }
    return this.setSelection(next);
  }
  private setSelection(next: Uint8Array): this {
    if (next.every((v, i) => v === this.selected[i])) return this;
    this.push({ selection: this.selected });
    this.selected = next;
    return this;
  }
  /** Selects every visible splat. */
  selectAll(): this {
    return this.pickWhere(() => true, 'replace');
  }
  /** Empties the selection. */
  clearSelection(): this {
    return this.setSelection(new Uint8Array(this.count));
  }
  /** Selects the visible splats that are not selected and deselects the rest. */
  invertSelection(): this {
    const next = new Uint8Array(this.count);
    for (let i = 0; i < this.count; i++) next[i] = this.state[i] === 0 && !this.selected[i] ? 1 : 0;
    return this.setSelection(next);
  }
  /** Splats whose centre is inside the axis-aligned box, world units. */
  selectBox(min: ArrayLike<number>, max: ArrayLike<number>, mode: SelectionMode = 'replace'): this {
    if (!finite(min, 3) || !finite(max, 3)) throw new RangeError('selectBox needs finite min and max of 3 numbers');
    const p = this.positions;
    return this.pickWhere(
      (i) => p[i * 3] >= min[0] && p[i * 3] <= max[0] && p[i * 3 + 1] >= min[1] && p[i * 3 + 1] <= max[1] && p[i * 3 + 2] >= min[2] && p[i * 3 + 2] <= max[2],
      mode,
    );
  }
  /** Splats whose centre is within `radius` of `center`, world units. */
  selectSphere(center: ArrayLike<number>, radius: number, mode: SelectionMode = 'replace'): this {
    if (!finite(center, 3) || !(radius >= 0 && radius < Infinity)) throw new RangeError('selectSphere needs a centre and a radius of 0 or more');
    const p = this.positions;
    return this.pickWhere(
      (i) => (p[i * 3] - center[0]) ** 2 + (p[i * 3 + 1] - center[1]) ** 2 + (p[i * 3 + 2] - center[2]) ** 2 <= radius * radius,
      mode,
    );
  }
  /** Projects every centre to pixels; `null` for centres behind the camera. */
  private project(view: SelectionView): (i: number) => [number, number] | null {
    const m = view?.viewProjection;
    if (!m || m.length !== 16 || !Array.from(m).every(Number.isFinite) || !(view.width > 0) || !(view.height > 0))
      throw new RangeError('A selection view needs a 16-number viewProjection and a positive width and height');
    const p = this.positions;
    return (i) => {
      const x = p[i * 3],
        y = p[i * 3 + 1],
        z = p[i * 3 + 2],
        w = m[3] * x + m[7] * y + m[11] * z + m[15];
      if (!(w > 0)) return null;
      return [
        (((m[0] * x + m[4] * y + m[8] * z + m[12]) / w + 1) / 2) * view.width,
        ((1 - (m[1] * x + m[5] * y + m[9] * z + m[13]) / w) / 2) * view.height,
      ];
    };
  }
  /** The brush: splats whose projected centre is within `radius` pixels of (`x`, `y`). */
  selectBrush(view: SelectionView, x: number, y: number, radius: number, mode: SelectionMode = 'replace'): this {
    if (![x, y, radius].every(Number.isFinite) || radius < 0) throw new RangeError('selectBrush needs finite x, y and a radius of 0 or more');
    const at = this.project(view);
    return this.pickWhere((i) => {
      const s = at(i);
      return !!s && (s[0] - x) ** 2 + (s[1] - y) ** 2 <= radius * radius;
    }, mode);
  }
  /** The rectangle: splats whose projected centre is inside the pixel rectangle (`x0`, `y0`) to (`x1`, `y1`). */
  selectRect(view: SelectionView, x0: number, y0: number, x1: number, y1: number, mode: SelectionMode = 'replace'): this {
    if (![x0, y0, x1, y1].every(Number.isFinite)) throw new RangeError('selectRect needs 4 finite pixel coordinates');
    const at = this.project(view),
      [a, b] = [Math.min(x0, x1), Math.max(x0, x1)],
      [c, d] = [Math.min(y0, y1), Math.max(y0, y1)];
    return this.pickWhere((i) => {
      const s = at(i);
      return !!s && s[0] >= a && s[0] <= b && s[1] >= c && s[1] <= d;
    }, mode);
  }
  /** The lasso: splats whose projected centre is inside the closed polygon of pixel points `[x, y]` (even-odd rule). */
  selectLasso(view: SelectionView, polygon: ReadonlyArray<readonly [number, number]>, mode: SelectionMode = 'replace'): this {
    if (!Array.isArray(polygon) || polygon.length < 3 || !polygon.every((q) => finite(q, 2)))
      throw new RangeError('selectLasso needs a polygon of at least 3 finite [x, y] points');
    const at = this.project(view);
    return this.pickWhere((i) => {
      const s = at(i);
      if (!s) return false;
      let inside = false;
      for (let a = 0, b = polygon.length - 1; a < polygon.length; b = a++) {
        const [ax, ay] = polygon[a],
          [bx, by] = polygon[b];
        if (ay > s[1] !== by > s[1] && s[0] < ((bx - ax) * (s[1] - ay)) / (by - ay) + ax) inside = !inside;
      }
      return inside;
    }, mode);
  }
  /** Splats whose display colour is within `tolerance` (Euclidean, linear RGB 0 to 1.74) of `rgb`; SH base band used when present. */
  selectByColor(rgb: ArrayLike<number>, tolerance: number, mode: SelectionMode = 'replace'): this {
    if (!finite(rgb, 3) || !(tolerance >= 0)) throw new RangeError('selectByColor needs an RGB colour and a tolerance of 0 or more');
    return this.pickWhere((i) => {
      const c = this.baseColor(i);
      return (c[0] - rgb[0]) ** 2 + (c[1] - rgb[1]) ** 2 + (c[2] - rgb[2]) ** 2 <= tolerance * tolerance;
    }, mode);
  }
  /** Splats whose opacity is within `min` to `max` (inclusive); select faint floaters with `selectByOpacity(0, 0.1)`. */
  selectByOpacity(min: number, max: number, mode: SelectionMode = 'replace'): this {
    if (!(min <= max) || ![min, max].every(Number.isFinite)) throw new RangeError('selectByOpacity needs min <= max');
    return this.pickWhere((i) => this.colors[i * 4 + 3] >= min && this.colors[i * 4 + 3] <= max, mode);
  }
  private baseColor(i: number): number[] {
    if (!this.sh) return [this.colors[i * 4], this.colors[i * 4 + 1], this.colors[i * 4 + 2]];
    const at = i * this.per * 3;
    return [0, 1, 2].map((c) => Math.min(1, Math.max(0, 0.5 + C0 * this.sh![at + c])));
  }

  // ---- edits -----------------------------------------------------------------------------------------------------

  /** Hides the selected splats (kept, not exported or selectable) and deselects them. */
  hideSelected(): this {
    return this.markSelected(HIDDEN);
  }
  /** Deletes the selected splats (removed from `toData()`; undo brings them back) and deselects them. */
  deleteSelected(): this {
    return this.markSelected(DELETED);
  }
  private markSelected(flag: number): this {
    const idx = this.indicesOf(this.selected);
    if (!idx.length) return this;
    this.push({ ...this.capture(idx), selection: this.selected });
    for (const i of idx) this.state[i] |= flag;
    this.selected = new Uint8Array(this.count);
    return this;
  }
  /** Shows every hidden splat again (deleted ones stay deleted). */
  unhideAll(): this {
    const idx = this.indicesOf(this.state, HIDDEN);
    if (!idx.length) return this;
    this.push(this.capture(idx));
    for (const i of idx) this.state[i] &= ~HIDDEN;
    return this;
  }
  /**
   * Moves, turns and scales the selected splats by a column-major 4x4 affine `matrix` (`transformSplats`: covariances
   * and SH turn with it), about `about` when given (default the world origin).
   * @throws RangeError for an invalid or singular matrix or pivot.
   */
  transformSelected(matrix: ArrayLike<number>, options: { about?: ArrayLike<number> } = {}): this {
    const idx = this.indicesOf(this.selected);
    let m = Array.from(matrix ?? []);
    const c = options.about;
    if (c) {
      if (!finite(c, 3)) throw new RangeError('transformSelected `about` needs 3 finite numbers');
      if (m.length === 16) {
        // T(c) M T(-c): the translation becomes t + c - A c.
        for (let r = 0; r < 3; r++) m[12 + r] += c[r] - (m[r] * c[0] + m[4 + r] * c[1] + m[8 + r] * c[2]);
      }
    }
    const moved = transformSplats(this.subset(idx.length ? idx : [0]), m); // validates the matrix even for an empty selection
    if (!idx.length) return this;
    this.push(this.capture(idx));
    idx.forEach((i, k) => {
      this.positions.set(moved.positions.subarray(k * 3, k * 3 + 3), i * 3);
      this.covariances.set(moved.covariances.subarray(k * 6, k * 6 + 6), i * 6);
      if (this.sh) this.sh.set(moved.sphericalHarmonics!.subarray(k * this.per * 3, (k + 1) * this.per * 3), i * this.per * 3);
    });
    return this;
  }
  /** Changes the colour (and opacity) of the selected splats; with SH only the base band is adjusted. */
  adjustColor(adjust: ColorAdjust): this {
    const { brightness = 1, contrast = 1, saturation = 1, hue = 0, opacity = 1 } = adjust ?? {};
    if (![brightness, contrast, saturation, hue, opacity].every(Number.isFinite) || brightness < 0 || saturation < 0 || opacity < 0)
      throw new RangeError('adjustColor needs finite numbers; brightness, saturation and opacity of 0 or more');
    const idx = this.indicesOf(this.selected);
    if (!idx.length) return this;
    this.push(this.capture(idx));
    const a = (hue * Math.PI) / 180,
      cs = Math.cos(a),
      sn = Math.sin(a),
      // Rotation about the grey axis (1,1,1)/sqrt(3), the usual hue matrix.
      k = (1 - cs) / 3,
      s3 = Math.sqrt(1 / 3) * sn,
      h = [cs + k, k - s3, k + s3, k + s3, cs + k, k - s3, k - s3, k + s3, cs + k];
    for (const i of idx) {
      const base = this.baseColor(i);
      let rgb = base.map((v) => (v * brightness - 0.5) * contrast + 0.5);
      const luma = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
      rgb = rgb.map((v) => luma + (v - luma) * saturation);
      rgb = [0, 1, 2].map((r) => h[r * 3] * rgb[0] + h[r * 3 + 1] * rgb[1] + h[r * 3 + 2] * rgb[2]).map((v) => Math.min(1, Math.max(0, v)));
      for (let c = 0; c < 3; c++) {
        this.colors[i * 4 + c] = rgb[c];
        if (this.sh) this.sh[i * this.per * 3 + c] = (rgb[c] - 0.5) / C0;
      }
      this.colors[i * 4 + 3] = Math.min(1.5625, this.colors[i * 4 + 3] * opacity);
    }
    return this;
  }

  // ---- history ---------------------------------------------------------------------------------------------------

  /** Reverts the last edit or selection change; returns whether there was one. */
  undo(): boolean {
    return this.step(this.undoStack, this.redoStack);
  }
  /** Reapplies the last undone step; returns whether there was one. */
  redo(): boolean {
    return this.step(this.redoStack, this.undoStack);
  }
  private step(from: Patch[], to: Patch[]): boolean {
    const patch = from.pop();
    if (!patch) return false;
    to.push(this.swap(patch));
    return true;
  }
  private push(patch: Patch): void {
    this.undoStack.push(patch);
    this.redoStack = [];
    if (this.undoStack.length > this.maxHistory) this.undoStack.splice(0, this.undoStack.length - this.maxHistory);
  }
  /** Rows of `idx` as they are now (state included), to restore later. */
  private capture(idx: Uint32Array): Patch {
    const p = this.subset(idx);
    return {
      indices: idx,
      positions: p.positions,
      covariances: p.covariances,
      colors: p.colors,
      sh: p.sphericalHarmonics,
      state: Uint8Array.from(idx, (i) => this.state[i]),
    };
  }
  /** Exchanges the patch's content with the session's: the patch then holds what was replaced. */
  private swap(p: Patch): Patch {
    if (p.selection) [p.selection, this.selected] = [this.selected, p.selection];
    const idx = p.indices;
    if (idx) {
      const k = this.per * 3;
      const swapRows = (own: Float32Array | undefined, saved: Float32Array | undefined, width: number) => {
        if (!own || !saved) return;
        idx.forEach((i, n) => {
          for (let j = 0; j < width; j++) {
            const t = own[i * width + j];
            own[i * width + j] = saved[n * width + j];
            saved[n * width + j] = t;
          }
        });
      };
      swapRows(this.positions, p.positions, 3);
      swapRows(this.covariances, p.covariances, 6);
      swapRows(this.colors, p.colors, 4);
      swapRows(this.sh, p.sh, k);
      idx.forEach((i, n) => {
        const t = this.state[i];
        this.state[i] = p.state![n];
        p.state![n] = t;
      });
    }
    return p;
  }
  private indicesOf(array: Uint8Array, mask = 0xff): Uint32Array {
    const out: number[] = [];
    for (let i = 0; i < this.count; i++) if (array[i] & mask) out.push(i);
    return Uint32Array.from(out);
  }
  private subset(idx: ArrayLike<number>): SplatData {
    const n = idx.length,
      k = this.per * 3,
      out: SplatData = {
        positions: new Float32Array(n * 3),
        covariances: new Float32Array(n * 6),
        colors: new Float32Array(n * 4),
      };
    if (this.sh) out.sphericalHarmonics = new Float32Array(n * k);
    for (let j = 0; j < n; j++) {
      const i = idx[j];
      out.positions.set(this.positions.subarray(i * 3, i * 3 + 3), j * 3);
      out.covariances.set(this.covariances.subarray(i * 6, i * 6 + 6), j * 6);
      out.colors.set(this.colors.subarray(i * 4, i * 4 + 4), j * 4);
      if (this.sh) out.sphericalHarmonics!.set(this.sh.subarray(i * k, (i + 1) * k), j * k);
    }
    return out;
  }

  // ---- output ----------------------------------------------------------------------------------------------------

  /**
   * The edited cloud without hidden and deleted splats, as a new data set.
   * @throws RangeError when none are left.
   */
  toData(): SplatData {
    const keep = Uint32Array.from({ length: this.count }, (_, i) => i).filter((i) => this.state[i] === 0);
    if (!keep.length) throw new RangeError('No splats are left; undo the deletes or unhide them.');
    return this.subset(keep);
  }
  /**
   * The edited cloud written as a file: `'ply'` (Gaussian PLY), `'spz'`, `'splat'` or `'sog'`, by the package's
   * encoders. Hidden and deleted splats are left out.
   * @throws RangeError for another format or when no splats are left; the encoder's errors (SPZ needs `CompressionStream`).
   */
  async encode(format: SplatExportFormat): Promise<Uint8Array<ArrayBuffer>> {
    const data = this.toData();
    if (format === 'ply') return (await import('./formats.js')).encodePly(data);
    if (format === 'spz') return (await import('./encode.js')).encodeSpz(data);
    if (format === 'sog') return (await import('./encode.js')).encodeSog(data);
    if (format === 'splat') return (await import('./ply.js')).encodeSplat(data);
    throw new RangeError("Export format must be 'ply', 'spz', 'splat' or 'sog'");
  }
  /**
   * Writes the edited splats into `cloud` (same splat count, as `fromCloud` made it): hidden and deleted splats take
   * opacity 0, so the draw shows the edit without a new cloud.
   * @throws RangeError when the counts differ.
   */
  applyTo(cloud: Splats): Splats {
    if (cloud.count !== this.count) throw new RangeError(`applyTo needs a cloud of ${this.count} splats; this one has ${cloud.count}`);
    const data = this.subset(Uint32Array.from({ length: this.count }, (_, i) => i));
    for (let i = 0; i < this.count; i++) if (this.state[i]) data.colors[i * 4 + 3] = 0;
    cloud.write(0, data);
    return cloud;
  }
}
