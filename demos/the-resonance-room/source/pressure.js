import { createMesh, Material } from '@margoengine/materials';
import { createRoomResponse, listener, room } from './acoustics.js';

const { width, height, length } = room;
const levels = [-.78,-.55,-.32,-.12,0,.12,.32,.55,.78];
const nearZero = [.056,.062,.063];
const below = [.055,.53,1];
const above = [1,.29,.093];

function slice(along, across, point, normal) {
  const points = [], normals = [], indices = [];
  for (let j = 0; j <= across; j++) {
    for (let i = 0; i <= along; i++) {
      points.push(point(i/along,j/across));
      normals.push(...normal);
      if (!i || !j) continue;
      const right = j*(along+1)+i, left = right-1, prev = left-along-1;
      indices.push(prev,right,left,prev,prev+1,right);
    }
  }
  return { points, normals, indices, normal, along, across };
}

function sampleRoom() {
  const points = [];
  for (let y=0; y<=6; y++) for (let z=0; z<=12; z++) for (let x=0; x<=10; x++)
    points.push([(x/10-.5)*width,y/6*height,(z/12-.5)*length]);
  return points;
}

function offsetPoint(point, value, vertical) {
  const [x,y,z] = point;
  return vertical ? [x+value*.20,y,z] : [x,y+value*.231,z];
}

function colors(amount) {
  const amplitude = Math.min(1,Math.abs(amount));
  const tint = amount < 0 ? below : above;
  const gradient = Math.pow(amplitude,.60);
  return [0,1,2].map((i) => nearZero[i]+(tint[i]-nearZero[i])*gradient);
}

function sheet(plane, values, vertical) {
  const positions = [], color = [];
  for (let i=0;i<plane.points.length;i++) {
    const amount = values[i], amplitude = Math.abs(amount);
    positions.push(...offsetPoint(plane.points[i],amount,vertical));
    color.push(...colors(amount), .11 + Math.min(1,amplitude*1.28)*.55);
  }
  return { positions, normals:plane.normals, indices:plane.indices, colors:color };
}

function contourMesh(plane, values, vertical) {
  const positions = [], normals = [], indices = [], color = [];
  const { normal, points, along, across } = plane;
  function segment(start, end, tint, weight) {
    const a = vertical ? 1 : 0, b = 2;
    const dx = end[a]-start[a], dz = end[b]-start[b];
    const span = Math.hypot(dx,dz);
    if (span < 1e-6) return;
    const offset = [0,0,0];
    offset[a] = dz/span*weight;
    offset[b] = -dx/span*weight;
    const first = positions.length/3;
    for (const [point, side] of [[start,1],[start,-1],[end,-1],[end,1]]) {
      positions.push(...point.map((v,i) => v+offset[i]*side + normal[i]*.014));
      normals.push(...normal);
      color.push(...tint);
    }
    indices.push(first,first+1,first+2,first,first+2,first+3);
  }
  function crossing(first, second, level) {
    const a = values[first], b = values[second];
    if ((a >= level) === (b >= level)) return null;
    const step = (level-a)/(b-a), pa = points[first], pb = points[second];
    return offsetPoint(pa.map((p,i) => p + (pb[i]-p)*step),level,vertical);
  }
  for (let i=0;i<plane.indices.length;i+=3) {
    const a = plane.indices[i], b = plane.indices[i+1], c = plane.indices[i+2];
    const lo = Math.min(values[a], values[b], values[c]), hi = Math.max(values[a], values[b], values[c]);
    for (const level of levels) {
      if (level < lo || level > hi) continue;
      const pair = [crossing(a,b,level),crossing(b,c,level),crossing(c,a,level)].filter(Boolean);
      if (pair.length !== 2) continue;
      const palette = level === 0 ? [.49,.56,.53] : colors(level).map((c) => Math.min(1,c*.85+.09));
      segment(pair[0],pair[1],palette,level===0?.0095:.007);
    }
  }
  const edgeColor = [.20,.24,.23];
  for (let n=0;n<along;n++) {
    for (const start of [n,across*(along+1)+n])
      segment(offsetPoint(points[start],values[start],vertical),offsetPoint(points[start+1],values[start+1],vertical),edgeColor,.009);
  }
  for (let n=0;n<across;n++) {
    for (const start of [n*(along+1),n*(along+1)+along])
      segment(offsetPoint(points[start],values[start],vertical),offsetPoint(points[start+along+1],values[start+along+1],vertical),edgeColor,.009);
  }
  return { positions, normals, indices, colors:color };
}

export function preparePressureDisplay(frequency) {
  const plan = slice(40,51,(u,v) => [(u-.5)*(width-.18),listener[1],(v-.5)*(length-.20)],[0,1,0]);
  const section = slice(29,51,(u,v) => [0,.12+u*(height-.25),(v-.5)*(length-.20)],[1,0,0]);
  const response = createRoomResponse([...plan.points,...section.points,...sampleRoom(),listener]);
  function read(frequency,orientation) {
    const reading = response(frequency);
    const vertical = orientation === 'section';
    const plane = vertical ? section : plan, start = vertical ? plan.points.length : 0;
    const values = reading.signed.subarray(start,start+plane.points.length);
    return { reading, mesh:sheet(plane,values,vertical), contours:contourMesh(plane,values,vertical) };
  }
  const first = read(frequency,'plan');
  return (engine) => {
    const surfaceMaterial = new Material({ shading:'basic',color:'#fff',transparent:true,depthWrite:false,doubleSided:true });
    const lineMaterial = new Material({ shading:'basic',color:'#fff',doubleSided:true });
    const overlay = createMesh(engine,first.mesh,surfaceMaterial);
    overlay.root.name = 'Acoustic pressure phase slice';
    const lines = createMesh(engine,first.contours,lineMaterial);
    lines.root.name = 'Acoustic pressure isolines';

    return {
      first:first.reading,
      setPressure(frequency,orientation) {
        const { reading,mesh,contours } = read(frequency,orientation);
        overlay.setGeometry(mesh);
        lines.setGeometry(contours);
        return reading;
      },
      dispose() { overlay.destroy(); lines.destroy(); },
    };
  };
}
