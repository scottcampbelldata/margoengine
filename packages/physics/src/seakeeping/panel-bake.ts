import { MargoError } from '@margoengine/math/errors';
import { hullError } from './errors.js';
import { bakeWithHelper } from './panel-bake-helpers.js';
import {
  openPanelKernel,
  type PanelBakeInput,
  type PanelFrequency,
  type PanelFrequencyResult,
} from './panel-bake-native.js';
import { panelsOf } from './panel-surge.js';
import {
  depthRatio,
  type HullPanelOptions,
  type HullPanelResponse,
  type HullPanelSample,
  type HullPanelWorkerWork,
} from './panels.js';
import { GRAVITY, SEA_WATER, type HullMesh, type Vec3 } from './wetted.js';

const MAX_PANELS = 768;
const MATRIX = 36;

async function kernel(signal: AbortSignal | undefined): Promise<WebAssembly.Module> {
  const url = new URL(/* @vite-ignore */ './hull-panel-kernel.wasm?no-inline', import.meta.url);
  try {
    let module: WebAssembly.Module;
    if (url.protocol === 'file:') {
      url.search = '';
      const nodeModule = 'node:fs/promises';
      const { readFile } = await import(/* @vite-ignore */ /* webpackIgnore: true */ nodeModule);
      module = await WebAssembly.compile(await readFile(url, { signal }));
    } else {
      const response = await fetch(url, { signal });
      if (!response.ok)
        throw hullError('failed', `Hull panel Wasm returned HTTP ${response.status}. Serve the optional panel asset.`);
      module = await WebAssembly.compile(await response.arrayBuffer());
    }
    signal?.throwIfAborted();
    return module;
  } catch (cause) {
    signal?.throwIfAborted();
    if (cause instanceof MargoError) throw cause;
    throw Object.assign(hullError('failed', 'Load the compiled hull panel asset in a Wasm SIMD runtime.'), { cause });
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
  const k = (frequency * frequency) / gravity;
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
  return Object.freeze(
    Array.from(values, (n) => {
      const value = n * factor;
      if (!Number.isFinite(value))
        throw hullError(
          'state',
          'Reduce the hull scale, density, gravity or frequency to obtain finite SI coefficients.',
        );
      return value;
    }),
  );
}

function participantWork(results: readonly PanelFrequencyResult[]): HullPanelWorkerWork {
  let frequencySolves = 0;
  let eliminationPairs = 0;
  let eliminationTail = 0;
  for (const { index, pairs, tail } of results) {
    frequencySolves += Number(index !== 0);
    eliminationPairs += pairs;
    eliminationTail += tail;
  }
  return Object.freeze({ systems: results.length, frequencySolves, eliminationPairs, eliminationTail });
}

async function bakePartitions(
  input: PanelBakeInput,
  jobs: readonly PanelFrequency[],
  requested: number,
  signal?: AbortSignal,
): Promise<(readonly PanelFrequencyResult[])[]> {
  const module = await kernel(signal);
  const controller = new AbortController();
  const active = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const threads = Math.min(requested, jobs.length);
  const slices = Array.from({ length: threads }, (_, part) => jobs.filter((_, i) => i % threads === part));
  async function bakeLocally(): Promise<PanelFrequencyResult[]> {
    active.throwIfAborted();
    const local = openPanelKernel(module, input);
    try {
      const results: PanelFrequencyResult[] = [];
      for (const job of slices[0]!) {
        // Let the caller process aborts between synchronous systems.
        if (job.index !== 0 || threads !== 1) await new Promise<void>((resolve) => setTimeout(resolve, 0));
        active.throwIfAborted();
        const result = local.solve(job);
        if (!result)
          throw hullError(
            'state',
            'The hull panel system is ill-conditioned. Refine hull triangles and remove crossed or duplicate faces.',
          );
        results.push(result);
      }
      return results;
    } finally {
      local.close();
    }
  }
  const remote = slices.slice(1).map((jobs) => bakeWithHelper({ module, input, jobs }, active));
  const pending = [bakeLocally(), ...remote];
  try {
    return await Promise.all(pending);
  } catch (cause) {
    signal?.throwIfAborted();
    if (cause instanceof MargoError) throw cause;
    throw Object.assign(hullError('failed', 'Run the hull panel bake in a memory-supported Wasm SIMD runtime.'), {
      cause,
    });
  } finally {
    controller.abort();
    await Promise.allSettled(pending);
  }
}

export async function bake(mesh: HullMesh, options: HullPanelOptions): Promise<HullPanelResponse> {
  const {
    waterline = 0,
    centre = [0, 0, 0],
    depth = Infinity,
    density = SEA_WATER,
    gravity = GRAVITY,
    headings = 16,
    signal,
    threads = 1,
  } = options;
  signal?.throwIfAborted();
  if (threads !== 1 && threads !== 2 && threads !== 4) throw hullError('state', 'Choose 1, 2 or 4 hull panel threads.');
  if (![waterline, ...centre, density, gravity].every(Number.isFinite) || !(depth > 0 && density > 0 && gravity > 0))
    throw new MargoError(
      'state',
      'Use finite waterline and centre coordinates and positive depth, density and gravity.',
    );
  if (!(Number.isInteger(headings) && ((headings >= 4 && headings <= 64) || headings === 0)))
    throw new MargoError('state', 'Use 4 to 64 diffraction headings, or zero for radiation alone.');
  const frequencies = Object.freeze(Array.from(options.frequencies));
  if (
    frequencies.length < 2 ||
    frequencies.length > 64 ||
    frequencies.some((f, i) => !(f > (frequencies[i - 1] ?? 0) && Number.isFinite(f)))
  )
    throw new MargoError('state', 'Use 2 to 64 positive finite panel frequencies in increasing order.');
  validMesh(mesh);
  const panels = panelsOf(mesh, waterline, depth, MAX_PANELS);
  if (panels.length === 0) throw new MargoError('state', 'Set the panel waterline above some of the hull surface.');
  let edge = 0;
  for (const panel of panels) for (const side of panel.edges) edge = Math.max(edge, side.length);
  const wave = frequencies.map((f) => wavenumber(f, gravity, depth));
  if (!Number.isFinite(edge) || wave.some((k) => !(k > 0 && Number.isFinite(k))))
    throw hullError('state', 'Use representable hull edge lengths, frequencies, gravity and depth.');
  if (wave.at(-1)! * edge > Math.PI / 4)
    throw new MargoError(
      'state',
      'Reduce the panel edge length or the last frequency until each edge is at most one eighth of its wavelength.',
    );
  const vertexWords = panels.length * 9;
  const geometry = new Float64Array(vertexWords + headings);
  let word = 0;
  for (const panel of panels)
    for (const point of panel.vertices) {
      geometry.set(point, word);
      word += 3;
    }
  for (let i = 0; i < headings; i++) geometry[vertexWords + i] = (i * 2 * Math.PI) / headings;
  const results = await bakePartitions(
    {
      geometry,
      count: panels.length,
      centre: [centre[0], centre[1] - waterline, centre[2]],
      depth,
      headings,
    },
    [{ index: 0, k: -1, headings: 0 }, ...wave.map((k, i) => ({ index: i + 1, k, headings }))],
    threads,
    signal,
  );
  signal?.throwIfAborted();
  const ordered = results.flat().sort((a, b) => a.index - b.index);
  const infiniteMass = frozen(ordered[0]!.words.subarray(0, MATRIX), density);
  const samples: HullPanelSample[] = ordered.slice(1).map(({ index, words }) =>
    Object.freeze({
      addedMass: frozen(words.subarray(0, MATRIX), density),
      damping: frozen(words.subarray(MATRIX, 2 * MATRIX), density * frequencies[index - 1]!),
      diffraction: frozen(words.subarray(2 * MATRIX), density * gravity),
    }),
  );
  const workers = options.threads === undefined ? undefined : Object.freeze(results.map(participantWork));
  return Object.freeze({
    waterline,
    centre: Object.freeze([...centre]) as Vec3,
    depth,
    density,
    gravity,
    headings,
    panelCount: panels.length,
    frequencies,
    samples: Object.freeze(samples),
    infiniteMass,
    ...(workers && { work: Object.freeze({ ...participantWork(ordered), threads: workers.length, workers }) }),
  });
}
