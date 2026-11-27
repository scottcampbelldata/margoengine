import {
  applyMatrix4, boxGeometry, cylinderGeometry, extrudeGeometry, latheGeometry,
  mergeGeometries, Path, ringGeometry, Shape,
} from '@margoengine/geometry';
import { roundedBoxGeometry } from '@margoengine/geometry/extras';
import { createMesh, Material } from '@margoengine/materials';
import { hourLine, lat, styleLength } from './solar.js';

const deck = .715;
const profile = [
  [0,0],[Math.cos(lat)*styleLength,Math.sin(lat)*styleLength], 
  [Math.cos(lat)*styleLength+.066,Math.sin(lat)*styleLength-.016],[Math.cos(lat)*styleLength+.116,0],
];
const digitStrokes = [
  [[.16,.04],[.84,.04]],[[.93,.14],[.93,.45]],[[.93,.55],[.93,.86]],
  [[.16,.96],[.84,.96]],[[.07,.55],[.07,.86]],[[.07,.14],[.07,.45]],[[.16,.50],[.84,.50]],
];
const digits = ['012345','12','01643','01623','5612','05623','056234','012','0123456','015623'];
const northStrokes = [[[.15,.95],[.15,.05]],[[.15,.05],[.85,.95]],[[.85,.95],[.85,.05]]];

function moved(geometry,x,y,z,yaw=0) {
  const c=Math.cos(yaw),s=Math.sin(yaw);
  return applyMatrix4(geometry,[c,0,-s,0, 0,1,0,0, s,0,c,0, x,y,z,1]);
}

function horizontal(geometry,x,y,z) {
  return applyMatrix4(geometry,[1,0,0,0, 0,0,-1,0, 0,1,0,0, x,y,z,1]);
}

function drawProfile(path,points) {
  path.moveTo(...points[0]);
  for(const point of points.slice(1)) path.lineTo(...point);
  path.closePath();
  return path;
}

function castFace() {
  const sectors=112, rings=16, radius=2.202;
  const positions=[0,deck,0], normals=[0,1,0], colors=[.92,.93,.89], indices=[];
  for(let r=1;r<=rings;r++) {
    const t=r/rings;
    for(let n=0;n<sectors;n++) {
      const theta=n*2*Math.PI/sectors, x=radius*t*Math.sin(theta), z=-radius*t*Math.cos(theta);
      const mottling=Math.sin(4.3*x+Math.sin(5.7*z))*.019+Math.cos(12.1*z-4.6*x)*.012;
      const age=.055*t**3+mottling;
      positions.push(x,deck,z);
      normals.push(0,1,0);
      colors.push(.947-age,.954-age*.8,.972-age*.7);
      const current=1+(r-1)*sectors+n, next=1+(r-1)*sectors+(n+1)%sectors;
      if(r===1) indices.push(0,next,current);
      else indices.push(current-sectors,next,current,current-sectors,next-sectors,next);
    }
  }
  return {positions,normals,indices,colors};
}
export function prepareCourtyard() {
  const geometry = new Map();
  const finishes = {
    background: {color:'#55514c',roughness:.93},
    foundation: {color:'#8f7b61',roughness:.89},
    stone: {color:'#ac9679',roughness:.87},
    stoneWarm: {color:'#b29e80',roughness:.89},
    stonePale: {color:'#c8b394',roughness:.80},
    joints: {color:'#776859',roughness:.91},
    pedestal: {color:'#cec0a2',roughness:.82},
    pavers: {color:'#9f886d',roughness:.92},
    rim: {color:'#835722',roughness:.31,metalness:.73},
    rimLight: {color:'#d7b16d',roughness:.37,metalness:.48},
    face: {color:'#b29b72',roughness:.69,metalness:.16},
    patina: {color:'#566254',roughness:.83,metalness:.0},
    fine: {color:'#ead397',roughness:.60,metalness:.05},
    marks: {color:'#363730',roughness:.82},
    gnomon: {color:'#c69758',roughness:.32,metalness:.46},
    gnomonEdge: {color:'#e2b379',roughness:.36,metalness:.61},
  };
  function add(key,part) {
    if(!geometry.has(key)) geometry.set(key,[]);
    geometry.get(key).push(part);
  }
  function slab(key,w,h,d,x,y,z,bevel=0,yaw=0) {
    const data=bevel ? roundedBoxGeometry(w,h,d,2,bevel) : boxGeometry(w,h,d);
    add(key,moved(data,x,y,z,yaw));
  }
  function disc(key,top,bottom,h,y,segments=112) {
    add(key,moved(cylinderGeometry(top,bottom,h,segments,1),0,y,0));
  }
  function edge(key,inner,outer,y,segments=112) {
    add(key,horizontal(ringGeometry(inner,outer,segments),0,y,0));
  }
  function stroke(key,a,b,thickness,y=deck+.004) {
    const dx=b[0]-a[0], dz=b[1]-a[1];
    const length=Math.hypot(dx,dz);
    slab(key,thickness,.004,length,(a[0]+b[0])/2,y,(a[1]+b[1])/2,0,Math.atan2(dx,dz));
  }
  function polar(length,angle) { return [length*Math.sin(angle),-length*Math.cos(angle)]; }
  function glyph(strokes,centerX,centerZ,w,h,key) {
    for(const [a,b] of strokes) {
      const point=(p)=>[centerX+(p[0]-.5)*w,centerZ+(p[1]-.5)*h];
      stroke(key,point(a),point(b),.020,deck+.006);
    }
  }

  slab('background',190,.12,190,0,-.65,0);
  slab('joints',8.55,.16,7.23,0,-.49,-.20,.048);
  slab('foundation',8.42,.30,7.12,0,-.27,-.21,.064);
  slab('stonePale',8.40,.068,7.11,0,-.091,-.21,.025);
  slab('joints',8.10,.082,6.88,0,-.049,-.21,.015);
  const columns=12,rows=8, tileWidth=8.08/columns,tileDepth=6.86/rows;
  for(let row=0;row<rows;row++) {
    const z=-3.64+(row+.5)*tileDepth;
    for(let col=0;col<columns;col++) {
      const x=-4.04+(col+.5)*tileWidth;
      const tone=['stone','stoneWarm','pavers','stone','stonePale'][(col*13+row*21+col*row)%5];
      slab(tone,tileWidth-.010,.047,tileDepth-.011,x,-.024,z,.009);
    }
  }
  for(const x of [-4.03,4.03]) {
    slab('pedestal',.265,.16,6.85,x,.051,-.21,.018);
    slab('joints',.035,.025,6.41,x*.965,.079,-.21,.008);
  }
  slab('pedestal',7.86,.116,.23,0,.054,3.097,.017);
  slab('joints',8.04,.104,.32,0,.048,-3.52,.022);
  slab('stone',8.10,.56,.405,0,.281,-3.58,.034);
  slab('pedestal',8.17,.106,.485,0,.608,-3.58,.027);
  for(let n=0;n<9;n++) {
    const x=(n-4)*.892;
    slab('stoneWarm',.677,.329,.024,x,.345,-3.365,.021);
    slab('stonePale',.583,.245,.022,x,.345,-3.346,.019);
    slab('joints',.051,.265,.016,x-.44,.342,-3.332,.009);
  }
  for(const x of [-3.93,3.93]) {
    slab('pedestal',.47,.12,.56,x,.076,-3.49,.032);
    slab('stoneWarm',.34,1.02,.37,x,.606,-3.49,.026);
    slab('stonePale',.46,.087,.51,x,1.17,-3.49,.022);
    slab('pedestal',.385,.054,.43,x,1.238,-3.49,.011);
  }

  disc('joints',2.42,2.44,.066,.032);
  disc('pedestal',2.36,2.40,.145,.121);
  disc('stoneWarm',2.24,2.32,.112,.254);
  const base=latheGeometry([[2.206,.31],[2.18,.35],[2.10,.384],[2.09,.46],[2.14,.49],[2.23,.53]],112);
  add('pedestal',base);
  disc('rim',2.258,2.245,.128,.594);
  disc('rimLight',2.255,2.276,.018,.661);
  disc('rim',2.234,2.255,.054,.683);
  add('face',castFace());
  edge('patina',2.095,2.198,deck+.002);
  edge('rimLight',2.172,2.197,deck+.003);
  edge('fine',2.088,2.099,deck+.004);
  edge('marks',2.048,2.060,deck+.004);
  edge('marks',1.709,1.719,deck+.004);
  edge('fine',.329,.342,deck+.004);

  for(let minute=480;minute<=960;minute+=15) {
    const angle=hourLine(minute);
    const isHour=minute%60===0;
    const isHalfHour=minute%30===0;
    stroke(isHour?'marks':'fine',polar(isHour?.61:isHalfHour?1.826:1.911,angle),polar(2.049,angle),
      isHour?.020:isHalfHour?.012:.007);
    if(!isHour) continue;
    const [x,z]=polar(1.88,angle);
    const hour=String(minute/60);
    for(let i=0;i<hour.length;i++) {
      const strokes=[...digits[Number(hour[i])]].map((s)=>digitStrokes[s]);
      glyph(strokes,x+(i-(hour.length-1)/2)*.135,z,.118,.175,'fine');
    }
  }
  // Compass rose and solar meridian are inlaid into the unused southern half.
  stroke('marks',[0,.67],[0,1.65],.011);
  stroke('marks',[-.49,1.13],[.49,1.13],.009);
  for(const sign of [-1,1]) {
    stroke('fine',[0,.75],[sign*.125,1.13],.016);
    stroke('fine',[sign*.125,1.13],[0,1.49],.016);
    stroke('marks',[0,.75],[sign*.348,1.13],.009);
    stroke('marks',[sign*.348,1.13],[0,1.49],.009);
  }
  glyph(northStrokes,0,.53,.102,.146,'fine');
  for(let n=0;n<16;n++) {
    const angle=2*Math.PI*n/16;
    const [x,z]=polar(2.15,angle);
    add('gnomonEdge',moved(cylinderGeometry(.024,.024,.013,12,1),x,deck+.006,z));
    stroke('marks',[x-.014,z],[x+.014,z],.004,deck+.014);
  }

  slab('rim',.238,.052,1.78,0,deck+.025,-.805,.023);
  const frame=drawProfile(new Shape(),profile);
  const u=Math.cos(lat)*styleLength, v=Math.sin(lat)*styleLength;
  frame.holes.push(drawProfile(new Path(),[
    [.397,.095],[u-.19,.095],[u-.19,v-.32],[u-.37,v-.388],[.594,.367],
  ]));
  // The long upper edge of the metal frame is parallel to Earth's axis.
  const extruded=extrudeGeometry(frame,{depth:.104,bevelEnabled:true,bevelThickness:.017,bevelSize:.016,bevelSegments:2});
  add('gnomon',applyMatrix4(extruded,[0,0,-1,0, 0,1,0,0, 1,0,0,0, -.052,deck,0,1]));
  for(const x of [-.078,.078]) for(const z of [-.106,-1.515])
    add('gnomonEdge',moved(cylinderGeometry(.015,.015,.011,12,1),x,deck+.053,z));

  const parts=Array.from(geometry,([key,faces])=>({
    key,
    data:faces.length===1 ? faces[0] : mergeGeometries(faces),
  }));
  return (engine,shadows) => {
    const drawMeshes = parts.map(({key,data})=>{
      const mesh=createMesh(engine,data,new Material(finishes[key]));
      mesh.root.name='Courtyard '+key;
      const casts = !['background','face','patina','fine','marks','stone','pavers'].includes(key);
      shadows.add(mesh,{static:true,castShadow:casts});
      return mesh;
    });
    return { dispose() { for(const mesh of drawMeshes) mesh.destroy(); } };
  };
}
