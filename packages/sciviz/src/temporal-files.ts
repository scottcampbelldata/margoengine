import { rangeError } from '../../shared/errors.js';
import type { TemporalOptions, TemporalSource } from './temporal.js';
import { parseTimeUnits } from './temporal-units.js';

/** Filename and physical step time; URLs are resolved only with an explicit baseURL. */
export interface TemporalFile { readonly name: string; readonly time: number }
/** A single field's ordered files. */
export interface TemporalFileSeries {
  readonly pattern: string;
  readonly files: readonly TemporalFile[];
  readonly units: string;
}
/** Numbered-file time is start + (number - first number) * step. Defaults: start=0, step=1, units=seconds. */
export interface FileSeriesOptions {
  readonly start?: number;
  readonly step?: number;
  readonly units?: string;
  readonly baseURL?: string | URL;
}
const bad = (text: string) => rangeError(`Temporal files: ${text}`, 'sciviz');
function nameOf(name: unknown, base?: string | URL): string {
  if (typeof name !== 'string' || !name.trim() || /[\x00-\x1f\x7f]/.test(name)) throw bad('each file needs a nonempty name without control characters');
  if (!base) return name;
  try { return new URL(name, base).href; } catch { throw bad('baseURL and file names must form valid URLs'); }
}
function ordered(pattern: string, files: TemporalFile[], units: string): TemporalFileSeries {
  if (!files.length) throw bad('series must contain files');
  parseTimeUnits(units);
  files.sort((a, b) => a.time - b.time);
  const names = new Set<string>();
  for (let i = 0; i < files.length; i++) {
    if (!Number.isFinite(files[i].time) || (i && files[i].time <= files[i - 1].time)) throw bad('step times must be finite and unique');
    if (names.has(files[i].name)) throw bad('duplicate file name');
    names.add(files[i].name);
    Object.freeze(files[i]);
  }
  return Object.freeze({ pattern, files: Object.freeze(files), units });
}
/** Group the last number in each basename, preserving directories and suffixes; unnumbered files remain separate groups. */
export function groupFileSeries(names: readonly string[], options: FileSeriesOptions = {}): readonly TemporalFileSeries[] {
  const start = options.start ?? 0, step = options.step ?? 1, units = options.units ?? 'seconds';
  if (!Number.isFinite(start) || !Number.isFinite(step) || step <= 0) throw bad('start must be finite and step positive');
  parseTimeUnits(units);
  const groups = new Map<string, { pattern: string; entries: { number: number; name: string }[] }>(), seen = new Set<string>();
  for (const raw of names) {
    const name = nameOf(raw), slash = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\')),
      directory = name.slice(0, slash + 1), basename = name.slice(slash + 1), match = /^(.*?)(\d+)(\D*)$/.exec(basename),
      pattern = match ? `${directory}${match[1]}*${match[3]}` : name,
      key = JSON.stringify(match ? [directory, match[1], match[3]] : [name]), number = match ? Number(match[2]) : 0;
    if (!Number.isSafeInteger(number)) throw bad('file sequence number exceeds safe integer range');
    const resolved = nameOf(name, options.baseURL);
    if (seen.has(resolved)) throw bad('duplicate file name');
    seen.add(resolved);
    const group = groups.get(key) ?? { pattern, entries: [] };
    group.entries.push({ number, name: resolved }); groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => a.pattern < b.pattern ? -1 : a.pattern > b.pattern ? 1 : 0).map((group) => {
    group.entries.sort((a, b) => a.number - b.number);
    return ordered(group.pattern, group.entries.map((e) => ({ name: e.name, time: start + (e.number - group.entries[0].number) * step })), units);
  });
}
/** Parse ParaView .series JSON version 1.0. Explicit times are preserved and sorted; duplicate times reject. */
export function parseFileSeries(input: string | unknown, options: Pick<FileSeriesOptions, 'units' | 'baseURL'> = {}): TemporalFileSeries {
  let parsed: unknown = input;
  if (typeof input === 'string') {
    try { parsed = JSON.parse(input); } catch { throw bad('invalid .series JSON'); }
  }
  if (!parsed || typeof parsed !== 'object') throw bad('expected a .series object');
  const data = parsed as Record<string, unknown>;
  if (data['file-series-version'] !== '1.0' || !Array.isArray(data.files)) throw bad('expected file-series-version 1.0 and files array');
  const files = data.files.map((entry: unknown) => {
    if (!entry || typeof entry !== 'object') throw bad('invalid file entry');
    const file = entry as Record<string, unknown>;
    if (typeof file.time !== 'number') throw bad('each file needs an explicit numeric time');
    return { name: nameOf(file.name, options.baseURL), time: file.time };
  });
  return ordered('.series', files, options.units ?? 'seconds');
}
/** Adapt grouped files to any existing format reader. Loading and its cancellation belong to the supplied reader. */
export function fileSeriesSource<T>(series: TemporalFileSeries, load: (file: TemporalFile, options: TemporalOptions) => T | Promise<T>): TemporalSource<T> {
  const snapshot = ordered(series.pattern, series.files.map((f) => ({ name: nameOf(f.name), time: f.time })), series.units);
  if (typeof load !== 'function') throw bad('supply a file loader');
  return {
    times: Float64Array.from(snapshot.files, (f) => f.time),
    async read(index, options = {}) {
      options.signal?.throwIfAborted();
      if (!Number.isInteger(index) || index < 0 || index >= snapshot.files.length) throw bad('file index outside series');
      const result = await load(snapshot.files[index], options);
      options.signal?.throwIfAborted();
      return result;
    },
  };
}
