// Hidden-line display: a second line that repeats another and draws only where the scene covers it, dashed or faded.
import type { EngineKernel } from '@margoengine/core';
import { Line, type LineMaterialOptions } from './line.js';
import { copyIfChanged } from './math.js';

/** Options for `new HiddenLine(...)`: any `LineMaterial` option except `behind`, `onTop` and `depthWrite`. */
export type HiddenLineOptions = Omit<LineMaterialOptions, 'behind' | 'onTop' | 'depthWrite'>;

/**
 * The hidden part of `source`: the same points, drawn only where something in the scene is in front of them, so an
 * edge behind a surface shows dashed or faded, the standard technical drawing view. Add both lines to a `Lines` plugin.
 * Follows the source's points, mode, matrix, mesh and visibility, and draws while the source is in a plugin.
 * Defaults: the source's colour and width, dashes of 0.1 and gaps of 0.1 world units, opacity 0.5, butt caps and a
 * `depthBias` of 0.001, which is also given to the source when it has none, so edges lying on a surface count as seen.
 * Pass `dashed: false` and a low `opacity` for faded edges. Hidden lines do not pick.
 */
export class HiddenLine extends Line {
  readonly source: Line;
  private seen = -1;

  constructor(source: Line, options: HiddenLineOptions = {}) {
    if (!(source instanceof Line)) throw new TypeError('Expected a Line');
    const { color, width, worldUnits } = source.material;
    super({
      color: [color[0], color[1], color[2]],
      width,
      worldUnits,
      dashed: true,
      dashSize: 0.1,
      gapSize: 0.1,
      opacity: 0.5,
      cap: 'butt',
      depthBias: 0.001,
      ...options,
    });
    this.material.behind = true;
    this.source = source;
    source.material.depthBias ||= this.material.depthBias;
  }

  override update(engine: EngineKernel): boolean | void {
    const { source } = this;
    if (!source.visible || !source.attached || source.update(engine, 0) === false) return false;
    if (source.version !== this.seen) {
      const count = source.count,
        positions = new Float32Array(count * 3);
      for (let i = 0; i < count; i++) {
        positions[i * 3] = source.points[i * 4];
        positions[i * 3 + 1] = source.points[i * 4 + 1];
        positions[i * 3 + 2] = source.points[i * 4 + 2];
      }
      this.setPositions(positions, source.colors ? source.colors.subarray(0, count * 4) : null);
      this.seen = source.version;
    }
    this.mode = source.mode;
    copyIfChanged(this.matrix, source.matrix);
    if (this.attachedMesh !== source.attachedMesh) this.attach(source.attachedMesh);
  }
}
