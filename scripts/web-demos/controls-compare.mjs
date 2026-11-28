// Comparison logic for scripts/web-demos/controls.mjs, kept free of the browser so tests/web-demos-controls.test.js
// can drive it on synthetic frames.
//
// A frame is { width, height, data } with `data` packed RGB bytes (3 per pixel), already scaled to a working size.
// The page's own motion is measured on a pair of frames taken with no input (the noise pair): the pixels that moved
// there, grown by a few pixels, form the noise mask, and their count and mean difference form the noise floor. A
// change after an input counts only when it shows outside the noise mask or clearly above the noise floor.

/** A pixel changed when one of its channels moved by at least this much (0 to 255). */
export const PIXEL_DELTA = 16;
/** Fewest changed pixels that count as a visible change at the working size. */
export const MIN_PIXELS = 12;
/** How far the noise mask is grown, in working pixels, so an animated edge that shifts a little stays inside it. */
export const NOISE_GROW = 3;
/** With more of the picture than this inside the noise mask, a quiet result cannot be trusted. */
export const INCONCLUSIVE_MASK = 0.5;

/** @param {{width:number,height:number,data:Uint8Array}} a @param {{width:number,height:number,data:Uint8Array}} b */
export function diffFrames(a, b, delta = PIXEL_DELTA) {
  if (a.width !== b.width || a.height !== b.height)
    throw new Error(`frame sizes differ: ${a.width}x${a.height} and ${b.width}x${b.height}`);
  const n = a.width * a.height,
    mask = new Uint8Array(n);
  let count = 0,
    sum = 0;
  for (let i = 0, p = 0; i < n; i++, p += 3) {
    const dr = Math.abs(a.data[p] - b.data[p]),
      dg = Math.abs(a.data[p + 1] - b.data[p + 1]),
      db = Math.abs(a.data[p + 2] - b.data[p + 2]);
    sum += dr + dg + db;
    if (dr >= delta || dg >= delta || db >= delta) {
      mask[i] = 1;
      count++;
    }
  }
  return { mask, count, mean: n ? sum / (3 * n) : 0, pixels: n };
}

/** Grows a mask by `r` pixels in every direction (square neighbourhood). */
export function growMask(mask, width, height, r = NOISE_GROW) {
  if (r <= 0) return mask.slice();
  const rows = new Uint8Array(mask.length),
    out = new Uint8Array(mask.length);
  for (let y = 0; y < height; y++) {
    // Two sweeps per row: distance to the nearest set pixel on the left, then on the right.
    let last = -Infinity;
    for (let x = 0; x < width; x++) {
      if (mask[y * width + x]) last = x;
      if (x - last <= r) rows[y * width + x] = 1;
    }
    last = Infinity;
    for (let x = width - 1; x >= 0; x--) {
      if (mask[y * width + x]) last = x;
      if (last - x <= r) rows[y * width + x] = 1;
    }
  }
  for (let x = 0; x < width; x++) {
    let last = -Infinity;
    for (let y = 0; y < height; y++) {
      if (rows[y * width + x]) last = y;
      if (y - last <= r) out[y * width + x] = 1;
    }
    last = Infinity;
    for (let y = height - 1; y >= 0; y--) {
      if (rows[y * width + x]) last = y;
      if (last - y <= r) out[y * width + x] = 1;
    }
  }
  return out;
}

/** The noise floor of a pair of frames taken with no input. */
export function noiseFloor(a, b) {
  const d = diffFrames(a, b),
    mask = growMask(d.mask, a.width, a.height),
    covered = mask.reduce((s, v) => s + v, 0);
  return { mask, count: d.count, mean: d.mean, maskFraction: d.pixels ? covered / d.pixels : 0 };
}

/**
 * Compares the frame before an input with the frame after it against the noise floor.
 * Returns whether the picture visibly changed, why, and whether a "no change" answer can be trusted.
 */
export function compareRegion(before, after, noise) {
  const d = diffFrames(before, after);
  let outside = 0;
  for (let i = 0; i < d.mask.length; i++) if (d.mask[i] && !noise.mask[i]) outside++;
  const reasons = [];
  if (outside >= MIN_PIXELS && noise.maskFraction < 0.9) reasons.push(`${outside} px changed outside the moving area`);
  if (d.count >= 2 * noise.count + MIN_PIXELS) reasons.push(`${d.count} px changed against ${noise.count} px of noise`);
  if (d.mean >= 0.5 && d.mean >= 2 * noise.mean + 0.5)
    reasons.push(`mean change ${d.mean.toFixed(2)} against ${noise.mean.toFixed(2)} of noise`);
  return {
    changed: reasons.length > 0,
    reasons,
    count: d.count,
    outside,
    mean: round(d.mean),
    noiseCount: noise.count,
    noiseMean: round(noise.mean),
    conclusive: noise.maskFraction < INCONCLUSIVE_MASK,
  };
}

/**
 * Whether the amount of motion changed (a play or pause control): `before` and `after` are the noise floors of the
 * pairs taken before and after the input.
 */
export function motionChanged(before, after) {
  const lo = Math.min(before.count, after.count),
    hi = Math.max(before.count, after.count);
  return hi >= MIN_PIXELS * 4 && hi >= 4 * lo + MIN_PIXELS;
}

/**
 * The readouts that changed: `before` and `after` map an element key to its text; keys in `noisy` changed with no
 * input and keys in `own` belong to the control's own label. Returns { changed, own } as lists of keys.
 */
export function textChanges(before, after, noisy = new Set(), own = new Set()) {
  const changed = [],
    ownChanged = [];
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of keys) {
    if ((before[key] ?? '') === (after[key] ?? '') || noisy.has(key)) continue;
    (own.has(key) ? ownChanged : changed).push(key);
  }
  return { changed, own: ownChanged };
}

/** Keys whose text changed between two snapshots taken with no input. */
export function noisyKeys(a, b) {
  const out = new Set();
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)]))
    if ((a[key] ?? '') !== (b[key] ?? '')) out.add(key);
  return out;
}

/**
 * The verdict for one input. `step` holds { regions: compareRegion results, motion: boolean, text: textChanges
 * result, events: page events such as a download or a sound, layoutChanged: boolean }.
 * live: something outside the control changed. dead: nothing did and the picture was steady enough to tell.
 * unsure: nothing changed but the picture moves too much on its own to tell.
 */
export function judgeStep(step) {
  const evidence = [];
  step.regions.forEach((r, i) => {
    if (r.changed) evidence.push(`picture ${i + 1}: ${r.reasons[0]}`);
  });
  if (step.motion) evidence.push('the amount of motion changed');
  if (step.text.changed.length) evidence.push(`${step.text.changed.length} readout(s) changed`);
  if (step.layoutChanged) evidence.push('the layout changed');
  for (const e of step.events) evidence.push(e);
  if (evidence.length) return { verdict: 'live', evidence, labelOnly: false };
  const conclusive = step.regions.length === 0 || step.regions.every((r) => r.conclusive);
  return { verdict: conclusive ? 'dead' : 'unsure', evidence, labelOnly: step.text.own.length > 0 };
}

/**
 * The verdict for a control from the verdicts of its inputs: live if any input was live, unsure if any could not be
 * told, unreachable if a real click never reached it (covered: its events were sent directly and did nothing).
 */
export function judgeControl(steps) {
  if (!steps.length) return { verdict: 'skipped', labelOnly: false };
  if (steps.some((s) => s.verdict === 'live')) return { verdict: 'live', labelOnly: false };
  const verdict = steps.some((s) => s.verdict === 'unsure')
    ? 'unsure'
    : steps.some((s) => s.verdict === 'unreachable')
      ? 'unreachable'
      : 'dead';
  return { verdict, labelOnly: steps.some((s) => s.labelOnly) };
}

/** Whether the page stopped drawing: it drew steadily at the start and drew nothing in the last window. */
export function stalled(start, end) {
  return start.frames >= 3 && end.frames === 0;
}

/**
 * Stops of one control (slider ends and middle, select options) that give the same picture: a "partly dead"
 * control looks dead to a visitor between those stops even when its readout moves. Each stop is { name, value,
 * frames: [frame per picture], noise: [noiseFloor per picture] } with frames taken once the picture settled. Only
 * steady stops (no motion of their own) with different values are compared: values equal as numbers (1.7 and a
 * computed 1.7000000000000002, which the input holds as 1.7) are one value, and so are values one `step` apart or
 * less (neighbouring settings; on a `period` such as a day of minutes, 0 and 1439 are neighbours). Returns the pairs
 * of stop names.
 */
export function identicalStops(stops, { period = 0, step = 0 } = {}) {
  const wraps = (a, b) => {
    if (!period) return false;
    const turns = Math.abs(Number(a) - Number(b)) / period;
    return Number.isFinite(turns) && turns > 0.5 && Math.abs(turns - Math.round(turns)) < 1e-6;
  };
  // The distance between two numeric values, around the period when there is one; NaN when either is not a number.
  const apart = (a, b) => {
    if (String(a).trim() === '' || String(b).trim() === '') return NaN;
    let d = Math.abs(Number(a) - Number(b));
    if (period > 0) {
      d %= period;
      d = Math.min(d, period - d);
    }
    return d;
  };
  const same = (a, b) => {
    const d = apart(a, b);
    return d <= 1e-9 * Math.max(1, Math.abs(Number(a)), Math.abs(Number(b))) || (step > 0 && d <= step * (1 + 1e-9));
  };
  const steady = stops.filter((s) => s.frames.length && s.noise.every((n) => n.count < MIN_PIXELS));
  const pairs = [];
  for (let i = 0; i < steady.length; i++)
    for (let j = i + 1; j < steady.length; j++) {
      const a = steady[i],
        b = steady[j];
      if (a.value === b.value || same(a.value, b.value) || wraps(a.value, b.value) || a.frames.length !== b.frames.length)
        continue;
      if (a.frames.some((f, k) => f.width !== b.frames[k].width || f.height !== b.frames[k].height)) continue;
      if (a.frames.every((f, k) => !compareRegion(f, b.frames[k], b.noise[k]).changed)) pairs.push([a.name, b.name]);
    }
  return pairs;
}

/**
 * The period of a slider whose ends meet: whole turns (-180 and 180 degrees draw the same picture by design) or a day
 * of minutes or hours. 0 when its ends do not meet.
 */
export function periodOf(c) {
  // A live control carries min and max; a saved record keeps them only in its step names ("to max (360)").
  const end = (which) => c[which] ?? /\(([-+\d.e]+)\)/.exec((c.steps ?? []).find((s) => s.action?.startsWith(`to ${which} `))?.action ?? '')?.[1];
  const span = Number(end('max')) - Number(end('min'));
  if (Math.abs(span - 2 * Math.PI) < 1e-3) return 2 * Math.PI;
  // A clock: minutes or hours of a day, where the last stop is one step before the first again (1439 then 0).
  const step = Number(c.step ?? 1) || 1;
  if (/\b(time|clock|hour|minute|o'?clock)\b/i.test(c.label ?? '') && [1440, 24].includes(span + step)) return span + step;
  return span >= 360 &&
    /°|\b(deg|degrees|turn|rotat\w*|angle|heading|yaw|bearing|azimuth|spin|hue|longitude)\b/i.test(c.label ?? '')
    ? 360
    : 0;
}

/** Pixels that differ by at least this much (of 255, any channel) at full size can be seen. */
export const VISIBLE_DELTA = 32;
/** A full-size picture with at least this many such pixels (beyond its noise) is visibly different. */
export const VISIBLE_PIXELS = 50;

/**
 * Pixels of two full-size raw RGB pictures ({ width, height, data }, 3 bytes a pixel) that differ by at least
 * VISIBLE_DELTA; -1 when the sizes differ.
 */
export function visiblePixels(a, b) {
  if (a.width !== b.width || a.height !== b.height) return -1;
  let n = 0;
  for (let i = 0; i < a.data.length; i += 3)
    if (
      Math.max(
        Math.abs(a.data[i] - b.data[i]),
        Math.abs(a.data[i + 1] - b.data[i + 1]),
        Math.abs(a.data[i + 2] - b.data[i + 2]),
      ) >= VISIBLE_DELTA
    )
      n++;
  return n;
}

/**
 * Whether two stops that look the same at the working size still differ visibly at full size: a thin part that moves
 * a few pixels (a bimetal strip's tip) is lost when the picture shrinks, not to a visitor. `noise` is the larger
 * count of visible pixels each stop's picture changed by on its own.
 */
export function visiblyApart(a, b, noise = 0) {
  const n = visiblePixels(a, b);
  return n >= VISIBLE_PIXELS && n >= 4 * noise;
}

function round(v) {
  return Math.round(v * 100) / 100;
}
