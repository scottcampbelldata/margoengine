// @margoengine/cutscene/editor: a timeline panel for in-page authoring, a separate tool as Margo has no visual editor by
// design. `TimelineModel` is the editing itself, plain data with undo and no DOM, so it runs in Node. `TimelineEditor` is
// the panel on top: scrub, zoom, snap, keying, and every action on the keyboard too.
import { EditHistory } from '@margoengine/inspector/history';
import { MargoError } from '@margoengine/math/errors';
import { Cutscene, EASING_NAMES, type CutsceneTrackType } from './cutscene.js';
import { type CutsceneDocument, validateCutscene } from './document.js';

/** The `track` of the row that holds the document's markers. */
export const MARKERS = '@markers';

/** An item of a row: a place in its track's list. Moves and deletes give new refs, as lists stay sorted. */
export interface ItemRef {
  track: string;
  index: number;
}

/** Something on a row. */
export interface TimelineItem extends ItemRef {
  kind: 'key' | 'event' | 'clip' | 'marker';
  /** Seconds; a clip's start. */
  time: number;
  /** Seconds; 0 for all but clips. */
  duration: number;
  /** What it shows: an event's name, a clip's text, sound or camera. */
  label: string;
}

/** A track as the panel shows it. */
export interface TimelineRow {
  track: string;
  type: string;
  /** The track's target or id. */
  label: string;
  items: TimelineItem[];
  /** True when {@link TimelineModel.addKey} can add here with no fields. */
  keyable: boolean;
}

/** Options of {@link TimelineModel}. */
export interface TimelineModelOptions {
  /** Custom track types the document uses, as for `Cutscene`. Default none. */
  tracks?: readonly CutsceneTrackType[];
  /** Undo stack, to share with the rest of your tool. Default a new one. */
  history?: EditHistory;
}

/** Options of {@link TimelineModel.snap}. */
export interface SnapOptions {
  /** Grid in seconds; 0 turns it off. Default 0.1. */
  step?: number;
  /** Pulls to other items and to these times within this many seconds; 0 turns it off. Default 0.05. */
  reach?: number;
  /** Items that do not pull: the ones being dragged. */
  ignore?: readonly ItemRef[];
  /** More times that pull, such as the playhead. */
  times?: readonly number[];
}

type Data = Record<string, unknown> & { time?: number; start?: number; duration?: number };
type TrackData = Record<string, unknown> & { id: string; type: string; target?: string; keys?: Data[]; events?: Data[]; clips?: Data[] };
type Listener = (label: string) => void;

/** Times stay readable in the saved file: sums of steps pick up rounding. */
const tidy = (seconds: number): number => Number(seconds.toFixed(9));
const finite = (value: number, what: string): void => {
  if (!Number.isFinite(value)) throw new RangeError(`${what} must be a finite number of seconds; pass a number`);
};
const timeOf = (item: Data): number => (item.time ?? item.start) as number;
const clipName = (clip: Data): string =>
  String(clip.text ?? clip.sound ?? clip.clip ?? clip.camera ?? clip.timeline ?? clip.name ?? 'clip');

/**
 * A cutscene document being edited: add, move and delete keys, events, clips and markers with undo and redo. Every
 * edit leaves a valid document: one that would break it, such as two shots overlapping, is refused and changes nothing.
 *
 * ```ts
 * const model = new TimelineModel(document);
 * const key = model.addKey('door', 1.5);
 * model.moveItems([key], 0.25);
 * model.undo();
 * const text = model.save();
 * ```
 */
export class TimelineModel {
  /** The undo stack. */
  readonly history: EditHistory;
  private doc: CutsceneDocument;
  private readonly types: readonly CutsceneTrackType[];
  private readonly checks: ReadonlyMap<string, CutsceneTrackType>;
  private readonly listeners = new Set<Listener>();
  private open: { label: string; before: string } | null = null;
  /** @throws TypeError naming the first problem of a document that is not valid. */
  constructor(document: CutsceneDocument | string | unknown, { tracks = [], history = new EditHistory(200, 0) }: TimelineModelOptions = {}) {
    this.types = tracks;
    this.checks = new Map(tracks.map((type) => [type.type, type]));
    this.doc = JSON.parse(JSON.stringify(new Cutscene(document, { tracks }).document)) as CutsceneDocument;
    this.history = history;
  }
  /** Length of the timeline, seconds. */
  get duration(): number {
    return this.doc.duration;
  }
  /** A copy of the document as it stands. */
  get document(): CutsceneDocument {
    return JSON.parse(JSON.stringify(this.doc)) as CutsceneDocument;
  }
  /** The document as it stands, for `JSON.stringify`. */
  toJSON(): CutsceneDocument {
    return this.document;
  }
  /** The document as JSON text, for a file; `new Cutscene(text)` reads it. */
  save(): string {
    return JSON.stringify(this.doc, null, 2);
  }
  /** A `Cutscene` of the document as it stands, to play or render. */
  cutscene(): Cutscene {
    return new Cutscene(this.document, { tracks: this.types });
  }
  /** Calls `listener` with the edit's label after every change, undo and redo included. Returns an unsubscribe function. */
  on(event: 'change', listener: Listener): () => void {
    if (event !== 'change') throw new RangeError(`TimelineModel has no '${String(event)}' event; use 'change'`);
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }
  /** Every top-level track, then the markers. A timeline clip moves as one clip; what is inside it is not shown. */
  get rows(): TimelineRow[] {
    const rows = (this.doc.tracks as unknown as TrackData[]).map((track): TimelineRow => {
      const [list, kind] = listOf(track);
      return {
        track: track.id,
        type: track.type,
        label: track.target ?? track.id,
        keyable: track.type === 'event' || (kind === 'key' && !!list),
        items: (list ?? []).map((item, index): TimelineItem => ({
          track: track.id,
          index,
          kind,
          time: timeOf(item),
          duration: kind === 'clip' ? (item.duration as number) : 0,
          label: kind === 'clip' ? clipName(item) : kind === 'event' ? String(item.name) : '',
        })),
      };
    });
    rows.push({
      track: MARKERS,
      type: 'marker',
      label: 'Markers',
      keyable: true,
      items: (this.doc.markers ?? []).map((marker, index) => ({
        track: MARKERS,
        index,
        kind: 'marker',
        time: marker.time,
        duration: 0,
        label: marker.name,
      })),
    });
    return rows;
  }
  /**
   * Adds a key at `time` on a key track, holding what the track gives there, so the value at that time stays as it
   * was until you edit it; `fields` set or replace parts of it. On an event track or the marker row it adds one named
   * `fields.name`.
   * @returns the new item.
   * @throws RangeError for an unknown track, a time outside the timeline, or a clip track: use {@link addItem}.
   */
  addKey(track: string, time: number, fields: Record<string, unknown> = {}): ItemRef {
    finite(time, 'Key time');
    if (time < 0 || time > this.duration) throw new RangeError(`Key time ${time} is outside the timeline; pass 0 to its duration`);
    if (track === MARKERS || this.track(track).type === 'event')
      return this.addItem(track, { name: track === MARKERS ? 'marker' : 'event', ...fields, time });
    const data = this.track(track);
    if (!data.keys) throw new RangeError(`Track '${track}' holds clips, not keys; use addItem with the clip's fields`);
    return this.addItem(track, { ...this.sampled(data, time), ...fields, time });
  }
  /**
   * Adds a whole key, event, marker or clip: `{ time, ... }`, or `{ start, duration, ... }` for a clip.
   * @returns the new item.
   * @throws RangeError for an unknown track or fields the document refuses.
   */
  addItem(track: string, item: Record<string, unknown>): ItemRef {
    const fresh = JSON.parse(JSON.stringify(item)) as Data;
    let at = -1;
    this.edit('Add', true, () => {
      const list = this.list(track, true);
      list.push(fresh);
      sort(list);
      at = list.indexOf(fresh);
    });
    return { track, index: at };
  }
  /**
   * Moves items together by `delta` seconds, stopping at the ends of the timeline as a group.
   * @returns the items where they are now. A move the document refuses changes nothing, and gives them back as they were.
   */
  moveItems(items: readonly ItemRef[], delta: number): ItemRef[] {
    finite(delta, 'Move');
    const held = items.map((ref) => ({ ref, item: this.item(ref) }));
    if (!held.length || delta === 0) return [...items];
    let shift = delta;
    for (const { item } of held) {
      const start = timeOf(item),
        end = start + (item.duration ?? 0);
      shift = Math.max(-start, Math.min(this.duration - end, shift));
    }
    if (shift === 0) return [...items];
    const moved = this.edit('Move', false, () => {
      for (const { item } of held) {
        if (item.start !== undefined) item.start = tidy(item.start + shift);
        else item.time = tidy((item.time as number) + shift);
      }
      for (const name of new Set(held.map(({ ref }) => ref.track))) sort(this.list(name));
    });
    if (!moved) return [...items];
    return held.map(({ ref, item }) => ({ track: ref.track, index: this.list(ref.track).indexOf(item) }));
  }
  /**
   * Changes fields of an item: a key's `value` or `ease`, an event's `name`, a clip's `duration`. Pass `undefined` to
   * remove a field. Use {@link moveItems} for its time.
   * @returns true, or false when the document refuses the change, which then does not happen.
   */
  setItem(ref: ItemRef, fields: Record<string, unknown>): boolean {
    const item = this.item(ref);
    return this.edit('Set', false, () => {
      for (const [name, value] of Object.entries(fields)) {
        if (value === undefined) delete item[name];
        else item[name] = JSON.parse(JSON.stringify(value)) as unknown;
      }
    });
  }
  /** Atomically edits and sorts an item, including its time. Returns its new ref, or undefined if validation refuses it. */
  updateItem(ref: ItemRef, fields: Record<string, unknown>): ItemRef | undefined {
    const item = this.item(ref);
    const changed = this.edit('Set', false, () => {
      for (const [name, value] of Object.entries(fields)) {
        if (value === undefined) delete item[name];
        else item[name] = JSON.parse(JSON.stringify(value)) as unknown;
      }
      sort(this.list(ref.track));
    });
    return changed ? { track: ref.track, index: this.list(ref.track).indexOf(item) } : undefined;
  }
  /** Deletes items. A delete the document refuses, such as a track's last key, changes nothing and gives false. */
  deleteItems(items: readonly ItemRef[]): boolean {
    const held = items.map((ref) => ({ ref, item: this.item(ref) }));
    if (!held.length) return true;
    return this.edit('Delete', false, () => {
      for (const { ref, item } of held) {
        const list = this.list(ref.track);
        list.splice(list.indexOf(item), 1);
      }
    });
  }
  /** Sets the length of the timeline. False when something would fall outside it, which is then not done. */
  setDuration(seconds: number): boolean {
    finite(seconds, 'Duration');
    return this.edit('Set duration', false, () => void ((this.doc as { duration: number }).duration = seconds));
  }
  /** Starts a run of edits that undo as one, such as a drag; {@link commit} ends it. */
  begin(label: string): void {
    if (this.open) throw new MargoError('state', 'An edit is already open; call commit() before begin()');
    this.open = { label, before: this.snapshot() };
  }
  /** Ends the run {@link begin} started. A run that changed nothing leaves no undo step. */
  commit(): void {
    if (!this.open) throw new MargoError('state', 'No edit is open; call begin() first');
    const { label, before } = this.open;
    this.open = null;
    this.remember(label, before);
  }
  /** Takes back the last edit, if any. */
  undo(): void {
    this.history.undo();
  }
  /** Does the last undone edit again, if any. */
  redo(): void {
    this.history.redo();
  }
  /** The time to use for `time`: on another item or a given time if one is near, else on the grid, else as it is. */
  snap(time: number, { step = 0.1, reach = 0.05, ignore = [], times = [] }: SnapOptions = {}): number {
    finite(time, 'Snap time');
    const skip = new Set(ignore.map((ref) => `${ref.track}\0${ref.index}`));
    let best = time,
      gap = reach;
    const pull = (at: number): void => {
      const away = Math.abs(at - time);
      if (away > gap) return;
      gap = away;
      best = at;
    };
    if (reach > 0) {
      for (const at of times) pull(at);
      pull(0);
      pull(this.duration);
      for (const row of this.rows)
        for (const item of row.items)
          if (!skip.has(`${item.track}\0${item.index}`)) {
            pull(item.time);
            if (item.duration) pull(item.time + item.duration);
          }
    }
    if (best !== time || !(step > 0)) return best;
    return Math.min(this.duration, Math.max(0, tidy(Math.round(time / step) * step)));
  }
  private track(id: string): TrackData {
    const found = (this.doc.tracks as unknown as TrackData[]).find((track) => track.id === id);
    if (!found) throw new RangeError(`No track '${id}' in this cutscene; use a row's track`);
    return found;
  }
  private list(track: string, create = false): Data[] {
    if (track === MARKERS) {
      if (create) this.doc.markers ??= [];
      return (this.doc.markers ?? []) as unknown as Data[];
    }
    const [list] = listOf(this.track(track));
    if (!list) throw new RangeError(`Track '${track}' holds nothing to edit here; use a row with items`);
    return list;
  }
  private item(ref: ItemRef): Data {
    const item = this.list(ref.track)[ref.index];
    if (!item) throw new RangeError(`No item ${ref.index} on track '${ref.track}'; use refs the last edit gave`);
    return item;
  }
  private sampled(track: TrackData, time: number): Record<string, unknown> {
    const state = this.cutscene().evaluate(time);
    if (track.type === 'camera') {
      const { position, target, fov, roll } = state.camera ?? ({} as Record<string, undefined>);
      return { position, target, fov, roll };
    }
    if (track.type === 'transform') return { ...state.transforms[track.target as string] };
    if (track.type === 'property') return { value: state.properties[track.target as string]?.[track.property as string] };
    return {};
  }
  private snapshot(): string {
    return JSON.stringify(this.doc);
  }
  private restore(text: string, label: string): void {
    this.doc = JSON.parse(text) as CutsceneDocument;
    this.changed(label);
  }
  private changed(label: string): void {
    for (const listener of [...this.listeners]) listener(label);
  }
  private remember(label: string, before: string): void {
    const after = this.snapshot();
    if (after === before) return;
    this.history.record({
      label,
      undo: () => this.restore(before, label),
      redo: () => this.restore(after, label),
    });
  }
  /** Runs one change; keeps it only if the document stays valid. `strict` reports a refusal as a RangeError. */
  private edit(label: string, strict: boolean, change: () => void): boolean {
    const before = this.snapshot();
    try {
      change();
    } catch (error) {
      this.doc = JSON.parse(before) as CutsceneDocument;
      throw error;
    }
    const issues = validateCutscene(this.doc, EASING_NAMES, this.checks);
    if (issues.length) {
      this.doc = JSON.parse(before) as CutsceneDocument;
      if (strict) throw new RangeError(`${label} refused: ${issues[0].path}: ${issues[0].message}; use a value the document allows`);
      return false;
    }
    if (!this.open) this.remember(label, before);
    this.changed(label);
    return true;
  }
}

function listOf(track: TrackData): [Data[] | undefined, TimelineItem['kind']] {
  if (track.keys) return [track.keys, 'key'];
  if (track.events) return [track.events, 'event'];
  return [track.clips, 'clip'];
}
/** Sorted by time; a stable sort keeps items of one time in their order. */
const sort = (list: Data[]): void => void list.sort((a, b) => timeOf(a) - timeOf(b));

/** Options of {@link TimelineEditor}. */
export interface TimelineEditorOptions extends TimelineModelOptions {
  /** Where the panel goes. Default none: place `element` yourself. */
  parent?: HTMLElement;
  /** Pixels a second, from 10 to 2000. Default 100. */
  zoom?: number;
  /** Grid in seconds, also what an arrow key moves. Default 0.1. */
  step?: number;
  /** Snap while dragging and scrubbing. Default true. */
  snap?: boolean;
  /** File name of the Export button. Default `'cutscene.json'`. */
  fileName?: string;
}

/** What {@link TimelineEditor.on} listens for, with what each gives. */
export interface TimelineEditorEvents {
  /** The playhead moved: seconds. */
  seek: number;
  /** The selection changed. */
  select: readonly ItemRef[];
  /** The document changed: the edit's label. */
  change: string;
}

const MIN_ZOOM = 10;
const MAX_ZOOM = 2000;
const ZOOM_STEP = 1.25;
/** Ruler marks: the first of these that leaves room for a label is used. */
const SPANS = [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60, 120, 300, 600];
const LABEL_ROOM = 60;

const STYLE = `
.mtl{--bg:#16181d;--panel:#1f2229;--line:#3a3f4a;--text:#e6e8ec;--dim:#a9afbb;--accent:#f2b134;--clip:#2f6f8f;
  background:var(--bg);color:var(--text);font:13px/1.4 system-ui,sans-serif;display:flex;flex-direction:column;min-height:120px;
  border:1px solid var(--line);outline-offset:-2px;touch-action:none;user-select:none}
.mtl button{font:inherit;color:inherit}
.mtl-bar{display:flex;gap:4px;align-items:center;padding:4px;background:var(--panel);border-bottom:1px solid var(--line);flex-wrap:wrap}
.mtl-bar button{min-height:28px;min-width:28px;padding:0 8px;background:transparent;border:1px solid var(--line);border-radius:3px;cursor:pointer}
.mtl-bar button[aria-pressed=true]{background:var(--accent);color:#16181d;border-color:var(--accent)}
.mtl-bar button:disabled{opacity:.45;cursor:default}
.mtl-time{margin-left:auto;font-variant-numeric:tabular-nums;padding:0 8px}
.mtl-body{display:flex;flex:1;min-height:0;overflow-y:auto}
.mtl-names{flex:0 0 130px;border-right:1px solid var(--line);background:var(--panel)}
.mtl-name{height:28px;line-height:28px;padding:0 8px;border-bottom:1px solid var(--line);overflow:hidden;white-space:nowrap;text-overflow:ellipsis;color:var(--dim);cursor:pointer}
.mtl-name[data-current]{color:var(--text);box-shadow:inset 3px 0 var(--accent)}
.mtl-head{height:24px;line-height:24px;border-bottom:1px solid var(--line)}
.mtl-scroll{flex:1;overflow-x:auto;overflow-y:hidden;position:relative}
.mtl-inner{position:relative}
.mtl-ruler{height:24px;position:relative;border-bottom:1px solid var(--line);cursor:ew-resize;overflow:hidden}
.mtl-tick{position:absolute;top:0;bottom:0;border-left:1px solid var(--line);padding-left:3px;font-size:11px;color:var(--dim);pointer-events:none}
.mtl-lane{height:28px;position:relative;border-bottom:1px solid var(--line)}
.mtl-item{position:absolute;top:3px;height:21px;padding:0;background:var(--clip);border:1px solid transparent;border-radius:3px;cursor:grab;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;font-size:11px;text-align:left}
.mtl-item[data-kind=key],.mtl-item[data-kind=event],.mtl-item[data-kind=marker]{width:13px;margin-left:-7px;background:var(--dim);transform:rotate(45deg) scale(.72)}
.mtl-item[data-kind=event],.mtl-item[data-kind=marker]{border-radius:50%;transform:none;top:7px;height:13px}
.mtl-item[aria-pressed=true]{background:var(--accent);color:#16181d;border-color:#fff}
.mtl-play{position:absolute;top:0;bottom:0;width:1px;background:var(--accent);pointer-events:none}
.mtl :focus-visible{outline:2px solid #fff;outline-offset:1px}
`;

/**
 * The timeline panel: rows of keys, clips and events under a ruler. Drag the ruler to scrub, drag items to move them,
 * and `on('seek' | 'select' | 'change', listener)` to follow along.
 *
 * | Key | Does |
 * | --- | --- |
 * | Left, Right | Moves the selection a step, or the playhead with nothing selected; Shift makes it ten |
 * | Home, End | Playhead to the ends |
 * | K | Adds a key at the playhead on the current row |
 * | Delete, Backspace | Deletes the selection |
 * | Ctrl+Z, Ctrl+Shift+Z, Ctrl+Y | Undo, redo (Cmd too) |
 * | +, - | Zoom |
 * | Escape | Clears the selection |
 *
 * @throws TypeError for a document that is not valid, RangeError for options out of range.
 */
export class TimelineEditor {
  /** The panel. */
  readonly element: HTMLDivElement;
  /** The document being edited. */
  readonly model: TimelineModel;
  private readonly bar: Record<'undo' | 'redo' | 'snap' | 'key' | 'time', HTMLElement> = {} as never;
  private readonly names: HTMLDivElement;
  private readonly scroll: HTMLDivElement;
  private readonly inner: HTMLDivElement;
  private readonly ruler: HTMLDivElement;
  private readonly lanes: HTMLDivElement;
  private readonly head: HTMLDivElement;
  private readonly listeners = new Map<string, Set<(value: never) => void>>();
  private readonly fileName: string;
  private readonly step: number;
  private readonly unsubscribe: () => void;
  private pixels: number;
  private snapping: boolean;
  private playhead = 0;
  private picked: ItemRef[] = [];
  private row: string;
  private drag: { pointer: number; kind: 'items' | 'scrub'; from: number; origin: number; applied: number } | null = null;
  /** True while a move is under way: the rows wait for the selection's new places. */
  private holding = false;
  private disposed = false;
  constructor(document: CutsceneDocument | string | unknown, options: TimelineEditorOptions = {}) {
    const { parent, zoom = 100, step = 0.1, snap = true, fileName = 'cutscene.json', ...model } = options;
    if (!(zoom >= MIN_ZOOM && zoom <= MAX_ZOOM)) throw new RangeError(`Timeline zoom must be ${MIN_ZOOM} to ${MAX_ZOOM}; pass pixels a second`);
    if (!(step > 0) || !Number.isFinite(step)) throw new RangeError('Timeline step must be above 0; pass seconds');
    this.model = new TimelineModel(document, model);
    this.pixels = zoom;
    this.step = step;
    this.snapping = snap;
    this.fileName = fileName;
    this.row = this.model.rows.find((row) => row.keyable)?.track ?? MARKERS;

    const tag = <K extends keyof HTMLElementTagNameMap>(name: K, className: string, into?: HTMLElement): HTMLElementTagNameMap[K] => {
      const made = window.document.createElement(name);
      made.className = className;
      into?.append(made);
      return made;
    };
    const root = (this.element = tag('div', 'mtl'));
    root.tabIndex = 0;
    root.setAttribute('role', 'application');
    root.setAttribute('aria-label', 'Cutscene timeline');
    tag('style', '', root).textContent = STYLE;
    const bar = tag('div', 'mtl-bar', root);
    bar.setAttribute('role', 'toolbar');
    bar.setAttribute('aria-label', 'Timeline tools');
    const button = (text: string, title: string, action: () => void): HTMLButtonElement => {
      const made = tag('button', '', bar);
      made.type = 'button';
      made.textContent = text;
      made.title = title;
      made.setAttribute('aria-label', title);
      made.addEventListener('click', action);
      return made;
    };
    this.bar.key = button('Key', 'Add key at the playhead', () => this.addKey());
    this.bar.undo = button('Undo', 'Undo', () => this.history('undo'));
    this.bar.redo = button('Redo', 'Redo', () => this.history('redo'));
    this.bar.snap = button('Snap', 'Snap to the grid and to other items', () => {
      this.snapping = !this.snapping;
      this.toolbar();
    });
    button('-', 'Zoom out', () => (this.zoom = this.pixels / ZOOM_STEP));
    button('+', 'Zoom in', () => (this.zoom = this.pixels * ZOOM_STEP));
    button('Export', 'Save the document as a JSON file', () => this.download());
    this.bar.time = tag('span', 'mtl-time', bar);
    this.bar.time.setAttribute('aria-live', 'off');
    const body = tag('div', 'mtl-body', root);
    this.names = tag('div', 'mtl-names', body);
    this.scroll = tag('div', 'mtl-scroll', body);
    this.inner = tag('div', 'mtl-inner', this.scroll);
    this.ruler = tag('div', 'mtl-ruler', this.inner);
    this.ruler.tabIndex = 0;
    this.ruler.setAttribute('role', 'slider');
    this.ruler.setAttribute('aria-label', 'Playhead');
    this.ruler.setAttribute('aria-valuemin', '0');
    this.lanes = tag('div', '', this.inner);
    this.head = tag('div', 'mtl-play', this.inner);

    root.addEventListener('pointerdown', (event) => this.press(event));
    root.addEventListener('pointermove', (event) => this.pointerMove(event));
    root.addEventListener('pointerup', (event) => this.release(event));
    root.addEventListener('pointercancel', (event) => this.release(event));
    root.addEventListener('keydown', (event) => this.key(event));
    root.addEventListener('wheel', (event) => this.wheel(event), { passive: false });
    this.unsubscribe = this.model.on('change', (label) => {
      if (!this.holding) this.draw();
      this.emit('change', label);
    });
    this.draw();
    parent?.append(root);
  }
  /** Playhead, seconds. Setting it moves the playhead and fires no event. */
  get time(): number {
    return this.playhead;
  }
  set time(seconds: number) {
    if (!Number.isFinite(seconds)) throw new RangeError('Timeline time must be a finite number of seconds; pass a number');
    this.playhead = Math.min(this.model.duration, Math.max(0, seconds));
    this.place();
  }
  /** Pixels a second. */
  get zoom(): number {
    return this.pixels;
  }
  set zoom(value: number) {
    if (!Number.isFinite(value)) throw new RangeError('Timeline zoom must be a finite number; pass pixels a second');
    this.pixels = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));
    this.draw();
  }
  /** Selected items. */
  get selection(): readonly ItemRef[] {
    return this.picked;
  }
  set selection(items: readonly ItemRef[]) {
    this.picked = [...items];
    this.draw();
    this.emit('select', this.picked);
  }
  /** Calls `listener` on an event. Returns an unsubscribe function. */
  on<K extends keyof TimelineEditorEvents>(event: K, listener: (value: TimelineEditorEvents[K]) => void): () => void {
    let set = this.listeners.get(event);
    if (!set) this.listeners.set(event, (set = new Set()));
    set.add(listener as (value: never) => void);
    return () => void set.delete(listener as (value: never) => void);
  }
  /** Removes the panel and its listeners. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe();
    this.listeners.clear();
    this.element.remove();
  }
  [Symbol.dispose](): void {
    this.dispose();
  }
  private emit<K extends keyof TimelineEditorEvents>(event: K, value: TimelineEditorEvents[K]): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) (listener as (value: TimelineEditorEvents[K]) => void)(value);
  }
  private toolbar(): void {
    (this.bar.undo as HTMLButtonElement).disabled = !this.model.history.undoCount;
    (this.bar.redo as HTMLButtonElement).disabled = !this.model.history.redoCount;
    this.bar.snap.setAttribute('aria-pressed', String(this.snapping));
    this.bar.time.textContent = `${this.playhead.toFixed(2)} s`;
  }
  /** Moves what follows the time, without rebuilding the rows. */
  private place(): void {
    this.head.style.left = `${this.playhead * this.pixels}px`;
    this.ruler.setAttribute('aria-valuenow', this.playhead.toFixed(2));
    this.ruler.setAttribute('aria-valuetext', `${this.playhead.toFixed(2)} seconds`);
    this.toolbar();
  }
  private draw(): void {
    const { rows, duration } = this.model,
      focused = window.document.activeElement as HTMLElement | null,
      keep = focused?.dataset?.track !== undefined && this.element.contains(focused),
      names = window.document.createDocumentFragment(),
      lanes = window.document.createDocumentFragment(),
      picked = new Set(this.picked.map((ref) => `${ref.track}\0${ref.index}`));
    const width = duration * this.pixels;
    this.inner.style.width = `${width + LABEL_ROOM}px`;
    this.ruler.setAttribute('aria-valuemax', String(duration));
    this.ruler.textContent = '';
    const span = SPANS.find((seconds) => seconds * this.pixels >= LABEL_ROOM) ?? SPANS.at(-1)!;
    for (let i = 0; i * span <= duration + 1e-9; i++) {
      const tick = window.document.createElement('div');
      tick.className = 'mtl-tick';
      tick.style.left = `${i * span * this.pixels}px`;
      tick.textContent = `${Number((i * span).toFixed(2))}`;
      this.ruler.append(tick);
    }
    const heading = window.document.createElement('div');
    heading.className = 'mtl-head';
    names.append(heading);
    for (const row of rows) {
      const name = window.document.createElement('div');
      name.className = 'mtl-name';
      name.textContent = row.label;
      name.title = `${row.type}: ${row.label}`;
      name.dataset.row = row.track;
      if (row.track === this.row) name.dataset.current = '';
      names.append(name);
      const lane = window.document.createElement('div');
      lane.className = 'mtl-lane';
      lane.dataset.row = row.track;
      lane.setAttribute('role', 'group');
      lane.setAttribute('aria-label', `${row.type} ${row.label}`);
      for (const item of row.items) {
        const element = window.document.createElement('button');
        element.type = 'button';
        element.className = 'mtl-item';
        element.dataset.kind = item.kind;
        element.dataset.track = item.track;
        element.dataset.index = String(item.index);
        element.style.left = `${item.time * this.pixels}px`;
        if (item.kind === 'clip') {
          element.style.width = `${Math.max(4, item.duration * this.pixels)}px`;
          element.textContent = item.label;
        }
        element.setAttribute('aria-pressed', String(picked.has(`${item.track}\0${item.index}`)));
        element.setAttribute('aria-label', `${item.kind} ${item.label} at ${item.time.toFixed(2)} seconds on ${row.label}`.replace('  ', ' '));
        lane.append(element);
      }
      lanes.append(lane);
    }
    this.names.replaceChildren(names);
    this.lanes.replaceChildren(lanes);
    this.place();
    // Rows are rebuilt, so the keyboard stays on the first selected item.
    if (keep && this.picked[0]) this.itemElement(this.picked[0])?.focus();
    else if (keep) this.element.focus();
  }
  private itemElement({ track, index }: ItemRef): HTMLElement | null {
    return this.lanes.querySelector(`[data-track="${CSS.escape(track)}"][data-index="${index}"]`);
  }
  /** Seconds under a pointer. */
  private timeAt(event: PointerEvent | WheelEvent): number {
    return (event.clientX - this.inner.getBoundingClientRect().left) / this.pixels;
  }
  private snapped(time: number, ignore: readonly ItemRef[] = []): number {
    if (!this.snapping) return time;
    // Eight pixels of pull, however far in or out the view is.
    return this.model.snap(time, { step: this.step, reach: 8 / this.pixels, ignore, times: ignore.length ? [this.playhead] : [] });
  }
  private seek(time: number): void {
    this.playhead = Math.min(this.model.duration, Math.max(0, time));
    this.place();
    this.emit('seek', this.playhead);
  }
  private press(event: PointerEvent): void {
    if (event.button !== 0 || this.drag) return;
    const target = event.target as HTMLElement,
      item = target.closest<HTMLElement>('.mtl-item'),
      rowOf = target.closest<HTMLElement>('[data-row]')?.dataset.row;
    if (rowOf !== undefined && rowOf !== this.row) {
      this.row = rowOf;
      for (const name of this.names.querySelectorAll<HTMLElement>('.mtl-name'))
        if (name.dataset.row === rowOf) name.dataset.current = '';
        else delete name.dataset.current;
    }
    if (item) {
      const ref = { track: item.dataset.track!, index: Number(item.dataset.index) },
        known = this.picked.some((other) => other.track === ref.track && other.index === ref.index);
      if (event.shiftKey || event.ctrlKey || event.metaKey)
        this.selection = known ? this.picked.filter((other) => other.track !== ref.track || other.index !== ref.index) : [...this.picked, ref];
      else if (!known) this.selection = [ref];
      if (!this.picked.length) return;
      const lead = this.model.rows.flatMap((row) => row.items).find((one) => one.track === ref.track && one.index === ref.index)!;
      this.grab(event, 'items', this.timeAt(event), lead.time);
      this.model.begin('Move');
      this.itemElement(ref)?.focus();
    } else if (this.ruler.contains(target)) {
      this.grab(event, 'scrub', 0, 0);
      this.ruler.focus();
      this.seek(this.snapped(this.timeAt(event)));
    } else if (this.scroll.contains(target)) {
      if (this.picked.length) this.selection = [];
      this.seek(this.snapped(this.timeAt(event)));
    }
  }
  private grab(event: PointerEvent, kind: 'items' | 'scrub', from: number, origin: number): void {
    // On the panel, as the rows are rebuilt under the pointer while it moves.
    this.element.setPointerCapture(event.pointerId);
    event.preventDefault();
    this.drag = { pointer: event.pointerId, kind, from, origin, applied: 0 };
  }
  private pointerMove(event: PointerEvent): void {
    const drag = this.drag;
    if (!drag || event.pointerId !== drag.pointer) return;
    if (drag.kind === 'scrub') {
      this.seek(this.snapped(this.timeAt(event)));
      return;
    }
    // The item grabbed leads: the others keep their distance from it.
    const wanted = this.snapped(drag.origin + this.timeAt(event) - drag.from, this.picked);
    drag.applied += this.shift(wanted - drag.origin - drag.applied);
  }
  /** Moves the selection and gives how far it went: less at the ends of the timeline, 0 when the document refuses. */
  private shift(by: number): number {
    const at = (): number => {
        const { track, index } = this.picked[0];
        return this.model.rows.find((row) => row.track === track)!.items[index].time;
      },
      before = at();
    this.holding = true;
    this.picked = this.model.moveItems(this.picked, by);
    this.holding = false;
    this.draw();
    return at() - before;
  }
  private release(event: PointerEvent): void {
    const drag = this.drag;
    if (!drag || event.pointerId !== drag.pointer) return;
    this.drag = null;
    if (this.element.hasPointerCapture(event.pointerId)) this.element.releasePointerCapture(event.pointerId);
    if (drag.kind === 'items') {
      this.model.commit();
      this.draw();
      this.emit('select', this.picked);
    }
  }
  /** Undo and redo put older lists back, so refs of the selection mean nothing there. */
  private history(action: 'undo' | 'redo'): void {
    if (this.drag) return;
    if (this.picked.length) this.selection = [];
    this.model[action]();
  }
  private addKey(): void {
    const row = this.model.rows.find((one) => one.track === this.row);
    if (!row?.keyable) return;
    this.selection = [this.model.addKey(row.track, this.playhead)];
    // The new key is where the keyboard goes next, and a screen reader says what was added.
    this.itemElement(this.picked[0])?.focus();
  }
  private nudge(direction: number, large: boolean): void {
    const by = direction * this.step * (large ? 10 : 1);
    if (this.picked.length) {
      this.shift(by);
      this.emit('select', this.picked);
    } else this.seek(tidy(this.playhead + by));
  }
  private key(event: KeyboardEvent): void {
    const { key } = event,
      command = event.ctrlKey || event.metaKey,
      letter = key.toLowerCase();
    if (command && letter === 'z') {
      this.history(event.shiftKey ? 'redo' : 'undo');
    } else if (command && letter === 'y') this.history('redo');
    else if (command || event.altKey) return;
    else if (key === 'ArrowLeft') this.nudge(-1, event.shiftKey);
    else if (key === 'ArrowRight') this.nudge(1, event.shiftKey);
    else if (key === 'Home') this.seek(0);
    else if (key === 'End') this.seek(this.model.duration);
    else if (letter === 'k') this.addKey();
    else if (key === 'Delete' || key === 'Backspace') {
      if (this.picked.length && this.model.deleteItems(this.picked)) this.selection = [];
    } else if (key === '+' || key === '=') this.zoom = this.pixels * ZOOM_STEP;
    else if (key === '-') this.zoom = this.pixels / ZOOM_STEP;
    else if (key === 'Escape') this.selection = [];
    else return;
    event.preventDefault();
  }
  private wheel(event: WheelEvent): void {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    // Keeps the time under the pointer where it is.
    const time = this.timeAt(event),
      left = event.clientX - this.scroll.getBoundingClientRect().left;
    this.zoom = this.pixels * (event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP);
    this.scroll.scrollLeft = time * this.pixels - left;
  }
  private download(): void {
    const url = URL.createObjectURL(new Blob([this.model.save()], { type: 'application/json' })),
      link = window.document.createElement('a');
    link.href = url;
    link.download = this.fileName;
    link.click();
    URL.revokeObjectURL(url);
  }
}
