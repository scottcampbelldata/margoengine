export function finite(values: ArrayLike<number>, size: number, label: string): void {
  if (values.length !== size) throw new TypeError(`${label} needs ${size} values`);
  for (let i = 0; i < size; i++) {const value=values[i];if (typeof value !== 'number' || !Number.isFinite(Math.fround(value))) throw new RangeError(`${label} must be finite Float32 values`);}
}

export class Geometry {
  readonly vertices: Float32Array;
  readonly indices: Uint32Array;
  readonly bounds: Float32Array;

  constructor(positions: ArrayLike<number>, normals: ArrayLike<number>, indices: ArrayLike<number>) {
    const count = positions.length/3;
    if (!Number.isInteger(count) || count < 3 || count > 1_000_000 || !indices.length || indices.length % 3) throw new RangeError('Expected bounded triangle geometry');
    finite(positions, count*3, 'Positions'); finite(normals, count*3, 'Normals');
    for (let i = 0; i < indices.length; i++) if (!Number.isInteger(indices[i]) || indices[i] < 0 || indices[i] >= count) throw new RangeError('Index exceeds vertices');
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
  finite([width,height,depth],3,'Box size');
  if (Math.min(width,height,depth) <= 0) throw new RangeError('Box size must be positive');
  const positions: number[] = [], normals: number[] = [], indices: number[] = [];
  for (let axis = 0; axis < 3; axis++) for (const side of [-1,1]) {
    const start = positions.length/3, u = (axis+1)%3, v = (axis+2)%3;
    for (const [a,b] of [[-1,-1],[1,-1],[1,1],[-1,1]]) {
      const p = [0,0,0], n = [0,0,0]; p[axis]=side; p[u]=a; p[v]=b; n[axis]=side;
      positions.push(p[0]*width/2,p[1]*height/2,p[2]*depth/2); normals.push(...n);
    }
    indices.push(...(side > 0 ? [0,1,2,0,2,3] : [0,2,1,0,3,2]).map(i => start+i));
  }
  return new Geometry(positions,normals,indices);
}

export class PbrMaterial {
  readonly data = new Float32Array(8);
  constructor({color = '#4f46e5', roughness = 0.5, metalness = 0, doubleSided=true}: {color?: string|readonly number[]; roughness?: number; metalness?: number;doubleSided?:boolean} = {}) {
    const rgb = typeof color === 'string' ? /^#[0-9a-f]{6}$/i.test(color) ? [1,3,5].map(i => parseInt(color.slice(i,i+2),16)/255).map(v => v <= 0.04045 ? v/12.92 : ((v+0.055)/1.055)**2.4) : null : color;
    if (!rgb) throw new TypeError('Color must be #rrggbb or linear RGB');
    finite(rgb,3,'Color');
    if ([...rgb,roughness,metalness].some(v => !Number.isFinite(v) || v < 0 || v > 1)) throw new RangeError('Material values must be in [0,1]');
    if(typeof doubleSided!=='boolean')throw new TypeError('doubleSided must be boolean');
    this.data.set([...rgb,1,Math.max(0.045,roughness),metalness,+doubleSided,0]);
  }
}
