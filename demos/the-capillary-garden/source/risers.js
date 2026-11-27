import { Material,MatcapMaterial } from '@margoengine/materials';
import { mergeGeometries } from '@margoengine/geometry/utils';
import { box,profile } from './garden.js';
import { boreMagnification,immersion,positions,radii,referenceY } from './rise.js';

export const riserZ=.028;
const top=.217,bottom=referenceY-immersion;

export function makeRisers(add,maps){
  const textures={
    glass:new MatcapMaterial({color:'#b3eae0',matcap:maps.metal,transparent:true,opacity:.27,depthWrite:false}),
    rim:new MatcapMaterial({color:'#a7d3c2',matcap:maps.metal,transparent:true,opacity:.66,depthWrite:false}),
    body:new MatcapMaterial({color:'#c1e9f5',matcap:maps.column}),
    cap:new MatcapMaterial({color:'#e3ffff',matcap:maps.water}),
    waterline:new Material({shading:'basic',color:'#268cc8'}),
    glint:new Material({shading:'basic',color:'#dfedde',transparent:true,opacity:.48,depthWrite:false}),
    brass:new MatcapMaterial({color:'#d2a878',matcap:maps.metal}),
  };
  const glass=[],rims=[],glints=[],clamps=[];
  const columns=radii.map((actual,i)=>{
    const x=positions[i],r=actual*boreMagnification,outer=r+.0024;
    const span=top-bottom;
    glass.push(profile([[outer,0],[outer,span-.001],[outer-.00035,span],[r+.0003,span],
      [r,span-.001],[r,0],[outer,0]],[x,bottom,riserZ],24));
    const ring=[[r,0],[outer-.0004,0],[outer,.00035],[outer-.0004,.00072],[r,.00072],[r,0]];
    rims.push(profile(ring,[x,top-.001,riserZ],26));
    glints.push(box(.00078,span-.009,.00043,[x-outer*.61,bottom+(span-.009)*.5+.005,riserZ+outer*.799],.00018));
    const collar=[[r,.0003],[outer+.0013,.0003],[outer+.0016,.0014],[outer+.0016,.0058],
      [outer+.0014,.0065],[r,.0065],[r,.0003]];
    clamps.push(profile(collar,[x,.197,riserZ],25),
      box(.011,.005,.049,[x,.200,-.001],.002));
    const body=add(profile([[0,0],[r*.993,0],[r*.993,1],[0,1]],[0,0,0],24),textures.body,'Capillary water '+i);
    const cap=add(profile([[0,-1],[r*.38,-.89],[r*.64,-.71],[r*.84,-.43],[r*.98,-.05],[r,.0]],
      [0,0,0],26),textures.cap,'Concave meniscus '+i);
    const line=add(profile([[r*.91,-.00058],[r,-.00058],[r,0],[r*.925,0]],[0,0,0],24),textures.waterline,'Dyed waterline '+i);
    body.root.setPosition([x,bottom,riserZ]);
    return {body,cap,line,x,actual};
  });
  add(mergeGeometries(clamps),textures.brass,'Five brass tube saddles');
  add(mergeGeometries(glass),textures.glass,'Five hollow, magnified glass bores',undefined,7);
  add(mergeGeometries(rims),textures.rim,'Polished open tube mouths',undefined,8);
  add(mergeGeometries(glints),textures.glint,'Thin continuous glass reflections',undefined,9);
  return {
    set(heights,angle){
      const theta=angle*Math.PI/180;
      for(const [i,{body,cap,line,x,actual}] of columns.entries()){
        const h=heights[i],sag=actual*(1-Math.sin(theta))/Math.cos(theta);
        body.root.setScale([1,immersion+h-sag,1]);
        cap.root.setPosition([x,referenceY+h,riserZ]);
        line.root.setPosition([x,referenceY+h,riserZ]);
        cap.root.setScale([1,Math.max(.000018,sag),1]);
      }
    },
    dispose(){for(const mat of Object.values(textures))mat.dispose();},
  };
}
