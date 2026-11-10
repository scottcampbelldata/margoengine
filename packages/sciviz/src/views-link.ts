/// <reference lib="esnext.disposable" preserve="true" />
import { fault, rangeError } from '../../shared/errors.js';
import type { Figure } from './figure.js';

/** Camera and range links follow both controls and programmatic changes on the next engine frame. */
export interface LinkedCameraOptions {
  /** Default true for 3D, false for 2D. Copies look-at pose, fov, clip distances and projection override. */
  readonly camera?: boolean;
  /** Default true for 2D, false for 3D. Ranges transfer in physical data units. */
  readonly limits?: boolean;
  /** Linked range axes. Default x/y for 2D, x/y/z for 3D. */
  readonly axes?: readonly ('x' | 'y' | 'z')[];
  /** Removes links and callbacks on abort; figures remain caller-owned. */
  readonly signal?: AbortSignal;
}
const cameraValues = (f: Figure) => {
  const c = f.engine.camera;
  return [...c.position, ...c.target, ...c.up, c.fov, c.near, c.far];
};
/** Bidirectional, echo-free links between an arbitrary number of figures. */
export class LinkedCameras extends EventTarget {
  readonly figures: readonly Figure[];
  readonly #camera: boolean;
  readonly #limits: boolean;
  readonly #axes: readonly number[];
  readonly #off: (() => void)[] = [];
  readonly #seen = new Map<Figure, { values: string; project: unknown }>();
  #dead = false;
  constructor(figures: readonly Figure[], options: LinkedCameraOptions = {}) {
    super();
    options.signal?.throwIfAborted();
    if (
      figures.length < 2 ||
      new Set(figures).size !== figures.length ||
      figures.some((f) => f.is2d !== figures[0].is2d)
    )
      throw rangeError('Link at least two distinct figures of the same dimensionality', 'sciviz');
    this.figures = Object.freeze([...figures]);
    this.#camera = options.camera ?? !figures[0].is2d;
    this.#limits = options.limits ?? figures[0].is2d;
    const axes = options.axes ?? (figures[0].is2d ? ['x', 'y'] : ['x', 'y', 'z']);
    if (!axes.length || new Set(axes).size !== axes.length || axes.some((a) => !['x', 'y', 'z'].includes(a)))
      throw rangeError('Choose distinct linked axes x, y or z', 'sciviz');
    this.#axes = axes.map((a) => ['x', 'y', 'z'].indexOf(a));
    for (const f of figures) this.#remember(f);
    this.sync();
    for (const f of figures) {
      this.#off.push(
        f.engine.onFrame(() => {
          if (this.#dead) return;
          const seen = this.#seen.get(f)!;
          if (seen.values !== this.#stamp(f) || (this.#camera && seen.project !== f.engine.camera.project))
            this.sync(f);
        }),
      );
      const change = () => this.sync(f);
      f.controls?.addEventListener('change', change);
      this.#off.push(() => f.controls?.removeEventListener('change', change));
    }
    const abort = () => this.dispose();
    options.signal?.addEventListener('abort', abort, { once: true });
    this.#off.push(() => options.signal?.removeEventListener('abort', abort));
  }
  #stamp(f: Figure): string {
    return [...(this.#camera ? cameraValues(f) : []), ...(this.#limits ? f.bounds : [])].join(',');
  }
  #remember(f: Figure): void {
    this.#seen.set(f, { values: this.#stamp(f), project: f.engine.camera.project });
  }
  /** Synchronise immediately, including when all engines are stopped. No render is forced. */
  sync(source: Figure = this.figures[0]): void {
    if (this.#dead) throw fault('disposed', 'Camera links disposed; create a new link', 'sciviz');
    if (!this.#seen.has(source)) throw rangeError('Choose a source figure from this link', 'sciviz');
    const sourceBounds = source.bounds;
    const updates = this.figures
      .filter((f) => f !== source)
      .map((f) => {
        const bounds = f.bounds;
        if (this.#limits)
          for (const axis of this.#axes)
            for (const side of [0, 1])
              bounds[2 * axis + side] = f.axisScales[axis].forward(
                source.axisScales[axis].inverse(sourceBounds[2 * axis + side]),
              );
        if (this.#limits && bounds.some((v) => !Number.isFinite(v)))
          throw rangeError('Linked limits must lie inside every target scale domain', 'sciviz');
        return { f, bounds };
      });
    const c = source.engine.camera;
    for (const { f, bounds } of updates) {
      if (this.#limits) f.setLimits(bounds, { space: 'plot' });
      if (this.#camera)
        Object.assign(f.engine.camera, {
          position: [...c.position],
          target: [...c.target],
          up: [...c.up],
          fov: c.fov,
          near: c.near,
          far: c.far,
          project: c.project,
        });
      this.#remember(f);
    }
    this.#remember(source);
    this.dispatchEvent(new CustomEvent('change', { detail: { source, figures: this.figures } }));
  }
  /** Remove callbacks without disposing or resetting the figures. Idempotent. */
  dispose(): void {
    if (this.#dead) return;
    this.#dead = true;
    for (const off of this.#off) off();
    this.#off.length = 0;
    this.#seen.clear();
  }
  /** Enable explicit resource management. */
  [Symbol.dispose](): void {
    this.dispose();
  }
}
/** Create bidirectional camera/range links without import-time effects. */
export const linkCameras = (figures: readonly Figure[], options?: LinkedCameraOptions): LinkedCameras =>
  new LinkedCameras(figures, options);
