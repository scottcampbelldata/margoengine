/** A colour value: linear RGB. */
export type SettingColor = readonly [number, number, number];
/** One gradient stop: a colour at a position (`elevation` unless the row's `stopKey` says otherwise). */
export type SettingStop = { readonly color: SettingColor };
/** One value of a setting: a number, a colour, a choice, gradient stops, or null where `nullable`. */
export type SettingValue = number | SettingColor | string | readonly SettingStop[] | null;
/** Values by setting name; a name left out takes its default. */
export type SettingValues = Readonly<Record<string, SettingValue>>;
/** One slider row, the shape every package's `/settings` entry shares. */
export interface SettingRow {
  readonly name: string;
  readonly group: string;
  /** `number` is a slider, `color` three sliders or a picker, `choice` a list, `gradient` a stop editor. */
  readonly kind: 'number' | 'color' | 'choice' | 'gradient';
  /** The value with which the target draws exactly as it does without the option (null: follow the weather). */
  readonly default: SettingValue;
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
  readonly choices?: readonly string[];
  /** May be null: the target uses its own value, or follows the weather when `weather` is set. */
  readonly nullable?: boolean;
  /** The weather master slider that drives this row while it is null. */
  readonly weather?: string;
  /** The key a gradient stop is placed by (default `elevation`). */
  readonly stopKey?: string;
  readonly unit: string;
  readonly about: string;
  /** True: cheap to write every frame (no pipeline, buffer or texture is created), so it can be keyed over a shot. False: writing it rebuilds something. */
  readonly live: boolean;
}
export declare const numberSetting: (
  name: string,
  group: string,
  value: number,
  min: number,
  max: number,
  step: number,
  unit: string,
  about: string,
  live?: boolean,
) => SettingRow;
export declare const colorSetting: (
  name: string,
  group: string,
  value: SettingColor,
  min: number,
  max: number,
  about: string,
  live?: boolean,
) => SettingRow;
export declare const choiceSetting: (
  name: string,
  group: string,
  choices: readonly string[],
  about: string,
  live?: boolean,
) => SettingRow;
/** The row with a null default that follows the weather master slider `weather` until a value is given. */
export declare const followsWeather: (row: SettingRow, weather: string) => SettingRow;
/** Marks `key` of `target` as set by hand (`held` true) or hands it back to the weather (false). */
export declare function holdFromWeather(target: object, key: string, held?: boolean): void;
/** True while `key` of `target` holds a value set by hand, which the weather drive leaves alone. */
export declare const heldFromWeather: (target: object, key: string) => boolean;
export declare const sameSettingValue: (a: unknown, b: unknown) => boolean;
export declare function copySettingValue(v: SettingValue): SettingValue;
/** A fresh object holding every row at its default (a slider panel's state). */
export declare function settingDefaults(rows: readonly SettingRow[]): Record<string, SettingValue>;
/** The rows that may change every frame without a rebuild. */
export declare const liveSettings: (rows: readonly SettingRow[]) => SettingRow[];
/** A name to row map. */
export declare const settingIndex: (rows: readonly SettingRow[]) => Map<string, SettingRow>;
/** @throws RangeError when `v` is not a value of `row`. */
export declare function checkSettingValue(row: SettingRow, v: unknown, label: string): void;
/** @throws TypeError for an unknown name; RangeError for a bad value or a null on a row that is not nullable. */
export declare function checkSettings(
  rows: readonly SettingRow[] | ReadonlyMap<string, SettingRow>,
  values: SettingValues,
  label: string,
  entry?: string,
): void;
/** Checks `values`, then calls `write` once per row (or per row `only` accepts) with the given value or the default. */
export declare function applySettings(
  rows: readonly SettingRow[],
  values: SettingValues,
  label: string,
  write: (row: SettingRow, value: SettingValue) => void,
  only?: (row: SettingRow) => boolean,
): void;
