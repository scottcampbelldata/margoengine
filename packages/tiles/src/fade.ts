/// <reference lib="esnext.disposable" preserve="true" />
import type { PBRModel, MaterialExtension, PBRPrimitive } from '@margoengine/gltf-pro';
import { MargoError } from '@margoengine/math/errors';
import { ditherWGSL } from '../../shared/screen-door.js';
import type {
  TilesRenderer,
  TilesContentDecorator,
  TilesContentDecoration,
  TilesDecorationContext,
} from './renderer.js';
import type { TilesetTile } from './tileset.js';
/** Tile replacement fade options. */
export interface TilesFadeOptions {
  /** Seconds for a complete replacement. Default 0.3. */
  duration?: number;
  /** Monotonic seconds. Default performance.now()/1000. Supply a simulation clock for replay. */
  clock?: () => number;
  /** Preceding style or feature decoration, owned with the same content. */
  decorate?: TilesContentDecorator;
}
interface Binding {
  context: TilesDecorationContext;
  prior?: TilesContentDecoration;
  meshes: Array<{
    p: PBRPrimitive;
    base?: MaterialExtension;
    extension: MaterialExtension;
    offset: number;
    marker: string;
  }>;
  set: (lower: number, upper: number) => void;
}
interface State {
  value: number;
  from: number;
  target: number;
  time: number;
}
/** Hierarchical screen-door cross-fade of replacement tiles, including meshes, points and sorted splats. */
export class TilesFade implements Disposable {
  private readonly bindings = new Map<TilesetTile, Set<Binding>>();
  private readonly states = new Map<TilesetTile, State>();
  private stop?: () => void;
  private renderer?: TilesRenderer;
  private disposed = false;
  private started = false;
  private last = -Infinity;
  private readonly duration: number;
  private readonly clock: () => number;
  constructor(private readonly options: TilesFadeOptions = {}) {
    this.duration = options.duration ?? 0.3;
    this.clock = options.clock ?? (() => performance.now() / 1000);
    if (!Number.isFinite(this.duration) || this.duration <= 0)
      throw new RangeError('Tile fade duration must be finite and positive; supply seconds above zero');
  }
  /** Observes a renderer after load, before its first selection update. */
  attach(renderer: TilesRenderer): this {
    if (this.disposed) throw new MargoError('disposed', 'TilesFade is disposed; create a new controller');
    if (this.renderer)
      throw new MargoError('attached', 'TilesFade already has a renderer; create one controller per renderer');
    this.renderer = renderer;
    this.stop = renderer.tileset.on('selection', ({ selected }) => this.select(selected));
    return this;
  }
  /** Registers content while loading. Pass this callback to TilesRenderer.load as decorate. */
  readonly decorate: TilesContentDecorator = async (context) => {
    if (this.disposed) throw new MargoError('disposed', 'TilesFade is disposed; create a new controller');
    const prior = await this.options.decorate?.(context),
      meshes: Binding['meshes'] = [];
    if (this.disposed || context.signal?.aborted) {
      prior?.dispose();
      context.signal?.throwIfAborted();
      throw new MargoError('disposed', 'TilesFade is disposed; create a new controller');
    }
    if (context.kind === 'model' || context.kind === 'instances' || context.kind === 'splats')
      for (const p of (context.model as PBRModel).primitives) {
        const base = p.extension,
          offset = (base?.factors?.length ?? 0) / 4,
          factors = new Float32Array((base?.factors?.length ?? 0) + 4);
        factors.set(base?.factors ?? []);
        factors.set([0, 1, 0, 0], offset * 4);
        const marker = `tileDither${offset}`,
          code = `
// ${marker}
let ${marker}Value=(f32(margoDitherRank(i.clip.xy))+0.5)/16.0;
if(${marker}Value<materialFactors[${offset}].x || ${marker}Value>=materialFactors[${offset}].y){discard;}
`;
        const extension = {
          ...base,
          factors,
          declarations:
            (base?.declarations ?? '') + (base?.declarations?.includes('fn margoDitherRank') ? '' : ditherWGSL),
          wgsl: (base?.wgsl ?? '') + code,
        };
        p.extension = extension;
        meshes.push({ p, base, extension, offset, marker });
      }
    const binding: Binding = {
      context,
      prior,
      meshes,
      set: (lower, upper) => {
        for (const m of meshes) {
          m.extension.factors?.set([lower, upper], m.offset * 4);
          const current = m.p.extension;
          if (current?.wgsl?.includes(m.marker) && current.factors) current.factors.set([lower, upper], m.offset * 4);
        }
        if (context.kind === 'points')
          (context.cloud as { material: { ditherFade?: readonly [number, number] } }).material.ditherFade = [
            lower,
            upper,
          ];
        if (context.kind === 'splats') context.fade(lower, upper);
      },
    };
    let list = this.bindings.get(context.tile);
    if (!list) this.bindings.set(context.tile, (list = new Set()));
    list.add(binding);
    let released = false;
    return {
      get bytes() {
        return (
          (prior?.bytes ?? 0) + meshes.reduce((sum, m) => sum + (m.p.extension?.wgsl?.includes(m.marker) ? 16 : 0), 0)
        );
      },
      dispose: () => {
        if (released) return;
        released = true;
        binding.set(0, 1);
        for (const m of meshes) if (m.p.extension === m.extension) m.p.extension = m.base;
        if (context.kind === 'points')
          (context.cloud as { material: { ditherFade?: readonly [number, number] } }).material.ditherFade = undefined;
        list!.delete(binding);
        if (!list!.size) {
          this.bindings.delete(context.tile);
          this.states.delete(context.tile);
        }
        prior?.dispose();
      },
    };
  };
  private select(selected: readonly TilesetTile[]): void {
    if (this.disposed) return;
    const time = this.clock();
    if (!Number.isFinite(time) || time < this.last)
      throw new RangeError('Tile fade clock must be finite and monotonic; supply advancing seconds');
    this.last = time;
    const wanted = new Set(selected),
      active = new Set<TilesetTile>();
    for (const tile of selected) for (let t: TilesetTile | null = tile; t; t = t.parent) active.add(t);
    const weight = (tile: TilesetTile): number => {
      let state = this.states.get(tile);
      const target = wanted.has(tile) ? 1 : active.has(tile) ? 0 : undefined;
      if (!state) {
        const value = target === undefined ? 1 : !this.started ? target : 1;
        state = { value, from: value, target: target ?? value, time };
        this.states.set(tile, state);
      }
      const evaluate = () =>
        state!.from + (state!.target - state!.from) * Math.min(1, (time - state!.time) / this.duration);
      state.value = evaluate();
      if (target !== undefined && target !== state.target) {
        state.from = state.value;
        state.target = target;
        state.time = time;
      }
      return state.value;
    };
    const visit = (tile: TilesetTile, lower: number, upper: number, ancestorWanted = false) => {
      const relevant = active.has(tile) || (ancestorWanted && this.states.has(tile));
      const own = this.bindings.has(tile),
        value = own && relevant ? weight(tile) : 0;
      if (!relevant) {
        if (tile.renderable) tile.renderable.visible = false;
        for (const child of tile.children) visit(child, 0, 0, false);
        return;
      }
      if (tile.refine === 'ADD') {
        const show = wanted.has(tile);
        for (const b of this.bindings.get(tile) ?? []) b.set(0, 1);
        if (tile.renderable) tile.renderable.visible = show;
        for (const child of tile.children) visit(child, lower, upper, ancestorWanted || wanted.has(tile));
        return;
      }
      const boundary = lower + (upper - lower) * (1 - value),
        show = own && upper > boundary && active.has(this.renderer!.tileset.root);
      for (const b of this.bindings.get(tile) ?? []) b.set(boundary, upper);
      if (tile.renderable) tile.renderable.visible = show;
      for (const child of tile.children) visit(child, lower, boundary, ancestorWanted || wanted.has(tile));
    };
    visit(this.renderer!.tileset.root, 0, active.size ? 1 : 0);
    this.started = true;
  }
  /** Removes the selection observer and restores full content coverage. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stop?.();
    for (const [tile, list] of this.bindings) {
      for (const b of list) {
        b.set(0, 1);
        for (const m of b.meshes) if (m.p.extension === m.extension) m.p.extension = m.base;
        if (b.context.kind === 'points')
          (b.context.cloud as { material: { ditherFade?: readonly [number, number] } }).material.ditherFade = undefined;
      }
      if (tile.renderable) tile.renderable.visible = this.renderer?.last.selected.includes(tile) ?? false;
    }
    this.states.clear();
  }
  [Symbol.dispose](): void {
    this.dispose();
  }
}
export { ditherRank } from '../../shared/screen-door.js';
