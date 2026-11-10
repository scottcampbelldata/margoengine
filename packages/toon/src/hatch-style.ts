/** Shared core/model hatching options; each is live as the property of the same name. */
export interface HatchingOptions {
  /** `'hatch'`: pen strokes, a layer more for each step darker; `'halftone'`: one dot a cell. Default `'hatch'`. */
  style?: 'hatch' | 'halftone';
  /** Line or dot spacing in screen pixels, 2-64. Default 8. */
  spacing?: number;
  /** Stroke width in screen pixels for `'hatch'`, 0.5 up to `spacing`. Default 1.5. */
  width?: number;
  /** Stroke layers for `'hatch'`, an integer 1-4, each turned 180 / layers degrees from the last. Default 3. */
  layers?: number;
  /** Angle of the first strokes (or of the dot grid) in degrees. Default 45. */
  angle?: number;
  /** Ink colour, linear RGB 0..1, drawn unlit over the surface. Default [0, 0, 0]. */
  ink?: readonly [number, number, number];
}

// Halftone: the dot's share of its cell is c = 1 - light. Up to pi/4 the dot is a whole disc (r = sqrt(c / pi)); past it
// the cell's sides cut four circular segments off, so r is found by bisection from that clipped area, which grows
// monotonically on [0.5, sqrt(0.5)].
/** WGSL pattern with a selectable binding group. Shape, angle and ink occupy three vec4 uniform rows. */
export const hatchWGSL = (binding: number, group = 0): string => `struct Hatch {shape:vec4f,angle:vec4f,ink:vec4f}
@group(${group}) @binding(${binding}) var<uniform> hatch:Hatch;
fn hatchInk(pixel:vec2f,light:f32)->f32{
  let s=hatch.shape.y;
  if(hatch.shape.x>0.5){
    let a=hatch.angle.x;let r=mat2x2f(cos(a),sin(a),-sin(a),cos(a))*pixel/s;let d=length(fract(r)-0.5)*s;
    let c=clamp(1.0-light,0.0,1.0);
    if(c>=1.0){return 1.0;}
    var cell=sqrt(c/3.14159265);
    if(c>0.78539816){
      var lo=0.5;var hi=0.70710678;
      for(var k=0;k<20;k++){let m=0.5*(lo+hi);let q=m*m;if(3.14159265*q-4.0*(q*acos(0.5/m)-0.5*sqrt(q-0.25))<c){lo=m;}else{hi=m;}}
      cell=0.5*(lo+hi);
    }
    let radius=s*cell;
    return clamp(radius-d+0.5,0.0,1.0);
  }
  let n=hatch.shape.w;var ink=0.0;
  for(var k=0.0;k<n;k+=1.0){
    if(light>=(n-k)/(n+1.0)){break;}
    let a=hatch.angle.x+k*3.14159265/n;let t=dot(pixel,vec2f(cos(a),sin(a)))/s;let d=abs(fract(t)-0.5)*s;
    ink=max(ink,clamp(hatch.shape.z*0.5-d+0.5,0.0,1.0));
  }
  return ink;
}
`;

function checked(o: Required<HatchingOptions>): void {
  if (o.style !== 'hatch' && o.style !== 'halftone')
    throw new RangeError("Hatching style must be 'hatch' or 'halftone'");
  if (
    !Number.isFinite(o.spacing) ||
    o.spacing < 2 ||
    o.spacing > 64 ||
    !Number.isFinite(o.width) ||
    o.width < 0.5 ||
    o.width > o.spacing ||
    !Number.isSafeInteger(o.layers) ||
    o.layers < 1 ||
    o.layers > 4 ||
    !Number.isFinite(o.angle) ||
    !Array.isArray(o.ink) ||
    o.ink.length !== 3 ||
    o.ink.some((v) => typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1)
  )
    throw new RangeError(
      'Invalid Hatching options; use spacing 2-64 px, width 0.5 px to spacing, integer layers 1-4, a finite angle and ink RGB 0..1',
    );
}

/** Shared validated, live pattern controls for core and model renderers. */
export class HatchStyle {
  private options: Required<HatchingOptions>;
  private readonly values = new Float32Array(12);
  constructor({
    style = 'hatch',
    spacing = 8,
    width = 1.5,
    layers = 3,
    angle = 45,
    ink = [0, 0, 0],
  }: HatchingOptions = {}) {
    this.options = { style, spacing, width, layers, angle, ink: [ink[0], ink[1], ink[2]] };
    checked({ ...this.options, ink });
  }
  /** Sets any of the options; the others keep their values. @throws RangeError as the constructor. */
  set(options: HatchingOptions): void {
    const next = { ...this.options, ...options };
    checked(next);
    this.options = { ...next, ink: [next.ink[0], next.ink[1], next.ink[2]] };
  }
  get style(): 'hatch' | 'halftone' {
    return this.options.style;
  }
  set style(style: 'hatch' | 'halftone') {
    this.set({ style });
  }
  get spacing(): number {
    return this.options.spacing;
  }
  set spacing(spacing: number) {
    this.set({ spacing });
  }
  get width(): number {
    return this.options.width;
  }
  set width(width: number) {
    this.set({ width });
  }
  get layers(): number {
    return this.options.layers;
  }
  set layers(layers: number) {
    this.set({ layers });
  }
  get angle(): number {
    return this.options.angle;
  }
  set angle(angle: number) {
    this.set({ angle });
  }
  get ink(): readonly [number, number, number] {
    return this.options.ink;
  }
  set ink(ink: readonly [number, number, number]) {
    this.set({ ink });
  }
  /** Current validated pattern parameters, packed for either renderer. */
  protected hatchValues(): Float32Array {
    const o = this.options;
    this.values.set([
      +(o.style === 'halftone'),
      o.spacing,
      o.width,
      o.layers,
      (o.angle * Math.PI) / 180,
      0,
      0,
      0,
      ...o.ink,
      0,
    ]);
    return this.values;
  }
}
