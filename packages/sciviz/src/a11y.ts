import type { Figure, Layer, LineLayer, ScatterLayer } from './figure.js';
import type { Theme } from './axes.js';
import { chartDataAdapters } from './chart-data.js';
import { figureAtCanvas, registerFigureCleanup } from './publication-labels.js';
import { fault, rangeError } from '../../shared/errors.js';
import { multiplyMatrices, projectPoint } from '@margoengine/math/mat4';

/** A native or application-defined row, in data units. */
export interface AccessibleDatum {
  readonly x?: number;
  readonly y?: number;
  readonly z?: number;
  readonly value: number;
}
/** A complete lazy series. Navigation and table paging do not truncate its count. */
export interface AccessibleSeries {
  readonly name: string;
  readonly kind: 'point' | 'bin' | 'series' | 'voxel' | 'cell';
  readonly count: number;
  datum(index: number): AccessibleDatum;
}
/** Numeric evidence used by both descriptions and sonification. */
export interface DataDescription {
  readonly count: number;
  readonly finite: number;
  readonly missing: number;
  readonly minimum: number;
  readonly maximum: number;
  readonly minimumIndex: number;
  readonly maximumIndex: number;
  readonly mean: number;
  readonly slope: number;
  readonly trend: 'rising' | 'falling' | 'flat' | 'unavailable';
}

function abortable<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  if (!signal) return pending;
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    pending.then(
      (v) => {
        signal.removeEventListener('abort', abort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener('abort', abort);
        reject(e);
      },
    );
    if (signal.aborted) abort();
  });
}

/** Exact one-pass finite-value ranges, extreme positions and online least-squares trend in observation order. */
export function describeSeries(series: AccessibleSeries): DataDescription {
  let finite = 0,
    minimum = Infinity,
    maximum = -Infinity,
    minimumIndex = -1,
    maximumIndex = -1,
    mean = 0,
    meanX = 0,
    sxx = 0,
    sxy = 0;
  for (let i = 0; i < series.count; i++) {
    const row = series.datum(i),
      y = row.value,
      x = Number.isFinite(row.x) ? row.x! : i;
    if (!Number.isFinite(y)) continue;
    finite++;
    if (y < minimum) {
      minimum = y;
      minimumIndex = i;
    }
    if (y > maximum) {
      maximum = y;
      maximumIndex = i;
    }
    const dx = x - meanX,
      dy = y - mean;
    meanX += dx / finite;
    mean += dy / finite;
    sxx += dx * (x - meanX);
    sxy += dx * (y - mean);
  }
  const slope = sxx > 0 ? sxy / sxx : 0;
  return {
    count: series.count,
    finite,
    missing: series.count - finite,
    minimum: finite ? minimum : NaN,
    maximum: finite ? maximum : NaN,
    minimumIndex,
    maximumIndex,
    mean: finite ? mean : NaN,
    slope,
    trend: !finite ? 'unavailable' : slope > 0 ? 'rising' : slope < 0 ? 'falling' : 'flat',
  };
}

/** A complete finite/missing pitch schedule. Missing samples occupy their own silent time slots. */
export interface SonificationPlan {
  readonly frequencies: Float32Array;
  readonly audible: Uint8Array;
  readonly times: Float64Array;
  readonly duration: number;
}
/** Listening duration and pitch bounds. No sound plays while constructing a plan. */
export interface SonificationOptions {
  /** Seconds, default 10; (0,600]. */ readonly duration?: number;
  /** Low/high Hz, default [220,880], each in [20,20000]. Values interpolate in octaves. */ readonly pitch?: readonly [
    number,
    number,
  ];
  /** Finite data range, default observed finite extremes. Constant data maps to the pitch midpoint. */ readonly range?: readonly [
    number,
    number,
  ];
  /** Optional increasing source times; default equally spaced records. */ readonly times?: ArrayLike<number>;
  /** Allocation/event budget, default 100000 records. Exceeding it rejects instead of discarding data. */ readonly maxPoints?: number;
  readonly signal?: AbortSignal;
}

/** Map scalar value to pitch and source time to listening time, following astronomical time-series sonification practice. */
export function sonificationPlan(values: ArrayLike<number>, options: SonificationOptions = {}): SonificationPlan {
  options.signal?.throwIfAborted();
  if (!values || typeof values.length !== 'number')
    throw rangeError('Sonification needs numeric values; supply an array-like source', 'sciviz');
  const duration = options.duration ?? 10,
    pitch = options.pitch ?? [220, 880],
    n = values.length,
    max = options.maxPoints ?? 100000;
  if (!Number.isInteger(n) || n < 1 || !Number.isInteger(max) || max < 1 || n > max)
    throw rangeError('Sonification needs 1..maxPoints records; choose a data window or raise maxPoints', 'sciviz');
  if (
    !(duration > 0 && duration <= 600 && Number.isFinite(duration)) ||
    pitch.length !== 2 ||
    !pitch.every((v) => Number.isFinite(v) && v >= 20 && v <= 20000) ||
    pitch[1] <= pitch[0]
  )
    throw rangeError(
      'Sonification needs duration in (0,600] and increasing pitch bounds in [20,20000] Hz; correct options',
      'sciviz',
    );
  let lo = Infinity,
    hi = -Infinity;
  for (let i = 0; i < n; i++) {
    const v = values[i];
    if (Number.isFinite(v)) {
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
  }
  if (!Number.isFinite(lo)) throw rangeError('Sonification has no finite values; supply an observed series', 'sciviz');
  if (options.range) {
    [lo, hi] = options.range;
    if (![lo, hi].every(Number.isFinite) || hi < lo)
      throw rangeError('Sonification range must be finite and ordered; correct range', 'sciviz');
  }
  const times = options.times;
  if (
    times &&
    (times.length !== n || Array.from(times).some((t, i) => !Number.isFinite(t) || (i > 0 && t <= times[i - 1])))
  )
    throw rangeError('Source times must be finite, strictly increasing and match values; correct times', 'sciviz');
  const frequencies = new Float32Array(n),
    audible = new Uint8Array(n),
    at = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    if ((i & 16383) === 0) options.signal?.throwIfAborted();
    const v = values[i],
      f = hi > lo ? Math.min(1, Math.max(0, (v - lo) / (hi - lo))) : 0.5;
    audible[i] = Number.isFinite(v) ? 1 : 0;
    frequencies[i] = audible[i] ? pitch[0] * (pitch[1] / pitch[0]) ** f : pitch[0];
    at[i] =
      n === 1 ? 0 : duration * (times ? (((times[i] - times[0]) / (times[n - 1] - times[0])) * (n - 1)) / n : i / n);
  }
  return { frequencies, audible, times: at, duration };
}

/** Play only after a user gesture. Own contexts close on completion, cancellation or failure; borrowed contexts remain open. */
export async function playSonification(
  values: ArrayLike<number>,
  options: SonificationOptions & { readonly volume?: number; readonly context?: AudioContext } = {},
): Promise<void> {
  const plan = sonificationPlan(values, options),
    volume = options.volume ?? 0.05;
  if (!Number.isFinite(volume) || volume < 0 || volume > 1)
    throw rangeError('Sonification volume must be in [0,1]; correct volume', 'sciviz');
  if (!options.context && typeof AudioContext === 'undefined')
    throw fault('unsupported', 'Web Audio is unavailable; use a browser with AudioContext', 'sciviz');
  const context = options.context ?? new AudioContext(),
    owned = !options.context;
  let oscillator: OscillatorNode | undefined, gain: GainNode | undefined;
  try {
    options.signal?.throwIfAborted();
    await abortable(context.resume(), options.signal);
    options.signal?.throwIfAborted();
    oscillator = context.createOscillator();
    gain = context.createGain();
    oscillator.connect(gain);
    gain.connect(context.destination);
    const start = context.currentTime + 0.03,
      stop = start + plan.duration;
    gain.gain.setValueAtTime(0, start);
    let previousGain = 0;
    for (let i = 0; i < plan.times.length; i++) {
      const t = start + plan.times[i];
      oscillator.frequency.setValueAtTime(plan.frequencies[i], t);
      gain.gain.setValueAtTime(previousGain, t);
      previousGain = plan.audible[i] ? volume : 0;
      gain.gain.linearRampToValueAtTime(
        previousGain,
        Math.min(t + Math.min(0.003, plan.duration / plan.times.length / 3), stop),
      );
    }
    gain.gain.setValueAtTime(0, stop);
    await new Promise<void>((resolve, reject) => {
      let finished = false;
      const abort = () => {
        if (finished) return;
        finished = true;
        oscillator!.onended = null;
        oscillator!.stop();
        reject(options.signal!.reason);
      };
      oscillator!.onended = () => {
        if (finished) return;
        finished = true;
        options.signal?.removeEventListener('abort', abort);
        resolve();
      };
      options.signal?.addEventListener('abort', abort, { once: true });
      oscillator!.start(start);
      oscillator!.stop(stop + 0.01);
      if (options.signal?.aborted) abort();
    });
  } finally {
    oscillator?.disconnect();
    gain?.disconnect();
    if (owned) await context.close();
  }
}

/** High-contrast chrome; data colour encodings remain explicit and retain their legends. */
export const HIGH_CONTRAST_THEME: Theme = Object.freeze({
  background: '#000000',
  axis: '#ffffff',
  grid: '#888888',
  text: '#ffffff',
});

/** Optional descriptions/adapters and presentation preferences. */
export interface AccessibilityOptions {
  readonly title?: string;
  /** Custom layers supply complete rows; native point/line/bin/surface/volume data is discovered automatically. */
  readonly series?:
    | readonly AccessibleSeries[]
    | ((signal: AbortSignal) => readonly AccessibleSeries[] | Promise<readonly AccessibleSeries[]>);
  /** Rows on one table page, default 50, 1..1000. Every row remains reachable. */ readonly pageSize?: number;
  /** Respect prefers-reduced-motion by default; true/false overrides the media query. */ readonly reducedMotion?: boolean;
  /** Apply high-contrast chrome. Default prefers-contrast:more or forced-colors:active. */ readonly highContrast?: boolean;
  readonly signal?: AbortSignal;
}
/** A live optional accessible view. Focus and selection are separate; refresh after in-place application data edits. */
export interface AccessibilityHandle {
  /** Initial data description and table are ready. */
  readonly ready: Promise<void>;
  readonly element: HTMLElement;
  readonly series: readonly AccessibleSeries[];
  readonly focused: { readonly series: number; readonly index: number };
  refresh(): Promise<void>;
  focus(series: number, index: number): void;
  listen(options?: SonificationOptions): Promise<void>;
  dispose(): void;
  [Symbol.dispose](): void;
}

/** A canvas's current figure, or undefined for an application-owned non-figure canvas. */
export function figureForCanvas(canvas: HTMLCanvasElement): Figure | undefined {
  return figureAtCanvas(canvas) as Figure | undefined;
}
const number = (n: number | undefined) =>
  n === undefined
    ? ''
    : Number.isNaN(n)
      ? 'missing'
      : Number.isFinite(n)
        ? Number(n.toPrecision(7)).toString()
        : String(n);
let serial = 0;
const views = new WeakMap<Figure, AccessibilityHandle>();
const plotPositions = new WeakMap<AccessibleSeries, (index: number) => readonly [number, number, number]>();

async function nativeSeries(figure: Figure, signal: AbortSignal): Promise<AccessibleSeries[]> {
  const out: AccessibleSeries[] = [];
  const scales = figure.axisScales;
  for (const layer of figure.layers) {
    signal.throwIfAborted();
    const l = layer as Layer & {
      kind?: string;
      name?: string;
      positions?: Float32Array;
      values?: ArrayLike<number>;
      rects?: Float32Array;
      dims?: readonly [number, number, number];
      nx?: number;
      ny?: number;
      x?: readonly [number, number];
      y?: readonly [number, number];
      readValues?: (o: { signal: AbortSignal }) => Promise<ArrayLike<number>>;
    };
    const name = l.name || `${l.kind ?? 'Scalar layer'} ${out.length + 1}`;
    if (l.positions && (l.kind === 'line' || l.kind === 'scatter')) {
      const p = l.positions,
        n = p.length / 3;
      const raw = chartDataAdapters.get(figure)?.read(layer as LineLayer | ScatterLayer);
      const series: AccessibleSeries = {
        name,
        kind: l.kind === 'scatter' ? 'point' : 'series',
        count: n,
        datum: (i) => ({
          x: raw?.x[i] ?? scales[0].inverse(p[i * 3]),
          y: raw?.y[i] ?? scales[1].inverse(p[i * 3 + 1]),
          z: scales[2].inverse(p[i * 3 + 2]),
          value: l.values?.[i] ?? raw?.y[i] ?? scales[1].inverse(p[i * 3 + 1]),
        }),
      };
      plotPositions.set(series, (i) => [p[i * 3], p[i * 3 + 1], p[i * 3 + 2]]);
      out.push(series);
    } else if (l.values && l.rects) {
      const v = l.values,
        r = l.rects;
      out.push({
        name,
        kind: 'bin',
        count: v.length,
        datum: (i) => ({
          x: scales[0].inverse((r[i * 4] + r[i * 4 + 2]) / 2),
          y: scales[1].inverse((r[i * 4 + 1] + r[i * 4 + 3]) / 2),
          value: v[i],
        }),
      });
    } else if (l.readValues) {
      const v = await l.readValues({ signal });
      const dims = l.dims,
        b = l.bounds;
      if (dims)
        out.push({
          name,
          kind: 'voxel',
          count: v.length,
          datum: (i) => ({
            x: b[0] + ((i % dims[0]) / (dims[0] - 1)) * (b[1] - b[0]),
            y: b[2] + ((Math.floor(i / dims[0]) % dims[1]) / (dims[1] - 1)) * (b[3] - b[2]),
            z: b[4] + (Math.floor(i / (dims[0] * dims[1])) / (dims[2] - 1)) * (b[5] - b[4]),
            value: v[i],
          }),
        });
      else if (l.nx && l.ny && l.x && l.y) {
        const nx = l.nx,
          ny = l.ny,
          x = l.x,
          y = l.y;
        out.push({
          name,
          kind: 'point',
          count: v.length,
          datum: (i) => ({
            x: x[0] + ((i % nx) / (nx - 1)) * (x[1] - x[0]),
            y: y[0] + (Math.floor(i / nx) / (ny - 1)) * (y[1] - y[0]),
            z: v[i],
            value: v[i],
          }),
        });
      } else out.push({ name, kind: 'cell', count: v.length, datum: (i) => ({ value: v[i] }) });
    }
  }
  return out;
}

/** Attach keyboard data exploration, live summaries, full pageable data tables and explicit sonification controls. */
export function attachAccessibility(figure: Figure, options: AccessibilityOptions = {}): AccessibilityHandle {
  options.signal?.throwIfAborted();
  views.get(figure)?.dispose();
  const canvas = (figure.engine as unknown as { canvas: HTMLCanvasElement }).canvas,
    doc = canvas.ownerDocument,
    host = canvas.parentElement ?? doc.body;
  const size = options.pageSize ?? 50;
  if (!Number.isInteger(size) || size < 1 || size > 1000)
    throw rangeError('Accessibility pageSize must be 1..1000; correct pageSize', 'sciviz');
  const originalPosition = host.style.position;
  if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
  const id = `margo-a11y-${serial++}`,
    controller = new AbortController(),
    off: (() => void)[] = [];
  let data: readonly AccessibleSeries[] = [],
    seriesIndex = 0,
    index = 0,
    page = 0,
    disposed = false,
    audio: AbortController | undefined,
    version = 0;
  const saved = new Map(
    ['role', 'tabindex', 'aria-label', 'aria-describedby', 'aria-keyshortcuts', 'aria-roledescription'].map((k) => [
      k,
      canvas.getAttribute(k),
    ]),
  );
  const root = doc.createElement('section');
  root.dataset.margoA11y = '';
  root.setAttribute('aria-label', options.title ?? 'Figure data access');
  root.style.cssText = `position:absolute;top:${canvas.offsetTop + 8}px;left:${canvas.offsetLeft + 8}px;width:min(360px,calc(100% - 16px));font:14px/1.5 system-ui;color:#111111;z-index:40;pointer-events:none`;
  const panel = doc.createElement('details'),
    launcher = doc.createElement('summary');
  launcher.textContent = 'Explore data';
  launcher.style.cssText = 'min-height:24px;min-width:24px;line-height:24px';
  panel.style.cssText =
    'pointer-events:auto;width:fit-content;max-width:100%;margin-left:0;background:#ffffff;color:#111111;border:1px solid #666666;padding:7px;box-sizing:border-box;max-height:min(70vh,420px);overflow:auto';
  panel.append(launcher);
  root.append(panel);
  const summary = doc.createElement('p');
  summary.id = id + '-summary';
  const instructions = doc.createElement('p');
  instructions.id = id + '-keys';
  instructions.textContent =
    'Focus the chart to explore data. Left and right move records; up and down change series; Home and End jump to endpoints. Tab leaves the chart. Focus does not change selection.';
  const live = doc.createElement('p');
  live.setAttribute('role', 'status');
  live.setAttribute('aria-live', 'polite');
  live.setAttribute('aria-atomic', 'true');
  const details = doc.createElement('details'),
    toggle = doc.createElement('summary');
  toggle.textContent = 'Data table';
  toggle.style.cssText = 'min-height:24px;min-width:24px;line-height:24px';
  details.append(toggle);
  const table = doc.createElement('table'),
    caption = doc.createElement('caption'),
    head = doc.createElement('thead'),
    body = doc.createElement('tbody');
  table.append(caption, head, body);
  details.append(table);
  const controls = doc.createElement('div'),
    previous = doc.createElement('button'),
    next = doc.createElement('button'),
    listen = doc.createElement('button'),
    stop = doc.createElement('button');
  previous.textContent = 'Previous rows';
  next.textContent = 'Next rows';
  listen.textContent = 'Listen to series';
  stop.textContent = 'Stop sound';
  for (const b of [previous, next, listen, stop]) {
    b.type = 'button';
    b.style.cssText =
      'font:inherit;margin:4px;padding:6px 10px;color:#111111;background:#ffffff;border:1px solid #666666';
    controls.append(b);
  }
  panel.append(summary, instructions, details, controls);
  live.style.cssText = 'position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap';
  root.append(live);
  host.append(root);
  const style = doc.createElement('style');
  style.textContent = `[data-margo-a11y] details[open]{width:360px;max-width:100%}[data-margo-a11y] button:disabled{color:#555555!important;background:#eeeeee!important}canvas[data-margo-explore]:focus-visible{outline:3px solid Highlight;outline-offset:3px}[data-margo-a11y] :focus-visible{outline:3px solid Highlight;outline-offset:3px}[data-margo-a11y] th,[data-margo-a11y] td{padding:3px 8px;text-align:right}[data-margo-a11y] table{border-collapse:collapse}[data-margo-a11y] tbody tr[aria-current=true]{outline:2px solid Highlight}`;
  root.append(style);
  canvas.dataset.margoExplore = '';
  canvas.tabIndex = 0;
  canvas.setAttribute('role', 'application');
  canvas.setAttribute('aria-roledescription', 'interactive scientific figure');
  canvas.setAttribute('aria-label', options.title ?? saved.get('aria-label') ?? 'Scientific figure');
  canvas.setAttribute('aria-describedby', `${id}-summary ${id}-keys`);
  canvas.setAttribute('aria-keyshortcuts', 'ArrowLeft ArrowRight ArrowUp ArrowDown Home End');
  const marker = doc.createElement('span');
  marker.setAttribute('aria-hidden', 'true');
  marker.style.cssText =
    'position:absolute;width:12px;height:12px;box-sizing:border-box;border:2px solid #ffffff;outline:2px solid #000000;border-radius:50%;pointer-events:none;z-index:20;transform:translate(-50%,-50%)';
  marker.hidden = true;
  host.append(marker);
  const on = (target: EventTarget, type: string, fn: EventListener, capture = false) => {
    target.addEventListener(type, fn, capture);
    off.push(() => target.removeEventListener(type, fn, capture));
  };
  const coordinate = (value: number | undefined, axis: number) =>
    value !== undefined && Number.isFinite(value) && figure.axisScales[axis]?.type === 'date'
      ? new Date(value).toISOString()
      : number(value);
  const paintTable = () => {
    const s = data[seriesIndex];
    head.replaceChildren();
    body.replaceChildren();
    if (!s) {
      caption.textContent = 'No data series';
      previous.disabled = next.disabled = listen.disabled = true;
      return;
    }
    page = Math.min(Math.floor(Math.max(0, s.count - 1) / size), Math.max(0, page));
    const start = page * size,
      end = Math.min(s.count, start + size);
    caption.textContent = `${s.name}. Records ${s.count ? start + 1 : 0} to ${end} of ${s.count}.`;
    table.setAttribute('aria-rowcount', String(s.count + 1));
    const tr = doc.createElement('tr');
    for (const label of ['Record', 'x', 'y', 'z', 'Value']) {
      const th = doc.createElement('th');
      th.scope = 'col';
      th.textContent = label;
      tr.append(th);
    }
    head.append(tr);
    for (let i = start; i < end; i++) {
      const r = s.datum(i),
        tr = doc.createElement('tr');
      tr.setAttribute('aria-rowindex', String(i + 2));
      if (i === index) tr.setAttribute('aria-current', 'true');
      const th = doc.createElement('th');
      th.scope = 'row';
      th.textContent = String(i + 1);
      tr.append(th);
      for (const [column, v] of [r.x, r.y, r.z, r.value].entries()) {
        const td = doc.createElement('td');
        td.textContent = column < 3 ? coordinate(v, column) : number(v);
        tr.append(td);
      }
      body.append(tr);
    }
    previous.disabled = start === 0;
    next.disabled = end === s.count;
    listen.disabled = s.count === 0;
  };
  const positionMarker = () => {
    const s = data[seriesIndex];
    if (!s || !s.count) {
      marker.hidden = true;
      return;
    }
    const r = s.datum(index);
    marker.hidden = r.x === undefined || r.y === undefined || !Number.isFinite(r.x) || !Number.isFinite(r.y);
    if (!marker.hidden) {
      const scales = figure.axisScales;
      const position = plotPositions.get(s)?.(index) ?? [
        scales[0].forward(r.x!),
        scales[1].forward(r.y!),
        scales[2].forward(r.z ?? 0),
      ];
      const matrix = multiplyMatrices(figure.engine.camera.matrix, figure.model),
        p = projectPoint(
          matrix,
          position[0],
          position[1],
          position[2],
          canvas.clientWidth,
          canvas.clientHeight,
          'webgpu',
        );
      marker.hidden = !p.inFrustum;
      marker.style.left = `${canvas.offsetLeft + p.x}px`;
      marker.style.top = `${canvas.offsetTop + p.y}px`;
    }
  };
  const showFocus = () => {
    const s = data[seriesIndex];
    if (!s || !s.count) {
      marker.hidden = true;
      return;
    }
    const r = s.datum(index);
    live.textContent = `${s.name}, ${s.kind} ${index + 1} of ${s.count}. x ${coordinate(r.x, 0)}, y ${coordinate(r.y, 1)}, z ${coordinate(r.z, 2)}, value ${number(r.value)}.`;
    figure.render();
    positionMarker();
    page = Math.floor(index / size);
    paintTable();
  };
  const frame = figure.engine.onFrame?.(() => {
    if (doc.activeElement === canvas) positionMarker();
  });
  if (frame) off.push(frame);
  const focus = (s: number, i: number) => {
    if (!Number.isInteger(s) || !Number.isInteger(i) || s < 0 || s >= data.length || i < 0 || i >= data[s].count)
      throw rangeError('Focus requires an existing series and record index; choose a listed record', 'sciviz');
    seriesIndex = s;
    index = i;
    if (doc.activeElement !== canvas) canvas.focus({ preventScroll: true });
    showFocus();
  };
  const refresh = async () => {
    const current = ++version;
    controller.signal.throwIfAborted();
    await abortable(figure.ready(), controller.signal);
    controller.signal.throwIfAborted();
    const result =
      typeof options.series === 'function'
        ? await abortable(Promise.resolve(options.series(controller.signal)), controller.signal)
        : (options.series ?? (await nativeSeries(figure, controller.signal)));
    controller.signal.throwIfAborted();
    if (current !== version) return;
    for (const s of result)
      if (
        !Number.isInteger(s.count) ||
        s.count < 0 ||
        typeof s.datum !== 'function' ||
        !s.name ||
        !['point', 'bin', 'series', 'voxel', 'cell'].includes(s.kind)
      )
        throw rangeError(
          'Accessible series needs a nonnegative integer count and datum(index); correct adapter',
          'sciviz',
        );
    data = result;
    seriesIndex = Math.min(seriesIndex, Math.max(0, data.length - 1));
    index = Math.min(index, Math.max(0, (data[seriesIndex]?.count ?? 1) - 1));
    summary.textContent = data.length
      ? data
          .map((s) => {
            const d = describeSeries(s);
            return d.finite
              ? `${s.name}: ${d.count} ${s.kind} records, ${d.missing} missing. Range ${number(d.minimum)} to ${number(d.maximum)}. Minimum at record ${d.minimumIndex + 1}; maximum at record ${d.maximumIndex + 1}. Trend ${d.trend}.`
              : `${s.name}: ${d.count} records, no finite observations.`;
          })
          .join(' ')
      : `${figure.layers.length} visual layers. Data bounds ${figure.bounds.map(number).join(', ')}.`;
    paintTable();
    if (doc.activeElement === canvas) positionMarker();
  };
  const play = async (o: SonificationOptions = {}) => {
    const s = data[seriesIndex];
    if (!s) throw fault('state', 'No accessible series; await refresh or supply an adapter', 'sciviz');
    audio?.abort(new DOMException('Replaced', 'AbortError'));
    audio = new AbortController();
    const signal = AbortSignal.any([audio.signal, controller.signal, ...(o.signal ? [o.signal] : [])]);
    if (s.count > (o.maxPoints ?? 100000))
      throw rangeError('Series exceeds sonification maxPoints; choose a window or raise maxPoints', 'sciviz');
    const array = Float64Array.from({ length: s.count }, (_, i) => s.datum(i).value);
    await playSonification(array, { ...o, signal });
  };
  on(
    canvas,
    'keydown',
    ((event: KeyboardEvent) => {
      if (!data.length || event.altKey || event.ctrlKey || event.metaKey) return;
      const s = data[seriesIndex];
      let si = seriesIndex,
        i = index;
      switch (event.key) {
        case 'ArrowLeft':
          i = Math.max(0, i - 1);
          break;
        case 'ArrowRight':
          i = Math.min(s.count - 1, i + 1);
          break;
        case 'ArrowUp':
          si = Math.max(0, si - 1);
          i = Math.min(i, data[si].count - 1);
          break;
        case 'ArrowDown':
          si = Math.min(data.length - 1, si + 1);
          i = Math.min(i, data[si].count - 1);
          break;
        case 'Home':
          i = 0;
          break;
        case 'End':
          i = s.count - 1;
          break;
        default:
          return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      if (i >= 0 && i < data[si].count) focus(si, i);
      else {
        seriesIndex = si;
        index = 0;
        marker.hidden = true;
        live.textContent = `${data[si].name}: no observations.`;
        paintTable();
      }
    }) as EventListener,
    true,
  );
  on(canvas, 'focus', (() => {
    if (data[seriesIndex]?.count) showFocus();
  }) as EventListener);
  on(canvas, 'blur', (() => {
    marker.hidden = true;
  }) as EventListener);
  on(previous, 'click', (() => {
    page--;
    paintTable();
  }) as EventListener);
  on(next, 'click', (() => {
    page++;
    paintTable();
  }) as EventListener);
  on(listen, 'click', (() => {
    live.textContent = 'Playing series.';
    void play().then(
      () => {
        live.textContent = 'Sonification finished.';
      },
      (e) => {
        live.textContent = e?.name === 'AbortError' ? 'Sonification stopped.' : `Sonification failed: ${String(e)}`;
      },
    );
  }) as EventListener);
  on(stop, 'click', (() => audio?.abort(new DOMException('Stopped', 'AbortError'))) as EventListener);
  const reduced = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : undefined;
  const contrast =
    typeof matchMedia === 'function' ? matchMedia('(prefers-contrast: more), (forced-colors: active)') : undefined;
  const motion = () => {
    if (options.reducedMotion ?? reduced?.matches) {
      figure.pause();
      figure.engine.stop();
      root.dataset.reducedMotion = 'true';
    } else root.dataset.reducedMotion = 'false';
  };
  motion();
  if (reduced) on(reduced, 'change', motion as EventListener);
  const originalTheme = { ...figure.theme };
  let contrastApplied = false;
  const useContrast = () => {
    const active = options.highContrast ?? contrast?.matches ?? false;
    if (active || contrastApplied) {
      contrastApplied = active;
      void figure.setTheme(active ? HIGH_CONTRAST_THEME : originalTheme).then(
        () => {
          if (!disposed) figure.render();
        },
        (e) => {
          if (!disposed) live.textContent = `Theme update failed: ${String(e)}`;
        },
      );
    }
  };
  useContrast();
  if (contrast) on(contrast, 'change', useContrast as EventListener);
  const unregister = registerFigureCleanup(figure, () => dispose());
  function dispose(reason: unknown = new DOMException('Figure data view disposed', 'AbortError')) {
    if (disposed) return;
    disposed = true;
    views.delete(figure);
    controller.abort(reason);
    audio?.abort(controller.signal.reason);
    for (const remove of off) remove();
    unregister();
    root.remove();
    marker.remove();
    if (host.style.position === 'relative' && !originalPosition) host.style.position = originalPosition;
    delete canvas.dataset.margoExplore;
    for (const [k, v] of saved)
      if (v === null) canvas.removeAttribute(k);
      else canvas.setAttribute(k, v);
  }
  if (options.signal) on(options.signal, 'abort', (() => dispose(options.signal!.reason)) as EventListener);
  let initial: Promise<void>;
  const handle: AccessibilityHandle = {
    get ready() {
      return initial;
    },
    element: root,
    get series() {
      return data;
    },
    get focused() {
      return { series: seriesIndex, index };
    },
    refresh,
    focus,
    listen: play,
    dispose,
    [Symbol.dispose]: dispose,
  };
  views.set(figure, handle);
  initial = refresh();
  void initial.catch((e) => {
    if (!disposed) {
      live.textContent = `Data description failed: ${String(e)}`;
    }
  });
  return handle;
}
