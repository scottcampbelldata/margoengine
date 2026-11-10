// Clean-room graph editing over the existing timeline's validated, undoable document.
import type { EaseSpec } from './document.js';
import type { ItemRef, TimelineEditor, TimelineModel } from './editor.js';

/** One scalar channel of a numeric key track. */
export interface CurveChannel {
  /** Timeline track id. */
  track: string;
  /** Key field, such as value, position, fov or scale. */
  field: string;
  /** Component of an array; omitted for a scalar. */
  component?: number;
}
/** A graph point, retaining its place in the original track, including sparse transform keys. */
export interface CurvePoint extends ItemRef {
  time: number;
  value: number;
  ease?: EaseSpec;
}
type Key = { time: number; ease?: EaseSpec; [field: string]: unknown };
const finite = (value: number): void => {
  if (!Number.isFinite(value)) throw new RangeError('Curve coordinates must be finite; pass a number');
};
const clamp = (value: number, low: number, high: number): number => Math.max(low, Math.min(high, value));

/** Numeric graph operations on a shared timeline model. No DOM or rendering required. */
export class CurveModel {
  constructor(readonly timeline: TimelineModel) {}
  /** All editable numeric channels; string and boolean keys have no value graph. */
  get channels(): CurveChannel[] {
    const found = new Map<string, CurveChannel>();
    for (const track of this.timeline.document.tracks) {
      if (!('keys' in track) || !Array.isArray(track.keys)) continue;
      for (const key of track.keys as Key[])
        for (const [field, value] of Object.entries(key)) {
          if (field === 'time' || field === 'ease') continue;
          const add = (component?: number): void => {
            const channel = { track: track.id, field, component };
            found.set(JSON.stringify(channel), channel);
          };
          if (typeof value === 'number') add();
          else if (Array.isArray(value))
            value.forEach((v, i) => {
              if (typeof v === 'number') add(i);
            });
        }
    }
    return [...found.values()];
  }
  private keys(channel: CurveChannel): Key[] {
    const track = this.timeline.document.tracks.find((t) => t.id === channel.track);
    if (!track || !('keys' in track) || !Array.isArray(track.keys))
      throw new RangeError('Curve track must have keys; choose a numeric channel');
    return track.keys as Key[];
  }
  /** Points of a channel, omitting keys that do not set that channel. */
  points(channel: CurveChannel): CurvePoint[] {
    return this.keys(channel).flatMap((key, index) => {
      const field = key[channel.field];
      const value =
        channel.component === undefined ? field : Array.isArray(field) ? field[channel.component] : undefined;
      return typeof value === 'number' ? [{ track: channel.track, index, time: key.time, value, ease: key.ease }] : [];
    });
  }
  /** Moves a key and edits one component, keeping all other components and returning its new index. */
  moveKey(channel: CurveChannel, index: number, time: number, value: number): ItemRef {
    finite(time);
    finite(value);
    const key = this.keys(channel)[index];
    if (!key || !this.points(channel).some((p) => p.index === index))
      throw new RangeError('Curve point does not exist; choose a point of this channel');
    const field = channel.component === undefined ? value : [...(key[channel.field] as number[])];
    if (Array.isArray(field)) field[channel.component!] = value;
    const ref = { track: channel.track, index };
    return (
      this.timeline.updateItem(ref, { time: clamp(time, 0, this.timeline.duration), [channel.field]: field }) ?? ref
    );
  }
  /** Sets a segment's normalized CSS control point on its destination key. X is clamped to [0,1], Y may overshoot. */
  setHandle(channel: CurveChannel, endIndex: number, handle: 0 | 1, x: number, y: number): boolean {
    finite(x);
    finite(y);
    const points = this.points(channel),
      at = points.findIndex((p) => p.index === endIndex);
    if (at < 1) throw new RangeError('A curve handle needs a preceding point; choose a segment destination');
    const old = points[at].ease;
    const ease = Array.isArray(old) ? [...old] : [1 / 3, 1 / 3, 2 / 3, 2 / 3];
    ease[handle * 2] = clamp(x, 0, 1);
    ease[handle * 2 + 1] = y;
    return this.timeline.setItem({ track: channel.track, index: endIndex }, { ease });
  }
  /** Trims a clip edge while holding its opposite edge. Invalid overlaps or empty spans leave it unchanged. */
  resizeClip(ref: ItemRef, edge: 'start' | 'end', time: number): boolean {
    finite(time);
    const item = this.timeline.rows.find((r) => r.track === ref.track)?.items[ref.index];
    if (!item || item.kind !== 'clip') throw new RangeError('Only clip edges resize; choose a clip item');
    const end = item.time + item.duration,
      at = clamp(time, 0, this.timeline.duration);
    if ((edge === 'start' && at >= end) || (edge === 'end' && at <= item.time)) return false;
    return this.timeline.setItem(
      ref,
      edge === 'start' ? { start: at, duration: end - at } : { duration: at - item.time },
    );
  }
}

/** Options of the graph panel. */
export interface CurveEditorOptions {
  /** Container; default the timeline panel. */
  parent?: HTMLElement;
  /** Initial channel; default the first numeric channel. */
  channel?: CurveChannel;
  /** View box width, default 800. The SVG scales to the available width. */
  width?: number;
  /** Height in pixels, default 240. */
  height?: number;
}
type Drag = { pointer: number; kind: 'key' | 'handle' | 'start' | 'end'; index: number; handle: 0 | 1; track: string };
const NS = 'http://www.w3.org/2000/svg';

/** A graph panel sharing a TimelineEditor's model, playhead, zoom and undo. Clip edges in the timeline become draggable. */
export class CurveEditor {
  readonly element: HTMLDivElement;
  readonly model: CurveModel;
  private readonly svg: SVGSVGElement;
  private readonly select: HTMLSelectElement;
  private readonly width: number;
  private readonly height: number;
  private current?: CurveChannel;
  private low = -1;
  private high = 1;
  private drag?: Drag;
  private readonly unsubscribe: () => void;
  private readonly abort = new AbortController();
  constructor(
    readonly editor: TimelineEditor,
    { parent = editor.element, channel, width = 800, height = 240 }: CurveEditorOptions = {},
  ) {
    if (!(width > 80 && height > 80 && Number.isFinite(width) && Number.isFinite(height)))
      throw new RangeError('Curve view must exceed 80 pixels; pass finite width and height');
    this.width = width;
    this.height = height;
    this.model = new CurveModel(editor.model);
    this.current = channel ?? this.model.channels[0];
    this.element = document.createElement('div');
    this.element.className = 'margo-curve-editor';
    this.element.style.cssText = 'background:#16181d;color:#e6e8ec;padding:8px;touch-action:none';
    this.select = document.createElement('select');
    this.select.setAttribute('aria-label', 'Curve channel');
    this.element.append(this.select);
    const fit = document.createElement('button');
    fit.textContent = 'Fit values';
    fit.type = 'button';
    this.element.append(fit);
    this.svg = document.createElementNS(NS, 'svg');
    this.svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    this.svg.style.cssText = `display:block;width:100%;height:${height}px;touch-action:none;user-select:none`;
    this.svg.setAttribute('aria-label', 'Key value graph');
    this.element.append(this.svg);
    parent.append(this.element);
    const options = { signal: this.abort.signal };
    this.select.addEventListener(
      'change',
      () => {
        this.current = this.model.channels[this.select.selectedIndex];
        this.fit();
      },
      options,
    );
    fit.addEventListener('click', () => this.fit(), options);
    this.element.addEventListener('keydown', (e) => this.key(e), options);
    editor.element.addEventListener('pointerdown', (e) => this.down(e), { ...options, capture: true });
    if (!editor.element.contains(this.element))
      this.element.addEventListener('pointerdown', (e) => this.down(e), options);
    window.addEventListener('pointermove', (e) => this.move(e), options);
    window.addEventListener('pointerup', (e) => this.up(e), options);
    window.addEventListener('pointercancel', (e) => this.up(e), options);
    this.unsubscribe = editor.model.on('change', () => this.draw());
    this.fit();
  }
  /** Current channel, or undefined when the document has no numeric keys. */
  get channel(): CurveChannel | undefined {
    return this.current;
  }
  set channel(value: CurveChannel | undefined) {
    this.current = value;
    this.fit();
  }
  /** Frames the current key values with a 20 percent margin. */
  fit(): void {
    this.reconcileChannels();
    const values = this.current ? this.model.points(this.current).map((p) => p.value) : [0];
    this.low = Math.min(...values);
    this.high = Math.max(...values);
    const margin = Math.max(1e-3, (this.high - this.low || Math.abs(this.high) || 1) * 0.2);
    this.low -= margin;
    this.high += margin;
    this.draw();
  }
  private x(time: number): number {
    return 32 + (time / (this.editor.model.duration || 1)) * (this.width - 48);
  }
  private y(value: number): number {
    return this.height - 24 - ((value - this.low) / (this.high - this.low)) * (this.height - 40);
  }
  private position(e: PointerEvent): [number, number] {
    const rect = this.svg.getBoundingClientRect(),
      x = ((e.clientX - rect.left) * this.width) / rect.width,
      y = ((e.clientY - rect.top) * this.height) / rect.height;
    return [
      ((x - 32) / (this.width - 48)) * this.editor.model.duration,
      this.low + ((this.height - 24 - y) / (this.height - 40)) * (this.high - this.low),
    ];
  }
  private node(tag: string, attrs: Record<string, string | number>, label?: string): SVGElement {
    const node = document.createElementNS(NS, tag);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
    if (label) node.setAttribute('aria-label', label);
    this.svg.append(node);
    return node;
  }
  private reconcileChannels(): CurveChannel[] {
    const channels = this.model.channels;
    this.current =
      channels.find(
        (c) =>
          c.track === this.current?.track && c.field === this.current.field && c.component === this.current.component,
      ) ?? channels[0];
    return channels;
  }
  private draw(): void {
    const previous = this.current;
    const channels = this.reconcileChannels();
    if (
      previous?.track !== this.current?.track ||
      previous?.field !== this.current?.field ||
      previous?.component !== this.current?.component
    ) {
      this.fit();
      return;
    }
    this.select.replaceChildren(
      ...channels.map((c) => {
        const o = document.createElement('option');
        o.textContent = `${c.track}.${c.field}${c.component === undefined ? '' : '[' + c.component + ']'}`;
        return o;
      }),
    );
    this.select.selectedIndex = channels.findIndex((c) => JSON.stringify(c) === JSON.stringify(this.current));
    this.svg.replaceChildren();
    for (let i = 0; i <= 4; i++) {
      const value = this.low + ((this.high - this.low) * i) / 4;
      this.node('line', { x1: 32, x2: this.width - 16, y1: this.y(value), y2: this.y(value), stroke: '#3a3f4a' });
      this.node('text', { x: 0, y: this.y(value), fill: '#a9afbb', 'font-size': 10 }).textContent =
        value.toPrecision(3);
      const time = (this.editor.model.duration * i) / 4;
      this.node('text', {
        x: this.x(time),
        y: this.height - 4,
        fill: '#a9afbb',
        'font-size': 10,
      }).textContent = `${time.toFixed(1)}s`;
    }
    if (!this.current) return;
    const points = this.model.points(this.current);
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1],
        b = points[i],
        ease = Array.isArray(b.ease) ? b.ease : [1 / 3, 1 / 3, 2 / 3, 2 / 3];
      const coords = (j: number): [number, number] => [
        this.x(a.time + (b.time - a.time) * ease[j * 2]),
        this.y(a.value + (b.value - a.value) * ease[j * 2 + 1]),
      ];
      const p = coords(0),
        q = coords(1);
      // Sample the runtime, including named easing, quaternion interpolation and camera paths.
      const doc = this.editor.model.document;
      const track = doc.tracks.find((t) => t.id === this.current!.track)!;
      const cutscene = this.editor.model.cutscene();
      const path: string[] = [];
      for (let n = 0; n <= 48; n++) {
        const time = a.time + ((b.time - a.time) * n) / 48,
          state = cutscene.evaluate(time);
        let value: unknown;
        if (track.type === 'property') value = state.properties[track.target]?.[track.property];
        else if (track.type === 'transform') value = state.transforms[track.target]?.[this.current.field as 'position'];
        else if (track.type === 'camera') value = state.camera?.[this.current.field as 'position'];
        if (this.current.component !== undefined && Array.isArray(value)) value = value[this.current.component];
        if (typeof value === 'number') path.push(`${n ? 'L' : 'M'}${this.x(time)},${this.y(value)}`);
      }
      this.node('path', { d: path.join(' '), stroke: '#f2b134', fill: 'none', 'stroke-width': 2 });
      for (const [j, handle] of [p, q].entries()) {
        const end = j ? b : a;
        this.node('line', {
          x1: this.x(end.time),
          y1: this.y(end.value),
          x2: handle[0],
          y2: handle[1],
          stroke: '#86c5ff',
        });
        this.node(
          'circle',
          {
            cx: handle[0],
            cy: handle[1],
            r: 5,
            fill: '#86c5ff',
            tabindex: 0,
            role: 'button',
            'data-kind': 'handle',
            'data-index': b.index,
            'data-handle': j,
          },
          `Bezier handle ${j + 1} into key ${b.index}`,
        );
      }
    }
    for (const point of points)
      this.node(
        'circle',
        {
          cx: this.x(point.time),
          cy: this.y(point.value),
          r: 6,
          fill: '#f2b134',
          tabindex: 0,
          role: 'button',
          'data-kind': 'key',
          'data-index': point.index,
        },
        `Key ${point.index}: ${point.value} at ${point.time} seconds`,
      );
  }
  private down(e: PointerEvent): void {
    if (e.button !== 0 || this.drag) return;
    const target = e.target as Element,
      graph = target.closest('[data-kind][data-index]');
    if (target.closest('.mtl') && target.closest('.mtl') !== this.editor.element) return;
    let drag: Drag | undefined;
    if (graph && this.svg.contains(graph) && this.current)
      drag = {
        pointer: e.pointerId,
        kind: graph.getAttribute('data-kind') as 'key' | 'handle',
        index: Number(graph.getAttribute('data-index')),
        handle: Number(graph.getAttribute('data-handle') ?? 0) as 0 | 1,
        track: this.current.track,
      };
    else {
      const clip = target.closest<HTMLElement>('.mtl-item[data-kind="clip"]');
      if (clip) {
        const rect = clip.getBoundingClientRect(),
          edge = e.clientX - rect.left < 8 ? 'start' : rect.right - e.clientX < 8 ? 'end' : undefined;
        if (edge)
          drag = {
            pointer: e.pointerId,
            kind: edge,
            index: Number(clip.dataset.index),
            track: clip.dataset.track!,
            handle: 0,
          };
      }
    }
    if (!drag) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    this.drag = drag;
    this.element.setPointerCapture(e.pointerId);
    this.editor.model.begin('Curve drag');
  }
  private move(e: PointerEvent): void {
    const d = this.drag;
    if (!d || d.pointer !== e.pointerId) return;
    if (d.kind === 'start' || d.kind === 'end') {
      const ruler = this.editor.element.querySelector('.mtl-ruler')!.getBoundingClientRect();
      this.model.resizeClip(
        d,
        d.kind,
        this.editor.model.snap((e.clientX - ruler.left) / this.editor.zoom, { ignore: [d] }),
      );
      return;
    }
    if (!this.current) return;
    const [time, value] = this.position(e);
    if (d.kind === 'key')
      d.index = this.model.moveKey(this.current, d.index, this.editor.model.snap(time, { ignore: [d] }), value).index;
    else {
      const points = this.model.points(this.current),
        at = points.findIndex((p) => p.index === d.index),
        a = points[at - 1],
        b = points[at];
      if (b.time !== a.time && b.value !== a.value)
        this.model.setHandle(
          this.current,
          d.index,
          d.handle,
          (time - a.time) / (b.time - a.time),
          (value - a.value) / (b.value - a.value),
        );
    }
  }
  private up(e: PointerEvent): void {
    if (!this.drag || this.drag.pointer !== e.pointerId) return;
    this.drag = undefined;
    this.editor.model.commit();
    if (this.element.hasPointerCapture(e.pointerId)) this.element.releasePointerCapture(e.pointerId);
    this.draw();
  }
  private key(e: KeyboardEvent): void {
    if ((e.target as Element).matches('select,button')) {
      e.stopPropagation();
      return;
    }
    if (e.ctrlKey || e.metaKey) return;
    const target = e.target as Element,
      kind = target.getAttribute('data-kind'),
      index = Number(target.getAttribute('data-index'));
    if (!this.current || !kind || !['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) return;
    e.preventDefault();
    e.stopPropagation();
    const dx = e.key === 'ArrowLeft' ? -0.01 : e.key === 'ArrowRight' ? 0.01 : 0;
    const dy = e.key === 'ArrowDown' ? -0.01 : e.key === 'ArrowUp' ? 0.01 : 0;
    const point = this.model.points(this.current).find((p) => p.index === index)!;
    if (kind === 'key') {
      this.editor.model.begin('Nudge curve');
      this.model.moveKey(this.current, index, point.time + dx, point.value + dy * (this.high - this.low));
      this.editor.model.commit();
    } else {
      const h = Number(target.getAttribute('data-handle')) as 0 | 1,
        ease = Array.isArray(point.ease) ? point.ease : [1 / 3, 1 / 3, 2 / 3, 2 / 3];
      this.model.setHandle(this.current, index, h, ease[h * 2] + dx, ease[h * 2 + 1] + dy);
    }
    this.svg.querySelector<SVGElement>(`[data-kind="${kind}"][data-index="${index}"]`)?.focus();
  }
  /** Removes the graph, edge handlers and subscriptions. Finishes an active gesture as one undo step. */
  dispose(): void {
    if (this.drag) {
      this.drag = undefined;
      this.editor.model.commit();
    }
    this.abort.abort();
    this.unsubscribe();
    this.element.remove();
  }
  [Symbol.dispose](): void {
    this.dispose();
  }
}
