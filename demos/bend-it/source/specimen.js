import {boxGeometry,mergeGeometries} from '@margoengine/geometry';
import {roundedBoxGeometry} from '@margoengine/geometry/extras';
import {CurveFlow} from '@margoengine/geometry/flow';
import {Spline} from '@margoengine/splines';

export const xKnots=[-5.1,-2.58,0,2.58,5.1];
const across=[-.39,-1.58,.06,1.58,.39], loft=[0,.36,1,.36,0];
const baseHeight=.46;
export function guide(bend,lift,offsets=[0,0,0,0,0]){
  return xKnots.map((x,i)=>[x,baseHeight+lift*loft[i],across[i]*bend+offsets[i]]);
}
function piece(w,h,d,x,y,z,n=1,bevel=0){
  const geometry=bevel?roundedBoxGeometry(w,h,d,1,bevel):boxGeometry(w,h,d,n,1,1);
  const p=geometry.positions;
  for(let i=0;i<p.length;i+=3){
    p[i]+=x;p[i+1]+=y;p[i+2]+=z;
  }
  return geometry;
}
function stack(parts){return mergeGeometries(parts);}
function parts(){
  const channels=[],bronze=[],sides=[],pale=[],fasteners=[];
  for(const sign of [-1,1]){
    channels.push(piece(10.20,.188,.190,0,-.106,sign*.752,64));
    channels.push(piece(10.20,.064,.166,0,-.226,sign*.626,64));
    sides.push(piece(10.20,.093,.043,0,.087,sign*.867,64));
    sides.push(piece(10.20,.046,.056,0,-.205,sign*.840,64));
    bronze.push(piece(10.20,.026,.031,0,.148,sign*.871,64));
    pale.push(piece(10.20,.031,.026,0,-.048,sign*.853,64));
  }
  const oak=[[],[],[]], supports=[];
  for(let i=0;i<44;i++){
    const x=-4.925+i*.229;
    oak[i%3].push(piece(.203,.066,1.453,x,.009,0,2,.014));
    if(i%4===1){
      supports.push(piece(.107,.104,1.587,x,-.154,0));
      for(const z of [-.699,.699]){
        fasteners.push(piece(.043,.017,.047,x,.047,z));
        bronze.push(piece(.054,.083,.036,x,-.106,Math.sign(z)*.857));
      }
    }
  }
  for(const sign of [-1,1]){
    const x=sign*4.996;
    sides.push(piece(.208,.115,1.776,x,-.013,0,3));
    bronze.push(piece(.211,.024,1.617,x,.051,0,3));
    for(const z of [-.53,0,.53])fasteners.push(piece(.045,.017,.062,x,.066,z));
  }
  return [
    {label:'rolled frame',color:'#394748',rough:.47,metal:.64,data:stack(channels)},
    {label:'blackened trim',color:'#182c30',rough:.47,metal:.38,data:stack(sides)},
    {label:'bronze bead',color:'#c79554',rough:.34,metal:.56,data:stack(bronze)},
    {label:'ceramic inlay',color:'#d7e4d5',rough:.44,metal:.16,data:stack(pale)},
    {label:'fasteners',color:'#464c47',rough:.32,metal:.73,data:stack(fasteners)},
    {label:'cross members',color:'#435b5b',rough:.5,metal:.51,data:stack(supports)},
    ...oak.map((pieces,i)=>({label:'oiled ash '+i,color:['#ae7850','#c79764','#bd8a5e'][i],rough:.68,metal:.06,data:stack(pieces)})),
  ];
}
export const specimen=parts();

export function construct(points,fit=true){
  const spline=new Spline(points,{kind:'catmull-rom',divisions:320}), length=spline.length;
  const a=new Float64Array(3),b=new Float64Array(3);
  const adapter={
    getLength:()=>length,
    getPointAt:u=>Array.from(spline.atDistance(u*length,a)),
    getTangentAt:u=>{
      spline.atDistance(Math.max(0,u-.00015)*length,a);
      spline.atDistance(Math.min(1,u+.00015)*length,b);
      const x=b[0]-a[0],y=b[1]-a[1],z=b[2]-a[2],norm=Math.hypot(x,y,z);
      return [x/norm,y/norm,z/norm];
    },
  };
  const flow=new CurveFlow(adapter,{segments:144});
  const meshes=specimen.map(part=>flow.deform(part.data,fit?{axis:'x',scale:length/10.2,offset:length*.5}:{axis:'x',offset:length*.5}));
  return {flow,spline,meshes,length,fit};
}
