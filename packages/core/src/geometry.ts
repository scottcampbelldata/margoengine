export function finite(values: ArrayLike<number>, size: number, label: string): void {
  if (values.length !== size) throw new TypeError(`${label}: ${size} values`);
  for (let i = 0; i < size; i++) {const value=values[i];if (typeof value !== 'number' || !Number.isFinite(Math.fround(value))) throw new RangeError(`${label}: finite values`);}
}

export class Geometry {
  readonly vertices: Float32Array;
  readonly indices: Uint32Array;
  readonly bounds: Float32Array;

  constructor(positions: ArrayLike<number>, normals: ArrayLike<number>, indices: ArrayLike<number>) {
    const count = positions.length/3;
    if (!Number.isInteger(count) || count < 3 || count > 1_000_000 || !indices.length || indices.length % 3) throw new RangeError('Invalid geometry');
    finite(positions, count*3, 'Positions'); finite(normals, count*3, 'Normals');
    for (let i = 0; i < indices.length; i++) if (!Number.isInteger(indices[i]) || indices[i] < 0 || indices[i] >= count) throw new RangeError('Invalid geometry');
    this.vertices = new Float32Array(count*6);
    const min = [Infinity,Infinity,Infinity], max = [-Infinity,-Infinity,-Infinity];
    for (let i = 0; i < count; i++) for (let a = 0; a < 3; a++) {
      this.vertices[i*6+a] = positions[i*3+a]; this.vertices[i*6+3+a] = normals[i*3+a];
      min[a] = Math.min(min[a],positions[i*3+a]); max[a] = Math.max(max[a],positions[i*3+a]);
    }
    this.indices = Uint32Array.from(indices);
    const center = min.map((v,a) => (v+max[a])/2);
    let radius = 0;
    for (let i = 0; i < count; i++) radius = Math.max(radius, Math.hypot(positions[i*3]-center[0],positions[i*3+1]-center[1],positions[i*3+2]-center[2]));
    this.bounds = new Float32Array([...center,radius]); finite(this.bounds,4,'Bounds');
  }
}

export function box(width = 1, height = 1, depth = 1): Geometry {
  const size=[width,height,depth];finite(size,3,'Box size');
  if (Math.min(width,height,depth) <= 0) throw new RangeError('Box size: positive');
  const positions: number[] = [], normals: number[] = [], indices: number[] = [];
  for (let axis = 0; axis < 3; axis++) for (const side of [-1,1]) {
    const start = positions.length/3, u = (axis+1)%3;
    for (const [a,b] of [[-1,-1],[1,-1],[1,1],[-1,1]]) {
      for(let component=0;component<3;component++){
        positions.push((component===axis?side:component===u?a:b)*size[component]/2);normals.push(component===axis?side:0);
      }
    }
    for(const i of side > 0 ? [0,1,2,0,2,3] : [0,2,1,0,3,2])indices.push(start+i);
  }
  return new Geometry(positions,normals,indices);
}

export class PbrMaterial {
  readonly data = new Float32Array([0,0,0,1,0.5,0,1,0]);
  constructor(options: PbrMaterialOptions = {}) {this.set({...options,color:options.color??'#4f46e5'});}
  /** Changes values in place; omitted ones keep their value. The next frame re-uploads instances (no new material, pipeline or bind group). */
  set({color = this.data.slice(0,3) as unknown as number[], roughness = this.data[4], metalness = this.data[5], doubleSided=!!this.data[6]}: PbrMaterialOptions):void {
    const rgb = typeof color === 'string' ? /^#[0-9a-f]{6}$/i.test(color) ? [1,3,5].map(i => {const v=parseInt(color.slice(i,i+2),16)/255;return v <= 0.04045 ? v/12.92 : ((v+0.055)/1.055)**2.4;}) : null : color;
    if (!rgb) throw new TypeError('Invalid Color');
    finite(rgb,3,'Color');
    if ([...rgb,roughness,metalness].some(v => !Number.isFinite(v) || v < 0 || v > 1)) throw new RangeError('Invalid material');
    if(typeof doubleSided!=='boolean')throw new TypeError('Invalid material');
    this.data.set([...rgb,1,Math.max(0.045,roughness),metalness,+doubleSided]);
  }
}
/** `color`: '#rrggbb' (sRGB) or linear [r, g, b] in 0..1. */
export interface PbrMaterialOptions {color?: string|readonly number[]; roughness?: number; metalness?: number; doubleSided?: boolean}
