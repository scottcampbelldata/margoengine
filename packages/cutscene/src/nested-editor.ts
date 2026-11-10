import type { CutsceneState, CutsceneTrackType } from './cutscene.js';
import type { TimelineClip } from './document.js';
import { type ItemRef, TimelineEditor } from './editor.js';

/** A boolean or string held until the next key. */
export interface DiscreteKey {
  time: number;
  value: boolean | string;
}
/** Step-sampled visibility flags, labels and other nonnumeric properties. */
export interface DiscreteTrack {
  type: 'discrete';
  id: string;
  target: string;
  property: string;
  keys: DiscreteKey[];
  muted?: boolean;
}
declare module './document.js' {
  interface CustomTrackTypes {
    discrete: DiscreteTrack;
  }
}
const sample = (track: DiscreteTrack, time: number): boolean | string => {
  let low = 0,
    high = track.keys.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (track.keys[mid].time <= time) low = mid + 1;
    else high = mid;
  }
  return track.keys[Math.max(0, low - 1)].value;
};
/** Registers validation, step sampling and default editor key fields for discrete tracks. Pass in the tracks option. */
export function discreteTrack(): CutsceneTrackType {
  return {
    type: 'discrete',
    validate(raw, check): void {
      check.target();
      if (typeof raw.property !== 'string' || !raw.property)
        check.add(`${check.path}.property`, 'must name a property; pass a nonempty string');
      const keys = check.list(raw.keys, `${check.path}.keys`);
      if (keys && !keys.length) check.add(`${check.path}.keys`, 'must contain a key; add an initial value');
      let type: string | undefined;
      keys?.forEach((key, i) => {
        const path = `${check.path}.keys[${i}]`;
        check.time(key.time, `${path}.time`);
        if (typeof key.value !== 'boolean' && typeof key.value !== 'string')
          check.add(`${path}.value`, 'must be a boolean or string; use a discrete value');
        else if (type !== undefined && typeof key.value !== type)
          check.add(`${path}.value`, 'must have the same type as the first key; split different properties');
        else type = typeof key.value;
        if (key.ease !== undefined && key.ease !== 'step')
          check.add(`${path}.ease`, 'discrete tracks use step sampling; omit easing or use step');
      });
      if (keys) check.ordered(keys, `${check.path}.keys`, 'time');
    },
    evaluate(raw, time, state): void {
      const track = raw as unknown as DiscreteTrack;
      const values = ((state.extras ??= {}).discrete ??= Object.create(null)) as Record<
        string,
        Record<string, boolean | string>
      >;
      (values[track.target] ??= Object.create(null))[track.property] = sample(track, time);
    },
    sampleKey(raw, time): Record<string, unknown> {
      return { value: sample(raw as unknown as DiscreteTrack, time) };
    },
  };
}
/** Discrete property values by target then property name. State and nested timing remain pure and seek independent. */
export function discreteOf(state: CutsceneState): Record<string, Record<string, boolean | string>> {
  return (state.extras?.discrete as Record<string, Record<string, boolean | string>> | undefined) ?? {};
}

/** Optional placement of the nested authoring controls. */
export interface NestedTimelineEditorOptions {
  /** Default the outer editor's element: nested panels open inline there. */
  parent?: HTMLElement;
  /** Maximum milliseconds between two stationary clip presses. Default 400; capture suppresses native dblclick. */
  doubleClickMs?: number;
}
type Pane = {
  editor: TimelineEditor;
  parent: TimelineEditor;
  ref: ItemRef;
  name: string;
  element: HTMLElement;
  off: (() => void)[];
  abort: AbortController;
};
/** Inline editing of nested timeline clips, with local playheads, shared root undo and boolean/string key controls. */
export class NestedTimelineEditor {
  readonly element: HTMLDivElement;
  private readonly panes: Pane[] = [];
  private active: TimelineEditor;
  private pressed?: { parent: TimelineEditor; ref: ItemRef; x: number; y: number; pointer: number };
  private clicked?: { parent: TimelineEditor; ref: ItemRef; x: number; y: number; at: number };
  private readonly doubleClickMs: number;
  private readonly select: HTMLSelectElement;
  private readonly value: HTMLInputElement;
  private readonly flag: HTMLInputElement;
  private readonly button: HTMLButtonElement;
  private readonly abort = new AbortController();
  private readonly off: (() => void)[] = [];
  constructor(
    readonly editor: TimelineEditor,
    { parent = editor.element, doubleClickMs = 400 }: NestedTimelineEditorOptions = {},
  ) {
    if (!(doubleClickMs > 0) || !Number.isFinite(doubleClickMs))
      throw new RangeError('Double-click interval must be finite and positive; pass milliseconds');
    this.doubleClickMs = doubleClickMs;
    this.active = editor;
    const doc = editor.element.ownerDocument;
    this.element = doc.createElement('div');
    this.element.className = 'margo-nested-editor';
    const form = doc.createElement('div');
    form.style.cssText = 'padding:8px;display:flex;gap:8px;align-items:center;flex-wrap:wrap';
    this.select = doc.createElement('select');
    this.select.setAttribute('aria-label', 'Discrete track');
    this.value = doc.createElement('input');
    this.value.type = 'text';
    this.value.setAttribute('aria-label', 'String key value');
    this.flag = doc.createElement('input');
    this.flag.type = 'checkbox';
    this.flag.setAttribute('aria-label', 'Boolean key value');
    this.button = doc.createElement('button');
    this.button.type = 'button';
    this.button.textContent = 'Key value at playhead';
    form.append(this.select, this.value, this.flag, this.button);
    this.element.append(form);
    parent.append(this.element);
    this.select.addEventListener(
      'change',
      () => {
        this.active.selection = [];
        this.fields();
      },
      { signal: this.abort.signal },
    );
    this.button.addEventListener(
      'click',
      () => {
        const track = this.tracks()[this.select.selectedIndex];
        if (track)
          this.keyDiscrete(track.id, typeof track.keys[0].value === 'boolean' ? this.flag.checked : this.value.value);
      },
      { signal: this.abort.signal },
    );
    form.addEventListener('keydown', (e) => e.stopPropagation(), { signal: this.abort.signal });
    editor.element.addEventListener('pointerdown', this.rememberPress, { signal: this.abort.signal, capture: true });
    editor.element.addEventListener('pointerup', this.finishPress, { signal: this.abort.signal, capture: true });
    if (!editor.element.contains(this.element))
      this.element.addEventListener('pointerdown', this.rememberPress, { signal: this.abort.signal, capture: true });
    if (!editor.element.contains(this.element))
      this.element.addEventListener('pointerup', this.finishPress, { signal: this.abort.signal, capture: true });
    this.off.push(
      editor.on('select', () => this.activate(editor)),
      editor.on('seek', () => this.syncTimes()),
      editor.model.on('change', () => {
        this.validatePanes();
        this.fields();
      }),
    );
    this.fields();
  }
  /** Editors opened inside nested clips, from outermost to innermost. */
  get editors(): readonly TimelineEditor[] {
    return this.panes.map((p) => p.editor);
  }
  private tracks(): DiscreteTrack[] {
    return this.active.model.document.tracks.filter((t): t is DiscreteTrack => t.type === 'discrete');
  }
  private activate(editor: TimelineEditor): void {
    this.active = editor;
    this.fields();
  }
  private fields(): void {
    const old = this.select.value,
      tracks = this.tracks();
    this.select.replaceChildren(
      ...tracks.map((t) => {
        const o = this.select.ownerDocument.createElement('option');
        o.value = t.id;
        o.textContent = `${t.target}.${t.property}`;
        return o;
      }),
    );
    if (tracks.some((t) => t.id === old)) this.select.value = old;
    const selected = this.active.selection[0],
      track = tracks.find((t) => t.id === selected?.track) ?? tracks[this.select.selectedIndex];
    if (track) this.select.value = track.id;
    const value = track
      ? selected?.track === track.id
        ? track.keys[selected.index]?.value
        : sample(track, this.active.time)
      : undefined;
    this.flag.hidden = typeof value !== 'boolean';
    this.value.hidden = typeof value !== 'string';
    this.button.disabled = !track;
    if (typeof value === 'boolean') this.flag.checked = value;
    if (typeof value === 'string') this.value.value = value;
  }
  /** Inserts/replaces a discrete key in the active panel at its playhead and selects it. */
  keyDiscrete(track: string, value: boolean | string): ItemRef {
    const found = this.active.model.document.tracks.find((t) => t.id === track);
    if (!found || found.type !== 'discrete')
      throw new RangeError('Choose a discrete track in the active timeline; open its panel first');
    const index = found.keys.findIndex((k) => k.time === this.active.time),
      fields = { time: this.active.time, value };
    const ref =
      index < 0 ? this.active.model.addItem(track, fields) : this.active.model.updateItem({ track, index }, fields);
    if (!ref) throw new RangeError('Discrete key was refused; keep its value type consistent with the track');
    this.active.selection = [ref];
    return ref;
  }
  /** Opens a timeline clip inline. Its definition is edited in place, shared by every placement of that definition. */
  open(ref: ItemRef, parent: TimelineEditor = this.active): TimelineEditor {
    const track = parent.model.document.tracks.find((t) => t.id === ref.track);
    if (!track || track.type !== 'timeline' || !track.clips[ref.index])
      throw new RangeError('Nested editing needs a timeline clip; choose an existing clip item');
    const parentIndex = parent === this.editor ? -1 : this.panes.findIndex((p) => p.editor === parent);
    if (parent !== this.editor && parentIndex < 0)
      throw new RangeError("Parent editor is not open here; choose this tool's editor");
    this.close(parentIndex + 1);
    const clip = track.clips[ref.index],
      scope = parent.model.nested(clip.timeline),
      doc = this.element.ownerDocument;
    const element = doc.createElement('section');
    element.className = 'margo-nested-pane';
    const heading = doc.createElement('div');
    heading.style.cssText = 'padding:8px';
    heading.textContent = `Nested timeline: ${clip.timeline} `;
    const close = doc.createElement('button');
    close.type = 'button';
    close.textContent = 'Close nested timeline';
    heading.append(close);
    element.append(heading);
    this.element.append(element);
    const editor = new TimelineEditor(scope, { parent: element, zoom: parent.zoom });
    const pane: Pane = {
      editor,
      parent,
      ref: { ...ref },
      name: clip.timeline,
      element,
      off: [],
      abort: new AbortController(),
    };
    this.panes.push(pane);
    close.addEventListener('click', () => this.close(this.panes.indexOf(pane)), { signal: pane.abort.signal });
    // A nested panel owns its own input; outer timeline shortcuts and drags must not run a second time.
    for (const name of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'keydown', 'wheel'] as const)
      editor.element.addEventListener(name, (e) => e.stopPropagation(), { signal: pane.abort.signal });
    editor.element.addEventListener('pointerdown', () => this.activate(editor), { signal: pane.abort.signal });
    pane.off.push(
      editor.on('select', () => this.activate(editor)),
      editor.on('seek', (time) => {
        const map = this.mapping(pane),
          global = map.origin + time / map.rate;
        this.editor.seek(Math.max(map.start, Math.min(map.end, global)));
      }),
    );
    this.active = editor;
    this.syncTimes();
    this.fields();
    return editor;
  }
  private clip(pane: Pane): TimelineClip | undefined {
    const track = pane.parent.model.document.tracks.find((t) => t.id === pane.ref.track);
    return track?.type === 'timeline' ? track.clips[pane.ref.index] : undefined;
  }
  private mapping(pane: Pane): { origin: number; rate: number; start: number; end: number } {
    const clip = this.clip(pane)!,
      parentPane = this.panes.find((p) => p.editor === pane.parent),
      parent = parentPane
        ? this.mapping(parentPane)
        : { origin: 0, rate: 1, start: 0, end: this.editor.model.duration };
    const start = parent.origin + clip.start / parent.rate,
      rate = parent.rate * (clip.speed ?? 1),
      origin = start - (clip.offset ?? 0) / rate;
    return {
      origin,
      rate,
      start: Math.max(parent.start, start),
      end: Math.min(parent.end, start + clip.duration / parent.rate),
    };
  }
  private syncTimes(): void {
    for (const pane of this.panes) {
      const map = this.mapping(pane);
      pane.editor.time = (this.editor.time - map.origin) * map.rate;
    }
  }
  private validatePanes(): void {
    for (let i = 0; i < this.panes.length; i++) {
      const pane = this.panes[i],
        clip = this.clip(pane);
      if (!clip || clip.timeline !== pane.name || !this.editor.model.document.timelines?.[pane.name]) {
        this.close(i);
        return;
      }
    }
    this.syncTimes();
  }
  private readonly rememberPress = (event: PointerEvent): void => {
    const item = (event.target as Element).closest<HTMLElement>('.mtl-item[data-kind="clip"]');
    const element = item?.closest('.mtl'),
      parent =
        element === this.editor.element ? this.editor : this.panes.find((p) => p.editor.element === element)?.editor;
    this.pressed =
      item && parent && event.button === 0
        ? {
            parent,
            ref: { track: item.dataset.track!, index: Number(item.dataset.index) },
            x: event.clientX,
            y: event.clientY,
            pointer: event.pointerId,
          }
        : undefined;
    if (!this.pressed) this.clicked = undefined;
  };
  private readonly finishPress = (event: PointerEvent): void => {
    const pressed = this.pressed;
    this.pressed = undefined;
    if (
      !pressed ||
      pressed.pointer !== event.pointerId ||
      Math.hypot(event.clientX - pressed.x, event.clientY - pressed.y) > 4
    ) {
      this.clicked = undefined;
      return;
    }
    const last = this.clicked;
    this.clicked = { ...pressed, at: event.timeStamp };
    if (
      !last ||
      last.parent !== pressed.parent ||
      last.ref.track !== pressed.ref.track ||
      last.ref.index !== pressed.ref.index ||
      event.timeStamp - last.at > this.doubleClickMs ||
      Math.hypot(last.x - pressed.x, last.y - pressed.y) > 4
    )
      return;
    this.clicked = undefined;
    // preventDefault on pointerdown suppresses compatibility mouse events, including dblclick.
    // Let the editor finish its pointerup/undo transaction before opening the pressed clip.
    pressed.parent.element.addEventListener(
      'pointerup',
      () => {
        if (this.abort.signal.aborted) return;
        const track = pressed.parent.model.document.tracks.find((t) => t.id === pressed.ref.track);
        if (track?.type === 'timeline' && track.clips[pressed.ref.index]) this.open(pressed.ref, pressed.parent);
      },
      { once: true, signal: this.abort.signal },
    );
  };
  /** Closes the panel at depth and all deeper panels. Default closes every nested panel. Edits remain in the document. */
  close(depth = 0): void {
    for (const pane of this.panes.splice(Math.max(0, depth)).reverse()) {
      pane.abort.abort();
      for (const off of pane.off) off();
      pane.editor.dispose();
      pane.element.remove();
    }
    this.active = this.panes.at(-1)?.editor ?? this.editor;
    this.fields();
  }
  /** Removes nested UI and listeners, retaining the borrowed outer editor and document. */
  dispose(): void {
    this.close();
    this.abort.abort();
    for (const off of this.off) off();
    this.off.length = 0;
    this.element.remove();
  }
  [Symbol.dispose](): void {
    this.dispose();
  }
}
