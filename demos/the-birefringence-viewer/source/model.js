import { PbrMaterial } from '@margoengine/core';
import { roundedBoxGeometry } from '@margoengine/geometry/extras';
import { cylinderGeometry, latheGeometry } from '@margoengine/geometry/primitives';
import { toGeometry } from '@margoengine/geometry/utils';
import { axisAngleToQuaternion } from '@margoengine/math/quat';
import { centerRetardationNm, radians, specimenRadius } from './optics.js';
import { attachScreen } from './screen.js';

const centerY = .299;
const ax = axisAngleToQuaternion([1, 0, 0], Math.PI / 2);
const spin = (angle) => axisAngleToQuaternion([0, 0, 1], angle);

function annulus(inner, outer, thickness, bevel) {
  const z = thickness / 2;
  return latheGeometry([
    [inner + bevel,-z],[outer - bevel,-z],[outer,-z + bevel],[outer,z - bevel],[outer - bevel,z],
    [inner + bevel,z],[inner,z - bevel],[inner,-z + bevel],[inner + bevel,-z],
  ], 112);
}

export function createPolariscope(engine, shadows) {
  const finish = (color, roughness, metalness = 0) => new PbrMaterial({ color, roughness, metalness });
  const ground = finish('#64726b', .86);
  const forest = finish('#354c40', .37);
  const moss = finish('#486252', .44);
  const gray = finish('#363d3d', .56);
  const graphite = finish('#2b3234', .71);
  const bronze = finish('#ba9365', .33, 1);
  const edge = finish('#d0b691', .25, 1);
  const steel = finish('#adb9b9', .29, 1);
  const lightMark = finish('#dbd3ad', .58);
  const ceramic = finish('#9aafa5', .48);
  const oxblood = finish('#825449', .41);
  const smoked = finish('#485e61', .25);
  const geometry = new WeakMap();
  let count = 0;
  function mount(data, material, where, { parent, rotation, cast } = {}) {
    if (!geometry.has(data)) geometry.set(data, toGeometry(data));
    const mesh = engine.createMesh(parent).setGeometry(geometry.get(data)).setMaterial(material).setPosition(where);
    if (rotation) mesh.setQuaternion(rotation);
    if (cast) shadows.add(mesh, { static: true });
    count++;
    return mesh;
  }
  const block = (w,h,d,b) => roundedBoxGeometry(w,h,d,3,b);
  const box = (dims, bevel, material, where, options) => mount(block(...dims,bevel),material,where,options);
  const caster = { cast: true };
  const disc = (radius, depth, material, where, options) =>
    mount(cylinderGeometry(radius,radius,depth,64,1),material,where,options);
  const ring = (inner, outer, thickness, bevel, material, where, { parent, cast } = {}) =>
    mount(annulus(inner,outer,thickness,bevel),material,where,{ rotation: ax,parent,cast });

  box([54,.12,54],.019,ground,[0,-.115,0]);
  box([.662,.057,.522],.025,graphite,[0,-.005,.018],caster);
  box([.636,.008,.493],.0038,edge,[0,.022,.018]);
  box([.614,.017,.477],.007,forest,[0,.033,.018]);
  for (const x of [-.244,.244]) for (const z of [-.166,.198]) disc(.026,.033,graphite,[x,-.038,z],caster);

  // The rigid yoke is wider at its crown and leaves the optical axis empty.
  for (const x of [-.204,.204]) {
    box([.093,.043,.182],.016,forest,[x,.062,.012],caster);
    box([.059,.380,.096],.020,forest,[x,.250,.011],caster);
    box([.012,.318,.041],.005,moss,[x + Math.sign(x)*.028,.248,.017]);
    box([.092,.050,.110],.018,moss,[x,.440,.010],caster);
    box([.066,.035,.134],.014,forest,[x,.087,-.013],caster);
  }
  box([.475,.064,.104],.023,forest,[0,.476,.011],caster);
  box([.373,.012,.058],.005,moss,[0,.507,.011]);
  box([.052,.009,.088],.004,steel,[0,.510,.011]);
  disc(.025,.021,bronze,[0,.523,.011]);
  disc(.014,.102,steel,[0,.508,.011],caster);
  const handle = engine.createMesh().setPosition([0,.563,.011]);
  disc(.050,.015,bronze,[0,0,0],{ parent: handle });
  disc(.030,.011,moss,[0,.011,0],{ parent: handle });
  box([.096,.010,.018],.004,graphite,[0,.011,0],{ parent: handle });
  for (const x of [-.053,.053]) disc(.013,.023,oxblood,[x,.012,0],{ parent: handle });
  disc(.014,.008,edge,[0,.019,0],{ parent: handle });

  // A ridged source housing and rear polarizer sit behind the removable specimen.
  box([.171,.025,.116],.009,gray,[0,.054,-.130],caster);
  box([.086,.107,.088],.012,moss,[0,.112,-.132],caster);
  disc(.118,.074,gray,[0,centerY,-.152],{ rotation: ax,cast: true });
  for (let i = 0; i < 6; i++) ring(.114,.128,.007,.0024,forest,[0,centerY,-.178 + .010*i]);
  ring(.125,.160,.026,.006,graphite,[0,centerY,-.094],{ cast: true });
  ring(.132,.162,.008,.002,bronze,[0,centerY,-.078]);
  const backFilter = engine.createMesh().setPosition([0,centerY,-.072]);
  for (const sign of [-1,1]) {
    box([.016,.033,.006],.0025,lightMark,[0,sign*.148,0],{ parent: backFilter });
    box([.003,.018,.003],.0011,gray,[0,sign*.148,.004],{ parent: backFilter });
  }

  // Front optical retainer rings surround a thin edge-on solid specimen.
  ring(specimenRadius-.003,specimenRadius+.004,.016,.0020,smoked,[0,centerY,.079]);
  disc(specimenRadius+.002,.008,graphite,[0,centerY,.111],{ rotation: ax });
  ring(.143,.168,.021,.005,forest,[0,centerY,.102],{ cast: true });
  ring(.144,.167,.010,.0027,bronze,[0,centerY,.120]);
  const frontFilter = engine.createMesh().setPosition([0,centerY,.131]);
  ring(.146,.165,.008,.0025,gray,[0,0,0],{ parent: frontFilter });
  const cut = block(.0017,.008,.0012,.00045);
  const longCut = block(.0024,.0118,.0019,.00055);
  for (let i = 0; i < 48; i++) {
    const azimuth = i * Math.PI / 24;
    const long = i % 6 === 0, r = long ? .1555 : .158;
    mount(long ? longCut : cut,long ? lightMark : ceramic,
      [-Math.sin(azimuth)*r,Math.cos(azimuth)*r,.005],{ parent: frontFilter,rotation: spin(azimuth) });
  }
  for (const sign of [-1,1]) {
    box([.023,.014,.006],.0025,bronze,[0,sign*.159,.007],{ parent: frontFilter });
    box([.005,.009,.002],.0007,lightMark,[0,sign*.158,.0104],{ parent: frontFilter });
  }
  // One index pointer marks the analyzer axis, so a quarter turn of both filters reads in the picture too.
  box([.016,.030,.014],.004,lightMark,[0,.182,.006],{ parent: frontFilter });
  box([.0025,.020,.002],.0008,gray,[0,.184,.0135],{ parent: frontFilter });

  // Compression shoes obscure the tiny point-contact neighborhoods.
  box([.087,.047,.073],.010,graphite,[0,.125,.103],caster);
  box([.078,.025,.046],.006,steel,[0,.155,.120],caster);
  const head = engine.createMesh().setPosition([0,.446,.115]);
  const shoe = box([.077,.028,.060],.006,steel,[0,-.001,.011],{ parent: head });
  shadows.add(shoe);
  box([.114,.024,.052],.007,gray,[0,.020,-.026],{ parent: head });
  box([.067,.033,.030],.008,bronze,[0,.041,-.075],{ parent: head });
  const screw = cylinderGeometry(.0061,.0061,.004,18,1);
  for (const x of [-.204,.204]) for (const z of [-.033,.044]) mount(screw,edge,[x,.467,z]);

  // A mechanical zero indicia and the click-stop on the base.
  box([.153,.006,.051],.0026,gray,[-.134,.046,.199]);
  box([.103,.0017,.0019],.0006,lightMark,[-.142,.050,.191]);
  box([.077,.0017,.0019],.0006,bronze,[-.156,.050,.206]);
  box([.090,.014,.078],.006,graphite,[.177,.047,.177],caster);
  disc(.026,.013,bronze,[.177,.060,.177],caster);
  disc(.016,.006,oxblood,[.177,.069,.177]);
  const mountPoint = engine.createMesh();
  const screen = attachScreen(engine,mountPoint,centerY,.1375);
  return {
    meshes: count + 1,
    ready: screen.ready,
    dispose: screen.dispose,
    update(force, degrees, parallel) {
      const angle = degrees * radians;
      handle.setQuaternion(axisAngleToQuaternion([0,1,0], force * .0033));
      head.setPosition([0,.446 - force*.000004,.115]);
      frontFilter.setQuaternion(spin(angle + (parallel ? 0 : Math.PI/2)));
      backFilter.setQuaternion(spin(angle));
      screen.update(centerRetardationNm(force),angle,parallel);
    },
  };
}
