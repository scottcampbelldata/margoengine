import { Material } from '@margoengine/materials';
import { initialCore,ringRadius,riseAt,spinAt,startY } from './vortex.js';
import { rgb } from './tank.js';

const tau=2*Math.PI;
const sections=104;
const radialRows=13;
const cloudRows=18;
const layers=3;
const light=rgb('#c3fff0');
const azure=rgb('#48bdfa');
const teal=rgb('#43e2c8');
const violet=rgb('#7789f5');

function layout(rows,azimuth,count){
  const span=rows*azimuth,indices=new Uint16Array(count*(rows-1)*(azimuth-1)*6);
  const positions=new Float32Array(count*span*3),normals=new Float32Array(positions.length);
  const colors=new Float32Array(count*span*4);
  let n=0;
  for(let k=0;k<count;k++)for(let j=0;j<rows-1;j++)for(let i=0;i<azimuth-1;i++){
    const a=k*span+j*azimuth+i,b=a+1,c=a+azimuth,d=c+1;
    indices.set([a,b,c,b,d,c],n);n+=6;
  }
  return {positions,normals,colors,indices};
}

function setVertex(g,index,phi,theta,d,height,tint,alpha){
  const cos=Math.cos(phi),sin=Math.sin(phi),u=Math.cos(theta),v=Math.sin(theta);
  const reach=ringRadius+d*u;
  const at=index*3;
  g.positions[at]=reach*cos;g.positions[at+1]=height+d*v;g.positions[at+2]=reach*sin;
  g.normals[at]=u*cos;g.normals[at+1]=v;g.normals[at+2]=u*sin;
  g.colors.set([tint[0],tint[1],tint[2],alpha],index*4);
}

function plumes(mesh,model,age,height){
  for(let layer=0;layer<layers;layer++){
    const shift=tau*layer/layers;
    const bright=layer===0?teal:layer===1?azure:violet;
    for(let j=0;j<radialRows;j++){
      const s=j/(radialRows-1);
      const distance=initialCore*(.81+s*(2.35+.27*layer));
      const angle=1.7*s-shift-spinAt(model,distance,age);
      const band=Math.sin(Math.PI*s)**.63;
      for(let i=0;i<sections;i++){
        const phi=tau*i/(sections-1);
        const fold=.46*Math.sin(4*phi+shift)+.29*Math.cos(9*phi-shift)+.13*Math.sin(16*phi+2.3*s);
        const θ=angle+fold+.72*Math.sin(phi+shift)*s;
        const patch=.5+.5*Math.sin(3*phi+shift+.57*Math.cos(11*phi));
        const detail=.53+.47*Math.sin(13*phi-shift+.9*s)**2;
        const breakup=Math.max(.04,patch)**1.8*detail;
        const tint=bright.map((c,k)=>c+(light[k]-c)*(.065+.43*patch+.08*Math.sin(θ)));
        const a=band*breakup*(layer===0?.86:.69);
        setVertex(mesh,(layer*radialRows+j)*sections+i,phi,θ,distance,height,tint,a);
      }
    }
  }
}

function pipe(mesh,model,age,height){
  const phase=spinAt(model,initialCore*1.16,age);
  for(let j=0;j<cloudRows;j++){
    const angle=tau*j/(cloudRows-1);
    for(let i=0;i<sections;i++){
      const phi=tau*i/(sections-1);
      const twist=.58*Math.sin(4*phi)+.28*Math.sin(10*phi+1.9);
      const d=initialCore*(1.16+.31*Math.sin(5*phi+angle)+.16*Math.cos(11*phi-angle*2));
      const offset=angle+.13*Math.sin(9*phi+2*angle)+twist;
      const flare=.5+.5*Math.sin(phi-1.0);
      const fine=.58+.42*Math.cos(15*phi+angle+.8*Math.sin(phi*4))**2;
      const tint=azure.map((c,k)=>c+(light[k]-c)*(.21+.61*flare));
      const a=(.20+.45*flare)*fine*(.70+.30*Math.cos(angle-.4));
      setVertex(mesh,j*sections+i,phi,offset-phase,d,height,tint,a);
    }
  }
}


function flecks(){
  const n=72;
  const positions=new Float32Array(n*12),normals=new Float32Array(n*12);
  const colors=new Float32Array(n*16),indices=new Uint16Array(n*6);
  for(let j=0;j<n;j++){
    const p=j*4;
    indices.set([p,p+1,p+2,p+2,p+1,p+3],j*6);
  }
  return {positions,normals,colors,indices};
}

function updateFlecks(g,model,age,height){
  const count=g.positions.length/12;
  const distances=[1.35,1.73,2.10,2.43,2.71].map(x=>x*initialCore);
  const phases=distances.map(d=>spinAt(model,d,age));
  for(let i=0;i<count;i++){
    const j=i%distances.length,s=distances[j];
    const phi=2.39996323*i;
    const theta=(i*1.83)%tau-phases[j];
    const u=Math.cos(phi),v=Math.sin(phi),cos=Math.cos(theta),sin=Math.sin(theta);
    const center=[(ringRadius+s*cos)*u,height+s*sin,(ringRadius+s*cos)*v];
    const span=.00055+.00095*Math.sin(i*1.96)**2,w=span*.26;
    const line=[-sin*u*span,cos*span,-sin*v*span];
    const cross=[-v*w,0,u*w];
    const tint=i%3===0?violet:light;
    for(let q=0;q<4;q++){
      for(let k=0;k<3;k++)g.positions[12*i+3*q+k]=center[k]+line[k]*(q<2?-1:1)+cross[k]*(q%2?-1:1);
      g.normals.set([u*cos,sin,v*cos],12*i+3*q);
      g.colors.set([...tint,.46+.44*Math.sin(i*2.81)**2],16*i+4*q);
    }
  }
}

export function createDye(add,initial,age){
  const sheets=layout(radialRows,sections,layers),core=layout(cloudRows,sections,1),dots=flecks();
  const glimmer=new Material({shading:'basic',color:'#dbf4f8',transparent:true,opacity:.69,depthWrite:false,doubleSided:true});
  const lightDye=new Material({shading:'basic',color:'#e4f4f6',transparent:true,opacity:.90,depthWrite:false,doubleSided:true});
  const boundedCore=new Material({shading:'basic',color:'#d7fcf2',transparent:true,opacity:.69,depthWrite:false,doubleSided:true});
  const firstHeight=startY+riseAt(initial,age);
  plumes(sheets,initial,age,firstHeight);pipe(core,initial,age,firstHeight);updateFlecks(dots,initial,age,firstHeight);
  const envelope=add(sheets,lightDye,'Splayed passive dye ribbons',undefined,5);
  const main=add(core,boundedCore,'Dye seeded inside the vortex core',undefined,4);
  const particles=add(dots,glimmer,'Fine advected dye fragments',undefined,7);
  let previous=initial,last=age;
  return {
    update(model,time){
      if(model===previous&&time===last)return;
      const height=startY+riseAt(model,time);
      plumes(sheets,model,time,height);pipe(core,model,time,height);updateFlecks(dots,model,time,height);
      envelope.setGeometry(sheets,{start:0,count:sheets.positions.length/3});
      main.setGeometry(core,{start:0,count:core.positions.length/3});
      particles.setGeometry(dots,{start:0,count:dots.positions.length/3});
      previous=model;last=time;
    },
    dispose(){lightDye.dispose();boundedCore.dispose();glimmer.dispose();},
  };
}
