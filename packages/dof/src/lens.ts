import { MargoError } from '@margoengine/math/errors';
import { orthographic } from '../../shared/projection.js';

/** `DOFLens` settings. */
export interface DOFLensOptions {
  /** Aperture blades, 3 to 16: the bokeh becomes this polygon. Fixed at construction. Default: round. */
  blades?: number;
  /** Turn of the bokeh polygon in radians. Fixed at construction. Default 0. */
  bladeRotation?: number;
  /** Tilt of the focal plane in radians, under 1.5 either way; 0 keeps it facing the camera. Default 0. */
  tilt?: number;
  /** Screen direction `[right, up]` in which a positive tilt moves the focal plane further away. Default `[0, 1]`. */
  tiltDirection?: readonly [number, number];
}
/** The shaders a {@link DOFLens} rewrites. */
export interface DOFLensShaders {
  readonly cocShader: string;
  readonly coarseShader: string;
  readonly bokehShader: string;
  readonly groupMax: string;
}

const CIRCLE =
  'let radius=clamp(p.frame.z*select(1.0-p.lens.x/z,(z-p.lens.x)/p.lens.x,ortho),-p.lens.w,p.lens.w)*p.frame.w;';
// The focal plane through the focal point: 1/focus is linear in clip x and y under a perspective camera, and focus itself
// under an orthographic one. p.ortho.yz holds the tilt per clip unit. The thin-lens scale follows the focus at each pixel.
const TILTED = `let n=(vec2f(id.xy)+0.5)/vec2f(textureDimensions(coc))*vec2f(2,-2)+vec2f(-1,1);let t=dot(p.ortho.yz,n);
    let focus=max(select(p.lens.x/max(1.0-t,1e-4),p.lens.x+t,ortho),p.lens.y*1.001);
    let radius=clamp(select(p.frame.z*(p.lens.x-p.lens.y)/(focus-p.lens.y)*(1.0-focus/z),p.frame.z*(z-focus)/p.lens.x,ortho),-p.lens.w,p.lens.w)*p.frame.w;`;

function edit(source: string, edits: readonly [string, string][]): string {
  return edits.reduce((code, [from, to]) => {
    if (code.split(from).length !== 2)
      throw new MargoError('unsupported', 'DOFLens needs the DOF shaders of its own version; update both together');
    return code.replace(from, to);
  }, source);
}

/**
 * Lens shape for `DOF`: a tilted focal plane (tilt-shift) and polygon bokeh from aperture blades. Pass one as
 * `DOF.attach(engine, {lens})`. `tilt` and `tiltDirection` are read every frame.
 * @throws RangeError when an option is out of range.
 */
export class DOFLens {
  /** See {@link DOFLensOptions.tilt}. */
  tilt: number;
  /** See {@link DOFLensOptions.tiltDirection}. */
  tiltDirection: readonly [number, number];
  private readonly blades?: number;
  private readonly bladeRotation: number;

  constructor({ blades, bladeRotation = 0, tilt = 0, tiltDirection = [0, 1] }: DOFLensOptions = {}) {
    if (blades !== undefined && (!Number.isInteger(blades) || blades < 3 || blades > 16))
      throw new RangeError('Invalid DOFLens blades; use a whole number from 3 to 16');
    if (!Number.isFinite(bladeRotation)) throw new RangeError('Invalid DOFLens bladeRotation; use finite radians');
    this.blades = blades;
    this.bladeRotation = bladeRotation;
    this.tilt = tilt;
    this.tiltDirection = tiltDirection;
    this.check();
  }
  private check(): void {
    const [x, y] = this.tiltDirection;
    if (!(Math.abs(this.tilt) < 1.5) || !Number.isFinite(x) || !Number.isFinite(y) || !(x || y))
      throw new RangeError('Invalid DOFLens tilt; use radians under 1.5 either way and a non-zero tiltDirection');
  }
  /** The DOF kernels rewritten for this lens. Called by `DOF` when it builds its pipelines. */
  shaders(source: DOFLensShaders): DOFLensShaders {
    const out = { ...source, cocShader: edit(source.cocShader, [[CIRCLE, TILTED]]) };
    const n = this.blades;
    if (n === undefined) return out;
    // Scaling each tap by the polygon's boundary at its angle keeps the taps uniform over the polygon.
    const sector = (2 * Math.PI) / n,
      inner = Math.cos(Math.PI / n),
      shape = `fn shape(a:f32)->f32 {let m=a-${this.bladeRotation};return ${inner}/cos(m-${sector}*floor(m/${sector})-${sector / 2});}
fn spiral(i:u32,n:f32)->vec2f {`,
      taps: [string, string][] = [
        ['fn spiral(i:u32,n:f32)->vec2f {', shape],
        ['return sqrt((f32(i)+0.5)/n)*vec2f', 'return sqrt((f32(i)+0.5)/n)*shape(angle)*vec2f'],
      ];
    out.coarseShader = edit(source.coarseShader, taps);
    out.bokehShader = edit(source.bokehShader, [
      ...taps,
      // The near gather's reach and its reach test follow the polygon: its taps lie closer, down to the inner circle.
      ['pow((nearMax+1.0)/p.lens.w,2.0)', `pow((nearMax+1.0)/(p.lens.w*${inner}),2.0)`],
      ['length(vec2f(nearOffset))<=radius', 'length(vec2f(nearOffset))<=radius*shape(f32(i)*2.39996323)'],
    ]);
    return out;
  }
  /** Writes the tilt per clip unit into the free uniform slots 9 and 10. Called by `DOF` every frame. */
  write(
    values: Float32Array,
    camera: { fov: number; matrix: Float32Array; position: ArrayLike<number> },
    aspect: number,
  ): void {
    this.check();
    const [x, y] = this.tiltDirection,
      slope = Math.tan(this.tilt) / Math.hypot(x, y),
      ortho = orthographic(camera.matrix, camera.position),
      half = Math.tan((camera.fov * Math.PI) / 360);
    values[9] = slope * x * (ortho ? 1 / ortho.sx : half * aspect);
    values[10] = slope * y * (ortho ? 1 / ortho.sy : half);
  }
}
