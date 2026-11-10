import { rangeError } from '../../shared/errors.js';
import {
  bindTransfer,
  TransferFunction,
  transferPreset,
  type TransferHistogram,
  type TransferWidget,
  type TransferRGBA,
  type Point2D,
} from './transfer.js';
import type { VolumeLayer } from './volume.js';

/** HTML editor configuration. No nodes or listeners are created on import. */
export interface TransferEditorOptions {
  /** Optional existing volume to edit. */ readonly layer?: VolumeLayer;
  /** Joint histogram to show behind classification widgets. */ readonly histogram?: TransferHistogram;
  /** Called after edits/upload, e.g. to render a stopped figure. */ readonly render?: () => void;
  /** Lifetime cancellation. */ readonly signal?: AbortSignal;
}
/** Owned HTML component. Removing it alone does not unbind the volume; dispose it. */
export interface TransferEditor {
  /** Accessible editor root. */ readonly element: HTMLElement;
  /** Remove DOM/listeners and restore the bound volume's original function. Idempotent. */ dispose(): void;
  /** Same as dispose. */ [Symbol.dispose](): void;
}

/** Create a 1D point editor / 2D value-gradient widget editor using the host document. */
export function transferEditor(
  parent: HTMLElement,
  tf: TransferFunction,
  options: TransferEditorOptions = {},
): TransferEditor {
  options.signal?.throwIfAborted();
  const doc = parent.ownerDocument,
    root = doc.createElement('section');
  root.setAttribute('aria-label', 'Volume transfer function editor');
  root.style.cssText = 'display:grid;gap:8px;max-width:640px;font:14px system-ui';
  const row = doc.createElement('div'),
    canvas = doc.createElement('canvas'),
    fields = doc.createElement('div'),
    status = doc.createElement('output');
  canvas.width = 512;
  canvas.height = 256;
  canvas.style.cssText = 'width:100%;touch-action:none;background:#151b26';
  canvas.tabIndex = 0;
  canvas.setAttribute(
    'aria-label',
    'Value versus gradient magnitude; drag widgets or 1D opacity points. Delete removes the selected item. Arrow keys move it.',
  );
  fields.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px';
  root.append(row, canvas, fields, status);
  parent.append(root);
  const ctx = canvas.getContext('2d')!;
  const listeners: (() => void)[] = [];
  function listen(target: EventTarget, type: string, fn: EventListener): void {
    target.addEventListener(type, fn);
    listeners.push(() => target.removeEventListener(type, fn));
  }
  function select(label: string, choices: string[], action: (value: string) => void): HTMLSelectElement {
    const wrap = doc.createElement('label'),
      input = doc.createElement('select');
    wrap.append(label, input);
    row.append(wrap);
    for (const c of choices) {
      const option = doc.createElement('option');
      option.value = c;
      option.textContent = c;
      input.append(option);
    }
    listen(input, 'change', () => action(input.value));
    return input;
  }
  const mode = select('Classification ', ['1d', '2d'], (value) => {
    selected = 0;
    tf.update({ ...tf.state, mode: value as '1d' | '2d' });
  });
  select('Preset ', ['custom', 'ct-lung', 'ct-bone', 'ct-soft', 'mri', 'pet'], (value) => {
    if (value === 'custom') return;
    const preset = transferPreset(value as Parameters<typeof transferPreset>[0]).state,
      s = tf.state;
    // MRI and PET presets are normalized display shapes; remap them to this volume's physical range.
    const points = preset.points.map((p) => ({
      value: value.startsWith('ct')
        ? p.value
        : s.range[0] + ((p.value - preset.range[0]) / (preset.range[1] - preset.range[0])) * (s.range[1] - s.range[0]),
      rgba: p.rgba,
    }));
    selected = 0;
    tf.update({ ...s, points, mode: '1d' });
  });
  const shape = select('New widget ', ['rectangle', 'triangle', 'gaussian'], () => {});
  const button = (label: string, action: () => void) => {
    const b = doc.createElement('button');
    b.type = 'button';
    b.textContent = label;
    row.append(b);
    listen(b, 'click', action);
  };
  let selected = 0;
  const inputs = new Map<string, HTMLInputElement>();
  function input(name: string, type = 'number'): HTMLInputElement {
    const wrap = doc.createElement('label'),
      el = doc.createElement('input');
    el.type = type;
    el.setAttribute('aria-label', name);
    el.style.width = type === 'color' ? '50px' : '90px';
    if (type === 'number') el.step = 'any';
    wrap.append(name, el);
    fields.append(wrap);
    inputs.set(name, el);
    listen(el, 'change', edit);
    return el;
  }
  for (const name of ['value', 'gradient', 'width', 'height', 'opacity']) input(name);
  input('colour', 'color');
  const geometry = doc.createElement('textarea');
  geometry.setAttribute('aria-label', 'Triangle vertices in value and gradient units');
  geometry.rows = 2;
  geometry.style.width = '100%';
  fields.append(geometry);
  listen(geometry, 'change', edit);
  const num = (name: string) => Number(inputs.get(name)!.value);
  const colour = (): TransferRGBA => {
    const hex = inputs.get('colour')!.value;
    return [1, 3, 5]
      .map((i) => {
        const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
        return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      })
      .concat(num('opacity')) as unknown as TransferRGBA;
  };
  const frame = (w: TransferWidget): [number, number, number, number] =>
    w.kind === 'rectangle'
      ? [w.bounds[0], w.bounds[2], w.bounds[1] - w.bounds[0], w.bounds[3] - w.bounds[2]]
      : w.kind === 'gaussian'
        ? [w.center[0], w.center[1], w.sigma[0], w.sigma[1]]
        : [w.vertices.reduce((a, p) => a + p[0], 0) / 3, w.vertices.reduce((a, p) => a + p[1], 0) / 3, 1, 1];
  function edit(): void {
    try {
      const s = tf.state;
      if (s.mode !== '2d') {
        const points = s.points.map((p, i) => (i === selected ? { value: num('value'), rgba: colour() } : p));
        const current = points[selected];
        points.sort((a, b) => a.value - b.value);
        selected = points.indexOf(current);
        tf.update({ ...s, points });
      } else {
        const widgets = [...(s.widgets ?? [])],
          w = widgets[selected];
        if (!w) return;
        const x = num('value'),
          y = num('gradient'),
          width = num('width'),
          height = num('height'),
          rgba = colour();
        widgets[selected] =
          w.kind === 'rectangle'
            ? { kind: w.kind, rgba, bounds: [x, x + width, y, y + height] }
            : w.kind === 'gaussian'
              ? { kind: w.kind, rgba, center: [x, y], sigma: [width, height] }
              : { kind: w.kind, rgba, vertices: JSON.parse(geometry.value) };
        tf.update({ ...s, widgets });
      }
      status.textContent = '';
    } catch (e) {
      status.textContent = (e as Error).message;
    }
  }
  button('Add', () => {
    const s = tf.state,
      dx = (s.range[1] - s.range[0]) / 5,
      dy = s.gradientMax / 5,
      x = s.range[0] + 2 * dx,
      y = dy;
    if (s.mode !== '2d') {
      let value = (s.range[0] + s.range[1]) / 2;
      const p = [...s.points];
      if (p.some((p) => p.value === value)) {
        const pairs = p
          .slice(1)
          .map((q, i) => ({ width: q.value - p[i].value, value: (q.value + p[i].value) / 2 }))
          .sort((a, b) => b.width - a.width);
        value = pairs[0].value;
      }
      const points = [...p, { value, rgba: [1, 1, 1, 0.2] as TransferRGBA }].sort((a, b) => a.value - b.value);
      selected = points.findIndex((p) => p.value === value);
      tf.update({ ...s, points });
      return;
    }
    const rgba: TransferRGBA = [0.9, 0.4, 0.1, 0.3];
    const w: TransferWidget =
      shape.value === 'rectangle'
        ? { kind: 'rectangle', bounds: [x, x + dx, y, y + dy], rgba }
        : shape.value === 'gaussian'
          ? { kind: 'gaussian', center: [x, y], sigma: [dx, dy], rgba }
          : {
              kind: 'triangle',
              vertices: [
                [x, y],
                [x + dx, y],
                [x + dx / 2, y + 2 * dy],
              ],
              rgba,
            };
    selected = s.widgets?.length ?? 0;
    tf.update({ ...s, widgets: [...(s.widgets ?? []), w] });
  });
  const remove = () => {
    const s = tf.state;
    if (s.mode === '2d') tf.update({ ...s, widgets: (s.widgets ?? []).filter((_, i) => i !== selected) });
    else if (s.points.length > 2) tf.update({ ...s, points: s.points.filter((_, i) => i !== selected) });
    selected = Math.max(0, selected - 1);
    draw();
  };
  button('Delete selected', remove);
  const pick = select('Selected item ', [], (value) => {
    selected = Number(value);
    draw();
  });
  function draw(): void {
    const s = tf.state,
      items = s.mode === '2d' ? (s.widgets ?? []) : s.points;
    selected = Math.max(0, Math.min(selected, items.length - 1));
    pick.replaceChildren();
    items.forEach((_, i) => {
      const option = doc.createElement('option');
      option.value = String(i);
      option.textContent = String(i + 1);
      pick.append(option);
    });
    pick.value = String(selected);
    mode.value = s.mode ?? '1d';
    const px = (v: number) => ((v - s.range[0]) / (s.range[1] - s.range[0])) * canvas.width,
      py = (g: number) => canvas.height * (1 - g / s.gradientMax);
    ctx.fillStyle = '#151b26';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const h = options.histogram;
    if (h) {
      let max = 0;
      for (const c of h.counts) max = Math.max(max, c);
      for (let y = 0; y < h.bins[1]; y++)
        for (let x = 0; x < h.bins[0]; x++) {
          const count = h.counts[y * h.bins[0] + x];
          if (!count) continue;
          ctx.fillStyle = `rgba(200,210,230,${Math.log1p(count) / Math.log1p(max)})`;
          const left = px(h.range[0] + (x / h.bins[0]) * (h.range[1] - h.range[0])),
            right = px(h.range[0] + ((x + 1) / h.bins[0]) * (h.range[1] - h.range[0]));
          ctx.fillRect(
            left,
            py(((y + 1) / h.bins[1]) * h.gradientMax),
            right - left + 1,
            (canvas.height * h.gradientMax) / s.gradientMax / h.bins[1] + 1,
          );
        }
    }
    const toCSS = (c: TransferRGBA) =>
      '#' +
      c
        .slice(0, 3)
        .map((v) =>
          Math.round((v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055) * 255)
            .toString(16)
            .padStart(2, '0'),
        )
        .join('');
    let c: TransferRGBA = [1, 1, 1, 0.2];
    if (s.mode === '2d')
      (s.widgets ?? []).forEach((w, i) => {
        ctx.beginPath();
        ctx.strokeStyle = i === selected ? '#fff' : toCSS(w.rgba);
        ctx.lineWidth = i === selected ? 3 : 1;
        if (w.kind === 'rectangle')
          ctx.rect(
            px(w.bounds[0]),
            py(w.bounds[3]),
            px(w.bounds[1]) - px(w.bounds[0]),
            py(w.bounds[2]) - py(w.bounds[3]),
          );
        else if (w.kind === 'gaussian')
          ctx.ellipse(
            px(w.center[0]),
            py(w.center[1]),
            (w.sigma[0] / (s.range[1] - s.range[0])) * canvas.width,
            (w.sigma[1] / s.gradientMax) * canvas.height,
            0,
            0,
            2 * Math.PI,
          );
        else {
          w.vertices.forEach((p, k) => {
            if (k) ctx.lineTo(px(p[0]), py(p[1]));
            else ctx.moveTo(px(p[0]), py(p[1]));
          });
          ctx.closePath();
        }
        ctx.fillStyle = toCSS(w.rgba);
        ctx.globalAlpha = w.rgba[3] * 0.4;
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.stroke();
      });
    else {
      ctx.beginPath();
      ctx.strokeStyle = '#fff';
      s.points.forEach((p, i) => {
        const x = px(p.value),
          y = canvas.height * (1 - p.rgba[3]);
        if (i) ctx.lineTo(x, y);
        else ctx.moveTo(x, y);
      });
      ctx.stroke();
      s.points.forEach((p, i) => {
        ctx.fillStyle = i === selected ? '#fff' : toCSS(p.rgba);
        ctx.beginPath();
        ctx.arc(px(p.value), canvas.height * (1 - p.rgba[3]), 5, 0, Math.PI * 2);
        ctx.fill();
      });
    }
    const w = s.widgets?.[selected],
      point = s.points[selected];
    if (s.mode === '2d' && w) {
      const f = frame(w);
      ['value', 'gradient', 'width', 'height'].forEach((name, i) => {
        inputs.get(name)!.value = String(f[i]);
      });
      c = w.rgba;
    } else if (point) {
      inputs.get('value')!.value = String(point.value);
      c = point.rgba;
    }
    inputs.get('opacity')!.value = String(c[3]);
    inputs.get('colour')!.value = toCSS(c);
    for (const name of ['gradient', 'width', 'height'])
      inputs.get(name)!.disabled = s.mode !== '2d' || w?.kind === 'triangle';
    geometry.hidden = s.mode !== '2d' || w?.kind !== 'triangle';
    if (w?.kind === 'triangle') geometry.value = JSON.stringify(w.vertices);
    canvas.setAttribute(
      'aria-description',
      `Value ${s.range.join(' to ')}; gradient 0 to ${s.gradientMax}. Selected item ${selected + 1}.`,
    );
  }
  function move(dx: number, dy: number): void {
    const s = tf.state;
    if (s.mode !== '2d') {
      const points = s.points.map((p, i) =>
        i === selected
          ? {
              value: Math.max(
                i ? s.points[i - 1].value + Number.EPSILON * Math.max(1, Math.abs(p.value)) : s.range[0],
                Math.min(
                  i + 1 < s.points.length
                    ? s.points[i + 1].value - Number.EPSILON * Math.max(1, Math.abs(p.value))
                    : s.range[1],
                  p.value + dx,
                ),
              ),
              rgba: [...p.rgba.slice(0, 3), Math.max(0, Math.min(1, p.rgba[3] + dy))] as unknown as TransferRGBA,
            }
          : p,
      );
      tf.update({ ...s, points });
      return;
    }
    const widgets = [...(s.widgets ?? [])],
      w = widgets[selected];
    if (!w) return;
    const shift = (p: Point2D): Point2D => [p[0] + dx, p[1] + dy];
    const minY =
      w.kind === 'rectangle'
        ? w.bounds[2]
        : w.kind === 'gaussian'
          ? w.center[1]
          : Math.min(...w.vertices.map((p) => p[1]));
    dy = Math.max(-minY, dy);
    widgets[selected] =
      w.kind === 'rectangle'
        ? { ...w, bounds: [w.bounds[0] + dx, w.bounds[1] + dx, w.bounds[2] + dy, w.bounds[3] + dy] }
        : w.kind === 'gaussian'
          ? { ...w, center: shift(w.center) }
          : { ...w, vertices: w.vertices.map(shift) as unknown as readonly [Point2D, Point2D, Point2D] };
    tf.update({ ...s, widgets });
  }
  let previous: Point2D | undefined;
  listen(canvas, 'pointerdown', (e) => {
    const event = e as PointerEvent,
      r = canvas.getBoundingClientRect(),
      s = tf.state,
      x = (event.clientX - r.left) / r.width,
      y = 1 - (event.clientY - r.top) / r.height;
    const candidates =
      s.mode === '2d'
        ? (s.widgets ?? []).map((w) => {
            const f = frame(w);
            return [(f[0] - s.range[0]) / (s.range[1] - s.range[0]), f[1] / s.gradientMax];
          })
        : s.points.map((p) => [(p.value - s.range[0]) / (s.range[1] - s.range[0]), p.rgba[3]]);
    if (!candidates.length) return;
    selected = candidates
      .map((p) => (p[0] - x) ** 2 + (p[1] - y) ** 2)
      .reduce((best, d, i, a) => (d < a[best] ? i : best), 0);
    previous = [x, y];
    canvas.setPointerCapture(event.pointerId);
    draw();
  });
  listen(canvas, 'pointermove', (e) => {
    if (!previous) return;
    const event = e as PointerEvent,
      r = canvas.getBoundingClientRect(),
      s = tf.state,
      x = (event.clientX - r.left) / r.width,
      y = 1 - (event.clientY - r.top) / r.height;
    move((x - previous[0]) * (s.range[1] - s.range[0]), (y - previous[1]) * (s.mode === '2d' ? s.gradientMax : 1));
    previous = [x, y];
  });
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture'])
    listen(canvas, type, () => {
      previous = undefined;
    });
  listen(canvas, 'keydown', (e) => {
    const event = e as KeyboardEvent,
      s = tf.state;
    if (event.key === 'Delete') remove();
    else if (event.key.startsWith('Arrow')) {
      event.preventDefault();
      move(
        ((event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0) * (s.range[1] - s.range[0])) / 100,
        ((event.key === 'ArrowUp' ? 1 : event.key === 'ArrowDown' ? -1 : 0) * (s.mode === '2d' ? s.gradientMax : 1)) /
          100,
      );
    }
  });
  if (options.histogram && options.histogram.counts.length !== options.histogram.bins[0] * options.histogram.bins[1]) {
    root.remove();
    throw rangeError('Histogram counts must match its bins; regenerate the histogram', 'sciviz');
  }
  const binding = options.layer
    ? bindTransfer(options.layer, tf, { render: options.render, signal: options.signal })
    : undefined;
  listen(tf, 'change', () => {
    draw();
    if (!binding) options.render?.();
  });
  draw();
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    for (const remove of listeners) remove();
    binding?.dispose();
    root.remove();
    options.signal?.removeEventListener('abort', dispose);
  };
  options.signal?.addEventListener('abort', dispose, { once: true });
  return { element: root, dispose, [Symbol.dispose]: dispose };
}
