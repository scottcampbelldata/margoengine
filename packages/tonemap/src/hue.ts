import { Grade, type GradeOptions } from './grade.js';

/** Circular [input hue, offset] control points in degrees. Inputs increase in [0, 360), offsets in [-360, 360]. */
export type HueCurve = readonly (readonly [number, number])[];
/** Live Grade controls plus global and selective hue rotation. */
export interface HueGradeOptions extends GradeOptions {
  /** Global rotation in degrees, -360 to 360. Default 0. */
  hueShift?: number;
  /** One to 64 circular, linearly interpolated hue offsets. Default none. */
  hueHue?: HueCurve;
}

function checkHue(options: HueGradeOptions): void {
  const { hueShift = 0, hueHue } = options;
  if (
    !Number.isFinite(hueShift) ||
    Math.abs(hueShift) > 360 ||
    (hueHue !== undefined &&
      !(
        Array.isArray(hueHue) &&
        hueHue.length >= 1 &&
        hueHue.length <= 64 &&
        hueHue.every(
          (p, i) =>
            Array.isArray(p) &&
            p.length === 2 &&
            Number.isFinite(p[0]) &&
            p[0] >= 0 &&
            p[0] < 360 &&
            Number.isFinite(p[1]) &&
            Math.abs(p[1]) <= 360 &&
            (i === 0 || p[0] > hueHue[i - 1][0]),
        )
      ))
  )
    throw new RangeError(
      'Invalid hue controls; use a finite hueShift in -360..360 and 1..64 increasing [hue, offset] points in [0, 360), [-360, 360].',
    );
}

const hueCode = `
fn shiftGradeHue(c:vec3f)->vec3f {
 let hi=max(c.r,max(c.g,c.b));let lo=min(c.r,min(c.g,c.b));let d=hi-lo;
 if(d==0.0){return c;}
 var h:f32;
 if(hi==c.r){h=(c.g-c.b)/d;}else if(hi==c.g){h=2.0+(c.b-c.r)/d;}else{h=4.0+(c.r-c.g)/d;}
 h=fract(h/6.0+1.0)*360.0;
 let n=i32(grading.hueControl.y);var offset=grading.hueControl.x;
 if(n>0){
  var a=grading.huePoints[n-1].xy-vec2f(360,0);var b=grading.huePoints[0].xy;
  for(var i=0;i<n;i++){let p=grading.huePoints[i].xy;
   if(h>=p.x){a=p;b=grading.huePoints[0].xy+vec2f(360,0);if(i+1<n){b=grading.huePoints[i+1].xy;}}
  }
  offset+=mix(a.y,b.y,(h-a.x)/(b.x-a.x));
 }
 if(offset==0.0){return c;}
 h=fract((h+offset)/360.0+2.0)*6.0;
 let ramp=clamp(abs(fract(h/6.0+vec3f(0,2.0/3.0,1.0/3.0))*6.0-3.0)-1.0,vec3f(0),vec3f(1));
 return lo+d*ramp;
}`;

/**
 * Grade with hue shift and hue-against-hue, after wheels/curves/saturation and before a LUT.
 * Use instead of Grade in Tonemap.extensions. HSV rotation retains channel minimum/maximum and greys.
 * @throws RangeError for invalid Grade or hue controls; correct the options before the next frame.
 */
export class HueGrade extends Grade {
  override readonly key = 'grade-hue';
  private readonly hueBuffer = new Float32Array(20 + 4 * 33 + 4 + 4 * 64);
  constructor(override readonly options: HueGradeOptions = {}) {
    super(options);
    checkHue(options);
  }
  override patch(shader: string, binding: number): string {
    return (
      super
        .patch(shader, binding)
        .replace('curve:array<vec4f,33>}', 'curve:array<vec4f,33>,hueControl:vec4f,huePoints:array<vec4f,64>}')
        .replace('return c+extra;', 'return shiftGradeHue(c)+extra;') + hueCode
    );
  }
  override values(): Float32Array {
    checkHue(this.options);
    const base = super.values(),
      v = this.hueBuffer,
      points = this.options.hueHue ?? [];
    v.set(base);
    v.fill(0, base.length);
    v[base.length] = this.options.hueShift ?? 0;
    v[base.length + 1] = points.length;
    points.forEach((p, i) => v.set(p, base.length + 4 + i * 4));
    return v;
  }
}
