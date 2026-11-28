import { Material, createMesh } from '@margoengine/materials';
import { batch, bed, box, clamp, color, disk, Geometry, groundGeometry, mix, radius, randomFrom, round, skirt, skySweep, tau, turn } from './geometry.js';

const bottom=-2.70;
const nearRadius=14.78;
const quarry=['#9d9986','#aca38e','#b4a990','#8c8f85','#a2a392','#b4ad96'].map(color);
const shadow=color('#737d7b');

function clockBase(add,mats) {
  add(skySweep(),mats.sweep,'Bright coastal studio sweep','receive');
  add(turn([[0,-3.43],[15.85,-3.43],[16.09,-3.38],[16.16,-3.24],[16.16,-3.04],[16.06,-2.95],
    [15.97,-2.90],[15.97,-2.83],[15.91,-2.76],[14.82,-2.76],[14.66,-2.83],[0,-2.83]],[0,0,0],112),
    mats.foundation,'Circular blue enamel instrument cabinet','shadow');
  add(turn([[16.12,-3.25],[16.17,-3.24],[16.171,-3.19],[16.12,-3.18]],[0,0,0],112),mats.gold,'Clock case brass bezel');
  add(turn([[14.83,-2.766],[16.06,-2.766],[16.06,-2.709],[16.02,-2.678],[14.88,-2.678],[14.80,-2.71]],
    [0,0,0],112),mats.clock,'Grained dial around the harbor');
  add(round(13.8,.236,[0,-3.543,0],100),mats.dark,'Inset foot grounded on the gallery cove','shadow');
  const tick=[];
  const ink=[];
  for(let i=0;i<48;i++) {
    const a=i*tau/48;
    const length=i%12===0?.72:i%2===0?.44:.26;
    const r=15.77-length*.5;
    (i%12===0?tick:ink).push(box(.068,.028,length,[r*Math.sin(a),-2.653,r*Math.cos(a)],.009,a));
  }
  add(batch(ink),mats.index,'Half-hour marks on the rim');
  add(batch(tick),mats.gold,'Six-hour divisions on the brass dial');
  const pointer=add(batch([
    box(.37,.071,.66,[0,.03,0],.022),
    box(.051,.044,.824,[0,.108,-.063],.012),
  ]),mats.red,'Rotating tide-clock time marker');
  return hour=>{
    const a=hour*tau/24;
    pointer.root.setPosition([15.78*Math.sin(a),-2.645,15.78*Math.cos(a)]);
    pointer.root.setRotation([0,a,0]);
  };
}

function makeCliffs(add,mats) {
  const rocks=new Geometry();
  const greens=new Geometry();
  const random=randomFrom(88361);
  function cobble(x,y,z,scale,paint) {
    const h=.15+random()*.26;
    const theta=random()*tau;
    const span=[];
    const crest=[];
    for(let i=0;i<6;i++) {
      const a=theta+i*tau/6;
      const width=scale*(.60+.39*random());
      span.push([x+width*Math.cos(a),y-.11*scale,z+width*Math.sin(a)]);
      crest.push([x+width*.73*Math.cos(a),y+(h+.18*random())*scale,z+width*.73*Math.sin(a)]);
    }
    for(let i=0;i<6;i++){
      const j=(i+1)%6;
      const tone=mix(paint,shadow,.18+.35*random());
      rocks.quad(span[i],crest[i],crest[j],span[j],tone);
      rocks.face(crest[j],crest[i],[x+.11*scale,y+(h+.2)*scale,z-.08*scale],paint);
    }
  }
  for(let index=0;index<90;index++) {
    const x=-12.7+random()*24.1;
    const z=-6.7+random()*12.1;
    if(Math.hypot(x,z)>radius-.42 || z<1 && x>-.7 || Math.abs(x+9)<1.4 && Math.abs(z+2.6)<1.8) continue;
    const level=bed(x,z);
    cobble(x,level-.015,z,.16+random()**2*.89,quarry[Math.floor(random()*quarry.length)]);
  }
  for(let index=0;index<48;index++) {
    const x=-13.8+random()*27.6,z=-13.7+random()*8.6;
    if(Math.hypot(x,z)>radius-.5 || bed(x,z)<.96) continue;
    const tone=mix(color('#587768'),color('#90a384'),random());
    const y=bed(x,z);
    const r=.10+.47*random();
    const h=.16+random()*.40;
    for(let j=0;j<5;j++) {
      const a=tau*j/5,b=tau*(j+1)/5;
      greens.face([x+Math.sin(a)*r,y-.01,z+Math.cos(a)*r],
        [x+Math.sin(b)*r,y-.01,z+Math.cos(b)*r],[x+.12,y+h,z-.04],tone);
    }
  }
  add(rocks.data,mats.land,'Tumbled headland boulders and offshore stones','shadow');
  add(greens.data,mats.land,'Low salt-tolerant coastal growth','shadow');
}

function quay(add,mats) {
  const stone=new Geometry();
  const timber=new Geometry();
  const metal=[];
  const edging=[];
  const houseTimber=[];
  const blockTint=index=>quarry[index%quarry.length];
  const parts=[
    { x:5.98, z:-1.03, w:14.72, d:2.65 },
    { x:10.17, z:1.64, w:2.52, d:5.30 },
  ];
  for(const { x,z,w,d } of parts) {
    stone.append(box(w,3.95,d,[x,-.47,z],.075),quarry[1]);
    for(let i=0;i<8;i++) {
      const y=-2.24+i*.459;
      const count=Math.round(w/.92);
      for(let column=0;column<count;column++) {
        const step=w/count;
        stone.append(box(step-.062,.422,.147,[x-w/2+(column+.5)*step,y,z+d/2],.040),blockTint(i+column*3));
      }
    }
    for(let i=0;i<Math.round(w/1.08);i++){
      const span=w/Math.round(w/1.08);
      const center=x-w/2+(i+.5)*span;
      stone.append(box(span-.035,.181,.32,[center,1.57,z+d/2],.031),blockTint(i+2));
    }
    const columns=Math.max(4,Math.round(w/1.15));
    for(let i=0;i<columns;i++) {
      for(let j=0;j<3;j++) {
        const dx=w/columns;
        stone.append(box(dx-.035,.035,d/3-.043,[x-w/2+(i+.5)*dx,1.529,z-d/2+(j+.5)*d/3],.012),
          blockTint(j*5+i));
      }
    }
  }
  for(const x of [-1.0,.9,3.0,6.9,9.14,11.8]) {
    metal.push(round(.12,.44,[x,1.79,.09],14));
    edging.push(round(.163,.094,[x,2.03,.09],15));
  }
  for(const z of [.48,1.83,3.85]) {
    metal.push(round(.13,.43,[10.87,1.77,z],16));
    edging.push(round(.151,.09,[10.87,2.02,z],16));
  }
  const dockX=-3.54;
  for(let index=0;index<21;index++) {
    const z=-4.81+index*.42;
    timber.append(box(1.57,.126,.389,[dockX,1.418,z],.026),color(['#867058','#a08a6b','#967a5c','#a69070'][index%4]));
    if(index%4===0) {
      for(const x of [dockX-.61,dockX+.61]) {
        houseTimber.push(round(.10,4.17,[x,-.61,z],12));
        edging.push(round(.12,.045,[x,1.502,z],12));
      }
    }
  }
  houseTimber.push(box(.10,.16,8.85,[dockX-.56,1.33,-.610],.024));
  houseTimber.push(box(.10,.16,8.85,[dockX+.56,1.33,-.610],.024));
  for(let i=0;i<8;i++){
    const z=3.91+i*.193;
    timber.append(box(.95,.116,.222,[dockX,1.35-i*.273,z],.021),color(i%2?'#917962':'#927d64'));
  }
  add(stone.data,mats.land,'Granite harbor quay and broad breakwater','shadow');
  add(timber.data,mats.land,'Slatted landing pier and tidal steps','shadow');
  add(batch(houseTimber),mats.darkWood,'Pier piles and pile caps','shadow');
  add(batch(metal),mats.dark,'Cast mooring bollards','shadow');
  add(batch(edging),mats.iron,'Mooring hardware and board fasteners','shadow');

  const ruler=[];
  const marks=[];
  const rulerX=4.72;
  ruler.push(box(.463,4.18,.146,[rulerX,-.51,.473],.043));
  ruler.push(box(.540,.127,.172,[rulerX,1.57,.492],.032));
  for(let mark=0;mark<=16;mark++) {
    const y=-2+mark*.21875;
    marks.push(box(mark%4===0?.328:.205,.030,.020,[rulerX,y,.552],.006));
  }
  add(batch(ruler),mats.dark,'Historic graduated tide staff','shadow');
  add(batch(marks),mats.cream,'Tide staff graduations');
  const slider=add(box(.512,.074,.132,[0,0,0],.022),mats.red,'Tide staff surface indicator');
  return level=>slider.root.setPosition([rulerX,level,.601]);
}

function lighthouse(add,mats) {
  const x=-8.73,z=-2.37;
  const y=bed(x,z)-.037;
  const terrace=[];
  const cream=[];
  const red=[];
  const frame=[];
  const glass=[];
  const treads=[];
  terrace.push(turn([[0,-.17],[1.47,-.17],[1.51,-.09],[1.48,.093],[1.41,.17],[1.32,.19],[0,.19]],[x,y,z],38));
  cream.push(turn([[.87,.17],[.90,.28],[.823,.43],[.64,3.33],[.70,3.47],[.76,3.52],[.74,3.61]],
    [x,y,z],42));
  red.push(turn([[.968,3.42],[1.014,3.46],[1.014,3.57],[.93,3.61],[.69,3.64]],
    [x,y,z],28));
  glass.push(turn([[.56,3.63],[.57,4.20],[.52,4.29]],[x,y,z],10));
  red.push(turn([[.68,4.20],[.79,4.25],[.79,4.31],[.72,4.36],[.37,4.60],[.13,4.79],[.085,4.82],[0,4.82]],
    [x,y,z],34));
  frame.push(round(.061,.23,[x,y+4.85,z],10));
  frame.push(turn([[.931,3.86],[.965,3.862],[.974,3.900],[.941,3.929],[.915,3.925]],
    [x,y,z],40));
  for(let i=0;i<10;i++){
    const a=tau*i/10;
    frame.push(round(.027,.33,[x+.932*Math.cos(a),y+3.74,z+.932*Math.sin(a)],8));
    frame.push(round(.036,.591,[x+.563*Math.cos(a),y+3.945,z+.563*Math.sin(a)],9));
  }
  frame.push(box(.397,.832,.046,[x,y+.665,z+.850],.037));
  cream.push(box(.56,.105,.28,[x,y+.195,z+.960],.034));
  frame.push(box(.235,.345,.041,[x,y+2.35,z+.713],.013));
  cream.push(box(.322,.057,.079,[x,y+2.17,z+.725],.015));
  for(let i=0;i<11;i++){
    const zRoad=z+1.10+i*.259;
    const h=bed(x-.03,zRoad);
    treads.push(box(.55,.075,.225,[x-.03,h+.019,zRoad],.015));
  }
  add(batch(terrace),mats.stone,'Circular lighthouse foundation','shadow');
  add(batch(cream),mats.cream,'Tapered white masonry light tower','shadow');
  add(batch(red),mats.red,'Copper-red lantern roof and walk');
  add(batch(frame),mats.dark,'Lighthouse lantern frames, railings and door','shadow');
  add(batch(glass),mats.lantern,'Amber lantern glazing');
  add(batch(treads),mats.stone,'Granite footpath');
}

function houses(add,mats) {
  const foundations=[];
  const wine=new Geometry();
  const blocks=new Geometry();
  const windows=[];
  const wood=[];
  const small=[
    [1.8,-7.64,2.96,2.16,1.81,'#a1a69c','#798c89'],
    [5.26,-8.15,3.43,2.86,2.02,'#d1b39b','#a3725c'],
    [8.91,-7.41,2.89,2.28,1.61,'#b9b6a5','#789096'],
    [5.79,-4.80,2.54,1.64,1.47,'#c6b89f','#af7965'],
  ];
  for(const [x,z,w,d,h,plaster,roof] of small) {
    const under=bed(x,z);
    const y=Math.max(1.54,under);
    const eve=y+h;
    const peak=eve+.65;
    foundations.push(box(w+.20,y-under+.36,d+.18,[x,(y+under)/2-.082,z],.061));
    blocks.append(box(w,h,d,[x,y+h/2,z],.058),color(plaster));
    const x0=x-w/2,x1=x+w/2;
    blocks.face([x0,eve,z+d/2],[x0,peak,z],[x0,eve,z-d/2],color(plaster));
    blocks.face([x1,eve,z-d/2],[x1,peak,z],[x1,eve,z+d/2],color(plaster));
    for(const side of [-1,1]) {
      for(let r=0;r<4;r++) {
        const za=z+side*(d/2+.13)*r/4;
        const zb=z+side*(d/2+.13)*(r+1)/4;
        const a=peak+(eve-peak)*r/4;
        const b=peak+(eve-peak)*(r+1)/4;
        for(let col=0;col<9;col++) {
          const p=x0-.135+(w+.27)*col/9,q=p+(w+.27)/9-.021;
          const points=[[p,a+.026,za],[p,b+.026,zb],[q,b+.026,zb],[q,a+.026,za]];
          if(side<0) points.reverse();
          wine.quad(...points,mix(color(roof),color('#6a7a77'),((r*3+col*9)%7)/29));
        }
      }
    }
    wood.push(box(w+.325,.09,.13,[x,peak+.041,z],.029));
    blocks.append(box(.33,.82,.38,[x+w*.26,peak-.115,z-.31],.023),color('#a68e79'));
    const front=z+d/2;
    for(const offset of [-.81,.81]) {
      wood.push(box(.50,.61,.051,[x+offset,y+h*.61,front+.042],.022));
      windows.push(box(.36,.468,.031,[x+offset,y+h*.61,front+.078],.012));
      wood.push(box(.035,.443,.037,[x+offset,y+h*.61,front+.092],.008));
    }
    windows.push(box(.53,.84,.057,[x,y+.53,front+.050],.011));
    wood.push(box(.649,.101,.173,[x,y+.102,front+.095],.021));
  }
  add(batch(foundations),mats.stone,'Village stone plinths','shadow');
  add(blocks.data,mats.land,'Tide house and small coast cottages','shadow');
  add(wine.data,mats.land,'Slate and terracotta cottage roofs','shadow');
  add(batch(windows),mats.dark,'Painted door openings and window glass');
  add(batch(wood),mats.cream,'Village window frames and ridge courses','shadow');
}

function buoy(add,mats) {
  const red=[];
  const white=[];
  const ribs=[];
  const hull=[];
  red.push(turn([[.19,-.240],[.48,-.125],[.67,.012],[.68,.132],[.55,.225],[.29,.282],[.26,.32]],
    [0,0,0],36));
  hull.push(turn([[0,-.290],[.22,-.29],[.46,-.13],[.69,.015],[.69,.086]],
    [0,0,0],36));
  white.push(round(.175,.83,[0,.687,0],16));
  red.push(round(.202,.264,[0,.850,0],16));
  white.push(round(.118,.158,[0,1.150,0],12));
  red.push(turn([[.12,1.224],[.187,1.24],[.187,1.32],[.126,1.36],[.02,1.45]],
    [0,0,0],16));
  for(let i=0;i<4;i++){
    const a=tau*i/4;
    ribs.push(box(.043,.68,.042,[.22*Math.cos(a),.65,.22*Math.sin(a)],.012,a));
  }
  const moves=[
    add(batch(red),mats.red,'Floating coral daymark buoy'),
    add(batch(white),mats.cream,'Buoy white band and lantern housing'),
    add(batch(ribs),mats.iron,'Daymark cage rods'),
    add(batch(hull),mats.dark,'Heavy buoy skirt'),
  ];
  return h =>{for(const model of moves)model.root.setPosition([4.71,h,6.75]);};
}

function shoreline(height) {
  const waterline=new Geometry();
  const white=color('#b2d2cf');
  for(let i=0;i<118;i++){
    const x=-13.45+i*(26.9/117);
    const radiusAt=Math.sqrt(nearRadius**2-x*x);
    let low=-radiusAt+.20,high=radiusAt-.21;
    if(bed(x,low)<=height || bed(x,high)>=height) continue;
    for(let j=0;j<17;j++){
      const m=(low+high)/2;
      if(bed(x,m)>height)low=m;
      else high=m;
    }
    const z=high+.10+Math.sin(x*2.99)*.051;
    if(z<.45 && z>-2.41 && x>-1.40 && x<13.45) continue;
    if(Math.hypot(x,z+.12)>nearRadius-.16)continue;
    const length=.095+.043*Math.sin(x*9.63);
    waterline.quad([x-length,.023,z-.014],[x-length*.25,.024,z+.066],
      [x+length,.023,z+.043],[x+length*.48,.023,z-.024],mix(white,color('#719b9e'),.2+.26*Math.sin(x*3.1)**2));
  }
  return waterline.data;
}

function water(add,mats) {
  const dark=color('#3e697d'), pale=color('#87b4ad'), middle=color('#649399');
  const surface=add(disk(nearRadius,(x,z)=>.014*Math.sin(1.38*x+2.24*z)+.007*Math.sin(2.09*x-4.1*z),
    (x,z)=>
      mix(mix(middle,pale,clamp((bed(x,z)+2.0)/2.15)*.52),
        dark,.41*clamp((z+2)/20)+.13*Math.sin(x*.32+z*.52)**2)),mats.surface,'Glossy tide plane inside the circular basin');
  const blue=color('#517685');
  const sky=color('#678e96');
  const cut=add(skirt(nearRadius+.018,()=>1,0,az=>mix(blue,sky,.25+.21*Math.cos(az-.48))),mats.waterCut,'Exposed model water section');
  cut.root.setPosition([0,bottom,0]);
  const marks=new Geometry();
  const random=randomFrom(619442);
  for(let i=0;i<175;i++){
    const a=tau*random(),r=14.2*Math.sqrt(random());
    const x=r*Math.sin(a),z=r*Math.cos(a);
    if(bed(x,z)>1.0)continue;
    const l=.087+random()**1.9*.51;
    const w=.018+random()*.031;
    marks.quad([x-l,.029,z],[x-l*.44,.029,z+w],[x+l,.029,z+.01],[x+l*.42,.029,z-w*.62],
      mix(middle,pale,.17+.38*random()));
  }
  const ripples=add(marks.data,mats.foam,'Water surface glints');
  const mark=add(shoreline(.5),mats.foam,'Foam tracing the currently submerged shoreline');
  return h=>{
    surface.root.setPosition([0,h,0]);
    cut.root.setScale([1,h-bottom,1]);
    ripples.root.setPosition([0,h,0]);
    mark.setGeometry(shoreline(h));
    mark.root.setPosition([0,h,0]);
  };
}

export function buildHarbor(engine,shadows) {
  const mats={
    sweep:new Material({color:'#eceee4',roughness:.86}),
    foundation:new Material({color:'#486a76',roughness:.52}),
    gold:new Material({color:'#a88555',roughness:.44}),
    clock:new Material({color:'#617681',roughness:.64}),
    index:new Material({color:'#d5c8a7',roughness:.61}),
    land:new Material({color:'#ece9dd',roughness:.84}),
    stone:new Material({color:'#9e9585',roughness:.76}),
    cream:new Material({color:'#e2d9bd',roughness:.57}),
    red:new Material({color:'#ab5844',roughness:.54}),
    dark:new Material({color:'#3e6268',roughness:.63}),
    iron:new Material({color:'#5d7375',roughness:.56}),
    darkWood:new Material({color:'#685447',roughness:.72}),
    lantern:new Material({color:'#c18b53',roughness:.33,emissive:'#b48451',emissiveIntensity:.32}),
    surface:new Material({color:'#c9dcda',roughness:.29,metalness:.035}),
    waterCut:new Material({color:'#a7bfc1',roughness:.73}),
    foam:new Material({color:'#cbdad6',roughness:.61}),
  };
  const owned=[];
  const add=(geometry,material,name,role)=>{
    const mesh=createMesh(engine,geometry,material);
    mesh.root.name=name;
    owned.push(mesh);
    if(role==='shadow')shadows.add(mesh,{static:true});
    if(role==='receive')shadows.add(mesh,{static:true,castShadow:false});
    return mesh;
  };
  const hand=clockBase(add,mats);
  const ground=groundGeometry();
  add(ground.top,mats.land,'Relief of exposed sandflats and coastal terraces','shadow');
  add(ground.side,mats.land,'Geological cut face around the relief','shadow');
  makeCliffs(add,mats);
  const staff=quay(add,mats);
  lighthouse(add,mats);
  houses(add,mats);
  const riseBuoy=buoy(add,mats);
  const ocean=water(add,mats);
  return {
    update(level,hour){ocean(level);staff(level);riseBuoy(level);hand(hour);},
    dispose(){for(const mesh of owned.reverse())mesh.dispose();for(const material of Object.values(mats))material.dispose();},
  };
}