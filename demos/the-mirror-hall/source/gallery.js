import { Geometry, PbrMaterial, box } from '@margoengine/core';

function tint(hex) {
  const triplet=hex.match(/[0-9a-f]{2}/g).map(part=>Number.parseInt(part,16)/255);
  return triplet.map(value=>value<=.04045?value/12.92:((value+.055)/1.055)**2.4);
}

const surface=(color,roughness,metalness=0)=>{
  const optical={color:tint(color),roughness,metalness};
  return {optical,material:new PbrMaterial(optical)};
};
const stone=surface('#b6a590',.92);
const honey=surface('#b9a084',.88);
const pale=surface('#cec1aa',.87);
const grout=surface('#6e655a',.96);
const slate=surface('#395653',.83);
const ox=surface('#62716a',.73);
const bronze=surface('#ac8255',.51,.25);
const copper=surface('#8c3428',.62);
const coral=surface('#dc5249',.61);
const ruby=surface('#833b3c',.60);
const pool=surface('#bcc5c6',.055,1);
const trim=surface('#484f4b',.72,.32);
const lamp=surface('#ead5aa',.71);
const unit=box(1,1,1);
const sun=[-.67,.52,.87,2.23],radiance=[1,.96,.88,.68],ambient=[.68,.90,.98];
const lightMagnitude=Math.hypot(...sun.slice(0,3));
export const mirrorPlane={
  color:pool.optical.color,bounds:[-.001,2.035,-7.105,5.725],
  sun:[sun[0]/lightMagnitude,sun[1]/lightMagnitude,sun[2]/lightMagnitude,sun[3]],radiance,ambient,
};
const items=[];

function element(name,geometry,appearance,position,scale=[1,1,1],rotation=[0,0,0]) {
  items.push({name,geometry,appearance,position,scale,rotation});
}
const block=(name,appearance,x,y,z,w,h,d,rz=0)=>element(name,unit,appearance,[x,y,z],[w,h,d],[0,0,rz]);

function tube(radius,height,width,twist=0) {
  const p=[],n=[],i=[];
  const turns=56,sides=10;
  for(let row=0;row<=turns;row++){
    const theta=row/turns*2*Math.PI, c=Math.cos(theta),s=Math.sin(theta);
    for(let side=0;side<=sides;side++){
      const phi=side/sides*2*Math.PI, a=Math.cos(phi), b=Math.sin(phi), change=twist*Math.sin(2*theta);
      p.push((radius+width*a)*c,(radius+width*a)*s*height,width*b+change);
      const normal=Math.hypot(c*a,s*a/height,b);
      n.push(c*a/normal,s*a/(height*normal),b/normal);
      if(row&&side){
        const at=row*(sides+1)+side,previous=at-sides-1;
        i.push(at,previous,previous-1,at,previous-1,at-1);
      }
    }
  }
  return new Geometry(p,n,i);
}
const circle=tube(.82,1.17,.123,.13);
const ring=tube(.63,1.18,.051,-.075);
const lip=tube(.36,1.08,.036,.026);

export const sculpture=[0,3.29,-2.47];
export const halfHeight=1.13;
const [hx,hy,hz]=sculpture;

function build(){
  block('Mirror-polished floor plate',pool,0,-.079,-.69,4.07,.156,12.83);
  block('Black brass bed in mineral grout',grout,0,-.09,-.69,6.70,.15,13.24);
  for(const side of [-1,1]){
    const x=side*2.05;
    block('Bronze foil edge',bronze,x,-.005,-.69,.035,.014,12.84);
    block('Beveled alloy drain',trim,side*2.135,-.012,-.69,.11,.028,12.91);
    for(let bay=0;bay<13;bay++){
      const z=5.45-bay*.91;
      block('Honed mineral paving',bay%3===0?honey:stone,side*2.77,-.053,z,1.16,.115,.898);
    }
    block('Skirt slab at corridor wall',grout,side*3.27,.19,-.81,.12,.35,12.18);
    block('Travertine wall core',stone,side*3.44,2.46,-1.21,.25,4.9,11.57);
    for(let panel=0;panel<8;panel++){
      const z=3.89-panel*1.47;
      block('Split-faced mineral panel',panel%3===1?honey:pale,side*3.295,2.39,z,.070,4.38,1.444);
      block('Inset dark wall joint',grout,side*3.274,.92,z,.011,.012,1.432);
      block('Inset high wall joint',grout,side*3.276,3.93,z,.011,.012,1.432);
    }
    for(let row=0;row<3;row++){
      const z=-4.01+row*2.05;
      block('Sandstone piers',honey,side*2.42,2.27,z,.39,4.55,.34);
      block('Pillar base collar',slate,side*2.42,.195,z,.56,.37,.52);
      block('Bronze reveal',bronze,side*2.42,.40,z,.58,.031,.54);
      block('Sloped roof joint',stone,side*1.978,4.381,z,1.327,.386,.34,side*Math.PI*.25);
      block('Shoulder with brass facing',bronze,side*2.05,4.199,z+.174,1.033,.037,.020,side*Math.PI*.247);
      for(let i=0;i<4;i++)block('Decorative key slot',grout,side*2.42,2.50+i*.16,z+.178,.20,.015,.012);
    }
    block('Alcove side slab',pale,side*2.50,2.37,-6.06,1.66,4.74,.29);
    block('Door recess brass jamb',bronze,side*1.63,1.70,-6.07,.059,3.42,.314);
    block('Sunken jade backdrop side',slate,side*1.75,1.85,-6.82,.11,3.77,1.46);
    block('Low recessed skirting',trim,side*1.66,.1,-6.71,.12,.14,1.3);
  }
  block('Rear lintel',stone,0,4.23,-6.06,6.63,1.01,.29);
  block('High carved recess',ox,0,1.71,-7.51,3.52,3.59,.13);
  block('Pilaster at rear relief',slate,0,1.22,-7.394,1.46,2.45,.12);
  for(let i=-7;i<=7;i++){
    block('Vertical rear relief',i%3===0?bronze:ox,i*.093,1.37,-7.31,.035,2.20,.042);
  }
  block('Rear threshold lip',trim,0,.06,-6.37,3.39,.125,.334);
  for(let i=0;i<15;i++){
    const z=2.88-i*.62;
    block('Oak ceiling blade',i%3===0?bronze:honey,0,4.77,z,4.43,.16,.151);
  }
  block('Central hanging bracket rail',trim,0,4.52,hz,.91,.085,.18);
  for(const side of [-1,1]){
    block('Tension rod',bronze,side*.39,4.23,hz,.025,.64,.025,side*.08);
    block('Clevis end',bronze,side*.35,4.02,hz,.10,.10,.11);
  }
  element('Vermilion outer body',circle,coral,sculpture,[1,1,1],[-.115,.19,-.16]);
  element('Oxide inner band',ring,ruby,[hx,hy+.019,hz+.040],[1,1,1],[.06,.16,-.28]);
  element('Warm inner keeper',lip,copper,[hx-.032,hy-.12,hz+.078],[1,1,1],[-.10,.35,.04]);
  block('Front floor stretcher',bronze,0,-.002,5.744,4.07,.009,.029);
  for(const side of [-1,1]){
    block('Stair recess glint',lamp,side*3.23,.351,2.85,.031,.050,4.12);
  }
}

build();

export function setGallery(scene){
  for(const item of items){
    scene.createMesh().setGeometry(item.geometry).setMaterial(item.appearance.material)
      .setPosition(item.position).setScale(item.scale).setRotation(item.rotation).name=item.name;
  }
  scene.lighting.direction.set(sun);
  scene.lighting.radiance.set(radiance);
  scene.lighting.ambient.set(ambient);
  scene.background='#21312f';
}

export function opticalItems(){
  return items;
}
