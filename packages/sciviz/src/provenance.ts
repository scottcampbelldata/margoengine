import { CORE_VERSION } from '@margoengine/core';
import {
  Figure as SpecFigure,
  specHash,
  recordedResources,
  createFigureResource,
  type Figure as PortableFigure,
  type FigureSpec,
  type FigureLoadOptions,
  type FigureSaveOptions,
  type SpecValue,
  type SpecIOOptions,
  type CreateFigureOptions,
  type FigureOptions,
} from '@margoengine/sciviz/spec';
import type { EngineKernel } from '@margoengine/core';
import type { DType } from '@margoengine/compute';
import type { PDFOptions } from './pdf.js';
import { ValueIO, copySpecArray, SavedGPUInput } from './spec-values.js';
import { observeFigureCalls, emitFigureCall, type FigureCall } from './spec-call-hooks.js';
import { fault, typeError, rangeError } from '../../shared/errors.js';
import { packageVersions } from './provenance-versions.js';
import { embedPNGProvenance, embedSVGProvenance } from './provenance-containers.js';
export {
  embedPNGProvenance,
  readPNGProvenance,
  embedSVGProvenance,
  readSVGProvenance,
} from './provenance-containers.js';
export type { ProvenanceIOOptions } from './provenance-containers.js';

/** Reproducible input entity, rendering activity and software/environment agents, inspired by W3C PROV-DM. */
export interface FigureProvenance {
  readonly version: 1;
  readonly createdAt: string;
  readonly sha256: string;
  readonly spec: FigureSpec;
  readonly data: readonly {
    readonly sha256: string;
    readonly dtype: string;
    readonly url?: string;
    readonly length?: number;
    readonly path?: string;
  }[];
  readonly packages: Readonly<Record<string, string>>;
  readonly gpu: Readonly<Record<string, string>>;
  readonly browser: Readonly<Record<string, string>>;
}
/** Extra application package versions and portable save bounds. */
export interface ProvenanceOptions extends FigureSaveOptions {
  readonly packages?: Readonly<Record<string, string>>;
}
/** Bounds for the retained successful-call history. Exceeding one makes trace() reject explicitly. */
export interface TraceRecordingOptions extends FigureSaveOptions {
  /** Default 10000 successful calls. */
  readonly maxCalls?: number;
  /** Default 256 MiB of retained arguments, excluding the initial spec. */
  readonly maxTraceBytes?: number;
}
/** Opted-in instance with embedded PNG/SVG provenance and a successful API-call history. */
export interface Figure extends PortableFigure {
  trace(options?: SpecIOOptions): Promise<string>;
  provenance(options?: ProvenanceOptions): Promise<FigureProvenance>;
}
interface Call {
  kind: 'create' | 'call' | 'set';
  id: string;
  method: string;
  args: unknown[];
  refs: Map<object, string>;
}
interface TraceState {
  initial: FigureSpec;
  calls: Call[];
  refs: Map<object, string>;
  creating: Map<object, Call>;
  muted: number;
  active: boolean;
  used: number;
  maxCalls: number;
  maxTraceBytes: number;
  error?: Error;
}
const states = new WeakMap<PortableFigure, TraceState>();
const traceArrays = new WeakMap<PortableFigure, { dispose(): void }[]>();
function snapshot(value: unknown, refs: ReadonlyMap<object, string>): unknown {
  if (!value || typeof value !== 'object' || refs.has(value)) return value;
  if (ArrayBuffer.isView(value) && !(value instanceof DataView)) return copySpecArray(value);
  if (Array.isArray(value)) return value.map((item) => snapshot(item, refs));
  if (Object.getPrototypeOf(value) === Object.prototype)
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, snapshot(item, refs)]));
  return value;
}
function retainedBytes(value: unknown, refs: ReadonlyMap<object, string>, seen = new Set<object>()): number {
  if (typeof value === 'string') return value.length * 2;
  if (!value || typeof value !== 'object') return 8;
  if (refs.has(value) || seen.has(value)) return 8;
  seen.add(value);
  if (ArrayBuffer.isView(value)) return value.byteLength + 32;
  if (value instanceof SavedGPUInput) return value.data.byteLength + 64;
  if (Array.isArray(value)) return 32 + value.reduce((sum, item) => sum + retainedBytes(item, refs, seen), 0);
  if (Object.getPrototypeOf(value) === Object.prototype)
    return (
      64 + Object.entries(value).reduce((sum, [key, item]) => sum + key.length * 2 + retainedBytes(item, refs, seen), 0)
    );
  return 128;
}
function remember(
  state: TraceState,
  kind: Call['kind'],
  id: string,
  method: string,
  args: readonly unknown[],
  replacement?: Call,
): Call | undefined {
  if (state.error) return;
  const bytes = retainedBytes(args, state.refs) + state.refs.size * 32;
  if ((!replacement && state.calls.length >= state.maxCalls) || state.used + bytes > state.maxTraceBytes) {
    state.error = rangeError(
      'Trace history exceeded its recording bound; increase maxCalls/maxTraceBytes or start a new recording',
      'sciviz',
    );
    state.calls.length = 0;
    state.creating.clear();
    state.refs.clear();
    return;
  }
  state.used += bytes;
  const call = { kind, id, method, args: args.map((arg) => snapshot(arg, state.refs)), refs: new Map(state.refs) };
  if (replacement) {
    Object.assign(replacement, call);
    return replacement;
  }
  state.calls.push(call);
  return call;
}
function watchObject(figure: PortableFigure, state: TraceState, object: object, id: string): void {
  const target = object as Record<string, unknown>;
  const dispose = typeof target.dispose === 'function' ? (target.dispose as () => void) : undefined;
  if (dispose)
    target.dispose = function () {
      const result = dispose.call(object);
      if (!state.muted && state.active) remember(state, 'call', id, 'dispose', []);
      return result;
    };
  for (const key of [
    'visible',
    'range',
    'contours',
    'grid',
    'opacity',
    'mode',
    'density',
    'quality',
    'shading',
    'clip',
    'position',
  ]) {
    if (!(key in object)) continue;
    const own = Object.getOwnPropertyDescriptor(object, key);
    let parent = Object.getPrototypeOf(object),
      inherited: PropertyDescriptor | undefined;
    while (parent && !inherited) {
      inherited = Object.getOwnPropertyDescriptor(parent, key);
      parent = Object.getPrototypeOf(parent);
    }
    const descriptor = own ?? inherited;
    if (
      !descriptor ||
      own?.configurable === false ||
      (descriptor.get && !descriptor.set) ||
      descriptor.writable === false
    )
      continue;
    let current = target[key];
    Object.defineProperty(object, key, {
      configurable: true,
      enumerable: descriptor.enumerable ?? true,
      get: () => (descriptor.get ? descriptor.get.call(object) : current),
      set: (value) => {
        if (descriptor.set) descriptor.set.call(object, value);
        else current = value;
        emitFigureCall(figure, { type: 'set', object, method: key, args: [value] });
      },
    });
  }
}
/** Attach provenance before further plotting. Existing state becomes the replay baseline. No prototype is changed. */
export async function withProvenance(figure: PortableFigure, options: TraceRecordingOptions = {}): Promise<Figure> {
  if (states.has(figure)) return figure as Figure;
  const maxCalls = options.maxCalls ?? 10000,
    maxTraceBytes = options.maxTraceBytes ?? 256 * 1024 * 1024;
  if (!Number.isSafeInteger(maxCalls) || maxCalls < 1 || !Number.isSafeInteger(maxTraceBytes) || maxTraceBytes < 1)
    throw rangeError('Recording bounds must be positive safe integers; correct maxCalls/maxTraceBytes', 'sciviz');
  const initial = await figure.toJSON({ ...options, timeline: false });
  const state: TraceState = {
    initial,
    calls: [],
    refs: new Map(recordedResources(figure)),
    creating: new Map(),
    muted: 0,
    active: true,
    used: 0,
    maxCalls,
    maxTraceBytes,
  };
  state.refs.set(figure, 'figure');
  states.set(figure, state);
  for (const [object, id] of state.refs) if (object !== figure) watchObject(figure, state, object, id);
  const unsubscribe = observeFigureCalls(figure, (event: FigureCall) => {
    if (!state.active || state.muted || state.error) return;
    if (event.type === 'create' || event.type === 'recipe') {
      state.refs.set(event.object, event.id!);
      const previous = state.creating.get(event.object);
      if (event.type === 'recipe' && previous) {
        remember(state, 'create', event.id!, event.method, event.args, previous);
        return;
      }
      const call = remember(state, 'create', event.id!, event.method, event.args);
      if (!call) return;
      state.creating.set(event.object, call);
      watchObject(figure, state, event.object, event.id!);
    } else {
      const id = state.refs.get(event.object);
      if (id) remember(state, event.type === 'set' ? 'set' : 'call', id, event.method, event.args);
    }
  });
  for (const method of ['remove', 'replace', 'setLimits'] as const) {
    const original = figure[method].bind(figure) as (...args: unknown[]) => unknown;
    Object.defineProperty(figure, method, {
      configurable: true,
      value: (...args: unknown[]) => {
        state.muted++;
        let result;
        try {
          result = original(...args);
        } finally {
          state.muted--;
        }
        if (!state.muted && state.active) emitFigureCall(figure, { type: 'call', object: figure, method, args });
        return result;
      },
    });
  }
  const dispose = figure.dispose.bind(figure);
  figure.dispose = () => {
    state.active = false;
    unsubscribe();
    state.calls.length = 0;
    state.refs.clear();
    state.creating.clear();
    dispose();
  };
  const png = figure.toPNG.bind(figure),
    svg = figure.toSVG.bind(figure);
  figure.toPNG = async (options) => embedPNGProvenance(await png(options), await captureProvenance(figure), {});
  figure.toSVG = async (options) => embedSVGProvenance(await svg(options), await captureProvenance(figure));
  Object.defineProperties(figure, {
    trace: { value: (options?: SpecIOOptions) => traceFigure(figure, options) },
    provenance: { value: (options?: ProvenanceOptions) => captureProvenance(figure, options) },
  });
  return figure as Figure;
}
async function instrument(
  figure: PortableFigure | Promise<PortableFigure>,
  options: TraceRecordingOptions,
): Promise<Figure> {
  const value = await figure;
  try {
    return await withProvenance(value, options);
  } catch (error) {
    value.dispose();
    throw error;
  }
}
/** Factories with portable state, successful call recording and provenance-bearing image exports. */
export const Figure = {
  async create(canvas: HTMLCanvasElement, options: CreateFigureOptions & TraceRecordingOptions = {}): Promise<Figure> {
    return instrument(SpecFigure.create(canvas, options), options);
  },
  async attach(engine: EngineKernel, options: FigureOptions & TraceRecordingOptions = {}): Promise<Figure> {
    return instrument(SpecFigure.attach(engine, options), options);
  },
  async fromJSON(
    spec: FigureSpec,
    canvas: HTMLCanvasElement,
    options: FigureLoadOptions & TraceRecordingOptions = {},
  ): Promise<Figure> {
    return instrument(SpecFigure.fromJSON(spec, canvas, options), options);
  },
};
/** Capture the exact current spec, data digests, build package versions and available environment identity. */
export async function captureProvenance(
  figure: PortableFigure,
  options: ProvenanceOptions = {},
): Promise<FigureProvenance> {
  const spec = await figure.toJSON(options),
    data = new Map<string, FigureProvenance['data'][number]>();
  const visit = async (value: unknown, path: string): Promise<void> => {
    options.signal?.throwIfAborted();
    if (!value || typeof value !== 'object') return;
    const v = value as Record<string, unknown>;
    if (Array.isArray(value) && value.length && value.every((item) => typeof item === 'number')) {
      const sha256 = await specHash(new TextEncoder().encode(JSON.stringify(value)));
      data.set(sha256 + ':JSON', { sha256, dtype: 'JSON', length: value.length, path });
    }
    if (typeof v.$array === 'string' && typeof v.sha256 === 'string')
      data.set(v.sha256 + ':' + v.$array, { sha256: v.sha256, dtype: v.$array });
    if (v.$url) {
      const source = v.$url as FigureProvenance['data'][number];
      data.set(source.sha256 + ':' + source.url, { ...source });
    }
    for (const [key, item] of Object.entries(value)) await visit(item, path + '.' + key);
  };
  await visit(spec, 'spec');
  const info = (figure.renderer.device as (GPUDevice & { adapterInfo?: GPUAdapterInfo }) | undefined)?.adapterInfo;
  const gpu: Record<string, string> = { backend: figure.engine.backend };
  for (const key of ['vendor', 'architecture', 'device', 'description'] as const)
    gpu[key] = info?.[key] ?? 'unavailable';
  const browser: Record<string, string> = {};
  if (typeof navigator !== 'undefined') {
    browser.userAgent = navigator.userAgent;
    browser.platform = navigator.platform;
    browser.language = navigator.language;
  } else browser.userAgent = 'unavailable';
  const body = {
    version: 1 as const,
    createdAt: new Date().toISOString(),
    spec,
    data: [...data.values()],
    packages: { ...options.packages, ...packageVersions, '@margoengine/core': CORE_VERSION },
    gpu,
    browser,
  };
  return { ...body, sha256: await specHash(new TextEncoder().encode(JSON.stringify(body))) };
}
/** Detect accidental metadata changes. Hashes identify content and do not assert authorship or trust. */
export async function validateProvenance(record: FigureProvenance, options: SpecIOOptions = {}): Promise<void> {
  options.signal?.throwIfAborted();
  if (record?.version !== 1 || !record.sha256)
    throw typeError('Expected provenance version 1; supply the original record', 'sciviz');
  const { sha256, ...body } = record;
  if ((await specHash(new TextEncoder().encode(JSON.stringify(body)))) !== sha256)
    throw fault('failed', 'Provenance hash mismatch; use the original exported record', 'sciviz');
  options.signal?.throwIfAborted();
}
/** Decode script arguments with live resource references and GPU array recreation where originally needed. */
export async function decodeTraceValue(
  value: SpecValue,
  figure: PortableFigure,
  references: ReadonlyMap<string, object>,
  options: SpecIOOptions = {},
): Promise<unknown> {
  let owned = traceArrays.get(figure);
  if (!owned) {
    owned = [];
    traceArrays.set(figure, owned);
    const dispose = figure.dispose.bind(figure),
      arrays = owned;
    figure.dispose = () => {
      try {
        dispose();
      } finally {
        for (const array of arrays.splice(0)) array.dispose();
        traceArrays.delete(figure);
      }
    };
  }
  const io = new ValueIO(options, async (data, shape, dtype) => {
    const gpu = await figure.renderer.compute(),
      array = gpu.array(data, { shape, dtype: dtype as DType });
    owned!.push(array);
    return array;
  });
  return io.decode(value, references);
}
/** Emit an ESM replay function. Successful calls, intermediate mutations and removals are retained in order. */
export async function traceFigure(figure: PortableFigure, options: SpecIOOptions = {}): Promise<string> {
  const state = states.get(figure);
  if (!state?.active)
    throw fault('state', 'Trace needs an active provenance figure; call withProvenance before plotting', 'sciviz');
  if (state.error) throw state.error;
  const final = await figure.toJSON(options),
    calls = [...state.calls],
    io = new ValueIO(options);
  if (state.error) throw state.error;
  const lines = [
    `import { Figure, createFigureResource, recordedResources } from '@margoengine/sciviz/spec';`,
    `import { decodeTraceValue } from '@margoengine/sciviz/provenance';`,
    `export default async function replay(canvas, options = {}) {`,
    `const initial = ${JSON.stringify(state.initial)};`,
    `let figure = await Figure.fromJSON(initial, canvas, options);`,
    `const internal = new Map([...recordedResources(figure)].map(([object,id])=>[id,object]));`,
    `const loaded = await figure.toJSON({ timeline:false });`,
    `const refs = new Map([['figure', figure]]);`,
    `initial.resources.forEach((resource,i)=>refs.set(resource.id,internal.get(loaded.resources[i].id)));`,
    `const decode = value => decodeTraceValue(value,figure,refs,options);`,
    `try {`,
  ];
  for (const call of calls) {
    const args = JSON.stringify(await io.encode(call.args, call.refs));
    if (call.kind === 'create') {
      if (
        [
          'scatter',
          'line',
          'quiver',
          'streamlines',
          'surface',
          'volume',
          'isosurface',
          'bar',
          'histogram',
          'heatmap',
          'colorbar',
        ].includes(call.method)
      )
        lines.push(
          `refs.set(${JSON.stringify(call.id)}, await figure[${JSON.stringify(call.method)}](...await decode(${args})));`,
        );
      else
        lines.push(
          `refs.set(${JSON.stringify(call.id)}, await createFigureResource(figure, ${JSON.stringify(call.method)}, await decode(${args}), options));`,
        );
    } else if (call.kind === 'set')
      lines.push(`refs.get(${JSON.stringify(call.id)})[${JSON.stringify(call.method)}] = (await decode(${args}))[0];`);
    else
      lines.push(
        `await refs.get(${JSON.stringify(call.id)})[${JSON.stringify(call.method)}](...await decode(${args}));`,
      );
  }
  // View assignments and declarative temporal callbacks are frozen in the final portable state.
  lines.push(`const final = ${JSON.stringify(final)};`);
  lines.push(
    `figure.dispose();`,
    `figure = await Figure.fromJSON(final,canvas,options);`,
    `return figure;`,
    `} catch (error) { figure.dispose(); throw error; }`,
    `}`,
  );
  return lines.join('\n') + '\n';
}
/** Export PDF with the same record as PNG/SVG in its Unicode document information dictionary. */
export async function exportProvenancePDF(
  figure: PortableFigure,
  options: PDFOptions & ProvenanceOptions,
): Promise<Blob> {
  const { exportPDF } = await import('@margoengine/sciviz/pdf');
  return exportPDF(figure, { ...options, provenance: { ...(await captureProvenance(figure, options)) } });
}
