import { Geometry, PbrMaterial, box } from '@margoengine/core';
import { cylinderGeometry, icosahedronGeometry, latheGeometry, torusGeometry } from '@margoengine/geometry/primitives';
import { roundedBoxGeometry } from '@margoengine/geometry/extras';
import { toGeometry } from '@margoengine/geometry/utils';
import { axisAngleToQuaternion, rotateByQuaternion } from '@margoengine/math/quat';
import { fullLength, grain, sandY, shortLength } from './motion.js';

const beamHeight = .796;
const anchors = [[-.306, beamHeight, .008],[.306, beamHeight, .008]];

function aimY(from, to) {
  const x = to[0] - from[0], y = to[1] - from[1], z = to[2] - from[2];
  const horizontal = Math.hypot(x, z);
  const pitch = Math.atan2(horizontal, y);
  return axisAngleToQuaternion(horizontal ? [z / horizontal, 0, -x / horizontal] : [1, 0, 0], pitch);
}

function sandSurface(samples) {
  const xyz = [], normals = [], indices = [];
  for (let i = 0; i < samples.length; i++) {
    const [x, y, z] = samples[i].point;
    const a = samples[Math.max(0, i - 1)].point, b = samples[Math.min(i + 1, samples.length - 1)].point;
    const dx = b[0] - a[0], dz = b[2] - a[2];
    const length = Math.hypot(dx, dz) || 1;
    const width = .00175 + .00145 / (1 + samples[i].speed * 1.8);
    const variation = .91 + .19 * Math.sin(x * 16371 + z * 4553) ** 2;
    const tx = -dz / length * width * variation, tz = dx / length * width * variation;
    xyz.push(x + tx, y + .00036, z + tz, x, y + .00144 * variation, z, x - tx, y + .00036, z - tz);
    normals.push(.11, .98, .05, 0, 1, 0, -.11, .98, -.05);
    if (i) {
      const p = 3 * (i - 1);
      indices.push(p,p+3,p+1,p+3,p+4,p+1,p+1,p+4,p+2,p+4,p+5,p+2);
    }
  }
  return new Geometry(xyz, normals, indices);
}

export function makePendulum(engine, shadows) {
  const material = (color, roughness, metalness = 0) => new PbrMaterial({ color, roughness, metalness });
  const background = material('#3b5155', .83);
  const black = material('#303a3b', .56);
  const walnut = material('#654831', .55);
  const walnutCut = material('#503828', .55);
  const bevel = material('#9b6e49', .51);
  const iron = material('#475456', .56, 1);
  const enamel = material('#364c54', .44);
  const ink = material('#293a43', .88);
  const brass = material('#bb9150', .35, 1);
  const shiny = material('#cbb37c', .26, 1);
  const aged = material('#966e42', .44, 1);
  const steel = material('#aeb6af', .32, 1);
  const silk = material('#b3a589', .64);
  const sand = material('#e2ca93', .77);

  function node(name, at, parent = null) {
    const value = engine.createMesh(parent).setPosition(at);
    value.name = name;
    return value;
  }
  function add(name, mesh, paint, at, parent, shadow = true, flexible = false) {
    const value = node(name, at, parent).setGeometry('uvs' in mesh ? toGeometry(mesh) : mesh).setMaterial(paint);
    if (shadow) shadows.add(value, { static: !flexible });
    return value;
  }
  function block(name, dims, radius, paint, at, parent) {
    return add(name, roundedBoxGeometry(...dims, 2, radius), paint, at, parent);
  }
  function turned(name, radius, height, paint, at, parent = null, sides = 48, movable = false) {
    return add(name, cylinderGeometry(radius, radius, height, sides), paint, at, parent, true, movable);
  }

  add('Studio floor', box(42, .09, 42), background, [0,-.084,0], null, false);
  block('Walnut plinth', [.900,.065,.681], .021, walnut, [0,-.005,0]);
  block('Lower plinth bevel', [.870,.013,.649], .006, walnutCut, [0,-.034,0]);
  block('Top brass reveal', [.854,.0045,.631], .0021, brass, [0,.031,0]);
  block('Slab topside', [.850,.020,.624], .011, walnut, [0,.040,0]);
  for (const x of [-.33,.33]) {
    for (const z of [-.230,.216]) {
      block('Felt isolation foot', [.100,.022,.071], .009, black, [x,-.035,z]);
      turned('Plinth corner screw', .0088, .006, steel, [x,.049,z], null, 6);
    }
  }
  const tray = node('Sand tablet', [0,0,.013]);
  block('Tray backing', [.622,.017,.546], .011, black, [0,.051,0], tray);
  block('Slate drawing field', [.597,.019,.521], .007, ink, [0,sandY-.0095,0], tray);
  for (const side of [-1,1]) {
    block('Enamel tray side', [.017,.020,.538], .006, enamel, [side*.303,.067,0], tray);
    block('Enamel tray edge', [.599,.020,.018], .006, enamel, [0,.067,side*.266], tray);
    block('Brass tray inset', [.0038,.0039,.475], .0017, aged, [side*.305,.0785,0], tray);
  }
  const markings = toGeometry(roundedBoxGeometry(.0013,.0009,.0075,2,.0004));
  for (let i=-11; i<=11; i++) {
    const tick=add('Engraved length mark',markings,shiny,[i*.0205,.0779,.282],null,false);
    if(i%5===0)tick.setScale([1,1,1.56]);
  }

  for (const side of [-1,1]) {
    const x = side*.365;
    block('Brass shoe under upright', [.116,.019,.136], .008, aged, [x,.057,-.010]);
    block('Rounded walnut upright', [.071,.718,.062], .011, walnut, [x,.411,.012]);
    block('Inset upright field', [.045,.580,.010], .004, walnutCut, [x,.436,.044]);
    block('Chamfered upright edge', [.004,.590,.009], .002, bevel, [x+side*.021,.436,.046]);
    block('Flared upper bearing', [.090,.048,.081], .010, brass, [x,.762,.010]);
    for (const z of [-.053,.037]) turned('Upright fixing', .008, .007, steel, [x,.068,z], null, 6);
  }
  block('Walnut overhead beam', [.837,.054,.076], .009, walnut, [0,.823,.010]);
  block('Cut brass beam flange', [.742,.0062,.043], .0024, aged, [0,.793,.010]);
  for (const a of anchors) {
    turned('Wire anchor barrel', .015,.018,shiny,[a[0],beamHeight+.001,a[2]],null,28);
    turned('Anchor eye',.0064,.019,steel,[a[0],beamHeight-.010,a[2]],null,24);
  }
  const hopper=node('Suspended brass hopper',[0,0,0]);
  const turnedHopper = latheGeometry([
    [.004,.001],[.0085,.002],[.0108,.012],[.015,.031],[.033,.047],[.057,.072],
    [.067,.091],[.068,.105],[.065,.108],[.062,.106],[.060,.090],[.048,.069],
    [.016,.029],[.007,.014],[.004,.006],[.004,.001],
  ],108);
  add('Spun brass vessel',turnedHopper,brass,[0,0,0],hopper,true,true);
  add('Hopper rolled lip',torusGeometry(.0646,.0025,8,80),shiny,[0,.106,0],hopper,true,true)
    .setQuaternion(axisAngleToQuaternion([1,0,0],Math.PI/2));
  turned('Polished nozzle',.0075,.010,steel,[0,.005,0],hopper,36,true);
  turned('Sand visible inside vessel',.0585,.0023,sand,[0,.086,0],hopper,70,true);
  add('Hopper suspension ring',torusGeometry(.011,.0018,8,36),shiny,[0,.141,0],hopper,true,true);
  for (const i of [0,1,2]) {
    const angle=i*Math.PI*2/3;
    const top=[0,.135,0], low=[.061*Math.cos(angle),.100,.061*Math.sin(angle)];
    const middle=top.map((v,j)=>(v+low[j])*.5);
    const stay=turned('Hopper bridle',.0014,Math.hypot(...top.map((v,j)=>v-low[j])),silk,middle,hopper,6,true);
    stay.setQuaternion(aimY(low,top));
  }

  const yJoint=turned('Suspension junction',.0080,.015,aged,[0,0,0],null,24,true);
  const cords=Array.from({length:3},()=>add('Tensioned suspension thread',cylinderGeometry(.00145,.00145,1,8),
    silk,[0,0,0],null,false));
  function cord(item,a,b) {
    item.setPosition(a.map((v,i)=>(v+b[i])*.5));
    item.setScale([1,Math.hypot(...b.map((v,i)=>v-a[i])),1]);
    item.setQuaternion(aimY(a,b));
  }

  const accumulated = Array.from({length:8},()=>node('Deposited sand',[0,0,0]).setMaterial(sand));
  const pebble=toGeometry(icosahedronGeometry(.00137,0));
  const airborne=Array.from({length:22},()=>add('Falling sand',pebble,sand,[0,0,0],null,false));
  const stepSize=103;
  let lastCount=0;
  function deposits(samples) {
    if (samples.length===lastCount) return;
    if (samples.length < lastCount) {
      for(const item of accumulated)item.visible=false;
      lastCount=0;
    }
    if(samples.length>=2){
      const first=Math.max(0,Math.floor((lastCount-2)/stepSize));
      const last=Math.min(accumulated.length-1,Math.floor((samples.length-2)/stepSize));
      for(let i=first;i<=last;i++){
        const item=accumulated[i],from=i*stepSize;
        item.setGeometry(sandSurface(samples.slice(from,from+stepSize+1)));
        item.visible=true;
      }
    }
    lastCount=samples.length;
  }

  return {
    pose(p, ratio, visibleGrains) {
      const at=[p.x,p.y,p.z];
      const short=shortLength(ratio);
      const join=[0,.116+short+p.z*p.z/(2*fullLength)*.42,p.z*(1-short/fullLength)];
      const rotation=aimY(at,join);
      hopper.setPosition(at).setQuaternion(rotation);
      yJoint.setPosition(join);
      cord(cords[0],anchors[0],join);
      cord(cords[1],anchors[1],join);
      cord(cords[2],join,rotateByQuaternion([0,.149,0],rotation).map((v,i)=>v+at[i]));
      for(const [index,item] of airborne.entries()){
        const bead=visibleGrains[index];
        item.visible=Boolean(bead);
        if(bead){
          const xyz=grain(bead.p,bead.age);
          xyz[0]+=.0014*Math.sin(index*23.19);
          xyz[2]+=.0017*Math.cos(index*17.21);
          item.setPosition(xyz);
        }
      }
    },
    deposits,
  };
}
