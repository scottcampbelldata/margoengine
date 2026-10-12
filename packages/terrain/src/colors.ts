import type {EngineKernel, Mesh} from '@margoengine/core';
import {engineRuntime, meshRuntime, type Engine, type EnginePlugin, type FrameGraph} from '@margoengine/core/extension';

type Color = readonly [number, number, number];
type Range = readonly [number, number];
export interface TerrainColorOptions {
  sand: Color; meadow: readonly [Color, Color]; stone: Color;
  shore: Range; meadowHeight: Range; stoneHeight: Range; stoneNormal: Range;
  wetHeight: Range; wetDarkening: number; variation?: number;
}
let serial = 0;

/** Height/slope colors on one ordinary mesh, preserving the scene's PBR and shadow shader. */
export class TerrainColors implements EnginePlugin {
  readonly name = 'terrain:colors:' + ++serial;
  private engine?: Engine;
  private source = '';
  private shader = '';
  private disposed = false;
  private readonly colorCode: string;
  constructor(private readonly mesh: Mesh, options: TerrainColorOptions) {
    if (options.meadow.length !== 2) throw new RangeError('Expected two meadow colors');
    for (const color of [options.sand,...options.meadow,options.stone]) if (color.length !== 3 || color.some(v => !Number.isFinite(v) || v < 0 || v > 1)) throw new RangeError('Invalid terrain color');
    for (const range of [options.shore,options.meadowHeight,options.stoneHeight,options.stoneNormal,options.wetHeight]) if (range.length !== 2 || !range.every(v => Number.isFinite(Math.fround(v))) || range[0] >= range[1]) throw new RangeError('Invalid terrain color range');
    if (options.stoneNormal[0] < 0 || options.stoneNormal[1] > 1 || !Number.isFinite(options.wetDarkening) || options.wetDarkening < 0 || options.wetDarkening > 1 || !Number.isFinite(options.variation ?? 0) || (options.variation ?? 0) < 0 || (options.variation ?? 0) > 1) throw new RangeError('Invalid terrain wetness or variation');
    const rgb = (color: Color) => `vec3f(${color.join(',')})`;
    const variation = options.variation ?? 0;
    this.colorCode = `
      let h=p.y;let slope=normalize(o.normal).y;
      let variation=${1-variation}+${variation}*sin(p.x*0.8)*cos(p.z*0.6);
      let meadow=mix(${rgb(options.meadow[0])},${rgb(options.meadow[1])},smoothstep(${options.meadowHeight.join(',')},h));
      let stone=mix(meadow,${rgb(options.stone)},max(smoothstep(${options.stoneHeight.join(',')},h),1.0-smoothstep(${options.stoneNormal.join(',')},slope)));
      let wet=mix(${options.wetDarkening},1.0,smoothstep(${options.wetHeight.join(',')},h));
      o.color=mix(${rgb(options.sand)},stone,smoothstep(${options.shore.join(',')},h))*variation*wet;`;
  }
  static attach(engine: EngineKernel, mesh: Mesh, options: TerrainColorOptions): TerrainColors {
    const colors = new TerrainColors(mesh, options); engineRuntime(engine).use(colors); return colors;
  }
  setup(engine: Engine): void {
    const mesh = meshRuntime(this.mesh); mesh.check();
    if (this.engine || this.disposed || mesh.engine !== engine) throw new Error('Terrain color mesh belongs to another engine or is already attached');
    this.engine = engine;
  }
  registerPasses(graph: FrameGraph): void {
    graph.add({name: this.name, order: -4, execute: c => {
      if (c.backend !== 'webgpu') return;
      const mesh = meshRuntime(this.mesh); mesh.check();
      if (this.source !== c.shader) {
        this.source = c.shader;
        this.shader = c.shader.replace('o.color=i.color.rgb;', `o.color=i.color.rgb;if(i.factors.w==${mesh.id}.0){${this.colorCode}}`);
      }
      c.shader = this.shader;
    }});
  }
  dispose(): void {if (this.disposed) return; this.disposed = true; const engine = this.engine; this.engine = undefined; engine?.removePlugin(this.name);}
}
