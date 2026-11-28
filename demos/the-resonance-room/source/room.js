import {
  applyMatrix4, boxGeometry, cylinderGeometry, mergeGeometries, sphereGeometry, torusGeometry,
} from '@margoengine/geometry';
import { roundedBoxGeometry } from '@margoengine/geometry/extras';
import { createMesh, Material, Texture } from '@margoengine/materials';
import { listener, room, source } from './acoustics.js';

const { width, height, length } = room;
const halfWidth = width / 2, halfLength = length / 2;
const turn = Math.PI / 2;

function moved(geometry, x, y, z, yaw = 0) {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  return applyMatrix4(geometry, [c,0,-s,0, 0,1,0,0, s,0,c,0, x,y,z,1]);
}

function frontFacing(geometry, x, y, z) {
  return applyMatrix4(geometry, [1,0,0,0, 0,0,1,0, 0,-1,0,0, x,y,z,1]);
}

function ashGrain() {
  const width = 64, height = 128;
  const pixels = new Uint8Array(width*height*4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const u = x / width, v = y / height;
      const bend = Math.sin(v*6.8+u*4.2)*.30+Math.sin(v*15.1-u*10.3)*.14;
      const latewood = Math.pow(.5+.5*Math.sin(u*58+v*.95+bend),5);
      const fibre = Math.sin(u*161+v*3.2+bend*3);
      const value = Math.round(244-latewood*13+fibre*3);
      const offset = (y*width+x)*4;
      pixels.set([value,value,value,255],offset);
    }
  }
  return new Texture({ data:pixels,width,height },{ anisotropy:4 });
}
export function prepareRoom() {
  const groups = new Map(), grain = ashGrain();
  const surfaces = {
    deck: { color: '#353238', roughness: .89 },
    concrete: { color: '#716367', roughness: .96 },
    plaster: { color: '#a09997', roughness: .87 },
    backing: { color: '#352b29', roughness: .97 },
    fascia: { color: '#57443f', roughness: .62 },
    ash: { color: '#9b7259', roughness: .54 },
    ashLight: { color: '#a87c65', roughness: .59 },
    ashDark: { color: '#896049', roughness: .65 },
    floorAsh: { color: '#9b775e', roughness: .52, map:grain },
    floorLight: { color: '#a18168', roughness: .55, map:grain },
    floorDark: { color: '#927057', roughness: .58, map:grain },
    panel: { color: '#37383a', roughness: .96 },
    panelWarm: { color: '#443839', roughness: .96 },
    leather: { color: '#8b4e42', roughness: .66 },
    piping: { color: '#a16351', roughness: .63 },
    metal: { color: '#9c8064', roughness: .35, metalness: .84 },
    hardware: { color: '#59504e', roughness: .42, metalness: .46 },
    speaker: { color: '#3c4148', roughness: .64 },
    surround: { color: '#2b3035', roughness: .82 },
    cone: { color: '#68656a', roughness: .55 },
    vinyl: { color: '#464044', roughness: .50 },
    paper: { color: '#d1bb9e', roughness: .88 },
    cove: { color: '#e5ab6b', emissive: [1,.49,.19], emissiveIntensity: .52, roughness: .58 },
    signal: { color: '#7ac6d1', emissive: [.24,.70,.75], emissiveIntensity: .58, roughness: .38 },
  };
  function add(finish, geometry) {
    if (!groups.has(finish)) groups.set(finish, []);
    groups.get(finish).push(geometry);
  }
  function block(finish, w, h, d, x, y, z, bevel = 0, yaw = 0) {
    const piece = bevel ? roundedBoxGeometry(w,h,d,2,bevel) : boxGeometry(w,h,d);
    add(finish, moved(piece,x,y,z,yaw));
  }
  function ring(finish, radius, tube, x, y, z, count = 32) {
    add(finish, moved(torusGeometry(radius,tube,8,count),x,y,z));
  }
  function cone(finish, front, rear, depth, x, y, z, count = 32) {
    add(finish, frontFacing(cylinderGeometry(front,rear,depth,count,1),x,y,z));
  }

  block('deck', 240,.18,240,0,-.63,0);
  block('fascia', 5.22,.18,6.61,0,-.445,0,.043);
  block('concrete', 5.08,.32,6.50,0,-.205,0,.025);
  block('metal', 5.10,.022,6.52,0,-.354,0);
  block('backing', 4.84,.075,6.25,0,-.043,0);
  const floorRows = 30, strip = width / floorRows;
  for (let n = 0; n < floorRows; n++) {
    const x = -halfWidth + (n + .5) * strip;
    const seam = -1.42 + ((n * 17) % 23) / 8.2;
    const pieces = [[-halfLength,seam],[seam,halfLength]];
    pieces.forEach(([start,end], index) => {
      const finish = ['floorDark','floorAsh','floorLight','floorAsh','floorDark'][(n*3 + index*2) % 5];
      block(finish, strip-.004,.025,end-start-.006,x,-.013,(start+end)/2,.003);
    });
  }

  // The section cut exposes the slab and two of the room's six rigid boundaries.
  block('plaster', width+.17,height,.19,-.008,height/2,-halfLength-.095,.012);
  block('plaster', .19,height,length+.19,-halfWidth-.095,height/2,-.095,.012);
  block('fascia', width+.24,.082,.244,-.025,height+.01,-halfLength-.095,.016);
  block('fascia', .244,.082,length+.24,-halfWidth-.095,height+.01,-.12,.015);
  block('metal', width+.24,.016,.26,-.025,height+.059,-halfLength-.095,.004);
  block('metal', .26,.016,length+.215,-halfWidth-.095,height+.059,-.108,.004);
  block('fascia', width,.13,.095,0,.065,-halfLength+.045,.012);
  block('fascia', .095,.13,length,-halfWidth+.045,.065,0,.012);
  block('fascia', .10,height,.11,-halfWidth+.064,height/2,halfLength-.05,.014);
  block('fascia', .12,height,.09,halfWidth-.035,height/2,-halfLength+.04,.013);
  block('cove', width-.29,.035,.055,0,2.48,-halfLength+.065);
  block('ashDark', width-.25,.11,.13,0,2.54,-halfLength+.066,.008);
  block('cove', .055,.035,length-.29,-halfWidth+.065,2.48,-.018);
  block('ashDark', .13,.11,length-.25,-halfWidth+.064,2.54,-.019,.008);

  // Repeated timber cassettes over charcoal fabric use a quadratic-residue diffuser profile.
  block('backing', 3.62,1.54,.105,.03,1.56,-3.025,.019);
  block('metal', 3.68,.026,.17,.03,2.351,-2.98,.006);
  block('metal', 3.68,.026,.17,.03,.777,-2.98,.006);
  for (let bay = 0; bay < 3; bay++) {
    for (let slot = 0; slot < 11; slot++) {
      const depth = .065 + ((slot*slot)%11) * .0135;
      const x = -.03 + (bay-1)*1.17 + (slot-5)*.101;
      const finish = ['ash','ashLight','ashDark','ash','ash'][(slot+bay)%5];
      block(finish,.075,1.47,depth,x,1.56,-2.97+depth*.5,.006);
    }
  }
  for (const z of [-2.07,-.83,.41,1.65]) {
    block('fascia',.15,1.75,1.109,-2.306,1.396,z,.023);
    block(z>1?'panelWarm':'panel',.05,1.70,1.057,-2.217,1.396,z,.022);
    for (const edge of [-.5,.5]) block('metal',.008,1.6,.012,-2.18,1.396,z+edge,.003);
  }

  // The acoustic lab's two speakers have a waveguide, surrounds, cones and separate mounting hardware.
  for (const x of [source[0],-source[0]]) {
    block('fascia', .69,.07,.66,x,.055,-2.56,.024);
    block('hardware', .59,.081,.55,x,.122,-2.56,.020);
    block('speaker', .558,1.247,.52,x,.792,-2.568,.079);
    block('surround', .489,1.147,.042,x,.795,-2.293,.040);
    for (const [y, radius] of [[.475,.190],[.858,.150]]) {
      cone('hardware',radius+.022,radius+.022,.017,x,y,-2.266);
      ring('surround',radius,.016,x,y,-2.246);
      cone('cone',radius-.016,radius*.46,.061,x,y,-2.254);
      cone('vinyl',radius*.39,radius*.44,.027,x,y,-2.221);
      ring('hardware',radius+.021,.0035,x,y,-2.249);
      for (let n=0;n<6;n++) {
        const angle = n * Math.PI / 3;
        cone('metal',.006,.006,.005,x+Math.cos(angle)*(radius+.012),y+Math.sin(angle)*(radius+.012),-2.248,8);
      }
    }
    cone('hardware',.107,.111,.032,x,1.174,-2.252);
    cone('surround',.083,.056,.036,x,1.174,-2.230);
    cone('metal',.025,.036,.045,x,1.174,-2.208);
    block('metal',.069,.012,.008,x-.147,1.295,-2.267,.003);
    block(x<0?'signal':'hardware',.014,.014,.008,x+.178,1.294,-2.269,.003);
  }
  // Equipment rack and its actual front-panel features.
  block('speaker',1.245,.402,.39,0,.214,-2.585,.034);
  block('hardware',1.165,.21,.022,0,.249,-2.365,.015);
  block('signal',.207,.051,.013,-.355,.257,-2.348,.011);
  for (let i=0;i<17;i++) {
    block('surround',.01,.021,.011,-.155+i*.025,.243,-2.348,.003);
    if(i<11) block(i<8?'signal':'cove',.005,.008+i*.0004,.01,-.155+i*.025,.246,-2.339,.002);
  }
  cone('metal',.063,.064,.041,.449,.252,-2.338,28);
  cone('hardware',.048,.047,.013,.449,.252,-2.310,24);
  for (const x of [-.49,.49]) block('fascia',.12,.043,.26,x,.041,-2.57,.012);

  // A low listening chair keeps the ear-height sampling plane above the cushions.
  const seatZ = listener[2] + .09;
  for (const x of [-.47,.47]) {
    block('metal',.043,.30,.05,x,.15,seatZ-.32,.010,-.13);
    block('metal',.043,.30,.05,x,.15,seatZ+.38,.010,.13);
    block('ashDark',.075,.055,.86,x,.29,seatZ+.025,.018);
    block('leather',.15,.205,.877,x,.54,seatZ+.015,.068);
    block('piping',.065,.027,.73,x,.644,seatZ+.014,.012);
  }
  block('leather', .974,.229,.872,0,.402,seatZ-.035,.094);
  block('piping', .842,.028,.737,0,.511,seatZ-.065,.013);
  block('leather', .988,.671,.214,0,.71,seatZ+.399,.092);
  block('piping', .851,.572,.074,0,.74,seatZ+.495,.036);
  block('leather', .585,.127,.193,0,1.016,seatZ+.36,.061);

  const tableX = 1.26, tableZ = 1.61;
  for (const x of [-.18,.18]) for (const z of [-.17,.17])
    block('hardware',.035,.42,.035,tableX+x,.21,tableZ+z,.009);
  block('ashDark',.50,.042,.48,tableX,.44,tableZ,.017);
  block('paper',.18,.032,.228,tableX-.075,.478,tableZ+.05,.006,.22);
  block('fascia',.197,.009,.243,tableX-.075,.491,tableZ+.05,.003,.22);
  block('paper',.23,.017,.15,tableX+.083,.472,tableZ-.078,.006,-.27);
  add('metal',moved(cylinderGeometry(.036,.029,.048,17,1),tableX+.115,.489,tableZ+.114));
  add('surround',moved(cylinderGeometry(.035,.03,.005,17,1),tableX+.115,.516,tableZ+.114));

  // Engraved length ticks are on the cutaway, independent of the data layer.
  for (let i=0;i<25;i++) {
    const x = -2.24+i*(4.48/24);
    const long = i%6===0;
    block(long?'metal':'fascia',.008,long?.104:.054,.005,x,-.192+(long?.018:0),3.252);
  }
  block('metal',.54,.163,.018,1.79,-.195,3.264,.012);
  for (const x of [1.57,2.014]) cone('fascia',.017,.015,.006,x,-.195,3.276,10);

  const parts = Array.from(groups,([finish,geometries]) => ({
    finish,
    geometry: geometries.length===1 ? geometries[0] : mergeGeometries(geometries),
  }));
  return (engine,shadows) => {
    const models = parts.map(({ finish,geometry }) => {
      const model = createMesh(engine,geometry,new Material(surfaces[finish]));
      model.root.name = 'Listening room ' + finish;
      if (finish!=='cove' && finish!=='signal')
        shadows.add(model,{ static:true,castShadow:finish!=='deck' && !finish.startsWith('floor') });
      return model;
    });
    const warm = new Material({ shading:'basic',color:'#f7bc84' });
    const cool = new Material({ shading:'basic',color:'#98d7f7' });
    const seatRing = createMesh(engine,torusGeometry(.135,.007,7,30),warm);
    seatRing.root.setPosition(listener).setRotation([turn,0,0]);
    seatRing.root.name = 'Acoustic probe ring';
    const marker = sphereGeometry(.025,12,8);
    const seatPoint = createMesh(engine,marker,warm);
    seatPoint.root.setPosition(listener);
    seatPoint.root.name = 'Listening-position probe';
    const sourcePoint = createMesh(engine,marker,cool);
    sourcePoint.root.setPosition(source);
    sourcePoint.root.name = 'Driven loudspeaker marker';
    models.push(seatRing,seatPoint,sourcePoint);
    return { dispose() { for (const model of models) model.destroy(); grain.dispose(); } };
  };
}
