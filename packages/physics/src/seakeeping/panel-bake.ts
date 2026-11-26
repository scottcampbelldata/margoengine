import { MargoError } from '@margoengine/math/errors';
import { panelsOf } from './panel-surge.js';
import { depthRatio, type HullPanelOptions, type HullPanelResponse, type HullPanelSample } from './panels.js';
import { GRAVITY, SEA_WATER, type HullMesh, type Vec3 } from './wetted.js';

const MAX_PANELS = 768;
const MATRIX = 36;
const AXES = 6;

interface PanelKernel {
  readonly memory: WebAssembly.Memory;
  hull_panel_allocate(words: number): number;
  hull_panel_free(offset: number, words: number): void;
  hull_panel_coefficients(
    vertices: number, count: number, x: number, y: number, z: number, k: number, depth: number,
    direction: number, headings: number, output: number,
  ): number;
}

async function kernel(signal: AbortSignal | undefined): Promise<PanelKernel> {
  const url = new URL(/* @vite-ignore */ './hull-panel-kernel.wasm?no-inline', import.meta.url);
  try {
    let exported: WebAssembly.Exports;
    if (url.protocol === 'file:') {
      url.search = '';
      const nodeModule = 'node:fs/promises';
      const { readFile } = await import(/* @vite-ignore */ /* webpackIgnore: true */ nodeModule);
      exported = (await WebAssembly.instantiate(await readFile(url, { signal }))).instance.exports;
    } else {
      const response = await fetch(url, { signal });
      if (!response.ok)
        throw new MargoError('failed', `Hull panel Wasm returned HTTP ${response.status}. Check that the optional panel asset is served.`);
      exported = (await WebAssembly.instantiate(await response.arrayBuffer())).instance.exports;
    }
    signal?.throwIfAborted();
    return exported as unknown as PanelKernel;
  } catch (cause) {
    signal?.throwIfAborted();
    if (cause instanceof MargoError) throw cause;
    throw Object.assign(new MargoError('failed', 'Hull panel Wasm could not load. Check that the compiled hull panel asset is served.'), { cause });
  }
}

function validMesh(mesh: HullMesh): void {
  const { vertices, indices } = mesh;
  if (vertices.length < 9 || vertices.length % 3 !== 0 || indices.length < 3 || indices.length % 3 !== 0)
    throw new MargoError('state', 'Pass hull vertices in triples with outward-wound triangle indices.');
  for (let i = 0; i < vertices.length; i++) {
    if (!Number.isFinite(vertices[i])) throw new MargoError('state', 'Use finite metre coordinates in the hull mesh.');
  }
  for (let i = 0; i < indices.length; i++) {
    const v = indices[i]!;
    if (!Number.isInteger(v) || v < 0 || v >= vertices.length / 3)
      throw new MargoError('state', 'Keep each hull triangle index within the vertices array.');
  }
}

function wavenumber(frequency: number, gravity: number, depth: number): number {
  const k = frequency * frequency / gravity;
  if (depth === Infinity) return k;
  let lo = k;
  let hi = k + Math.sqrt(k / depth);
  for (let j = 0; j < 56; j++) {
    const middle = (lo + hi) / 2;
    if (middle * depthRatio(middle, depth) < k) lo = middle;
    else hi = middle;
  }
  return (lo + hi) / 2;
}

function frozen(values: Iterable<number>, factor = 1): readonly number[] {
  return Object.freeze(Array.from(values, (n) => n * factor));
}

export async function bake(mesh: HullMesh, options: HullPanelOptions): Promise<HullPanelResponse> {
  const { waterline = 0, centre = [0, 0, 0], depth = Infinity, density = SEA_WATER, gravity = GRAVITY,
    headings = 16, signal } = options;
  signal?.throwIfAborted();
  if (![waterline, ...centre, density, gravity].every(Number.isFinite) || !(depth > 0 && density > 0 && gravity > 0))
    throw new MargoError('state', 'Use finite waterline and centre coordinates and positive depth, density and gravity.');
  if (!(Number.isInteger(headings) && ((headings >= 4 && headings <= 64) || headings === 0)))
    throw new MargoError('state', 'Use 4 to 64 diffraction headings, or zero for radiation alone.');
  const frequencies = Object.freeze(Array.from(options.frequencies));
  if (frequencies.length < 2 || frequencies.length > 64 || frequencies.some((f, i) =>
    !(f > (frequencies[i - 1] ?? 0) && Number.isFinite(f))))
    throw new MargoError('state', 'Use 2 to 64 positive finite panel frequencies in increasing order.');
  validMesh(mesh);
  const panels = panelsOf(mesh, waterline, depth, MAX_PANELS);
  if (panels.length === 0)
    throw new MargoError('state', 'Set the panel waterline above some of the hull surface.');
  let edge = 0;
  for (const panel of panels) for (const side of panel.edges) edge = Math.max(edge, side.length);
  const wave = frequencies.map((f) => wavenumber(f, gravity, depth));
  if (wave.at(-1)! * edge > Math.PI / 4)
    throw new MargoError('state', 'Reduce the panel edge length or the last frequency until each edge is at most one eighth of its wavelength.');
  const vertexWords = panels.length * 9;
  const resultWords = 2 * (MATRIX + AXES * headings);
  const output = vertexWords + headings;
  const length = output + resultWords;
  const native = await kernel(signal);
  signal?.throwIfAborted();
  const pointer = native.hull_panel_allocate(length);
  try {
    const input = new Float64Array(native.memory.buffer, pointer, output);
    let word = 0;
    for (const panel of panels) for (const point of panel.vertices) {
      input.set(point, word);
      word += 3;
    }
    for (let i = 0; i < headings; i++) input[vertexWords + i] = i * 2 * Math.PI / headings;
    const coefficients = (k: number, directions: number) => {
      if (!native.hull_panel_coefficients(
        pointer, panels.length, centre[0], centre[1] - waterline, centre[2], k, depth,
        pointer + vertexWords * 8, directions, pointer + output * 8,
      ))
        throw new MargoError('state', 'The hull panel system is ill-conditioned. Refine hull triangles and remove crossed or duplicate faces.');
      return new Float64Array(native.memory.buffer, pointer + output * 8, resultWords);
    };
    const infiniteMass = frozen(coefficients(-1, 0).subarray(0, MATRIX), density);
    const samples: HullPanelSample[] = [];
    for (const [i, k] of wave.entries()) {
      // Give the browser a turn in between frequencies so an aborted bake releases its Wasm allocation.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      signal?.throwIfAborted();
      const words = coefficients(k, headings);
      samples.push(Object.freeze({
        addedMass: frozen(words.subarray(0, MATRIX), density),
        damping: frozen(words.subarray(MATRIX, 2 * MATRIX), density * frequencies[i]!),
        diffraction: frozen(words.subarray(2 * MATRIX), density * gravity),
      }));
    }
    return Object.freeze({
      waterline, centre: Object.freeze([...centre]) as Vec3, depth, density, gravity, headings, panelCount: panels.length,
      frequencies, samples: Object.freeze(samples), infiniteMass,
    });
  } finally {
    native.hull_panel_free(pointer, length);
  }
}
