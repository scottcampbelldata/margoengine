// The row shape every package's `/settings` entry shares, so one slider panel can list and drive any package: each row
// names an option, its group, kind, default, range, step, unit and what it does, plus `live` (true: cheap to write every
// frame, so it can be keyed over a shot; false: the package rebuilds something) and, where the weather panel can drive
// it, `nullable` with a null default and `weather` naming the master slider (null then follows the weather). The model
// is @margoengine/sky/settings; this module holds the rules it applies, so a package's table is data and one call.
const within = (v, lo, hi) => typeof v === 'number' && v >= lo && v <= hi;
const isColor = (v, lo, hi) => Array.isArray(v) && v.length === 3 && v.every((x) => within(x, lo, hi));
const stopKey = (row) => row.stopKey ?? 'elevation';

export const numberSetting = (name, group, value, min, max, step, unit, about, live = true) => ({
  name,
  group,
  kind: 'number',
  default: value,
  min,
  max,
  step,
  unit,
  about,
  live,
});
export const colorSetting = (name, group, value, min, max, about, live = true) => ({
  name,
  group,
  kind: 'color',
  default: value,
  min,
  max,
  step: 0.01,
  unit: '',
  about,
  live,
});
export const choiceSetting = (name, group, choices, about, live = true) => ({
  name,
  group,
  kind: 'choice',
  default: choices[0],
  choices,
  unit: '',
  about,
  live,
});
/** The row with a null default that follows the weather master slider `weather` until a value is given. */
export const followsWeather = (row, weather) => ({ ...row, default: null, nullable: true, weather });

// The override switch of a weather-driven value (Scott 2026-11-17: the weather is the master, a set value overrides it,
// null hands it back; the pattern of an override box on each property of a post-process volume). A settings apply marks
// the option it set as held; `WeatherDrive` never writes a held option and writes it again once it is released. The mark
// is a hidden set under a registered symbol, so every bundled copy of this module, and the drive, see the same one.
const HELD = Symbol.for('margoengine.weather-held');
/** Marks `key` of `target` as set by hand (`held` true) or hands it back to the weather (false). */
export function holdFromWeather(target, key, held = true) {
  if (typeof target !== 'object' || target === null) return;
  let set = target[HELD];
  if (held) {
    if (!set) Object.defineProperty(target, HELD, { value: (set = new Set()), configurable: true });
    set.add(key);
  } else set?.delete(key);
}
/** True while `key` of `target` holds a value set by hand, which the weather drive leaves alone. */
export const heldFromWeather = (target, key) =>
  typeof target === 'object' && target !== null && target[HELD]?.has(key) === true;

export const sameSettingValue = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export function copySettingValue(v) {
  if (!Array.isArray(v)) return v;
  return typeof v[0] === 'object' ? v.map((s) => ({ ...s, color: [...s.color] })) : [...v];
}
/** A fresh object holding every row at its default (a slider panel's state). */
export function settingDefaults(rows) {
  return Object.fromEntries(rows.map((r) => [r.name, copySettingValue(r.default)]));
}
/** The rows that may change every frame without a rebuild. */
export const liveSettings = (rows) => rows.filter((r) => r.live);
/** A name to row map. */
export const settingIndex = (rows) => new Map(rows.map((r) => [r.name, r]));

/** Throws RangeError when `v` is not a value of `row`; `label` names the package in the message. */
export function checkSettingValue(row, v, label) {
  const lo = row.min ?? -Infinity,
    hi = row.max ?? Infinity;
  let ok;
  if (v === null) ok = !!row.nullable;
  else if (row.kind === 'number') ok = within(v, lo, hi);
  else if (row.kind === 'color') ok = isColor(v, lo, hi);
  else if (row.kind === 'choice') ok = row.choices.includes(v);
  else {
    const key = stopKey(row);
    ok =
      Array.isArray(v) &&
      v.length >= 2 &&
      v.length <= 8 &&
      v.every(
        (stop, i) =>
          typeof stop === 'object' &&
          stop !== null &&
          within(stop[key], lo, hi) &&
          isColor(stop.color, 0, 1) &&
          (i === 0 || stop[key] > v[i - 1][key]),
      );
  }
  if (ok) return;
  const nul = row.nullable ? (row.weather ? ` or null (follow the weather's ${row.weather})` : ' or null') : '';
  const want =
    row.kind === 'number'
      ? `a number from ${lo} to ${hi}${nul}`
      : row.kind === 'color'
        ? `three numbers from ${lo} to ${hi} (linear RGB)${nul}`
        : row.kind === 'choice'
          ? row.choices.map((x) => `'${x}'`).join(' or ') + nul
          : `2 to 8 stops {${stopKey(row)}, color}, ${stopKey(row)} ${lo} to ${hi} rising, colours 0 to 1${nul}`;
  throw new RangeError(`Invalid ${label} setting ${row.name}; use ${want}`);
}
/**
 * Checks every name and value in `values` against the rows (a name left out is fine: it takes its default).
 * @throws TypeError for a name not in the rows; RangeError for a value outside its row's range or kind, or null on a
 * row that is not nullable.
 */
export function checkSettings(rows, values, label, entry = `the rows in @margoengine/${label}/settings`) {
  const index = rows instanceof Map ? rows : settingIndex(rows);
  for (const name of Object.keys(values)) {
    const row = index.get(name);
    if (!row) throw new TypeError(`Unknown ${label} setting ${name}; use a name from ${entry}`);
    checkSettingValue(row, values[name], label);
  }
}
/**
 * Checks `values`, then calls `write(row, value)` once per row in row order with the given value or the row's default
 * (null where a nullable row has it, meaning follow the weather), so the target ends up showing exactly that state.
 * `only` limits it to rows for which it returns true (for example `(row) => row.live`).
 */
export function applySettings(rows, values, label, write, only) {
  checkSettings(rows, values, label);
  for (const row of rows)
    if (!only || only(row)) write(row, row.name in values ? values[row.name] : copySettingValue(row.default));
}
