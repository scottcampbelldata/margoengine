import {Geometry, PbrMaterial, box} from '@margoengine/core';

const finish={
  asphalt:['#394e59',.67],wet:['#40545c',.25],seam:['#2a3944',.87],
  rim:['#5e747d',.51], paint:['#a79874',.7], warning:['#d2a750',.57],
  iron:['#415966',.43], patina:['#735f55',.62], roof:['#4a6771',.7],
  eave:['#758887',.62], wood:['#b47542',.54], mortar:['#49666f',.85],
  glass:['#d38a48',.54], panes:['#f8c879',.56], flame:['#f5c68c',.66],
  lamp:['#fff9e6',.26], tube:['#eee0b9',.6], label:['#f5ddad',.66], enameled:['#356b7d',.5],
  sea:['#26384d',.33], swell:['#3c596e',.31], seafoam:['#5c7a91',.41],
  haze:['#4b6378',.98], hills:['#373f59',.98], buildings:['#404e67',.86],
  cold:['#a4c9db',.54], teal:['#61aaa3',.56], red:['#d37d6d',.56],
  shell:['#537382',.67], white:['#a8ada6',.67], funnel:['#bf714d',.65],
};

export const mainLight=[1.68,2.53,-1.13,1];
const sine=Math.sin, cosine=Math.cos;

function polygonNormal(a,b,c){
  const u=b.map((value,i)=>value-a[i]),v=c.map((value,i)=>value-a[i]);
  const n=[u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]];
  const length=Math.hypot(...n)||1;
  return n.map(value=>value/length);
}

export function preparePier(){
  const batches=new Map();
  function layer(name){
    if(!batches.has(name))batches.set(name,{positions:[],normals:[],indices:[]});
    return batches.get(name);
  }
  function face(name,points,fixedNormal){
    const data=layer(name),base=data.positions.length/3;
    const n=fixedNormal??polygonNormal(...points);
    for(const point of points){ data.positions.push(...point);data.normals.push(...n); }
    for(let i=1;i<points.length-1;i++)data.indices.push(base,base+i,base+i+1);
  }
  function add(name,geometry,[x,y,z],angle=0){
    const data=layer(name),base=data.positions.length/3,c=cosine(angle),s=sine(angle);
    const source=geometry.vertices;
    for(let i=0;i<source.length;i+=6){
      const px=source[i],py=source[i+1],nx=source[i+3],ny=source[i+4];
      data.positions.push(x+px*c-py*s,y+px*s+py*c,z+source[i+2]);
      data.normals.push(nx*c-ny*s,nx*s+ny*c,source[i+5]);
    }
    for(const index of geometry.indices)data.indices.push(base+index);
  }
  function block(name,x,y,z,w,h,d,angle){
    add(name,box(w,h,d),[x,y,z],angle);
  }
  function rail(name,a,b,width,depth){
    const dx=b[0]-a[0],dy=b[1]-a[1];
    block(name,(a[0]+b[0])/2,(a[1]+b[1])/2,a[2],Math.hypot(dx,dy),width,depth,Math.atan2(dy,dx));
  }
  function paving(name,x0,x1,z0,z1,y){
    face(name,[[x0,y,z0],[x1,y,z0],[x1,y,z1],[x0,y,z1]],[0,1,0]);
  }

  block('asphalt',-.10,-.28,-11,8.05,.54,38.1);
  block('rim',3.92,-.23,-11,.18,.57,38.0);
  block('seam',3.94,-.57,-11,.15,.07,38.0);
  block('rim',-4.13,-.35,-11,.27,.65,38);
  paving('wet',-1.69,2.26,7.8,-29.7,.003);
  for(let i=0;i<19;i++){
    const z=7-i*2.09;
    paving('seam',-4.09,3.82,z,z-.023,.009);
    paving('warning',3.02,3.093,z-.16,z-.92,.012);
    if(i%3===0){
      const x=-.22+.54*cosine(i*4), w=.62+.20*sine(i*1.91);
      face('asphalt',[
        [x-w,.006,z-.09],[x-.38*w,.006,z-.24],[x+.45*w,.006,z-.45],
        [x+.93*w,.006,z-.81],[x+.51*w,.006,z-.96],[x-.34*w,.006,z-.53],
      ],[0,1,0]);
    }
  }
  paving('paint',-1.72,-1.687,8,-30,.015);
  paving('paint',2.27,2.307,8,-29.8,.015);
  for(let i=0;i<12;i++){
    const t=.09*i;
    paving('seam',-2.19+t,-2.15+t,4.95,4.47,.018);
  }

  // Late ferry pier, with long rails, station windows and a lean-to roof.
  for(const z of [5,2,-1,-4,-7,-10,-13,-16,-19,-22,-25,-28]){
    block('iron',3.34,.53,z,.076,1.1,.086);
    block('patina',3.34,.15,z,.20,.29,.21);
    block('rim',3.34,.022,z,.26,.035,.25);
  }
  block('iron',3.34,1.06,-11.4,.090,.080,34.2);
  block('iron',3.34,.61,-11.4,.039,.050,34.1);
  block('iron',3.34,.25,-11.4,.046,.057,34.1);
  block('patina',3.34,1.10,-11.4,.096,.024,34.2);

  block('mortar',-3.86,1.54,-9.61,2.12,3.06,19.9);
  block('rim',-2.76,.49,-9.60,.16,.98,19.9);
  block('eave',-2.73,2.80,-9.61,.21,.24,20.0);
  block('wood',-2.61,1.33,-9.61,.21,.13,19.7);
  block('seam',-2.57,1.28,-9.61,.20,.030,19.9);
  block('rim',-3.84,.25,.370,2.16,.40,.062);
  for(let i=0;i<19;i++){
    const x=-4.88+i*.104;
    block(i%4===0?'iron':'roof',x,.646,.380,.079,.37,.046);
  }
  block('teal',-3.86,.42,.412,2.05,.032,.037);
  block('patina',-3.84,2.570,.378,2.16,.66,.085);
  block('enameled',-3.54,2.572,.434,1.58,.47,.023);
  block('teal',-3.54,2.379,.449,1.45,.018,.025);
  block('iron',-3.70,1.32,.376,1.64,1.69,.052);
  block('glass',-3.70,1.51,.410,1.55,1.085,.040);
  block('panes',-3.70,1.985,.436,1.51,.160,.015);
  for(const x of [-4.5,-3.95,-3.42,-2.89]){
    block('iron',x,1.49,.434,.061,1.272,.078);
  }
  block('wood',-3.68,.925,.461,1.67,.104,.156);
  block('patina',-3.68,.849,.461,1.67,.040,.088);
  block('tube',-3.53,2.845,.463,.81,.028,.068);
  const glyphs={
    P:[[0,0,0,1],[0,1,.65,1],[.65,1,.65,.54],[.65,.54,0,.54]],
    I:[[.22,0,.22,1]],
    E:[[0,0,0,1],[0,1,.65,1],[0,.51,.51,.51],[0,0,.65,0]],
    R:[[0,0,0,1],[0,1,.65,1],[.65,1,.65,.54],[.65,.54,0,.54],[.30,.54,.68,0]],
  };
  for(const [i,letter] of [...'PIER'].entries()){
    const x=-3.95+i*.218,y=2.47,z=.456;
    for(const [a,b,c,d] of glyphs[letter])rail('label',[x+a*.186,y+b*.192,z],[x+c*.186,y+d*.192,z],.022,.012);
  }
  for(let i=0;i<10;i++){
    const z=-.49-i*1.96;
    block('iron',-2.737,1.51,z,.024,1.24,1.86);
    block(i%5===3?'patina':'glass',-2.717,1.57,z,.021,1.02,1.71);
    block(i%5===3?'rim':'panes',-2.703,1.96,z,.018,.177,1.66);
    for(let notch=0;notch<6;notch++){
      block(i%5===3?'iron':'flame',-2.703,1.465+notch*.054,z-.024,.019,.009,1.62);
    }
    block('mortar',-2.684,1.18,z,.033,.20,1.71);
    for(const dz of [-.855,0,.855])block('iron',-2.68,1.62,z+dz,.06,1.15,.047);
    block('iron',-2.677,1.87,z,.047,.043,1.78);
    block('tube',-2.655,2.274,z,.08,.038,.74);
  }
  block('roof',-2.49,3.45,-10.45,5.05,.15,23.90,-.124);
  block('eave',.02,3.138,-10.45,.18,.21,23.9);
  block('seam',.13,3.04,-10.45,.06,.051,23.85);
  block('patina',-.037,3.12,-10.45,.096,.018,23.87);
  for(let index=0;index<32;index++){
    const z=1.37-index*.743;
    rail('rim',[-2.58,3.402,z],[.043,3.075,z],.027,.027);
  }
  for(let i=0;i<9;i++){
    const z=.91-i*2.68;
    block('iron',-.01,1.56,z,.117,3.10,.119);
    block('rim',-.01,.16,z,.20,.32,.204);
    block('patina',-.01,2.99,z,.144,.15,.15);
    rail('patina',[-2.30,3.42,z],[.02,3.13,z],.083,.090);
    rail('iron',[-.63,3.21,z],[-.014,2.72,z],.052,.065);
    rail('iron',[-2.58,2.97,z],[-1.93,3.35,z],.049,.057);
    block('patina',-1.16,3.295,z,2.33,.046,.203,-.128);
    block('tube',-1.21,3.261,z,.78,.023,.137,-.128);
  }

  // A near bench and vertical route number, viewed through the first bay.
  for(const z of [-.76,-1.20,-1.65]){
    block('iron',-2.183,.230,z,.35,.43,.047);
    block('patina',-1.99,.035,z,.10,.05,.104);
  }
  for(let i=0;i<4;i++){
    block(i%2?'wood':'patina',-2.41+i*.118,.485,-1.18,.109,.067,1.51);
    block('wood',-2.582,.642+i*.09,-1.18,.055,.071,1.53);
  }
  block('iron',-.20,2.18,1.032,.23,.61,.075);
  block('enameled',-.20,2.18,1.074,.189,.55,.025);
  for(const y of [1.934,2.416])block('patina',-.20,y,1.094,.150,.014,.016);
  digits('07',-.262,2.253,1.099);

  function digits(value,x,y,z){
    const codes={0:[0,1,2,3,4,5],7:[0,1,2]};
    for(let i=0;i<value.length;i++){
      const dx=x+i*.070;
      const segments=[
        [-.000,.062,.043,.008],[.025,.035,.008,.049],[.025,-.025,.008,.049],
        [0,-.054,.043,.008],[-.025,-.025,.008,.049],[-.025,.035,.008,.049],
      ];
      for(const index of codes[value[i]]){
        const [px,py,w,h]=segments[index];
        block('label',dx+px,y+py,z,w,h,.009);
      }
    }
  }

  // The primary light sits just in front of the solid opal glass in depth.
  for(const [x,z,h,main] of [[1.68,-1.30,2.53,true],[1.82,-12.15,2.64,false],[2.28,-24.8,2.75,false]]){
    block('rim',x,.13,z,.225,.25,.23);
    block('iron',x,(h+.12)/2,z,.067,h+.12,.069);
    block('patina',x,h+.232,z,.19,.12,.27);
    block('eave',x,h+.195,z,.35,.048,.33);
    block('patina',x,h+.168,z,.326,.013,.316);
    block('iron',x,h-.167,z,.235,.048,.237);
    block('rim',x,h-.134,z,.249,.019,.272);
    const housing=main?'lamp':'flame';
    block(housing,x,h,z,.235,.253,.220);
    block(housing,x,h+.012,z+.109,.202,.192,.023);
    face(housing,[[x-.098,h-.09,z+.124],[x+.098,h-.09,z+.124],
      [x+.098,h+.116,z+.124],[x-.098,h+.116,z+.124]],[.16,.35,.925]);
    for(const dx of [-.120,.120]){
      block('rim',x+dx,h,z+.116,.016,.270,.018);
      block('patina',x+dx,h+.126,z+.116,.027,.030,.031);
    }
  }

  // Inlet, distant pier and an original side profile of a small ferry.
  paving('sea',-103,103,16,-156,-.64);
  for(let i=0;i<130;i++){
    const z=11-i*.66, x=4.1+20*(.5+.5*sine(i*19.11));
    const w=.20+1.6*(.5+.5*sine(i*2.4));
    face(i%5===0?'seafoam':'swell',[
      [x-w,-.634,z], [x+.47*w,-.625,z-.020],
      [x+w,-.633,z-.058], [x-.3*w,-.636,z-.053],
    ],[.04,.991,.13]);
  }
  const far=[
    [-101,7],[-81,6],[-72,8],[-58,6.5],[-47,7],[-35,5.9],[-22,5.5],[-12,4.5],
    [-1,4.1],[13,3.5],[21,3.68],[24,3.51],[28,3.62],[33,3.4],[38,4.01],
    [45,4.34],[51,5.1],[55,4.87],[65,5.35],[73,6.39],[79,6.74],[90,6.92],[110,9.50],
  ];
  for(let i=0;i<far.length-1;i++){
    const [x,h]=far[i],[xx,hh]=far[i+1],z=-143;
    face('haze',[[x,-.62,z],[xx,-.62,z],[xx,hh,z],[x,h,z]],[0,.2,1]);
  }
  for(let i=0;i<28;i++){
    const x=-25+i*2.35,z=-72-9*(.5+.5*sine(i*11.31));
    const h=1.2+(i%6)*.40+.5*cosine(i*5.2);
    block(i%2?'hills':'buildings',x,h/2-.64,z,1.45,h,2.5);
    if(i%3===0)block(i%2?'tube':'cold',x,h*.49-.42,z+1.27,.21,.16,.04);
  }
  block('hills',13,.34,-48,24,1.45,1.8);
  for(const x of [7,14,21]){
    block('patina',x,2.02,-47.96,.10,3.73,.10);
    block('tube',x,3.90,-47.77,.25,.18,.12);
  }
  const ferryX=12.3,ferryZ=-27.8;
  face('shell',[
    [ferryX-6.4,-.58,ferryZ],[ferryX+5.5,-.58,ferryZ],[ferryX+7.7,.67,ferryZ],
    [ferryX+5.1,.92,ferryZ],[ferryX-5.95,.92,ferryZ],
  ],[0,.14,1]);
  block('white',ferryX-.2,1.21,ferryZ-.37,10.5,.67,.70);
  block('shell',ferryX-.2,1.587,ferryZ-.34,10.95,.14,.76);
  face('iron',[
    [ferryX-6.24,-.35,ferryZ+.001],[ferryX+5.81,-.35,ferryZ+.001],
    [ferryX+6.10,-.11,ferryZ+.001],[ferryX-6.15,-.11,ferryZ+.001],
  ],[0,.14,1]);
  block('rim',ferryX-.20,1.038,ferryZ+.018,10.57,.052,.083);
  block('white',ferryX-1.01,2.223,ferryZ-.411,5.71,.097,.65);
  for(let i=0;i<19;i++)block('rim',ferryX-5.14+i*.550,1.78,ferryZ-.06,.026,.35,.023);
  block('rim',ferryX-.19,1.967,ferryZ-.06,10.35,.029,.025);
  block('iron',ferryX-.98,1.911,ferryZ-.41,5.40,.57,.59);
  block('funnel',ferryX+.48,2.38,ferryZ-.39,.63,.88,.58);
  block('iron',ferryX+.49,2.83,ferryZ-.39,.67,.115,.64);
  block('rim',ferryX-2.96,2.49,ferryZ-.44,.08,1.15,.09);
  block('cold',ferryX-2.96,3.10,ferryZ-.42,.19,.11,.13);
  block('red',ferryX+5.2,1.6,ferryZ+.08,.31,.14,.08);
  for(let i=0;i<10;i++){
    block(i%4===1?'panes':'funnel',ferryX-4.64+i*.93,1.37,ferryZ+.003,.48,.19,.022);
    if(i<6)block('panes',ferryX-3.33+i*.83,1.95,ferryZ-.102,.46,.23,.03);
  }

  return [...batches].map(([name,layer])=>{
    const [color,roughness]=finish[name];
    return {name,geometry:new Geometry(layer.positions,layer.normals,layer.indices),material:new PbrMaterial({color,roughness})};
  });
}
