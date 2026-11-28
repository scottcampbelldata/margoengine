import { Geometry, PbrMaterial, box } from '@margoengine/core';
import { extrudeGeometry } from '@margoengine/geometry/extrude';
import { polygonOffset, polygonShapes } from '@margoengine/geometry/polygon';

export function geometry(source){
  return new Geometry(source.positions,source.normals,source.indices);
}

const graphic=(color,emissive)=>new PbrMaterial({color,emissive,roughness:.85});
export const materials={
  grid:graphic('#365d59',[.034,.087,.077]),
  major:graphic('#537977',[.041,.12,.11]),
  fill:graphic('#1b514c',[.023,.11,.083]),
  source:graphic('#8db9a7',[.20,.33,.26]),
  contour:graphic('#acd6b4',[.22,.42,.24]),
  ring:graphic('#cda663',[.38,.22,.077]),
  pen:graphic('#f3c785',[.54,.29,.093]),
  pin:graphic('#d0d2a9',[.31,.28,.17]),
  cap:new PbrMaterial({color:'#d9b681',roughness:.45,metalness:0,emissive:[.024,.016,.008]}),
  wall:new PbrMaterial({color:'#cc995c',roughness:.40,metalness:1,emissive:[.059,.028,.010]}),
};

export const segments=(points,closed=false)=>points.slice(0,closed?points.length:points.length-1)
  .map((point,index)=>[point,points[(index+1)%points.length]]);
export const edges=polygons=>polygons.flatMap(poly=>[poly.contour,...poly.holes]).flatMap(ring=>segments(ring,true));

export function stroke(list,width){
  const positions=[],normals=[],indices=[];
  for(const [[ax,ay],[bx,by]] of list){
    const length=Math.hypot(bx-ax,by-ay);
    if(length<1e-7)continue;
    const dx=(by-ay)/length*width/2,dy=(ax-bx)/length*width/2;
    const index=positions.length/3;
    positions.push(ax+dx,ay+dy,0,bx+dx,by+dy,0,bx-dx,by-dy,0,ax-dx,ay-dy,0);
    normals.push(0,0,1,0,0,1,0,0,1,0,0,1);
    indices.push(index,index+1,index+2,index,index+2,index+3);
  }
  return geometry({positions:Float32Array.from(positions),normals:Float32Array.from(normals),indices:Uint32Array.from(indices)});
}

export function pins(points,r=.0016){
  const positions=[],normals=[],indices=[];
  for(const [x,y] of points){
    const start=positions.length/3;
    positions.push(x-r,y,0,x,y-r,0,x+r,y,0,x,y+r,0);
    normals.push(0,0,1,0,0,1,0,0,1,0,0,1);
    indices.push(start,start+1,start+2,start,start+2,start+3);
  }
  return geometry({positions:Float32Array.from(positions),normals:Float32Array.from(normals),indices:Uint32Array.from(indices)});
}

function viewLine(scene,list,width,material,z){
  return scene.createMesh().setGeometry(stroke(list,width)).setMaterial(material).setPosition([0,0,z]);
}

export function draftTable(scene){
  const minor=[],major=[];
  for(let i=-21;i<=21;i++){
    const at=i*.02;
    const group=i%5?minor:major;
    group.push([[-.43,at],[.43,at]],[[at,-.43],[at,.43]]);
  }
  viewLine(scene,minor,.0004,materials.grid,.001);
  viewLine(scene,major,.00092,materials.major,.0011);
  const corners=[];
  for(const signX of [-1,1])for(const signY of [-1,1]){
    const x=signX*.222,y=signY*.150;
    corners.push([[x-signX*.014,y],[x,y]],[[x,y],[x,y-signY*.014]]);
  }
  viewLine(scene,corners,.0018,materials.source,.0013);
}

function roundCorners(width,height,radius,depth){
  const x=width/2-radius,y=height/2-radius;
  const rect=[[-x,-y],[x,-y],[x,y],[-x,y]];
  const poly=polygonOffset(rect,radius,{join:'round',arcTolerance:.0004});
  return geometry(extrudeGeometry(polygonShapes(poly),{depth,bevelEnabled:false}));
}

export function studioFixture(scene){
  const frame=new PbrMaterial({color:'#41544f',roughness:.7,emissive:[.012,.017,.012]});
  const velvet=new PbrMaterial({color:'#4c6059',roughness:.95,emissive:[.012,.023,.014]});
  const pale=new PbrMaterial({color:'#a69068',roughness:.66,emissive:[.035,.022,.010]});
  scene.createMesh().setGeometry(roundCorners(.472,.339,.019,.018)).setMaterial(frame).setPosition([0,0,-.055]);
  scene.createMesh().setGeometry(roundCorners(.441,.310,.014,.008)).setMaterial(velvet).setPosition([0,0,-.036]);
  scene.createMesh().setGeometry(box(.498,.019,.061)).setMaterial(frame).setPosition([0,-.171,-.028]);
  scene.createMesh().setGeometry(box(.472,.004,.052)).setMaterial(pale).setPosition([0,-.164,-.028]);
  const pin=roundCorners(.010,.010,.0045,.006);
  for(const x of [-.207,.207])for(const y of [-.137,.137])
    scene.createMesh().setGeometry(pin).setMaterial(pale).setPosition([x,y,-.027]);
  const mark=box(.003,.011,.002);
  for(let i=0;i<9;i++)scene.createMesh().setGeometry(mark).setMaterial(pale).setPosition([-.08+i*.011,-.134,-.026]);
}
