/// <reference lib="esnext.disposable" preserve="true" />
import { invertMatrix, projectPoint } from '@margoengine/math/mat4';
import { fault, rangeError } from '../../shared/errors.js';
import { annotationControllers } from './annotation-state.js';
import type { Figure } from './figure.js';
import { dataToClip, screenRay } from './pick.js';
import { registerPublicationOverlay } from './publication-labels.js';
import {
  annotationSnapshot,
  annotationMeasure,
  firstVolumeHit,
  firstGridHit,
  type Annotation,
  type AnnotationPoint,
  type PickVolume,
  type VolumeHit,
  type GridHit,
} from './annotate-math.js';
import type { UnstructuredGrid } from './grids.js';
export {
  annotationMeasure,
  annotationContains,
  firstVolumeHit,
  firstGridHit,
  type Annotation,
  type AnnotationKind,
  type AnnotationPoint,
  type PickVolume,
  type VolumeHit,
  type GridHit,
} from './annotate-math.js';

/** Editable annotations in a physical linear data frame. */
export interface AnnotationOptions {
  /** Default true. Handles are excluded from exported figures. */ readonly editable?: boolean;
  /** Initial portable records, default empty. */ readonly annotations?: readonly Annotation[];
  /** Removes handles, export integration and listeners on abort. */ readonly signal?: AbortSignal;
}
type Path = { points: number[][]; color: string; width: number; closed?: boolean };
type Label = { point: number[]; text: string; color: string };
const managers = annotationControllers;
const xml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!);
const svgNS = 'http://www.w3.org/2000/svg';

/** Figure annotations, measurement handles, picking and export/state lifecycle. */
export class Annotations extends EventTarget {
  readonly figure: Figure;
  readonly element: SVGSVGElement;
  readonly #canvas: HTMLCanvasElement;
  readonly #records = new Map<string, Annotation>();
  readonly #events = new AbortController();
  readonly #resize: ResizeObserver;
  readonly #offFrame: () => void;
  readonly #offExport: () => void;
  readonly #editable: boolean;
  #disposed = false;
  #drag?: { id: string; index: number; depth: number; pointer: number };
  constructor(figure: Figure, options: AnnotationOptions = {}) {
    super();
    options.signal?.throwIfAborted();
    if (managers.has(figure)) throw fault('state', 'Figure already has annotations; reuse its controller', 'sciviz');
    if (figure.axisScales.some((s) => s.type !== 'linear'))
      throw rangeError('Physical annotations need linear axes; use a linear figure', 'sciviz');
    const records = (options.annotations ?? []).map(annotationSnapshot);
    if (new Set(records.map((a) => a.id)).size !== records.length)
      throw rangeError('Annotation IDs must be unique', 'sciviz');
    this.figure = figure;
    this.#editable = options.editable ?? true;
    this.#canvas = (figure.engine as unknown as { canvas: HTMLCanvasElement }).canvas;
    const parent = this.#canvas.parentElement ?? document.body;
    if (getComputedStyle(parent).position === 'static') parent.style.position = 'relative';
    this.element = document.createElementNS(svgNS, 'svg');
    this.element.setAttribute('aria-label', 'Figure annotations and measurement handles');
    this.element.style.cssText = 'position:absolute;pointer-events:none;overflow:hidden;z-index:2';
    parent.append(this.element);
    for (const a of records) this.#records.set(a.id, a);
    const signal = this.#events.signal;
    this.element.addEventListener(
      'pointerdown',
      (event) => {
        const target = (event.target as Element).closest('[data-handle]');
        if (!target || !this.#editable) return;
        const id = target.getAttribute('data-id')!,
          index = Number(target.getAttribute('data-handle')),
          a = this.#records.get(id)!;
        const p = this.#project(a.points[index]);
        if (!p) return;
        event.preventDefault();
        event.stopPropagation();
        this.#drag = { id, index, depth: p[2], pointer: event.pointerId };
        this.element.setPointerCapture(event.pointerId);
      },
      { signal },
    );
    this.element.addEventListener(
      'pointermove',
      (event) => {
        if (!this.#drag || event.pointerId !== this.#drag.pointer) return;
        const r = this.#canvas.getBoundingClientRect(),
          p = this.#unproject(event.clientX - r.left, event.clientY - r.top, this.#drag.depth);
        if (p) this.moveHandle(this.#drag.id, this.#drag.index, p);
      },
      { signal },
    );
    const end = () => {
      this.#drag = undefined;
    };
    this.element.addEventListener('pointerup', end, { signal });
    this.element.addEventListener('pointercancel', end, { signal });
    this.element.addEventListener(
      'keydown',
      (event) => {
        const target = (event.target as Element).closest('[data-handle]');
        if (!target || !this.#editable) return;
        const delta = event.shiftKey ? 10 : 1,
          dx = event.key === 'ArrowRight' ? delta : event.key === 'ArrowLeft' ? -delta : 0,
          dy = event.key === 'ArrowDown' ? delta : event.key === 'ArrowUp' ? -delta : 0;
        if (!dx && !dy) return;
        const id = target.getAttribute('data-id')!,
          index = Number(target.getAttribute('data-handle')),
          point = this.#project(this.#records.get(id)!.points[index]);
        if (!point) return;
        const p = this.#unproject(point[0] + dx, point[1] + dy, point[2]);
        if (p) {
          event.preventDefault();
          this.moveHandle(id, index, p);
          this.element
            .querySelector<SVGElement>(
              `[data-handle="${index}"][data-record="${Array.from(this.#records.keys()).indexOf(id)}"]`,
            )
            ?.focus();
        }
      },
      { signal },
    );
    this.#resize = new ResizeObserver(() => this.render());
    this.#resize.observe(this.#canvas);
    this.#offFrame = figure.engine.onFrame(() =>
      queueMicrotask(() => {
        if (!this.#disposed) this.render();
      }),
    );
    this.#offExport = registerPublicationOverlay(figure, {
      svg: (width, height) => this.#svg(width, height, false),
      paint: (ctx, width, height) => this.#paint(ctx, width, height),
      dispose: () => this.dispose(),
    });
    managers.set(figure, this);
    this.#save();
    options.signal?.addEventListener('abort', () => this.dispose(), { once: true, signal });
    this.render();
    if (options.signal?.aborted) this.dispose();
  }
  #check(): void {
    if (this.#disposed) throw fault('disposed', 'Annotations disposed; create a new controller', 'sciviz');
  }
  get annotations(): readonly Annotation[] {
    return [...this.#records.values()].map(annotationSnapshot);
  }
  add(annotation: Annotation): void {
    this.#check();
    const a = annotationSnapshot(annotation);
    if (this.#records.has(a.id)) throw rangeError('Annotation ID already exists; use update', 'sciviz');
    this.#records.set(a.id, a);
    this.#change(a.id);
  }
  update(id: string, patch: Partial<Omit<Annotation, 'id'>>): void {
    this.#check();
    const previous = this.#records.get(id);
    if (!previous) throw rangeError('Unknown annotation ID; add it first', 'sciviz');
    const a = annotationSnapshot({ ...previous, ...patch, id });
    this.#records.set(id, a);
    this.#change(id);
  }
  remove(id: string): void {
    this.#check();
    if (this.#records.delete(id)) this.#change(id);
  }
  /** Replace all records atomically after validating the entire state. */
  restore(records: readonly Annotation[]): void {
    this.#check();
    const next = records.map(annotationSnapshot);
    if (new Set(next.map((a) => a.id)).size !== next.length)
      throw rangeError('Restored annotations need unique IDs', 'sciviz');
    this.#records.clear();
    for (const a of next) this.#records.set(a.id, a);
    this.#change('restore');
  }
  /** Drag in the camera plane, or set an exact physical position programmatically. */
  moveHandle(id: string, index: number, position: AnnotationPoint): void {
    const a = this.#records.get(id);
    if (!a || !Number.isInteger(index) || index < 0 || index >= a.points.length)
      throw rangeError('Choose an existing annotation handle', 'sciviz');
    this.update(id, { points: a.points.map((p, i) => (i === index ? position : p)) });
  }
  #save(): void {
    (this.figure as Figure & { annotations: unknown }).annotations = {
      format: 'margo-annotations',
      version: 1,
      editable: this.#editable,
      records: this.annotations,
    };
  }
  #change(id: string): void {
    this.#save();
    this.render();
    this.dispatchEvent(new CustomEvent('change', { detail: { id, annotations: this.annotations } }));
  }
  #matrix(): Float64Array {
    return dataToClip(this.figure.engine.camera.matrix, this.figure.model);
  }
  #project(p: AnnotationPoint): number[] | null {
    const r = this.#canvas.getBoundingClientRect(),
      v = projectPoint(this.#matrix(), ...p, r.width, r.height, 'webgpu');
    return v.inFront && v.depth >= 0 && v.depth <= 1 ? [v.x, v.y, 1 - v.depth] : null;
  }
  #unproject(x: number, y: number, depth: number): AnnotationPoint | null {
    const m = invertMatrix(this.#matrix()),
      r = this.#canvas.getBoundingClientRect();
    if (!m || !r.width || !r.height) return null;
    const nx = (2 * x) / r.width - 1,
      ny = 1 - (2 * y) / r.height,
      w = m[3] * nx + m[7] * ny + m[11] * depth + m[15];
    if (!w) return null;
    return [0, 1, 2].map((i) => (m[i] * nx + m[i + 4] * ny + m[i + 8] * depth + m[i + 12]) / w) as [
      number,
      number,
      number,
    ];
  }
  /** Cast a CSS-pixel pointer through the current physical data frame. */
  pickVolume(volume: PickVolume, x: number, y: number, occupied?: (value: number) => boolean): VolumeHit | null {
    this.#check();
    const r = this.#canvas.getBoundingClientRect(),
      ray = screenRay(this.#matrix(), r.width, r.height, x, y);
    return ray ? firstVolumeHit(volume, ray.origin, ray.direction, occupied) : null;
  }
  pickGrid(grid: UnstructuredGrid, x: number, y: number): GridHit | null {
    this.#check();
    const r = this.#canvas.getBoundingClientRect(),
      ray = screenRay(this.#matrix(), r.width, r.height, x, y);
    return ray ? firstGridHit(grid, ray.origin, ray.direction) : null;
  }
  #scene(): { paths: Path[]; labels: Label[] } {
    const paths: Path[] = [],
      labels: Label[] = [];
    for (const a of this.#records.values()) {
      if (a.visible === false) continue;
      const points = a.points.map((p) => this.#project(p));
      if (points.some((p) => !p)) continue;
      const p = points as number[][],
        color = a.color ?? '#ffd166',
        width = a.width ?? 2;
      const line = (points: number[][], closed = false) => paths.push({ points, color, width, closed });
      if (['line', 'ruler', 'scale', 'arrow', 'angle', 'polyline'].includes(a.kind)) line(p);
      if (a.kind === 'arrow') {
        const [u, v] = p,
          dx = v[0] - u[0],
          dy = v[1] - u[1],
          l = Math.hypot(dx, dy);
        if (l) {
          const x = dx / l,
            y = dy / l;
          line([[v[0] - 10 * x + 5 * y, v[1] - 10 * y - 5 * x], v, [v[0] - 10 * x - 5 * y, v[1] - 10 * y + 5 * x]]);
        }
      }
      if (a.kind === 'rectangle') line([p[0], [p[1][0], p[0][1]], p[1], [p[0][0], p[1][1]]], true);
      if (a.kind === 'ellipse') {
        const cx = (p[0][0] + p[1][0]) / 2,
          cy = (p[0][1] + p[1][1]) / 2,
          rx = Math.abs(p[0][0] - p[1][0]) / 2,
          ry = Math.abs(p[0][1] - p[1][1]) / 2;
        line(
          Array.from({ length: 64 }, (_, i) => [
            cx + rx * Math.cos((i * Math.PI) / 32),
            cy + ry * Math.sin((i * Math.PI) / 32),
          ]),
          true,
        );
      }
      if (a.kind === 'scale') {
        for (const v of p)
          line([
            [v[0], v[1] - 5],
            [v[0], v[1] + 5],
          ]);
      }
      if (a.kind === 'box') {
        const corners = Array.from({ length: 8 }, (_, i) =>
          this.#project([a.points[i & 1 ? 1 : 0][0], a.points[i & 2 ? 1 : 0][1], a.points[i & 4 ? 1 : 0][2]]),
        );
        for (let i = 0; i < 8; i++)
          for (const bit of [1, 2, 4])
            if (!(i & bit) && corners[i] && corners[i | bit]) line([corners[i]!, corners[i | bit]!]);
      }
      if (a.kind === 'sphere') {
        const r = annotationMeasure(a)!;
        for (let axis = 0; axis < 3; axis++) {
          const circle = Array.from({ length: 64 }, (_, i) => {
            const v = [...a.points[0]] as [number, number, number];
            v[(axis + 1) % 3] += r * Math.cos((i * Math.PI) / 32);
            v[(axis + 2) % 3] += r * Math.sin((i * Math.PI) / 32);
            return this.#project(v);
          });
          if (circle.every((v) => v)) line(circle as number[][], true);
        }
      }
      const measure = annotationMeasure(a),
        label =
          a.text ??
          (measure === null
            ? ''
            : `${Number(measure.toPrecision(6))}${a.kind === 'angle' ? ' degrees' : a.unit ? ' ' + a.unit : ''}`);
      if (label) {
        const anchor = p[p.length - 1],
          offset = a.offset ?? [12, -12],
          labelPoint = [anchor[0] + offset[0], anchor[1] + offset[1]];
        line([anchor, labelPoint]);
        labels.push({ point: labelPoint, text: label, color });
      }
    }
    return { paths, labels };
  }
  #svg(width: number, height: number, handles: boolean): string {
    const r = this.#canvas.getBoundingClientRect(),
      { paths, labels } = this.#scene();
    let content = paths
      .map(
        (p) =>
          `<polyline points="${p.points
            .concat(p.closed ? [p.points[0]] : [])
            .map((v) => v.slice(0, 2).join(','))
            .join(' ')}" fill="none" stroke="${xml(p.color)}" stroke-width="${p.width}"/>`,
      )
      .join('');
    content += labels
      .map(
        (l) =>
          `<text x="${l.point[0]}" y="${l.point[1]}" fill="${xml(l.color)}" font-family="system-ui,sans-serif" font-size="13">${xml(l.text)}</text>`,
      )
      .join('');
    if (handles && this.#editable)
      for (const [record, a] of [...this.#records.values()].entries())
        if (a.visible !== false)
          for (const [index, p] of a.points.entries()) {
            const v = this.#project(p);
            if (v)
              content += `<circle cx="${v[0]}" cy="${v[1]}" r="5" fill="#ffffff" stroke="${a.color ?? '#ffd166'}" style="pointer-events:all;cursor:move" tabindex="0" role="button" aria-label="${xml(a.id)} handle ${index + 1}" data-id="${xml(a.id)}" data-record="${record}" data-handle="${index}"/>`;
          }
    return `<g data-sciviz-annotations="" transform="scale(${width / (r.width || 1)},${height / (r.height || 1)})">${content}</g>`;
  }
  #paint(ctx: OffscreenCanvasRenderingContext2D, width: number, height: number): void {
    const r = this.#canvas.getBoundingClientRect(),
      { paths, labels } = this.#scene();
    ctx.save();
    ctx.scale(width / (r.width || 1), height / (r.height || 1));
    for (const p of paths) {
      ctx.beginPath();
      p.points.forEach((v, i) => (i ? ctx.lineTo(v[0], v[1]) : ctx.moveTo(v[0], v[1])));
      if (p.closed) ctx.closePath();
      ctx.strokeStyle = p.color;
      ctx.lineWidth = p.width;
      ctx.stroke();
    }
    ctx.font = '13px system-ui,sans-serif';
    for (const l of labels) {
      ctx.fillStyle = l.color;
      ctx.fillText(l.text, l.point[0], l.point[1]);
    }
    ctx.restore();
  }
  /** Position the live SVG to the canvas, retaining exact physical handle coordinates. */
  render(): void {
    if (this.#disposed) return;
    const r = this.#canvas.getBoundingClientRect();
    this.element.style.left = `${this.#canvas.offsetLeft}px`;
    this.element.style.top = `${this.#canvas.offsetTop}px`;
    this.element.setAttribute('width', String(r.width));
    this.element.setAttribute('height', String(r.height));
    this.element.innerHTML = this.#svg(r.width, r.height, true);
  }
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#events.abort();
    this.#offFrame();
    this.#offExport();
    this.#resize.disconnect();
    this.element.remove();
    managers.delete(this.figure);
    delete (this.figure as Figure & { annotations?: unknown }).annotations;
  }
  [Symbol.dispose](): void {
    this.dispose();
  }
}
/** One controller per figure; no import-time DOM or engine effects. */
export const annotate = (figure: Figure, options?: AnnotationOptions): Annotations => new Annotations(figure, options);
