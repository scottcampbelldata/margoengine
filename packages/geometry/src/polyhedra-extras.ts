import { geometryData, type GeometryData, type GeometryGroup } from './data.js';
import { icosahedronGeometry } from './polyhedra.js';
import { convexGeometry } from './convex.js';
import { sphereGeometry } from './primitives.js';
import type { MutableVec3 } from './math.js';

/** Icosahedral triangular-lattice parameters; both chiralities are accepted. */
export interface GeodesicOptions {
  /** Lattice steps on the first axis. Default 1; integer >= 0, m+n must be positive. */
  m?: number;
  /** Lattice steps on the second 60 degree axis. Default 0; integer >= 0. */
  n?: number;
  /** Circumradius, positive and finite. Default 1. */
  radius?: number;
  /** Smooth radial normals instead of one normal per triangle. Default false. */
  smooth?: boolean;
}
/** Face-addressable polyhedron. Faces reference output vertices, and groups have the same face order. */
export interface PolyhedronGeometryData extends GeometryData {
  faces: number[][];
  adjacentFaces: number[][];
  faceCenters: MutableVec3[];
  faceNormals: MutableVec3[];
}
const unit = (p: readonly number[]): MutableVec3 => { const l = Math.hypot(...p); return p.map(x => x / l) as MutableVec3; };
const cross = (a: readonly number[], b: readonly number[]): MutableVec3 => [a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const dot = (a: readonly number[], b: readonly number[]) => a.reduce((s,x,i) => s+x*b[i],0);
const sub = (a: readonly number[], b: readonly number[]) => a.map((x,i) => x-b[i]);
function positive(x: number, label: string): void { if (!(x > 0 && Number.isFinite(x))) throw new RangeError(`Invalid ${label}; pass a finite positive value`); }

function lattice(options: GeodesicOptions): {points: MutableVec3[]; triangles: number[][]} {
  const {m=1,n=0} = options;
  if (!Number.isInteger(m) || !Number.isInteger(n) || m<0 || n<0 || m+n===0)
    throw new RangeError('Invalid lattice; pass nonnegative integers m,n with m+n > 0');
  const T=m*m+m*n+n*n;
  if (T>10000) throw new RangeError('Lattice exceeds 100002 vertices; reduce m or n');
  const base=icosahedronGeometry(1,0,true), candidates: MutableVec3[]=[];
  for(let f=0;f<base.indices.length;f+=3) {
    const [a,b,c]=[...base.indices.slice(f,f+3)].map(i=>[...base.positions.slice(i*3,i*3+3)]);
    for(let x=-n;x<=m;x++) for(let y=0;y<=m+n;y++) {
      const B=(m+n)*x+n*y, C=-n*x+m*y;
      if(B<0||C<0||B+C>T)continue;
      candidates.push(unit(a.map((v,k)=>(v*(T-B-C)+b[k]*B+c[k]*C)/T)));
    }
  }
  // The convex hull supplies spherical Delaunay connectivity, including triangles crossing primary-face seams.
  const hull=convexGeometry(candidates), points: MutableVec3[]=[], ids=new Map<string,number>(), remap: number[]=[];
  for(let i=0;i<hull.positions.length;i+=3) {
    const p=[...hull.positions.slice(i,i+3)] as MutableVec3,key=p.join(',');
    if(!ids.has(key)){ids.set(key,points.length);points.push(p);}
    remap.push(ids.get(key)!);
  }
  const triangles: number[][]=[];
  for(let t=0;t<hull.indices.length;t+=3)triangles.push([...hull.indices.slice(t,t+3)].map(i=>remap[i]));
  return {points,triangles};
}

function output(points: MutableVec3[], faces: number[][], radius: number, smooth=false): PolyhedronGeometryData {
  positive(radius,'radius');
  const positions: number[]=[],normals: number[]=[],uvs: number[]=[],indices: number[]=[],groups: GeometryGroup[]=[],
    faceCenters: MutableVec3[]=[],faceNormals: MutableVec3[]=[],outFaces: number[][]=[],adjacentFaces: number[][]=faces.map(()=>[]),edgeFace=new Map<string,number>();
  faces.forEach((face,f)=>{
    const center=face.reduce((a,id)=>a.map((v,k)=>v+points[id][k]/face.length) as MutableVec3,[0,0,0] as MutableVec3),
      normal=unit(cross(sub(points[face[1]],points[face[0]]),sub(points[face[2]],points[face[0]]))),
      x=unit(sub(points[face[0]],center)), y=cross(normal,x),extent=Math.max(...face.map(id=>Math.hypot(...sub(points[id],center)))),
      first=positions.length/3,start=indices.length;
    faceCenters.push(center.map(v=>v*radius) as MutableVec3);faceNormals.push(normal);
    for(let j=0;j<face.length;j++) {
      const id=face[j],p=points[id],q=sub(p,center),next=face[(j+1)%face.length],key=id<next?`${id},${next}`:`${next},${id}`,other=edgeFace.get(key);
      if(other===undefined)edgeFace.set(key,f);else{adjacentFaces[f].push(other);adjacentFaces[other].push(f);}
      positions.push(...p.map(v=>v*radius));normals.push(...(smooth?unit(p):normal));
      uvs.push(.5+dot(q,x)/(2*extent),.5+dot(q,y)/(2*extent));
    }
    for(let j=1;j<face.length-1;j++)indices.push(first,first+j,first+j+1);
    groups.push({start,count:indices.length-start,materialIndex:f});outFaces.push(face.map((_,j)=>first+j));
  });
  return {...geometryData(positions,normals,uvs,indices,groups),faces:outFaces,adjacentFaces,faceCenters,faceNormals};
}

/** Icosahedral geodesic sphere GD(m,n), including classes I, II and III. T=m*m+m*n+n*n, F=20*T. */
export function geodesicGeometry(options: GeodesicOptions = {}): PolyhedronGeometryData {
  const {points,triangles}=lattice(options);
  return output(points,triangles,options.radius??1,options.smooth??false);
}

/** Spherical Goldberg dual GP(m,n), with 12 pentagons first and 10*(T-1) hexagons. Face groups support per-face materials. */
export function goldbergGeometry(options: GeodesicOptions = {}): PolyhedronGeometryData {
  const {points,triangles}=lattice(options),dual=triangles.map(t=>unit(t.reduce((a,id)=>a.map((x,k)=>x+points[id][k]) as MutableVec3,[0,0,0] as MutableVec3))),
    incident: number[][]=points.map(()=>[]);
  triangles.forEach((t,f)=>t.forEach(v=>incident[v].push(f)));
  const faces=incident.map((list,id)=>{
    const normal=unit(points[id]),x=unit(sub(dual[list[0]],points[id])),y=cross(normal,x);
    return list.sort((a,b)=>Math.atan2(dot(dual[a],y),dot(dual[a],x))-Math.atan2(dot(dual[b],y),dot(dual[b],x)));
  }).sort((a,b)=>a.length-b.length);
  return output(dual,faces,options.radius??1,options.smooth??false);
}

/** Northern hemisphere on +y, with an optional flat downward-facing equatorial cap (default true). */
export function hemisphereGeometry(radius=1, segments=32, rings=16, cap=true): GeometryData {
  positive(radius,'radius');
  if(!Number.isInteger(segments)||segments<3||!Number.isInteger(rings)||rings<2)
    throw new RangeError('Invalid hemisphere resolution; pass segments >= 3 and rings >= 2');
  const sphere=sphereGeometry(radius,segments,rings,0,Math.PI*2,0,Math.PI/2);
  if(!cap)return sphere;
  const p=[...sphere.positions],n=[...sphere.normals],uv=[...sphere.uvs],ix=[...sphere.indices],base=p.length/3;
  p.push(0,0,0);n.push(0,-1,0);uv.push(.5,.5);
  for(let i=0;i<=segments;i++) {
    const angle=i/segments*Math.PI*2,x=-Math.cos(angle)*radius,z=Math.sin(angle)*radius;
    p.push(x,0,z);n.push(0,-1,0);uv.push(.5+x/(2*radius),.5+z/(2*radius));
    if(i)ix.push(base,base+i+1,base+i);
  }
  return geometryData(p,n,uv,ix,[{start:0,count:sphere.indices.length,materialIndex:0},{start:sphere.indices.length,count:segments*3,materialIndex:1}]);
}
