import type { Polygon, PolygonCap, PolygonJoin } from '@margoengine/geometry/polygon';
import type { JunctionRoad, JunctionMesh } from './junctions.js';
import { bounded, designError, DesignMesh, type Point3 } from './design-mesh.js';

/** All dimensions are metres. The shared height field makes at-grade crossing heights agree. */
export interface IntersectionOptions {
  /** Boundary join. Default round. */
  join?: PolygonJoin;
  /** Road end style. Default round. */
  cap?: PolygonCap;
  /** Miter ratio before bevel fallback. Default 4. */
  miterLimit?: number;
  /** Circular curb-return radius at concave corners. Default 2; 0 keeps sharp corners. */
  turnRadius?: number;
  /** Largest circular arc chord error, metres. Default 0.02. */
  arcTolerance?: number;
  /** Constant height or shared ground height(x,z). Default 0. Evaluated at triangulation vertices. */
  elevation?: number | ((x:number,z:number)=>number);
  /** Width outside the road. Default 0.2. */
  curbWidth?: number;
  /** Height above road/ground. Default 0.15. */
  curbHeight?: number;
  /** Width beyond curb. Default 1.8; 0 omits sidewalk. */
  sidewalkWidth?: number;
  /** Metres per planar UV repeat. Default 1. */
  uvMeters?: number;
  /** Checked around lazy loading and before return. Default none. */
  signal?: AbortSignal;
}
/** CPU design layers with independent mesh ownership. */
export interface IntersectionMesh extends JunctionMesh {
  /** Separate curb top and vertical road-facing riser, or null when curbWidth is zero. */
  curb: JunctionMesh | null;
  /** Raised sidewalk outside the curb, or null when sidewalkWidth is zero. */
  sidewalk: JunctionMesh | null;
  /** Caller-owned road footprint, coordinates [x,-z], including courtyard holes. */
  footprint: Polygon[];
}

// Circular fillets tangent to both incident edges. Only reentrant corners are
// changed: convex joins and caps are already authored by polygonStroke.
function returns(ring: [number,number][], radius: number, tolerance: number): [number,number][] {
  const corners = ring.map((b,i) => {
    const a=ring[(i+ring.length-1)%ring.length], c=ring[(i+1)%ring.length];
    const l=Math.hypot(b[0]-a[0],b[1]-a[1]), m=Math.hypot(c[0]-b[0],c[1]-b[1]);
    const u=[(b[0]-a[0])/l,(b[1]-a[1])/l], v=[(c[0]-b[0])/m,(c[1]-b[1])/m];
    const turn=Math.atan2(u[0]*v[1]-u[1]*v[0],u[0]*v[0]+u[1]*v[1]);
    const d=turn < -1e-7 ? radius*Math.tan(-turn/2) : 0;
    return {b,u,v,turn,d,l,m};
  });
  return corners.flatMap(({b,u,v,turn,d,l,m},i) => {
    if (!d) return [[...b] as [number,number]];
    if (d+corners[(i+corners.length-1)%corners.length].d>l || d+corners[(i+1)%corners.length].d>m)
      throw designError('Turn radius does not fit adjacent edges; lengthen approaches or reduce turnRadius');
    const start=[b[0]-u[0]*d,b[1]-u[1]*d], center=[start[0]+u[1]*radius,start[1]-u[0]*radius];
    const angle=Math.atan2(start[1]-center[1],start[0]-center[0]);
    const steps=Math.ceil(-turn/(2*Math.acos(Math.max(-1,1-tolerance/radius))));
    if (steps>4096) throw designError('Curb arc needs over 4096 segments; increase arcTolerance');
    return Array.from({length:Math.max(1,steps)+1},(_,k):[number,number] => {
      if(k===0)return [start[0],start[1]];
      if(k===Math.max(1,steps))return [b[0]+v[0]*d,b[1]+v[1]*d];
      const t=angle+turn*k/Math.max(1,steps); return [center[0]+radius*Math.cos(t),center[1]+radius*Math.sin(t)];
    });
  });
}

/** Unite road footprints, design curb returns, and lift road, curbs and sidewalks onto shared sloping ground. */
export async function intersections(roads: readonly JunctionRoad[], options: IntersectionOptions = {}): Promise<IntersectionMesh> {
  const {join='round',cap='round',miterLimit=4,turnRadius=2,arcTolerance=0.02,elevation=0,curbWidth=0.2,curbHeight=0.15,sidewalkWidth=1.8,uvMeters=1,signal}=options;
  signal?.throwIfAborted();
  if (!['round','miter','bevel'].includes(join) || !['round','butt','square'].includes(cap) ||
      !bounded(miterLimit,1,100) || !bounded(turnRadius,0,1000) || !bounded(arcTolerance,1e-6,100) ||
      !bounded(curbWidth,0,100) || !bounded(curbHeight,0.001,10) || !bounded(sidewalkWidth,0,100) ||
      !bounded(uvMeters,1e-30,1e6) || (typeof elevation!=='function' && !bounded(elevation,-1e6,1e6)) ||
      !Array.isArray(roads) || !roads.length || roads.length>64) throw designError('Invalid intersection options; use bounded metre dimensions and 1..64 roads');
  let count=0;
  const checked=roads.map(r=>{
    const width=r?.width??6;
    if (!bounded(width,1e-6,1000) || !Array.isArray(r?.points) || r.points.length<2 || (count+=r.points.length)>4096)
      throw designError('Intersection roads need positive widths and 2..4096 points, 4096 total');
    const points=r.points.map((p:readonly [number,number],i:number):[number,number]=>{
      if (!Array.isArray(p)||p.length!==2||!p.every(v=>bounded(v,-1e6,1e6)) || (i>0 && p[0]===r.points[i-1][0] && p[1]===r.points[i-1][1]))
        throw designError('Intersection points need finite distinct neighbouring [x,z] pairs');
      return [p[0],-p[1]];
    }); return {points,width};
  });
  const [{polygonStroke,polygonUnion,polygonOffset,polygonDifference,polygonShapes,polygonArea},{shapeGeometry}]=await Promise.all([import('@margoengine/geometry/polygon'),import('@margoengine/geometry/extrude')]);
  signal?.throwIfAborted();
  let footprint=polygonUnion(checked.map(r=>polygonStroke(r.points,r.width,{join,cap,miterLimit,arcTolerance})));
  if(turnRadius) footprint=polygonUnion(footprint.map(p=>({contour:returns(p.contour,turnRadius,arcTolerance),holes:p.holes.map(h=>returns(h,turnRadius,arcTolerance))})));
  if(!footprint.length)throw designError('Intersection footprint vanished; increase road width or use a local origin');
  // Round boundaries before triangulation, exactly as the renderer stores them.
  const rounded=(polygons:Polygon[]) => polygons.map(p=>({contour:p.contour.map(q=>q.map(Math.fround) as [number,number]), holes:p.holes.map(h=>h.map(q=>q.map(Math.fround) as [number,number]))}));
  footprint=rounded(footprint);
  const height=(x:number,z:number,raise:number):Point3=>[x,(typeof elevation==='function'?elevation(x,z):elevation)+raise,z];
  const mesh=(polygons:Polygon[],raise:number,walls=false):JunctionMesh=>{
    const builder=new DesignMesh(), regions=rounded(polygons);
    const data=shapeGeometry(polygonShapes(regions));
    for(let i=0;i<data.indices.length;i+=3){
      const v=Array.from(data.indices.subarray(i,i+3),j=>height(data.positions[j*3],-data.positions[j*3+1],raise));
      builder.triangle(v[0],v[1],v[2]);
    }
    if(walls) for(const p of footprint)for(const ring of [p.contour,...p.holes])for(let i=0;i<ring.length;i++){
      const a=ring[i],b=ring[(i+1)%ring.length];
      builder.quad(height(a[0],-a[1],0),height(a[0],-a[1],raise),height(b[0],-b[1],raise),height(b[0],-b[1],0));
    }
    return {...builder.finish(uvMeters),area:polygonArea(regions)};
  };
  const curbEdge=curbWidth ? polygonOffset(footprint,curbWidth,{join:'round',arcTolerance}) : footprint;
  const result={...mesh(footprint,0),footprint,
    curb:curbWidth ? mesh(polygonDifference(curbEdge,footprint),curbHeight,true) : null,
    sidewalk:sidewalkWidth ? mesh(polygonDifference(polygonOffset(footprint,curbWidth+sidewalkWidth,{join:'round',arcTolerance}),curbEdge),curbHeight) : null};
  signal?.throwIfAborted(); return result;
}
