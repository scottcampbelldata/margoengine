import { Material } from '@margoengine/materials';
import { color, dyeY } from './bench.js';
import { sample } from './pressure.js';

const warm=[color('#9d2452'),color('#c96328'),color('#66365d')];
const cool=[color('#006d70'),color('#0b597b'),color('#228668')];
const marks=11,pulses=3;
const tint=lane=>lane<9?warm[lane%3]:cool[lane%3];

function texture(count,steps){
  const vertices=2*count*steps,positions=new Float32Array(vertices*3);
  const normals=new Float32Array(vertices*3),colors=new Float32Array(vertices*4);
  const indices=new Uint16Array(count*(steps-1)*6);
  for(let i=0;i<vertices;i++)normals[3*i+1]=1;
  for(let j=0;j<count;j++)for(let i=0;i<steps-1;i++){
    const a=2*(j*steps+i);
    indices.set([a,a+2,a+1,a+1,a+2,a+3],6*(j*(steps-1)+i));
  }
  return {positions,normals,colors,indices};
}

function strip(mesh,index,y,x,z,dx,dz,width,rgb,alpha){
  const length=Math.hypot(dx,dz);
  const offset=length>0?width/length:0;
  const a=-dz*offset,b=dx*offset;
  mesh.positions.set([x+a,y,z+b,x-a,y,z-b],6*index);
  mesh.colors.set([...rgb,alpha,...rgb,alpha],8*index);
}
function anchored(mesh,model){
  model.lanes.forEach((lane,j)=>{
    const {x,z}=lane;
    for(let i=0;i<x.length;i++){
      const a=Math.max(0,i-1),b=Math.min(x.length-1,i+1);
      const bend=Math.abs(z[b]-z[a]);
      const width=.00047+.00024*Math.min(1,bend/.007);
      strip(mesh,j*x.length+i,dyeY,x[i],z[i],x[b]-x[a],z[b]-z[a],width,tint(j),.51);
    }
  });
}
function advected(mesh,model,time){
  model.lanes.forEach((lane,i)=>{
    const {duration}=lane;
    for(let j=0;j<pulses;j++){
      const end=(55*time+duration*(j/pulses+.041*i))%duration;
      const start=Math.max(0,end-duration*.154);
      const curve=Array.from({length:marks},(_,k)=>sample(lane,start+(end-start)*k/(marks-1)));
      curve.forEach(([x,z],k)=>{
        const f=k/(marks-1),a=curve[Math.max(0,k-1)],b=curve[Math.min(marks-1,k+1)];
        const fade=Math.sin(Math.PI*f)**.63;
        const width=.00020+(.00125+.00037*Math.sin(i*3.91))*fade;
        const alpha=fade*(.84+.16*Math.sin(i*1.27+j));
        strip(mesh,(i*pulses+j)*marks+k,dyeY+.00019,x,z,b[0]-a[0],b[1]-a[1],width,tint(i),alpha);
      });
    }
  });
}

export function dye(add,initial){
  const laneCount=initial.lanes.length,steps=initial.lanes[0].x.length;
  const lines=texture(laneCount,steps),motes=texture(laneCount*pulses,marks);
  const firstMaterial=new Material({shading:'basic',color:'#f4ebdc',transparent:true,opacity:.73,depthWrite:false});
  const pulseMaterial=new Material({shading:'basic',color:'#fffbef',transparent:true,opacity:.98,depthWrite:false});
  anchored(lines,initial);advected(motes,initial,0);
  const dyeLines=add(lines,firstMaterial,'Steady dye threads',undefined,2);
  const packets=add(motes,pulseMaterial,'Advected dye intervals',undefined,3);
  let previous=initial,last=0;
  return {
    update(model,time){
      const changed=previous!==model;
      if(changed){
        anchored(lines,model);
        dyeLines.setGeometry(lines,{start:0,count:lines.positions.length/3});
      }
      if(changed||time!==last){
        advected(motes,model,time);
        packets.setGeometry(motes,{start:0,count:motes.positions.length/3});
      }
      previous=model;last=time;
    },
    dispose(){firstMaterial.dispose();pulseMaterial.dispose();},
  };
}
