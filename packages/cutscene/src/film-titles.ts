// @margoengine/cutscene/film-titles: the words a documentary film shows on film time. Captions from a cue list (an
// SRT read by `@margoengine/text/captions` fits), a chapter card ("03 / 13", the title and a place and date line) at
// each chapter start, and a closing card. Everything is a pure function of film time, so a film rendered shot by shot
// (each shot a fresh page seeked to its start) shows exactly what one continuous run shows at that time: no clock, no
// frame delta, no state carried between frames. `filmTitlesAt(spec, t)` is the pure part; `FilmTitles` draws it with
// `@margoengine/ui` widgets (one panel per card, faded by opacity).
import { MargoError } from '@margoengine/math/errors';
import { typeError } from '../../shared/errors.js';
import { Label, Panel, type PanelOptions, type TextSize, type Ui, type Widget } from '@margoengine/ui';

/** One caption: shown from `start` (inclusive) to `end` (exclusive), in film seconds. */
export interface FilmCue {
  start: number;
  end: number;
  /** The text. Newlines break lines. */
  text: string;
}

/**
 * A cue as a film may hold it: a {@link FilmCue}, a `[start, end, text]` tuple, or a cue of
 * `@margoengine/text/captions` (`{ start, end, lines }`, lines joined by newlines).
 */
export type FilmCueInput =
  | FilmCue
  | readonly [start: number, end: number, text: string]
  | { readonly start: number; readonly end: number; readonly lines: readonly string[] };

/** One chapter of a film. */
export interface FilmChapter {
  /** Film second the chapter starts. */
  start: number;
  /** Number on the card. Default the chapter's position in the list, counted from `firstNumber`. */
  number?: number;
  /** Chapter title, the large line of the card. */
  title: string;
  /** Place and date line under the title, such as `'Fauld, Staffordshire, 1944'`. Default none. */
  place?: string;
  /** Show a card for this chapter. Default true; a cold open sets false. */
  card?: boolean;
  /** Seconds the card stays up, fades included. Default the spec's `chapterHold`. */
  hold?: number;
}

/** The closing card. */
export interface FilmClosing {
  /** Film second the card starts to fade in. */
  start: number;
  /** Lines of the card, top to bottom, each with its own size and colour. Default {@link defaultClosingLines}. */
  lines?: readonly FilmTitleLine[];
}

/** One line of text on a card. */
export interface FilmTitleLine {
  text: string;
  /** Default `'body'`. */
  size?: TextSize;
  /** `#rrggbb[aa]` or a theme colour role. Default `'#fff5e8'`. */
  color?: string;
}

/** Everything {@link filmTitlesAt} and {@link FilmTitles} read. */
export interface FilmTitlesSpec {
  /** Film title, shown on the default closing card. */
  title: string;
  /** Captions. Order does not matter; where two overlap, the one that starts first shows. Default none. */
  cues?: readonly FilmCueInput[];
  /** Chapters in film order. Default none. */
  chapters?: readonly FilmChapter[];
  /** The "of" number on cards (`03 / 13`). Default the highest chapter number. */
  chapterCount?: number;
  /** Number of the first chapter when chapters carry no `number`. Default 0 (a cold open is chapter 00). */
  firstNumber?: number;
  /** Seconds a chapter card stays up, fades included. Default 4. */
  chapterHold?: number;
  /** Closing card, or none. Default none. */
  closing?: FilmClosing;
  /** Seconds a caption or card takes to fade in. Default 0.22. */
  fadeIn?: number;
  /** Seconds a caption or card takes to fade out. Default 0.24. */
  fadeOut?: number;
  /** Seconds the closing card takes to fade in. Default 1. */
  closingFade?: number;
}

/** What shows at one film time. A new object each call. */
export interface FilmTitlesState {
  /** The caption on screen, or null. */
  caption: { text: string; opacity: number } | null;
  /** The chapter card on screen, or null. `label` is `'03 / 13'`. */
  chapter: { index: number; label: string; title: string; place: string | null; opacity: number } | null;
  /** Opacity of the closing card, 0 when there is none. */
  closing: number;
}

/** The closing card's lines when the spec gives none: a credit, the film title and a call to subscribe. */
export function defaultClosingLines(title: string): FilmTitleLine[] {
  return [
    { text: 'Made with Margo Engine', size: 36, color: '#edbd84' },
    { text: title, size: 74, color: '#fff5e8' },
    { text: 'Please subscribe', size: 41, color: '#e4edf1' },
  ];
}

const bad = (message: string): never => {
  throw typeError(message, 'film-titles');
};
const finite = (value: unknown, what: string): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) bad(`${what} is a finite number, got ${String(value)}`);
  return value as number;
};
const smooth = (t: number): number => {
  const x = Math.max(0, Math.min(1, t));
  return x * x * (3 - 2 * x);
};
/** 0 before `a`, 1 after `b`, smoothstep between; a zero-length ramp is a step at `a`. */
const ramp = (t: number, a: number, b: number): number => (b > a ? smooth((t - a) / (b - a)) : t >= a ? 1 : 0);
/** Fade in over `fadeIn` from `start`, out over `fadeOut` to `end`; both are held inside half the span. */
const span = (t: number, start: number, end: number, fadeIn: number, fadeOut: number): number => {
  if (!(t >= start && t < end)) return 0;
  const half = (end - start) / 2;
  return ramp(t, start, start + Math.min(fadeIn, half)) * (1 - ramp(t, end - Math.min(fadeOut, half), end));
};

/** A spec checked once: cues normalised and sorted, chapter numbers and card windows resolved. */
interface Resolved {
  cues: FilmCue[];
  cards: { start: number; end: number; index: number; label: string; title: string; place: string | null }[];
  closing: number | null;
  fadeIn: number;
  fadeOut: number;
  closingFade: number;
}

const resolved = new WeakMap<FilmTitlesSpec, Resolved>();

function cueOf(input: FilmCueInput, i: number): FilmCue {
  let start: unknown, end: unknown, text: unknown;
  if (Array.isArray(input)) [start, end, text] = input as unknown[];
  else if (input && typeof input === 'object') {
    const cue = input as { start?: unknown; end?: unknown; text?: unknown; lines?: unknown };
    ({ start, end } = cue);
    text = Array.isArray(cue.lines) ? cue.lines.join('\n') : cue.text;
  } else bad(`cues[${i}] is a cue, a [start, end, text] tuple or a captions cue`);
  finite(start, `cues[${i}] start`);
  finite(end, `cues[${i}] end`);
  if (!((end as number) > (start as number))) bad(`cues[${i}] ends after it starts (${start} to ${end})`);
  if (typeof text !== 'string') bad(`cues[${i}] text is a string`);
  return { start: start as number, end: end as number, text: text as string };
}

/** Checks a spec and resolves it; {@link filmTitlesAt} and {@link FilmTitles} call it, so a bad spec fails at once. */
export function checkFilmTitles(spec: FilmTitlesSpec): void {
  resolve(spec);
}

function resolve(spec: FilmTitlesSpec): Resolved {
  const cached = resolved.get(spec);
  if (cached) return cached;
  if (!spec || typeof spec !== 'object') bad('the film titles spec is an object');
  if (typeof spec.title !== 'string') bad('title is a string');
  const fadeIn = finite(spec.fadeIn ?? 0.22, 'fadeIn'),
    fadeOut = finite(spec.fadeOut ?? 0.24, 'fadeOut'),
    closingFade = finite(spec.closingFade ?? 1, 'closingFade'),
    hold = finite(spec.chapterHold ?? 4, 'chapterHold'),
    first = finite(spec.firstNumber ?? 0, 'firstNumber');
  if (fadeIn < 0 || fadeOut < 0 || closingFade < 0 || hold <= 0) bad('fades are 0 or more and chapterHold above 0');
  const cues = (spec.cues ?? []).map(cueOf).sort((a, b) => a.start - b.start || a.end - b.end);
  const chapters = spec.chapters ?? [];
  const numbers = chapters.map((c, i) =>
    c.number === undefined ? first + i : finite(c.number, `chapters[${i}] number`),
  );
  const count = spec.chapterCount === undefined ? Math.max(0, ...numbers) : finite(spec.chapterCount, 'chapterCount');
  const width = Math.max(2, String(Math.round(count)).length);
  const cards: Resolved['cards'] = [];
  chapters.forEach((chapter, i) => {
    const start = finite(chapter.start, `chapters[${i}] start`);
    if (i && !(start > chapters[i - 1].start)) bad(`chapters start in film order; chapters[${i}] starts at ${start}`);
    if (typeof chapter.title !== 'string') bad(`chapters[${i}] title is a string`);
    if (chapter.card === false) return;
    const length = finite(chapter.hold ?? hold, `chapters[${i}] hold`);
    if (length <= 0) bad(`chapters[${i}] hold is above 0`);
    const next = chapters[i + 1]?.start ?? Infinity;
    cards.push({
      start,
      end: Math.min(start + length, next),
      index: i,
      label: `${String(numbers[i]).padStart(width, '0')} / ${String(count).padStart(width, '0')}`,
      title: chapter.title,
      place: chapter.place ?? null,
    });
  });
  const closing = spec.closing ? finite(spec.closing.start, 'closing start') : null;
  const result = { cues, cards, closing, fadeIn, fadeOut, closingFade };
  resolved.set(spec, result);
  return result;
}

/** The first cue (by start) that holds `t`, by binary search on starts then a short scan back over overlaps. */
function cueAt(cues: FilmCue[], t: number): FilmCue | null {
  let lo = 0,
    hi = cues.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cues[mid].start <= t) lo = mid + 1;
    else hi = mid;
  }
  let found: FilmCue | null = null;
  for (let i = lo - 1; i >= 0; i--) if (cues[i].end > t) found = cues[i];
  return found;
}

/**
 * What a film shows at film second `t`: the caption with its fade, the chapter card with its fade and the closing
 * card's opacity. Pure: the same spec and time give the same state, whatever was asked before.
 *
 * @example
 * const state = filmTitlesAt({ title: 'Fauld', cues: [[1, 4, 'November 1944.']] }, 2);
 * state.caption; // { text: 'November 1944.', opacity: 1 }
 */
export function filmTitlesAt(spec: FilmTitlesSpec, t: number): FilmTitlesState {
  const r = resolve(spec);
  finite(t, 'film time');
  const cue = cueAt(r.cues, t);
  const card = r.cards.find((c) => t >= c.start && t < c.end) ?? null;
  return {
    caption: cue ? { text: cue.text, opacity: span(t, cue.start, cue.end, r.fadeIn, r.fadeOut) } : null,
    chapter: card
      ? {
          index: card.index,
          label: card.label,
          title: card.title,
          place: card.place,
          opacity: span(t, card.start, card.end, r.fadeIn, r.fadeOut),
        }
      : null,
    closing: r.closing === null ? 0 : ramp(t, r.closing, r.closing + r.closingFade),
  };
}

/** A panel whose opacity the film sets; hidden at 0 so it costs nothing to draw. */
class FadePanel extends Panel {
  private alpha = 0;
  constructor(options: PanelOptions) {
    super({ ...options, visible: false });
  }
  override get opacity(): number {
    return this.alpha;
  }
  fade(alpha: number): void {
    if (alpha === this.alpha) return;
    this.alpha = alpha;
    this.visible = alpha > 0;
    this.invalidate(false);
  }
}

/** Looks of {@link FilmTitles}. Every field has a default matched to a 1920 by 1080 reference UI. */
export interface FilmTitlesStyle {
  /** Caption text size. Default 39. */
  captionSize?: TextSize;
  /** Caption text colour. Default `'#faf4e7'`. */
  captionColor?: string;
  /** Panel colour behind captions and cards. Default `'#111a23cf'`. */
  background?: string;
  /** Chapter number size. Default 30. */
  numberSize?: TextSize;
  /** Chapter title size. Default 64. */
  titleSize?: TextSize;
  /** Place and date line size. Default 32. */
  placeSize?: TextSize;
  /** Margin of the caption panel from the bottom-left corner, `[top, right, bottom, left]`. Default `[0, 0, 74, 97]`. */
  captionMargin?: [number, number, number, number];
  /** Margin of the chapter and closing cards, `[top, right, bottom, left]`. Default `[0, 0, 200, 98]`. */
  cardMargin?: [number, number, number, number];
}

/**
 * Captions, chapter cards and a closing card drawn with `@margoengine/ui` on film time. Call `update(t)` with the film
 * second each frame (or once per captured frame); the widgets only change when what shows changes.
 *
 * @example
 * import { Ui, UiRenderer } from '@margoengine/ui';
 * import { parseSrt } from '@margoengine/text/captions';
 * import { FilmTitles } from '@margoengine/cutscene/film-titles';
 *
 * const ui = new Ui({ scale: { reference: [1920, 1080], match: 0.5 } });
 * UiRenderer.attach(engine, ui);
 * using titles = new FilmTitles(ui, {
 *   title: 'Fauld',
 *   cues: parseSrt(srtText).cues,
 *   chapters: [{ start: 0, title: 'Cold open', card: false }, { start: 43, title: 'Gentle country', place: 'Fauld, 1944' }],
 *   closing: { start: 880 },
 * });
 * engine.onFrame(() => titles.update(filmTime));
 */
export class FilmTitles implements Disposable {
  /** The spec this draws. */
  readonly spec: FilmTitlesSpec;
  /** What the last `update` showed. */
  state: FilmTitlesState = { caption: null, chapter: null, closing: 0 };
  private readonly ui: Ui;
  private readonly widgets: Widget[];
  private readonly caption: Label;
  private readonly captionPanel: FadePanel;
  private readonly number: Label;
  private readonly title: Label;
  private readonly place: Label;
  private readonly card: FadePanel;
  private readonly closing: FadePanel | null;
  private disposed = false;

  constructor(ui: Ui, spec: FilmTitlesSpec, style: FilmTitlesStyle = {}) {
    if (!ui || typeof (ui as { add?: unknown }).add !== 'function') bad('FilmTitles needs a Ui from @margoengine/ui');
    resolve(spec);
    this.ui = ui;
    this.spec = spec;
    const background = style.background ?? '#111a23cf';
    const cardMargin = style.cardMargin ?? [0, 0, 200, 98];
    this.caption = new Label({
      text: '',
      size: style.captionSize ?? 39,
      color: style.captionColor ?? '#faf4e7',
      outline: true,
      wrap: false,
    });
    this.captionPanel = new FadePanel({
      anchor: 'bottom-left',
      margin: style.captionMargin ?? [0, 0, 74, 97],
      padding: [11, 18, 11, 18],
      radius: 7,
      background,
      pointerEvents: 'none',
      children: [this.caption],
    });
    this.number = new Label({ text: '', size: style.numberSize ?? 30, color: '#edbd84', wrap: false });
    this.title = new Label({ text: '', size: style.titleSize ?? 64, color: '#fff5e8', wrap: false });
    this.place = new Label({ text: '', size: style.placeSize ?? 32, color: '#e4edf1', wrap: false });
    this.card = new FadePanel({
      anchor: 'bottom-left',
      margin: cardMargin,
      padding: 25,
      radius: 8,
      gap: 7,
      background,
      pointerEvents: 'none',
      children: [this.number, this.title, this.place],
    });
    const lines = spec.closing ? (spec.closing.lines ?? defaultClosingLines(spec.title)) : null;
    this.closing = lines
      ? new FadePanel({
          anchor: 'bottom-left',
          margin: cardMargin,
          padding: 25,
          radius: 8,
          gap: 7,
          background: '#101920e8',
          pointerEvents: 'none',
          children: lines.map(
            (line) =>
              new Label({ text: line.text, size: line.size ?? 'body', color: line.color ?? '#fff5e8', wrap: false }),
          ),
        })
      : null;
    this.widgets = [this.captionPanel, this.card, ...(this.closing ? [this.closing] : [])];
    ui.add(...this.widgets);
  }

  /** Shows what the film shows at second `t` and returns it. */
  update(t: number): FilmTitlesState {
    if (this.disposed)
      throw new MargoError(
        'disposed',
        'FilmTitles is disposed; create a new FilmTitles; see https://margoengine.com/errors#film-titles',
      );
    const state = filmTitlesAt(this.spec, t);
    if (state.caption) this.caption.text = state.caption.text;
    this.captionPanel.fade(state.caption?.opacity ?? 0);
    if (state.chapter) {
      this.number.text = state.chapter.label;
      this.title.text = state.chapter.title;
      this.place.text = state.chapter.place ?? '';
      this.place.visible = state.chapter.place !== null;
    }
    this.card.fade(state.chapter?.opacity ?? 0);
    this.closing?.fade(state.closing);
    this.state = state;
    return state;
  }

  /** Removes the widgets from the UI. Safe to call twice. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const widget of this.widgets) this.ui.remove(widget);
  }

  [Symbol.dispose](): void {
    this.dispose();
  }
}
