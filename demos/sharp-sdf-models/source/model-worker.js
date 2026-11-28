import {createSdfModeler} from '@margoengine/procedural/sdf';
import {evaluator,operation,resolution} from './operands.js';

const modeler=createSdfModeler();
const bounds=[[-.48,-.094,-.398],[.492,.729,.508]];
self.addEventListener('message',async ({data:{id,mode,width}})=>{
  try{
    const model=await modeler,shape=operation(mode,width);
    const mesh=model.mesh(shape,{resolution,bounds});
    const packed=pack(mesh,shape,mode);
    self.postMessage({id,...packed},[packed.vertices.buffer]);
  }catch(reason){
    self.postMessage({id,error:reason instanceof Error?reason.message:String(reason)});
  }
});

function pack({positions,indices,edgeSolves,cellEdgeUses},shape,mode){
  const a=evaluator(shape.a),b=evaluator(shape.b),field=evaluator(shape);
  const floats=new Float32Array(indices.length*9);
  let bottom=Infinity,cursor=0,volume=0,residual=0;
  for(let i=0;i<positions.length;i+=3){
    const [x,y,z]=positions.subarray(i,i+3);
    bottom=Math.min(bottom,y);
    residual=Math.max(residual,Math.abs(field(x,y,z)));
  }
  for(let i=0;i<indices.length;i+=3){
    const ia=indices[i]*3,ib=indices[i+1]*3,ic=indices[i+2]*3;
    const [ax,ay,az]=positions.subarray(ia,ia+3);
    const [bx,by,bz]=positions.subarray(ib,ib+3);
    const [cx,cy,cz]=positions.subarray(ic,ic+3);
    const abx=bx-ax,aby=by-ay,abz=bz-az,acx=cx-ax,acy=cy-ay,acz=cz-az;
    const nx=aby*acz-abz*acy,ny=abz*acx-abx*acz,nz=abx*acy-aby*acx;
    const length=Math.hypot(nx,ny,nz);
    if(length<1e-14)continue;
    const px=(ax+bx+cx)/3,py=(ay+by+cy)/3,pz=(az+bz+cz)/3;
    const fromTool=Math.abs(b(px,py,pz))<Math.abs(a(px,py,pz));
    const surface=fromTool&&mode==='difference'?.75:fromTool||mode==='intersection'?.5:.25;
    const normal=[nx/length,ny/length,nz/length];
    const exportVertex=(x,y,z,u,v)=>{
      floats.set([x,y-bottom,z,...normal,surface,u,v],cursor);
      cursor+=9;
    };
    exportVertex(ax,ay,az,1,0);exportVertex(bx,by,bz,0,1);exportVertex(cx,cy,cz,0,0);
    volume+=(ax*nx+ay*ny+az*nz)/6;
  }
  const vertices=floats.subarray(0,cursor);
  return {vertices,triangles:cursor/27,dualVertices:positions.length/3,
    edgeSolves,cellEdgeUses,residual,volume:Math.abs(volume)};
}
