import { LineBatch } from '@margoengine/lines/batch';
import { Material } from '@margoengine/materials';
import { color,deep,landEnd,mix } from './coast.js';
import { bed,channelDepth,distanceAt,farZ,fractionAt,interfaceY,leftX,mouthX,nearZ,planScale,position,seaX,surface } from './estuary.js';

const freshDark=color('#337f82'),freshLight=color('#89ccc0'),open=color('#518a98');
const saltDark=color('#194b6a'),saltLight=color('#4d94b0'),brine=color('#7fb8bc');
const air=color('#d2e8d8');
const counts=[24,74,21];
const total=counts.reduce((a,b)=>a+b,0)+1;
const front=nearZ+.0007;
function shape(columns,rows,up){
  const vertices=columns*rows,g={
    positions:new Float32Array(vertices*3),normals:new Float32Array(vertices*3),
    colors:new Float32Array(vertices*4),indices:new Uint16Array((columns-1)*(rows-1)*6),
  };
  let n=0;
  for(let j=0;j<rows;j++)for(let i=0;i<columns;i++){
    const a=i+j*columns;
    g.normals[3*a+(up?1:2)]=1;
    if(i+1===columns||j+1===rows)continue;
    const b=a+1,c=a+columns,d=c+1;
    g.indices.set(up?[a,c,b,b,c,d]:[a,b,c,b,d,c],n);n+=6;
  }
  return g;
}
function point(g,index,x,y,z,rgb,opacity=1){
  g.positions[3*index]=x;g.positions[3*index+1]=y;g.positions[3*index+2]=z;
  g.colors.set([rgb[0],rgb[1],rgb[2],opacity],4*index);
}
function section(model){
  const points=[];
  const [west,wedge,sea]=counts;
  const toe=position(model.length);
  for(let i=0;i<west;i++)points.push([leftX+(toe-leftX)*i/west,1]);
  for(let i=0;i<wedge;i++){
    const s=1+(model.mouthFraction-1)*i/wedge;
    points.push([position(distanceAt(model,s)),s]);
  }
  for(let i=0;i<=sea;i++)points.push([mouthX+(seaX-mouthX)*i/sea,model.mouthFraction]);
  return points;
}
function updateFaces(upper,lower,seam,model){
  for(const [i,[x,s]] of section(model).entries()){
    const edge=interfaceY(s),ocean=Math.max(0,(x-mouthX)/(seaX-mouthX));
    const lowerFour=i-counts[0];
    for(let j=0;j<5;j++){
      const f=j/4;
      const streak=.50+.50*Math.sin(15*x+4*f+.48*Math.sin(x*51+f));
      const shade=mix(mix(freshDark,freshLight,.36+.43*f+.12*streak),open,ocean*.47);
      point(upper,i+j*total,x,edge+(surface-edge)*f,front,shade);
      if(lowerFour>=0){
        const lowerWidth=total-counts[0];
        const deep=mix(mix(saltDark,saltLight,.23+.59*f),brine,.15*streak);
        point(lower,lowerFour+j*lowerWidth,x,bed+(edge-bed)*f,front,deep);
      }
    }
    if(lowerFour>=0){
      const lowerWidth=total-counts[0];
      const fade=Math.min(1,(edge-bed)/.006);
      point(seam,lowerFour,x,edge-.0015*fade,front+.0007,air,fade*.68);
      point(seam,lowerFour+lowerWidth,x,edge+.0007*fade,front+.0007,air,fade*.68);
    }
  }
}
function top(x0=leftX,x1=seaX,z0=farZ,z1=nearZ){
  const cols=105,rows=13,g=shape(cols,rows,true);
  for(let j=0;j<rows;j++)for(let i=0;i<cols;i++){
    const u=i/(cols-1),v=j/(rows-1);
    const x=x0+(x1-x0)*u,z=z0+(z1-z0)*v;
    const offshore=Math.max(0,(x-mouthX)/(seaX-mouthX));
    const riffle=.5+.5*Math.sin(x*82+z*41+.8*Math.sin(86*z+x*23));
    const sweep=.5+.5*Math.sin(x*24+z*95);
    const dye=mix(mix(freshLight,freshDark,.27+.18*riffle),open,offshore*.62+.14*sweep);
    point(g,j*cols+i,x,surface,z,dye);
  }
  return g;
}

function endcap(east){
  const rows=east?4:2;
  const g=shape(2,rows,false);
  for(let i=0;i<g.positions.length/3;i++){
    g.normals[i*3]=east?1:-1;
    g.normals[i*3+2]=0;
  }
  if(east)for(let i=0;i<g.indices.length;i+=3){
    const b=g.indices[i+1];g.indices[i+1]=g.indices[i+2];g.indices[i+2]=b;
  }
  return g;
}
function fillEnd(g,east,model){
  const edge=interfaceY(model.mouthFraction);
  const rows=east?
    [[bed,saltDark],[edge,mix(saltLight,brine,.12)],[edge,mix(freshLight,open,.74)],[surface,mix(freshLight,open,.47)]]:
    [[bed,mix(freshDark,freshLight,.42)],[surface,mix(freshLight,open,.15)]];
  for(const [j,[y,c]] of rows.entries()){
    const x=east?seaX+.0004:leftX-.0004;
    point(g,2*j,x,y,east?deep:farZ,c);
    point(g,2*j+1,x,y,front,c);
  }
}

function advection(model){
  const steps=108,x=new Float64Array(steps+1),s=new Float64Array(steps+1),time=new Float64Array(steps+1);
  for(let i=0;i<=steps;i++){
    x[i]=leftX+(seaX-leftX)*i/steps;
    s[i]=fractionAt(model,(mouthX-x[i])/planScale);
    if(i>0)time[i]=time[i-1]+(x[i]-x[i-1])/planScale*channelDepth*(s[i-1]+s[i])/(2*model.flow);
  }
  return {x,s,time,duration:time[steps]};
}
function travel(path,t){
  const {x,s,time}=path;
  let a=0,b=x.length-1;
  while(b-a>1){
    const middle=(a+b)>>1;
    if(time[middle]<t)a=middle;
    else b=middle;
  }
  const f=(t-time[a])/(time[b]-time[a]);
  return [x[a]+f*(x[b]-x[a]),s[a]+f*(s[b]-s[a])];
}

// Tracer streaks are line segments a fixed number of screen pixels wide (@margoengine/lines/batch), so they read at
// any zoom: 48 on the cut face at their depths in the fresh layer, 29 on the surface. Each fades in at its tail.
const tracerCount=77;
function tracerLines(){
  return {positions:new Float32Array(tracerCount*6),colors:new Float32Array(tracerCount*8)};
}
function updateTraces(g,path,t){
  for(let i=0;i<tracerCount;i++){
    const f=(((i*47)%81)/81+72*t/path.duration)%1;
    const [x,s]=travel(path,path.duration*f);
    const depth=.16+.70*((i*13%73)/72);
    const streak=.003+.007*Math.sin(i*3.95)**2;
    const opacity=Math.sin(Math.PI*f)**.35*(i<48?.9:.75);
    const onFace=i<48;
    const y=onFace?surface-(surface-bed)*s*depth:surface+.0008;
    const z=onFace?front+.0013:farZ+.012+(nearZ-farZ-.023)*((i*19%31)/30);
    g.positions.set([x-streak,y,z,x+streak,y,z],6*i);
    g.colors.set([...air,0,...air,opacity],8*i);
  }
}

function specks(){
  const g={positions:[],normals:[],colors:[],indices:[]};
  const rock=color('#d5c2a3'),dim=color('#9b8569');
  for(let i=0;i<210;i++){
    const x=leftX+(seaX-leftX)*(i*197%211)/211;
    const y=.028+(bed-.036)*(i*156%215)/215,r=.0007+.0015*Math.sin(i*122.3)**2;
    const z=front+.00017;
    const first=g.positions.length/3;
    const c=mix(rock,dim,.12+.75*Math.sin(i*83.9)**2);
    g.positions.push(x-r,y-r*.26,z,x+r*.44,y-r*.45,z,x+r,y+r*.26,z,x-r*.26,y+r*.37,z);
    g.normals.push(0,0,1,0,0,1,0,0,1,0,0,1);
    g.colors.push(...c,...c,...c,...c);
    g.indices.push(first,first+1,first+2,first,first+2,first+3);
  }
  return g;
}

export function makeWater(add,initial,batches){
  const lowerWidth=total-counts[0];
  const topcap=top(),frontUpper=shape(total,5,false),frontLower=shape(lowerWidth,5,false);
  const seam=shape(lowerWidth,2,false),tracers=tracerLines(),east=endcap(true),west=endcap(false);
  const mats={
    cut:new Material({shading:'basic',color:'#dcebe2'}),
    top:new Material({color:'#c9e6de',roughness:.23}),
    seam:new Material({shading:'basic',color:'#e1f0e6',transparent:true,opacity:.63,depthWrite:false}),
    rock:new Material({shading:'basic',color:'#d1b297'}),
  };
  let path=advection(initial);
  updateFaces(frontUpper,frontLower,seam,initial);updateTraces(tracers,path,0);
  add(topcap,mats.top,'Visible water surface');
  add(top(landEnd,seaX,deep,farZ),mats.top,'Seaward surface continuation');
  fillEnd(east,true,initial);fillEnd(west,false,initial);
  const cap=add(east,mats.cut,'Seaward section cap');
  add(west,mats.cut,'Upriver section cap');
  add(specks(),mats.rock,'Granular inclusions in the sediment cut');
  const up=add(frontUpper,mats.cut,'Fresh upper layer section'),low=add(frontLower,mats.cut,'Saltwater intrusion section');
  const edge=add(seam,mats.seam,'Calculated layer interface',undefined,4);
  const glints=batches.add(new LineBatch({...tracers,width:2.5}));
  let old=initial,lastTime=0;
  return {
    update(model,t){
      if(model!==old){
        path=advection(model);
        updateFaces(frontUpper,frontLower,seam,model);
        fillEnd(east,true,model);
        cap.setGeometry(east,{start:0,count:8});
        up.setGeometry(frontUpper,{start:0,count:frontUpper.positions.length/3});
        low.setGeometry(frontLower,{start:0,count:frontLower.positions.length/3});
        edge.setGeometry(seam,{start:0,count:seam.positions.length/3});
      }
      if(model!==old||t!==lastTime){
        updateTraces(tracers,path,t);
        glints.updateSegments(0,tracers.positions,tracers.colors);
      }
      old=model;lastTime=t;
    },
    dispose(){glints.dispose();for(const m of Object.values(mats))m.dispose();},
  };
}
