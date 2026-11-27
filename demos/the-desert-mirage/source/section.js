import { PbrMaterial } from '@margoengine/core';
import { roundedBoxGeometry } from '@margoengine/geometry/extras';
import { cylinderGeometry } from '@margoengine/geometry/primitives';
import { toGeometry } from '@margoengine/geometry/utils';
import { Line, Lines } from '@margoengine/lines';
import { distanceLimit, eyeHeight, targetAngle, trace } from './optics.js';

const left = -1.10;
const width = 2.20;
const height = .68;
const railHeight = .065;
const scaleHeight = height / 1.0;
const rayZ = .119;
const shots = [
  { elevation: targetAngle, color: '#f8b46e', width: 3.1 },
  { elevation: -.175, color: '#a5c4cd', width: 1.7 },
  { elevation: -.490, color: '#ba7860', width: 1.6 },
];

function chartPoint(x, y) {
  return [left + width * x / distanceLimit, railHeight + y * scaleHeight, rayZ];
}
function positions(points) {
  const data = [];
  for (let i = 0; i < points.length; i++) {
    const [x,y] = points[i];
    if (y <= 1) {
      data.push(...chartPoint(x,y));
    } else {
      const [previousX,previousY] = points[i-1];
      const f = (1 - previousY) / (y - previousY);
      data.push(...chartPoint(previousX + (x - previousX) * f,1));
      break;
    }
  }
  return data;
}

export function installSection(engine, temperature) {
  const parent = engine.createMesh();
  const finish = (color, roughness, metalness = 0) => new PbrMaterial({ color, roughness, metalness });
  const enclosure = finish('#4b3d3b', .41);
  const castMetal = finish('#a36950', .34, 1);
  const clampBlack = finish('#343236', .70);
  const enamel = finish('#c97c48', .43);
  const surface = finish('#555259', .93);
  const roadPaint = finish('#d39d67', .84);
  const face = finish('#342c35', .90);
  const grid = finish('#676068', .81);
  const bright = finish('#d5bcaa', .45, 1);
  const light = finish('#bf8e6e', .48);
  const layer = finish('#74534e', .83);
  const sensor = finish('#b1a7a3', .43, 1);
  const hole = finish('#494148', .60);
  const tableMaterial = finish('#433934', .64);
  const modelParts = [];
  const make = (geometry, material, at) => {
    const mesh=engine.createMesh(parent).setGeometry(geometry).setMaterial(material).setPosition(at);
    modelParts.push(mesh);
    return mesh;
  };
  const box = (x,y,z,r,material,at) => make(toGeometry(roundedBoxGeometry(x,y,z,2,r)),material,at);
  const makeCylinder = (radius,depth,extent,material,at) => make(toGeometry(cylinderGeometry(radius,radius,depth,extent,1)),material,at);

  box(2.61,.065,.58,.024,tableMaterial,[0,-.127,.02]);
  box(2.44,.108,.46,.036,enclosure,[0,-.043,.036]);
  box(2.40,.027,.421,.008,castMetal,[0,.015,.036]);
  box(2.30,.030,.366,.010,surface,[0,.036,.057]);
  box(2.205,.003,.009,.001,roadPaint,[0,.052,.166]);
  box(2.42,.795,.089,.023,clampBlack,[0,.416,-.039]);
  box(2.355,.728,.020,.009,castMetal,[0,.420,.006]);
  box(2.299,.683,.021,.008,face,[0,.409,.020]);

  box(2.20,.060,.010,.003,layer,[0,railHeight+.029,.040]);
  const chart = [];
  for(let i=0;i<6;i++){
    const y=railHeight+i*height/5;
    chart.push(left,y,.067,left+width,y,.067);
  }
  const major = toGeometry(roundedBoxGeometry(.006,.015,.007,1,.001));
  const minor = toGeometry(roundedBoxGeometry(.003,.007,.005,1,.001));
  for(let i=0;i<=32;i++) {
    const mark=left+width*i/32;
    if(i%4===0)chart.push(mark,railHeight,.067,mark,railHeight+height,.067);
    make(i%4===0?major:minor,i%4===0?bright:grid,[mark,railHeight+.003,.064]);
  }
  const strip = toGeometry(roundedBoxGeometry(.022,.683,.040,2,.009));
  const fastener = toGeometry(cylinderGeometry(.011,.011,.012,16,1));
  for(const x of [-1.166,1.166]){
    make(strip,clampBlack,[x,.410,.032]);
    for(const y of [.159,.673]) {
      make(fastener,bright,[x,y,.059]).setQuaternion([Math.SQRT1_2,0,0,Math.SQRT1_2]);
    }
  }

  box(.132,.030,.140,.009,clampBlack,[left,.069,rayZ]);
  makeCylinder(.019,.314,20,sensor,[left,.246,rayZ]);
  for(const y of [.130,.352])makeCylinder(.031,.026,22,enamel,[left,y,rayZ]);
  box(.125,.056,.079,.017,enclosure,[left-.058,chartPoint(0,eyeHeight)[1],rayZ]);
  box(.036,.031,.064,.011,bright,[left-.019,chartPoint(0,eyeHeight)[1],rayZ]);
  makeCylinder(.014,.012,24,hole,[left+.001,chartPoint(0,eyeHeight)[1],rayZ])
    .setQuaternion([0,0,Math.SQRT1_2,Math.SQRT1_2]);

  const lines=Lines.attach(engine);
  const ruling=lines.add(new Line({color:'#98818b',width:1,mode:'segments',opacity:.45,positions:chart}));
  const rays=shots.map(({color,width})=>lines.add(new Line({color,width,cap:'round',join:'round'})));
  const marks=lines.add(new Line({color:'#ffc28e',width:1.25,mode:'segments',opacity:.68}));
  const contextLines=lines.add(new Line({color:'#bf9682',width:1.25,mode:'segments',opacity:.53}));
  contextLines.setPositions([left,railHeight+.001,rayZ,left+width,railHeight+.001,rayZ]);
  let shown=false, turning;
  function setTemperature(value) {
    for(let i=0;i<shots.length;i++){
      const ray=trace(shots[i].elevation,value,{path:true});
      rays[i].setPositions(positions(ray.points));
      if(i===0)turning=ray.turn;
    }
    if(turning){
      const [x,y,z]=chartPoint(turning.distance,turning.height);
      const r=.018;
      marks.setPositions([x-r,y,z,x+r,y,z,x,y-r,z,x,y+r,z]);
    }
    marks.visible=shown&&Boolean(turning);
  }
  function setView(value) {
    shown=value;
    parent.setPosition([0,value?0:-50,0]);
    for(const ray of rays)ray.visible=value;
    contextLines.visible=value;
    ruling.visible=value;
    marks.visible=value&&Boolean(turning);
  }
  setTemperature(temperature);
  setView(false);
  return {setTemperature,setView,modelParts};
}
