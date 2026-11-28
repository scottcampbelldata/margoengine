
import {box, Geometry, PbrMaterial} from '@margoengine/core';
import {Figure} from '@margoengine/sciviz';
import {duration,nx,ny,frequencyLow,bandSpan,floorDb,ceilingDb} from './sounds.js';

const halfWidth=2.18, halfDepth=1.23, halfHeight=.49;
const tones=[
  [0,'#1a3444'],[.16,'#214457'],[.36,'#2e716e'],[.55,'#5e9a82'],
  [.72,'#b39d63'],[.89,'#e0b478'],[1,'#fff0bc'],
];
const xTime=time=>(time/duration*2-1)*halfWidth;
const zPitch=octave=>(1-2*octave/bandSpan)*halfDepth;
const yLevel=level=>(2*(level-floorDb)/(ceilingDb-floorDb)-1)*halfHeight;

function polygonOutline(w,d,cut){
  return [[-w+cut,-d],[w-cut,-d],[w,-d+cut],[w,d-cut],[w-cut,d],[-w+cut,d],[-w,d-cut],[-w,-d+cut]];
}
function baseGeometry(){
  const positions=[], normals=[], indices=[];
  const outlines=[
    [2.37,1.40,-.74],[2.42,1.45,-.69],[2.42,1.45,-.57],[2.36,1.39,-.507],
  ].map(([w,d,y])=>polygonOutline(w,d,.12).map(([x,z])=>[x,y,z]));
  function patch(points){
    const [a,b,c]=points;
    const u=b.map((x,i)=>x-a[i]),v=c.map((x,i)=>x-a[i]);
    const n=[u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]];
    const length=Math.hypot(...n), i=positions.length/3;
    positions.push(...points.flat());
    for(let j=0;j<points.length;j++)normals.push(...n.map(x=>x/length));
    for(let j=1;j<points.length-1;j++)indices.push(i,i+j,i+j+1);
  }
  for(let k=0;k<outlines.length-1;k++){
    const [down,up]=outlines.slice(k,k+2);
    for(let j=0;j<down.length;j++){
      const next=(j+1)%down.length;
      patch([down[j],up[j],up[next],down[next]]);
    }
  }
  patch([...outlines.at(-1)].reverse());
  return new Geometry(positions,normals,indices);
}

function playRibbon(index,values){
  const positions=[], normals=[], triangles=[];
  const x=xTime(index/(nx-1)*duration);
  for(let row=0;row<ny;row++){
    const z=zPitch(row/(ny-1)*bandSpan);
    const y=yLevel(values[row*nx+index])+.020;
    positions.push(x-.013,y,z,x+.013,y,z);
    normals.push(0,1,0,0,1,0);
    const k=2*row;
    if(row)triangles.push(k-2,k-1,k+1,k-2,k+1,k);
  }
  return new Geometry(positions,normals,triangles);
}

function project(matrix,[x,y,z],canvas){
  const w=matrix[3]*x+matrix[7]*y+matrix[11]*z+matrix[15];
  const u=(matrix[0]*x+matrix[4]*y+matrix[8]*z+matrix[12])/w;
  const v=(matrix[1]*x+matrix[5]*y+matrix[9]*z+matrix[13])/w;
  return [canvas.clientWidth*(u+1)/2,canvas.clientHeight*(1-v)/2];
}

export function openScene(engine,canvas,landscape){
  engine.scene.background='#122329';
  engine.lighting.direction.set([-.55,.75,.38,1]);
  engine.lighting.radiance.set([.75,.83,.79,.56]);
  const figure=Figure.attach(engine,{
    axes:false,tooltips:false,aspect:[halfWidth,halfDepth,halfHeight],
    limits:[0,duration,0,bandSpan,floorDb,ceilingDb],
  });
  const surface=figure.surface(landscape.visible,{
    nx,ny,x:[0,duration],y:[0,bandSpan],range:[floorDb,ceilingDb],
    colormap:tones,contours:8,name:'Spectral magnitude',
  });
  const material=(color,metalness,roughness)=>new PbrMaterial({color,metalness,roughness});
  const stand=material('#294448',.35,.52), trim=material('#9a9871',.36,.51), active=material('#fff1bb',0,.88);
  function mesh(name,geometry,finish){
    const mesh=engine.createMesh();
    mesh.name=name;
    return mesh.setGeometry(geometry).setMaterial(finish);
  }
  mesh('Chamfered sound relief cabinet',baseGeometry(),stand);
  mesh('Front inlay',box(4.40,.017,.016),trim).setPosition([0,-.593,1.456]);
  mesh('Left inlay',box(.015,.017,2.47),trim).setPosition([-2.426,-.593,0]);
  mesh('Right deck rail',box(.018,.025,2.55),trim).setPosition([2.205,-.507,0]);
  mesh('Rear deck rail',box(4.40,.025,.018),trim).setPosition([0,-.507,-1.25]);

  const axisTicks=[
    ...[0,1,2,3,4,5,6].map(time=>({name:time===6?'6 s':String(time),point:[xTime(time),-.491,1.29],time:true,show:time%2===0})),
    ...[125,250,500,1000,2000,4000].map(frequency=>({name:frequency>=1000?frequency/1000+'k':String(frequency),
      point:[-2.23,-.493,zPitch(Math.log2(frequency/frequencyLow))],show:frequency!==250&&frequency!==2000})),
  ];
  const tickGeometry=box(.008,.018,.045), sideGeometry=box(.047,.018,.008);
  for(const tick of axisTicks){
    mesh('Axis tick '+tick.name,tick.time?tickGeometry:sideGeometry,trim).setPosition(tick.point);
  }
  const ribbon=mesh('Current spectral slice',null,active);
  const toe=mesh('Playback position on time axis',box(.022,.025,.15),active).setPosition([xTime(0),-.48,1.33]);
  let overhead=false, slice=-1, activeData=landscape, clock=0;
  const labels=document.querySelector('#labels');
  engine.camera.project=(out,aspect,gpu)=>{
    const {near,far}=engine.camera,depth=far-near;
    const h=Math.max(overhead?1.64:1.60,2.92/aspect);
    out[0]=1/(h*aspect);out[5]=1/h;out[10]=(gpu?1:2)/depth;
    out[14]=(gpu?far:far+near)/depth;out[15]=1;
  };
  function placeCamera(){
    engine.camera.position=overhead?[0,8,0]:[2.85,6.50,7.90];
    engine.camera.target=overhead?[0,0,0]:[0,-.33,0];
    engine.camera.up=overhead?[0,0,-1]:[0,1,0];
  }
  function paintLabels(){
    const light=canvas.clientWidth<560;
    labels.replaceChildren();
    function label(name,point,dx,dy,title=false){
      const [left,top]=project(engine.camera.matrix,point,canvas);
      const element=document.createElement('span');
      element.textContent=name;
      element.style.left=(left+dx)+'px';
      element.style.top=(top+dy)+'px';
      if(title)element.className='axis-title';
      labels.append(element);
    }
    for(const tick of axisTicks){
      if(light&&!tick.show)continue;
      label(tick.name,tick.point,tick.time?0:-16,tick.time?16:1);
    }
    label('Time', [0,-.54,1.40],0,28,true);
    label('Hz',[-2.24,-.493,-1.27],-13,-3,true);
  }
  function render(){
    engine.render(clock++);
  }
  function move(time){
    const index=Math.min(nx-1,Math.max(0,Math.round(time/duration*(nx-1))));
    if(index===slice)return;
    slice=index;
    ribbon.setGeometry(playRibbon(index,activeData.values));
    toe.setPosition([xTime(index/(nx-1)*duration),-.48,1.33]);
    render();
  }
  function update(data){
    activeData=data;
    surface.setHeights(data.visible);
    slice=-1;
    move(0);
  }
  function setView(value){
    overhead=value;
    placeCamera();
    render();
    paintLabels();
  }
  function resize(){
    render();
    paintLabels();
  }

  placeCamera();
  move(0);
  paintLabels();
  return {move,update,setView,resize,dispose:()=>figure.dispose()};
}
