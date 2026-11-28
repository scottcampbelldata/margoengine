import { shapeGeometry, extrudeGeometry } from '@margoengine/geometry/extrude';
import { triangulateConstrained } from '@margoengine/geometry/delaunay';
import { polygonUnion, polygonOffset, polygonArea, polygonShapes } from '@margoengine/geometry/polygon';
import { Spline } from '@margoengine/splines';

const DEFAULT_OUTLINE=[
  [-.173,-.065],[-.116,-.054],[-.067,-.024],[-.027,.055],[.005,.098],
  [.043,.112],[.088,.100],[.124,.072],[.139,.032],[.113,-.020],
  [.073,-.058],[.009,-.086],[-.058,-.104],[-.128,-.103],[-.172,-.090],
];
export const defaults=Object.freeze({offset:7, thickness:20, bevel:3, joined:true, smooth:true});
export const resetOutline=()=>DEFAULT_OUTLINE.map(point=>[...point]);
export const draftExtent=[.218,.146];

function ellipse([cx,cy],rx,ry,count){
  return Array.from({length:count},(_,i)=>{
    const angle=2*Math.PI*i/count;
    return [cx+rx*Math.cos(angle),cy+ry*Math.sin(angle)];
  });
}
const collarCenter=[.148,.084];
export const collar=Object.freeze({
  contour:ellipse(collarCenter,.046,.040,48),
  holes:[ellipse(collarCenter,.022,.019,40).reverse()],
});

export function sampleOutline(points,smooth){
  if(!smooth||points.length<4)return points.map(point=>[...point]);
  const spline=new Spline(points.map(([x,y])=>[x,y,0]),{closed:true,divisions:112});
  const count=Math.min(156,Math.max(64,points.length*5));
  return Array.from({length:count},(_,i)=>{
    const [x,y]=spline.at(i/count);
    return [x,y];
  });
}

export function cleanOutline(points,smooth){
  if(points.length<3)return [];
  return polygonUnion(sampleOutline(points,smooth),undefined,{fillRule:'evenodd'});
}

function measure(polygons){
  return {area:polygonArea(polygons),pieces:polygons.length,holes:polygons.reduce((sum,part)=>sum+part.holes.length,0)};
}

export function buildProfile(points,settings){
  const base=cleanOutline(points,settings.smooth);
  const offset=settings.offset===0?base:polygonOffset(base,settings.offset/1000,{join:'round',arcTolerance:.00026});
  const result=settings.joined?polygonUnion(offset,collar):offset;
  return {base,offset,result,metrics:{base:measure(base),offset:measure(offset),result:measure(result)}};
}

const signature=polygons=>polygons.map(poly=>poly.holes.length).sort((a,b)=>a-b).join('/');
function bevelThatFits(polygons,thickness,requested){
  const maximum=Math.min(thickness*.42,requested);
  if(!maximum)return 0;
  const inset=polygonOffset(polygons,-maximum,{join:'miter',miterLimit:3});
  return inset.length===polygons.length&&signature(inset)===signature(polygons)?maximum:0;
}

function orientationOfCaps(mesh){
  for(const group of mesh.groups){
    if(group.materialIndex!==0)continue;
    const center=group.start+group.count/2;
    for(let index=group.start;index<group.start+group.count;index++){
      const direction=index<center?-1:1;
      if(mesh.normals[index*3+2]*direction<.99)return false;
    }
  }
  return true;
}

export function buildSolid(profile,{thickness,bevel}){
  if(!profile.result.length||thickness===0)return {mesh:null,bevel:0,depth:0};
  const metres=thickness/1000;
  const edge=bevelThatFits(profile.result,metres,bevel/1000);
  const shapes=polygonShapes(profile.result);
  function build(edge){
    const depth=metres-2*edge;
    const mesh=extrudeGeometry(shapes,{
      depth,bevelEnabled:edge>0,bevelSize:edge,bevelThickness:edge,
      bevelOffset:-edge,bevelSegments:4,triangulate:(contour,holes)=>triangulateConstrained(contour,holes),
    });
    return {mesh,bevel:edge*1000,depth};
  }
  const rounded=build(edge);
  return edge&&!orientationOfCaps(rounded.mesh)?build(0):rounded;
}

export const fillGeometry=polygons=>shapeGeometry(polygonShapes(polygons));

export function interiors(geo,kind){
  const groups=geo?.groups.filter(group=>group.materialIndex===kind)??[];
  const length=groups.reduce((total,group)=>total+group.count,0);
  const positions=new Float32Array(length*3),normals=new Float32Array(length*3);
  let cursor=0;
  for(const {start,count} of groups){
    positions.set(geo.positions.subarray(start*3,(start+count)*3),cursor);
    normals.set(geo.normals.subarray(start*3,(start+count)*3),cursor);
    cursor+=count*3;
  }
  return {positions,normals,indices:Uint32Array.from({length},(_,i)=>i)};
}
