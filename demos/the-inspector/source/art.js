import { Geometry,PbrMaterial,box } from '@margoengine/core';
import { Shape,applyMatrix4,boxGeometry,cylinderGeometry,extrudeGeometry,latheGeometry,mergeGeometries } from '@margoengine/geometry';

const swatch=(color,roughness=.57,metalness=0)=>new PbrMaterial({color,roughness,metalness,doubleSided:false});
const stone=swatch('#6a7272',.82),anodized=swatch('#253b45',.46,.41),ceramic=swatch('#376671',.33,.13);
const copper=swatch('#be8965',.39,.68),satin=swatch('#c2bcb0',.35,.68),gasket=swatch('#28343c',.85);
const ivory=swatch('#ddd0b5',.74),field=swatch('#aaa48f',.86),glaze=swatch('#357d91',.115,.28);
const deep=swatch('#244d62',.16,.21),cursor=swatch('#9ed2c5',.38,.12),reticle=swatch('#c09168',.55,.38);
const darkMount=swatch('#435453',.75);
const unitBox=boxGeometry(1,1,1);
const convert=g=>new Geometry(g.positions,g.normals,g.indices);
const shell=(profile,segments=36)=>convert(applyMatrix4(latheGeometry(profile,segments),
  [0,-1,0,0,1,0,0,0,0,0,1,0,0,0,0,1]));
const pipe=(top,bottom,height,segments=26)=>convert(cylinderGeometry(top,bottom,height,segments,1));
const bars=(members)=>{
  const transformed=members.map(([[w,h,d],[x,y,z],angle=0])=>{
    const c=Math.cos(angle),s=Math.sin(angle);
    return applyMatrix4(unitBox,[w*c,w*s,0,0,-h*s,h*c,0,0,0,0,d,0,x,y,z,1]);
  });
  return convert(mergeGeometries(transformed));
};

function beveledSlab(w,h,d,bevel){
  const x=w*.5-bevel,z=d*.5-bevel,depth=h-bevel*2;
  const outline=new Shape();
  outline.moveTo(-x,-z).lineTo(x,-z).lineTo(x,z).lineTo(-x,z).closePath();
  const geometry=extrudeGeometry(outline,{depth,bevelEnabled:true,bevelSegments:1,
    bevelThickness:bevel,bevelSize:bevel});
  return convert(applyMatrix4(geometry,[1,0,0,0,0,0,1,0,0,-1,0,0,0,depth*.5,0,1]));
}

export const lensRest=.305,lensTravel=.303;

export function makeBench(engine){
  engine.scene.background='#b1a994';
  engine.lighting.direction.set([-.58,.79,.33,3.45]);
  engine.lighting.radiance.set([1,.94,.84,.73]);
  engine.lighting.ambient.set([.82,.93,1.06]);
  function group(label,parent=null,position=[0,0,0]){
    const node=engine.createMesh(parent).setPosition(position);
    node.name=label;
    return node;
  }
  function item(label,parent,geometry,material,position=[0,0,0]){
    return group(label,parent,position).setGeometry(geometry).setMaterial(material);
  }

  const studio=group('Studio');
  item('Backdrop',studio,box(.8,.14,.8),field,[0,-.148,0]).setScale([60,1,60]);

  const bench=group('Aperture bench');
  item('Stone plinth',bench,beveledSlab(1.97,.107,.86,.011),stone,[0,-.012,0]);
  item('Beveled foot',bench,beveledSlab(1.88,.026,.81,.005),anodized,[0,-.064,0]);
  item('Bronze trim',bench,beveledSlab(1.92,.016,.807,.003),copper,[0,.043,0]);
  item('Platform',bench,box(1.87,.032,.765),darkMount,[0,.058,0]);

  const guide=group('Carriage guide',bench);
  item('Dovetail plates',guide,bars([
    [[1.76,.04,.066],[0,.10,-.184]],[[1.76,.04,.066],[0,.10,.184]],
    [[.053,.05,.423],[-.857,.119,0]],[[.053,.05,.423],[.857,.119,0]]
  ]),anodized);
  item('Machined runners',guide,bars([
    [[1.73,.019,.035],[0,.126,-.183]],[[1.73,.019,.035],[0,.126,.183]]
  ]),satin);
  const scale=[];
  for(let i=0;i<42;i++)scale.push([[
    .006,.003,i%5===0?.032:.016
  ],[-.811+i*.039,.134,.269-(i%5===0?.008:0)]]);
  item('Bed scale',guide,bars(scale),ivory);

  const body=group('Projector',bench,[-.420,0,0]);
  item('Saddle block',body,box(.433,.071,.494),anodized,[0,.170,0]);
  item('Cradle',body,bars([
    [[.358,.071,.253],[0,.219,0]],
    [[.261,.167,.083],[-.083,.291,-.158]],
    [[.261,.167,.083],[-.083,.291,.158]],
    [[.262,.054,.303],[-.082,.362,0]],
  ]),ceramic);
  item('Carriage feet',body,bars([
    [[.094,.036,.077],[-.076,.152,.206]],[[.094,.036,.077],[.108,.152,.206]],
    [[.094,.036,.077],[-.076,.152,-.206]],[[.094,.036,.077],[.108,.152,-.206]]
  ]),copper);

  const head=group('Optical head',body,[0,.474,0]);
  item('Enamel housing',head,shell([
    [0,-.330],[.161,-.330],[.179,-.314],[.194,-.282],[.195,-.258],[.184,-.241],
    [.173,.037],[.166,.101],[.151,.131],[.110,.137],[.100,.124],[.104,.094],
    [.133,-.154],[.129,-.264],[.096,-.287],[0,-.287]
  ]),ceramic);
  item('Rear service cap',head,shell([
    [0,-.376],[.140,-.376],[.154,-.361],[.154,-.340],[.143,-.329],[0,-.329]
  ]),anodized);
  item('Aperture collars',head,shell([
    [0,.101],[.152,.101],[.157,.110],[.139,.145],[.129,.150],[.129,.169],[.123,.181],
    [.097,.181],[.091,.177],[.091,.115],[.096,.101],[0,.101]
  ]),copper);
  item('Draw tube',head,shell([
    [.065,.135],[.086,.135],[.086,.299],[.084,.316],[.077,.322],[.062,.322],[.057,.312],
    [.057,.154],[.065,.135]
  ],28),satin);
  item('Internal aperture',head,shell([[0,.160],[.064,.160],[.064,.170],[0,.171]],28),gasket);
  item('Focus lock',head,pipe(.037,.043,.047),copper,[-.104,.155,.054]).setRotation([.10,0,-.55]);

  const lens=group('Lens cartridge',head,[lensRest,0,0]);
  item('Lens bezel',lens,shell([
    [0,-.043],[.103,-.043],[.114,-.033],[.133,-.023],[.137,-.012],[.137,.016],
    [.131,.030],[.125,.036],[.098,.036],[.093,.029],[.093,.011],[.091,-.004],
    [.088,-.035],[0,-.043],
  ]),copper);
  const flutes=[];
  const flute=boxGeometry(.031,.008,.018);
  for(let i=0;i<28;i++){
    const angle=i/28*Math.PI*2,c=Math.cos(angle),s=Math.sin(angle);
    flutes.push(applyMatrix4(flute,[1,0,0,0,0,c,s,0,0,-s,c,0,.002,.136*c,.136*s,1]));
  }
  item('Grip flutes',lens,convert(mergeGeometries(flutes)),anodized);
  item('Coated optical insert',lens,shell([
    [0,-.001],[.089,-.001],[.092,.007],[.085,.018],[.070,.026],[.048,.033],
    [.025,.036],[0,.038]
  ],36),glaze);
  item('Optical inset',lens,shell([[.096,.026],[.098,.027],[.096,.032],[.093,.032],[.093,.027],[.096,.026]],36),deep);

  const screen=group('Target cradle',bench,[.660,0,0]);
  item('Screen base',screen,box(.27,.08,.394),anodized,[0,.167,0]);
  item('Pedestal',screen,bars([
    [[.103,.108,.159],[-.047,.243,0]],
    [[.080,.256,.104],[-.049,.372,0]],
    [[.043,.051,.274],[-.032,.481,0]]
  ]),ceramic);
  item('Target surround',screen,box(.049,.337,.348),copper,[0,.492,0]);
  item('Calibration tile',screen,box(.018,.298,.305),ivory,[.029,.492,0]);
  const grid=[];
  for(let i=-4;i<=4;i++){
    const along=i*.027;
    grid.push([[.002,.246,.002],[.039,.492,along]],[[.002,.002,.246],[.039,.492+along,0]]);
  }
  item('Target graticule',screen,bars(grid),reticle);
  item('Center index',screen,bars([
    [[.003,.055,.004],[.041,.492,0]],[[.003,.004,.055],[.041,.492,0]]
  ]),cursor);

  return {bench,lens};
}
