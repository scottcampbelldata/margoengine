import { Forms,aperture,openings,archFace,archTrim,roomTransform } from './forms.js';

function collection(transform){
  const data=new Map();
  return {
    data,
    part(key){
      if(!data.has(key))data.set(key,new Forms(transform,transform?aperture.depth-.018:undefined));
      return data.get(key);
    },
    box(key,...values){this.part(key).box(...values);},
  };
}
function outside(){
  const room=collection();
  room.box('wall',-3.692,1.86,-.171,2.978,3.72,.287);
  room.box('wall',0,1.86,-.171,.714,3.72,.287);
  room.box('wall',3.692,1.86,-.171,2.978,3.72,.287);
  room.box('side',0,3.785,-.128,10.41,.167,.37);
  for(const {x} of openings){
    const z=-.027,top=3.721;
    for(let i=0;i<32;i++){
      const a=Math.PI*i/32,b=Math.PI*(i+1)/32;
      const xa=x+aperture.radius*Math.cos(a),xb=x+aperture.radius*Math.cos(b);
      const ya=aperture.spring+aperture.radius*Math.sin(a),yb=aperture.spring+aperture.radius*Math.sin(b);
      room.part('wall').face([xb,yb,z],[xa,ya,z],[xa,top,z],[xb,top,z]);
    }
    room.box('joint',x,aperture.bottom/2,-.126,aperture.radius*2,.048,.21);
    archTrim(room.part('darkBronze'),x,.927,.946,.091,.131);
    archTrim(room.part('bronze'),x,.946,1.008,.131,.158);
    archTrim(room.part('darkBronze'),x,1.008,1.044,.158,.077);
    archTrim(room.part('raised'),x,1.044,1.109,.077,-.011);
    room.box('pearl',x,.048,.203,1.825,.032,.198);
    for(let i=0;i<11;i++){
      const a=Math.PI*(i+.5)/11;
      const px=x+1.026*Math.cos(a),py=aperture.spring+1.026*Math.sin(a);
      room.box('darkBronze',px,py,.101,.017,.019,.023);
    }
  }
  for(let i=0;i<9;i++){
    const y=.17+i*.355;
    if(y<2.77){
      room.box('joint',-3.692,y,-.021,2.978,.010,.009);
      room.box('joint',0,y,-.021,.714,.010,.009);
      room.box('joint',3.692,y,-.021,2.978,.010,.009);
    }else{
      room.box('joint',0,y,-.020,10.22,.010,.009);
    }
  }
  room.box('side',0,.074,.096,10.05,.121,.16);
  for(let k=0;k<7;k++)for(let i=-6;i<=6;i++){
    const w=.82,z=.38+.76*k;
    room.box((i+k)%4===0?'floorAlt':'floor',i*.83,.003,z,w,.024,.75);
  }
  room.box('joint',0,-.061,2.74,12,.104,5.61);
  room.box('wall',0,1.78,-13,14,5,.35);

  const post=[-.539,0,.975];
  room.part('foot').lathe(post,[[.007,0],[.18,0],[.187,.016],[.187,.049],[.167,.065],[.04,.066]],30);
  room.part('post').lathe(post,[[.036,.048],[.038,.089],[.028,.119],[.026,.828],[.042,.855],[.042,.876],[.018,.904]],34);
  room.part('pearl').lathe(post,[[.013,.889],[.048,.917],[.057,.935],[.045,.961],[.020,.978],[.005,.984]],34);
  room.box('darkBronze',-.54,1.072,.982,.129,.062,.054);
  room.box('pearl',-.539,1.078,1.013,.107,.043,.006);

  return room;
}

function warmRoom(){
  const room=collection(roomTransform(openings[0].x,openings[0].yaw));
  room.box('wall',0,1.30,-5.03,3.23,3.6,.23);
  room.box('wall',-1.47,1.7,-2.53,.19,3.4,5.24);
  room.box('terra',1.58,1.70,-2.53,.20,3.4,5.24);
  room.box('terra',.04,3.31,-2.68,3.03,.16,5.38);
  room.box('floor',.04,-.049,-2.49,3.3,.11,5.10);
  for(let i=0;i<14;i++){
    const z=-.24-.341*i;
    room.box('line',.03,.013,z,3.27,.010,.022);
    for(const x of [-.79,.81])room.box('line',x,.013,z-.158,.015,.010,.306);
  }
  for(let i=0;i<5;i++){
    const z=-.53-.78*i;
    room.box('sill',-1.345,1.15,z,.095,2.31,.101);
    room.box('terra',1.45,1.15,z,.107,2.31,.117);
  }
  for(let i=0;i<4;i++){
    const y=.51+.51*i;
    room.box('line',1.467,y,-2.53,.025,.014,5.21);
    room.box('line',-1.36,y,-2.61,.025,.014,5.24);
  }
  for(let step=0;step<3;step++){
    room.box(step%2?'terra':'sill',.12,.045+step*.06,-1.88-step*.31,1.78-step*.17,.11+step*.12,.45);
  }
  room.box('terra',-.66,.226,-3.30,1.59,.35,2.38);
  room.box('sill',-.66,.416,-3.28,1.51,.085,2.29);
  for(let i=0;i<5;i++){
    const z=-1.08-i*.72;
    room.box('warm',-.85,2.752,z,.21,.063,.124);
    room.box('lamp',-.85,2.718,z,.16,.016,.087);
  }
  const specimen=[-.91,1.358,-2.98];
  room.part('chalk').lathe([-.91,.434,-2.98],[[.012,0],[.392,0],[.418,.025],[.417,.062],[.32,.082],[.272,.495],[.285,.536],[.259,.572],[.011,.572]],44);
  room.part('warm').lathe([-.91,.963,-2.98],[[.019,0],[.213,0],[.200,.031],[.139,.206],[.172,.24],[.010,.24]],36);
  room.part('warm').loop(specimen,.462,.026,.22,.59);
  room.part('bevel').loop(specimen,.459,.025,-.85,-.74);
  room.part('chalk').lathe([-.91,1.197,-2.98],[[.012,0],[.157,.035],[.202,.115],[.202,.225],[.156,.317],[.011,.355]],38);
  room.part('coil').loop(specimen,.322,.018,1.28,1.03);
  room.box('sill',-.35,1.54,-4.894,1.57,2.41,.109);
  room.box('terra',-.34,1.54,-4.830,1.45,2.26,.022);
  for(let i=0;i<12;i++)room.box('line',-.97+i*.115,1.54,-4.81,.028,2.23,.025);
  room.box('warm',.45,1.34,-4.63,.17,1.12,.11);
  room.box('lamp',.45,1.717,-4.56,.092,.088,.022);
  return room;
}

function coolRoom(){
  const room=collection(roomTransform(openings[1].x,openings[1].yaw));
  room.box('wall',.01,1.69,-5.08,3.30,3.43,.27);
  room.box('dark',-1.48,1.70,-2.53,.17,3.4,5.42);
  room.box('wall',1.52,1.70,-2.53,.18,3.4,5.42);
  room.box('dark',.04,3.36,-2.48,3.11,.16,5.53);
  room.box('floor',.03,-.037,-2.66,3.20,.114,5.48);
  room.box('dark',.03,.039,-2.58,1.06,.074,4.81);
  for(let i=0;i<15;i++){
    const z=-(.17+i*.347);
    room.box('seam',.02,.028,z,3.04,.011,.016);
    for(const side of [-1,1]){
      room.box('rib',side*1.43,1.61,z,.076,3.18,.068);
      if(i%3===0)room.box('light',side*1.36,1.34,z,.027,1.57,.021);
    }
  }
  room.box('lightBlue',-.53,.080,-2.61,.021,.015,4.82);
  room.box('lightBlue',.58,.080,-2.61,.021,.015,4.82);
  for(let i=0;i<6;i++){
    const z=-.60-i*.74;
    room.box('chrome',.04,3.08,z,2.92,.078,.064);
    room.box('light',.04,3.031,z,1.34,.016,.041);
  }
  room.box('dark',.78,.153,-3.16,.91,.20,.98);
  room.box('rib',.78,.267,-3.16,.81,.065,.89);
  room.box('chrome',.78,.332,-3.16,.61,.066,.68);
  for(let i=0;i<10;i++){
    const y=.408+i*.122,r=.278-i*.010;
    const key=i%3===0?'lightBlue':i%2===0?'light':'glass';
    room.box(key,.78,y,-3.16,2*r,.103,2*r,.61+i*.200);
    if(i%3===2)room.box('chrome',.78,y-.054,-3.16,2*r,.018,2*r,.61+i*.200);
  }
  room.part('light').loop([.78,1.763,-3.16],.228,.025,.99,.38,45,8);
  room.box('rib',.34,1.42,-4.902,1.61,2.83,.12);
  room.box('dark',.34,1.41,-4.829,1.41,2.64,.023);
  room.box('lightBlue',.34,1.43,-4.807,.426,2.31,.024);
  for(let i=0;i<9;i++){
    const y=.36+.258*i;
    room.box('dark',.34,y,-4.784,.423,.017,.015);
  }
  return room;
}


function geometry(forms){
  return {
    positions:new Float32Array(forms.positions),
    normals:new Float32Array(forms.normals),
    indices:new Uint32Array(forms.indices),
  };
}
function pack(room){
  return [...room.data].map(([id,forms])=>({id,geometry:geometry(forms)}));
}
export function describeGallery(){
  return {
    gallery:pack(outside()),rooms:[pack(warmRoom()),pack(coolRoom())],
    apertures:openings.map(({x})=>geometry(archFace(new Forms(),x,aperture.radius,aperture.depth))),
  };
}
