// Per-shot control of the settings tables, as pure data (no GPU, no imports of any package settings): a shot names, for
// each target, rows held for the whole shot or keyed over its seconds. The packages stay the only source of rows; the
// caller passes the tables (WEATHER_SETTINGS, SKY_SETTINGS, ...) it looks up by target name, and this module checks
// the values with each package's own rules (shared/settings.js) and evaluates the block at a time. A scene's
// `info.targets` maps each target name to the package entry whose table it uses; `tools/shot` writes the evaluated values
// to the page each frame through the package's own apply function.
import { checkSettingValue, copySettingValue, settingIndex, type SettingRow } from '../../shared/settings.js';

/** How the value moves from a key to the next: `linear`, `in` (slow start), `out` (slow end) or `inOut` (smoothstep). */
export type ShotEase = 'linear' | 'in' | 'out' | 'inOut';
/** One key of a keyed row: at `time` seconds into the shot the row has `value`; `ease` shapes the way to the next key. */
export interface ShotKey {
  readonly time: number;
  readonly value: unknown;
  readonly ease?: ShotEase;
}
/** A row held for the whole shot (a plain value) or keyed over it. */
export type ShotRowValue = unknown | { readonly keys: readonly ShotKey[] };
/** The settings of one shot: target name, then row name, then a held value or keys. */
export type ShotSettingsBlock = Readonly<Record<string, Readonly<Record<string, ShotRowValue>>>>;
/** The rows of each target, by target name. */
export type ShotTables = Readonly<Record<string, readonly SettingRow[]>>;
/** The values at one time: target name, then row name, then value. */
export type ShotValues = Record<string, Record<string, unknown>>;

const EASES: readonly string[] = ['linear', 'in', 'out', 'inOut'];
const isKeyed = (v: unknown): v is { keys: readonly ShotKey[] } =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && 'keys' in v;
const ease = (name: ShotEase | undefined, t: number): number =>
  name === 'in' ? t * t : name === 'out' ? 1 - (1 - t) * (1 - t) : name === 'inOut' ? t * t * (3 - 2 * t) : t;
const stopKey = (row: SettingRow) => (row as { stopKey?: string }).stopKey ?? 'elevation';

/**
 * Checks a shot's settings against the tables before a render starts: every target and row exists, each held value and
 * each key's value is a value of its row (the package's own check), a keyed row is `live`, key times rise and lie inside
 * `[0, seconds]` (when `seconds` is given) and an ease is one of `linear`, `in`, `out`, `inOut`.
 * @throws TypeError for an unknown target or row; RangeError for a bad value, a keyed row that is not live, key times
 * that do not rise or leave the shot, or an unknown ease. The message names the target and the row.
 * @example checkShotSettings({ weather: { 'wind.speed': { keys: [{ time: 0, value: 4 }, { time: 8, value: 20 }] } } }, { weather: WEATHER_SETTINGS }, 8);
 */
export function checkShotSettings(block: ShotSettingsBlock, tables: ShotTables, seconds?: number): void {
  if (typeof block !== 'object' || block === null)
    throw new TypeError('Shot settings must be an object of targets; pass { target: { row: value } }.');
  for (const [target, rows] of Object.entries(block)) {
    if (!(target in tables))
      throw new TypeError(`Unknown shot target ${target}; use one of ${Object.keys(tables).join(', ')}.`);
    const index = settingIndex(tables[target] as SettingRow[]);
    for (const [name, value] of Object.entries(rows)) {
      const where = `shot target ${target} row ${name}`;
      const row = index.get(name);
      if (!row) throw new TypeError(`Unknown ${where}; use a name from the ${target} settings table.`);
      if (!isKeyed(value)) {
        checkSettingValue(row, value, where);
        continue;
      }
      if (!row.live) throw new RangeError(`Invalid ${where}; it is not live, so hold a single value instead of keys.`);
      const keys = value.keys;
      if (!Array.isArray(keys) || keys.length < 1)
        throw new RangeError(`Invalid ${where}; keys needs at least one { time, value }.`);
      let last = -Infinity;
      for (const key of keys) {
        if (
          typeof key?.time !== 'number' ||
          !Number.isFinite(key.time) ||
          key.time < 0 ||
          (seconds !== undefined && key.time > seconds)
        )
          throw new RangeError(
            `Invalid ${where}; key times must be seconds inside the shot (0 to ${seconds ?? 'its length'}).`,
          );
        if (!(key.time > last)) throw new RangeError(`Invalid ${where}; key times must rise.`);
        last = key.time;
        if (key.ease !== undefined && !EASES.includes(key.ease))
          throw new RangeError(`Invalid ${where}; ease is one of ${EASES.join(', ')}.`);
        checkSettingValue(row, key.value, where);
      }
    }
  }
}

function blend(row: SettingRow, a: unknown, b: unknown, t: number): unknown {
  if (a === null || b === null) return a;
  if (row.kind === 'number') return (a as number) + ((b as number) - (a as number)) * t;
  if (row.kind === 'color') return (a as number[]).map((x, i) => x + ((b as number[])[i] - x) * t);
  if (row.kind === 'choice') return a;
  const key = stopKey(row),
    sa = a as Record<string, unknown>[],
    sb = b as Record<string, unknown>[];
  if (sa.length !== sb.length || !sa.every((s, i) => s[key] === sb[i][key])) return a;
  return sa.map((s, i) => ({
    ...s,
    color: (s.color as number[]).map((x, k) => x + ((sb[i].color as number[])[k] - x) * t),
  }));
}
function keyedAt(row: SettingRow, keys: readonly ShotKey[], seconds: number): unknown {
  if (seconds <= keys[0].time) return copySettingValue(keys[0].value as never);
  const last = keys[keys.length - 1];
  if (seconds >= last.time) return copySettingValue(last.value as never);
  let i = 0;
  while (keys[i + 1].time <= seconds) i++;
  const a = keys[i],
    b = keys[i + 1];
  const t = ease(a.ease, (seconds - a.time) / (b.time - a.time));
  return copySettingValue(blend(row, a.value, b.value, t) as never);
}
/**
 * The values of a (checked) shot block `seconds` into the shot: held rows as given, keyed rows between their keys (a
 * number linearly through the key's ease, a colour per channel in linear RGB, a gradient stop by stop when both keys
 * have the same stops; a choice, a null and a gradient with other stops step at each key), the first key's value
 * before it and the last key's after it. Equal inputs give equal bytes.
 */
export function shotSettingsAt(block: ShotSettingsBlock, tables: ShotTables, seconds: number): ShotValues {
  const out: ShotValues = {};
  for (const [target, rows] of Object.entries(block)) {
    const index = settingIndex(tables[target] as SettingRow[]);
    const values: Record<string, unknown> = (out[target] = {});
    for (const [name, value] of Object.entries(rows))
      values[name] = isKeyed(value) ? keyedAt(index.get(name)!, value.keys, seconds) : copySettingValue(value as never);
  }
  return out;
}
/**
 * The held rows that are not live (a row the package rebuilds something for): applied once before the shot's warm-up,
 * never every frame. Returned in the shape of {@link shotSettingsAt}.
 */
export function shotHeldRebuilds(block: ShotSettingsBlock, tables: ShotTables): ShotValues {
  const out: ShotValues = {};
  for (const [target, rows] of Object.entries(block)) {
    const index = settingIndex(tables[target] as SettingRow[]);
    for (const [name, value] of Object.entries(rows))
      if (!index.get(name)!.live && !isKeyed(value)) (out[target] ??= {})[name] = copySettingValue(value as never);
  }
  return out;
}
