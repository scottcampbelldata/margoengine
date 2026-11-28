import { box, Geometry, PbrMaterial } from '@margoengine/core';
import { randomFrom } from './birds.js';

const waterline = -11.5;
const material = (color, roughness = .84) => new PbrMaterial({color,roughness,metalness:0});
const batch = () => ({points:[],normals:[],indices:[]});

function face(mesh,a,b,c,normal=[0,1,0]) {
  const start = mesh.points.length / 3;
  mesh.points.push(...a,...b,...c);
  mesh.normals.push(...normal,...normal,...normal);
  mesh.indices.push(start,start+1,start+2);
}

function slab(mesh,x,z,l,w,angle,y) {
  const dx = Math.cos(angle) * l / 2, dz = Math.sin(angle) * l / 2;
  const wx = -Math.sin(angle) * w / 2, wz = Math.cos(angle) * w / 2;
  const a = [x-dx-wx,y,z-dz-wz], b = [x-dx+wx,y,z-dz+wz];
  const c = [x+dx+wx,y,z+dz+wz], d = [x+dx-wx,y,z+dz-wz];
  face(mesh,a,b,c);
  face(mesh,a,c,d);
}

function install(engine, mesh, color, roughness) {
  const geometry = new Geometry(mesh.points,mesh.normals,mesh.indices);
  engine.createMesh().setGeometry(geometry).setMaterial(material(color,roughness));
}

const bankLine = (x,z,l,w,a) => ({x,z,l,w,a});
const banks = [
  bankLine(-42,18,45,9,.21), bankLine(35,3,52,8,-.13),
  bankLine(-36,-21,53,11,-.08), bankLine(29,-35,40,10,.11),
  bankLine(3,-52,89,8,-.04), bankLine(-65,-66,52,18,.05),
  bankLine(35,-85,102,10,-.08), bankLine(-43,-105,98,15,.03),
];

export function buildMarsh(engine) {
  const random=randomFrom(433819), water=batch();
  slab(water,0,-167,1400,1100,0,waterline);
  install(engine,water,'#6b606d',.48);

  const channels = [batch(),batch(),batch(),batch()];
  for (let i=0;i<970;i++) {
    const z = 45 - 137 * random() ** 1.46;
    const x = 150 * (random() - .5);
    const glint = 1 - Math.min(1, Math.abs(x + 18) / 35);
    const palette = glint > .67 && random() > .5 ? 3 : Math.floor(random()*3);
    slab(channels[palette],x,z,.35+2.7*random(),.07+.23*random(),(.5-random())*.17,waterline+.006);
  }
  const ripples=['#85808a','#7b7081','#a78e93','#cb958b'];
  for(const [i, mesh] of channels.entries()) install(engine,mesh,ripples[i],.46);

  const mud=batch(), blades=[batch(),batch(),batch()];
  for (const bank of banks) {
    const points=[];
    const cos=Math.cos(bank.a), sin=Math.sin(bank.a);
    const inBank=(u,v,y)=>[bank.x+u*cos-v*sin,y,bank.z+u*sin+v*cos];
    for(let i=0;i<27;i++){
      const phase=i*2*Math.PI/27, jitter=.84+random()*.22;
      points.push(inBank(Math.cos(phase)*bank.l*.5*jitter,Math.sin(phase)*bank.w*.5*jitter,waterline+.18));
    }
    const middle=[bank.x,waterline+.62,bank.z];
    for(let i=0;i<points.length;i++)face(mud,middle,points[(i+1)%points.length],points[i]);

    for(let i=0;i<160;i++){
      const u=bank.l*(random()-.5)*.94;
      const side=(i%2)*2-1, v=side*bank.w*(.26+random()*.19);
      const [x,y,z]=inBank(u,v,waterline+.22);
      const height=.28+random()*.86, lean=(random()-.25)*.47;
      const mesh=blades[Math.floor(random()*blades.length)], r=.018+random()*.019;
      const joint=[x+lean*.30,y+height*.61,z+.04], top=[x+lean,y+height,z+.06];
      face(mesh,[x-r,y,z],[x+r,y,z],joint,[0,.25,1]);
      face(mesh,[joint[0]-r*.72,joint[1],joint[2]],[joint[0]+r*.72,joint[1],joint[2]],top,[0,.25,1]);
      const leaf=[joint[0]+side*.17,joint[1]+.21,joint[2]-.025];
      face(mesh,joint,[joint[0]+side*.04,joint[1]+.08,joint[2]+.012],leaf,[0,.25,1]);
    }
  }
  install(engine,mud,'#403b45',.94);
  const reeds=['#504744','#62554f','#73584c'];
  for(const [i, mesh] of blades.entries()) install(engine,mesh,reeds[i],.90);

  const stake = box(.19,3.2,.18), timber = material('#4b3c42');
  for (const [x,z] of [[-27,7],[-24,0],[-21,-7],[-18,-14],[-15,-21],[-12,-28]]) {
    const post = engine.createMesh().setGeometry(stake).setMaterial(timber);
    post.setPosition([x,waterline+.79+random()*.24,z]);
  }
}
