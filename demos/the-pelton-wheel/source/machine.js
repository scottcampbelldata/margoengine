import { createMesh, Material, MatcapMaterial } from '@margoengine/materials';
import { cylinderGeometry, sphereGeometry } from '@margoengine/geometry/primitives';
import { basin, box, color, cup, disk, front, lathe, merge, MeshData, mix, oak, place, round, studioMaps, sweep } from './craft.js';
import { bucketCount, deflected, jetHeight, jetSpeed, nozzleRadius, runnerRadius, tau, wheelCenter } from './impulse.js';

const nozzleTip=-.193;

function installSet(add,mats){
  add(sweep(),mats.studio,'Painted studio sweep','receiver');
  add(box(1.10,.047,.439,[-.022,.016,0],.018),mats.base,'Blackened oak plinth','static');
  add(oak(),mats.grain,'Oiled wood grain');
  add(merge([
    box(1.072,.003,.416,[-.022,.019,0],.015),
    box(.163,.024,.003,[-.407,.029,.220],.004),
    ...[-.463,-.350,.391,.459].map(x=>disk([[.003,-.002],[.005,-.002],[.005,.002],[.003,.002]], [x,.029,.222],12)),
  ]),mats.nickel,'Recessed maker plate and perimeter inlay');

  const basinX=.172,basinZ=.010;
  add(merge([
    box(.692,.037,.364,[basinX,.061,basinZ],.018),
    box(.692,.047,.039,[basinX,.080,-.153],.014),
    box(.692,.030,.030,[basinX,.074,.176],.013),
    ...[-.156,.500].map(x=>box(.043,.047,.337,[x,.080,basinZ],.015)),
  ]),mats.ceramic,'Ivory vitreous ceramic return tray','static');
  add(basin(),mats.reservoir,'Catch basin water');
  add(merge([
    box(.130,.030,.099,[.131,.100,-.103],.009),
    box(.067,.194,.082,[.132,.207,-.104],.010),
    box(.106,.050,.107,[.132,.311,-.104],.013),
    disk([[.201,-.038],[.205,-.044],[.223,-.044],[.229,-.036],[.229,.002],[.224,.010],[.207,.010],[.201,.004],[.201,-.038]],
      [.132,.318,-.086],61,.783,4.71),
    ...[-1,1].map(s=>box(.102,.041,.060,[.132+s*.158,.133,-.085],.009,s*.49)),
  ]),mats.ceramic,'Vitreous ceramic cutaway splash guard and bearing tower','static');
  const lip=[[.202,-.002],[.206,-.002],[.206,.003],[.202,.003],[.202,-.002]];
  add(disk(lip,[.132,.318,-.074],62,.783,4.71),mats.brass,'Glazed shroud and brass leading lip');
  const anchorPositions=[[-.018,.154],[.282,.154],[-.041,.433],[.307,.405]];
  add(merge(anchorPositions.map(([x,y])=>front(cylinderGeometry(.010,.010,.009,8,1),[x,y,-.068]))),mats.nickel,'Ceramic guard fixing bolts');

  add(merge([
    round(.042,.012,[-.427,.045,0]),
    lathe([[.031,0],[.031,.008],[.022,.016],[.022,.254],[.027,.261],[.027,.332],[.021,.343],[.021,.389]],[-.427,.052,0]),
    box(.057,.085,.084,[-.427,.429,0],.015),
  ]),mats.enamel,'Navy feed pipe and pedestal','static');
  const feeds=[
    lathe([[0,0],[.027,0],[.044,.003],[.044,.009],[.037,.014]],[-.451,jetHeight,0],-Math.PI/2,24),
    lathe([[.046,0],[.045,.010],[.041,.028],[.033,.034],[.033,.045],[.029,.053],[.029,.140],[.025,.150],[.015,.181],[.012,.213],[.011,.226],[.011,.250],[.0088,.250],[.0088,.239]],
      [nozzleTip-.250,jetHeight,0],-Math.PI/2),
    lathe([[.034,0],[.037,.006],[.037,.015],[.032,.018]],[-.389,jetHeight,0],-Math.PI/2),
    lathe([[.026,0],[.032,.006],[.032,.018],[.026,.022]],[-.427,.363,0]),
    lathe([[.014,0],[.018,.003],[.018,.013],[.013,.016]],[-.239,jetHeight,0],-Math.PI/2),
  ];
  add(merge(feeds),mats.brass,'Turned feed nozzle with collar and bore','static');
  add(merge([
    lathe([[.043,0],[.043,.005],[.037,.008],[.037,.005],[.037,0]],[-.427,.051,0]),
    ...[-.374,-.357,-.339,-.321,-.303].map(x=>lathe([[.029,0],[.0305,0],[.0305,.0015],[.029,.0015]],[x,jetHeight,0],-Math.PI/2,28)),
    ...[-.034,.034].map(z=>round(.007,.011,[-.427,.053,z],8)),
  ]),mats.nickel,'Machined feed accents');
}

function rotatingWheel(add,mats){
  const ring=[[.132,-.020],[.136,-.024],[.155,-.024],[.160,-.018],[.160,.017],[.154,.022],[.136,.022],[.132,.017],[.132,-.020]];
  const shapes=[disk(ring,[0,0,0])];
  const edgeBolts=[];
  for(let i=0;i<8;i++){
    const t=tau*i/8,c=Math.cos(t),s=Math.sin(t);
    shapes.push(box(.112,.022,.032,[.091*c,.091*s,0],.007,t));
    edgeBolts.push(front(cylinderGeometry(.006,.006,.008,8,1),[.146*c,.146*s,.025]));
  }
  const rotor=add(merge(shapes),mats.enamel,'Runner rim and curved spokes');
  const attach=(shape,material,name)=>{
    const mesh=add(shape,material,name);
    mesh.root.setParent(rotor.root);
    return mesh;
  };
  attach(disk([[.002,-.050],[.037,-.050],[.041,-.038],[.041,-.019],[.052,-.013],[.052,.012],[.042,.028],[.036,.035],[.002,.035]],
    [0,0,0],52),mats.brass,'Polished brass hub and axle');
  const bolt=front(cylinderGeometry(.020,.020,.011,8,1),[0,0,.041]);
  attach(merge([bolt,...edgeBolts]),mats.nickel,'Spinner nut and radial fasteners');
  for(const depth of [-.024,.023]){
    attach(disk([[.137,0],[.151,0],[.151,.003],[.137,.003],[.137,0]],[0,0,depth]),mats.brass,'Turned brass rim band');
  }
  attach(box(.011,.021,.008,[0,.142,.028],.003),mats.index,'Single amber phase reference');
  const bucket={...cup()};
  bucket.uvs=new Float32Array(bucket.positions.length/3*2);
  const buckets=Array.from({length:bucketCount},(_,i)=>{
    const theta=tau*i/bucketCount;
    return place(bucket,[-runnerRadius*Math.sin(theta),runnerRadius*Math.cos(theta),0],theta);
  });
  const colors=new Float32Array(bucket.colors.length*bucketCount);
  for(let i=0;i<bucketCount;i++)colors.set(bucket.colors,i*bucket.colors.length);
  attach({...merge(buckets),colors},mats.spoon,'Sixteen bronze double cups with machined splitters');
  rotor.root.setPosition(wheelCenter);
  return rotor;
}

function slick(model,side){
  const patch=new MeshData(),edge=color('#b4f8ed'),body=color('#319caa'),blue=color('#398fbc');
  const intervals=25,inside=7;
  for(let i=0;i<=inside+intervals;i++){
    const n=Math.max(0,i-inside)/intervals;
    const entrance=Math.min(1,i/inside);
    const [x,y,z]=i<inside
      ? [wheelCenter[0]-.012*(1-entrance)+.014*Math.sin(Math.PI*entrance),jetHeight-.002*Math.sin(Math.PI*entrance),side*(.003+entrance*.036)]
      : deflected(model,n*.034,side);
    const w=.002+.003*entrance+.011*n;
    const spread=.0025*Math.sin(Math.PI*n)+n*.002;
    const across=[[x,y-w,z+side*spread],[x,y-.28*w,z+side*(.0044+spread)],
      [x,y+.27*w,z+side*(.0044+spread)],[x,y+w,z+side*spread]];
    const end=Math.max(0,(n-.70)/.30);
    const fade=1-end*end*(3-2*end);
    across.forEach((p,k)=>{
      const rim=k===0||k===3;
      const tint=rim?mix(edge,blue,n):mix(body,edge,.38);
      patch.point(p,[0,.45,.89],[...tint,fade*(rim ? .52 : 1)]);
    });
    if(i){
      const l=(i-1)*4;
      for(let k=0;k<3;k++){
        const a=l+k,b=a+1,c=a+4,d=b+4;
        patch.data.indices.push(a,b,c,b,d,c,c,b,a,c,d,b);
      }
    }
  }
  return patch.data;
}

function water(add,mats){
  const start=lathe([[0,0],[nozzleRadius,0],[nozzleRadius,.3200],[0,.3200]],
    [nozzleTip,jetHeight,0],-Math.PI/2,30);
  add(start,mats.jet,'Continuous waterjet at true diameter');
  const tiny=sphereGeometry(.0027,9,7);
  const incoming=Array.from({length:11},()=>add(tiny,mats.glint,'Waterjet surface glint'));
  const ribbons=[-1,1].map(side=>add(slick({transverse:4,tangential:1},side),mats.sheet,'Outlet sheet'));
  const spray=[-1,1].map(side=>Array.from({length:6},()=>add(tiny,side===1?mats.glint:mats.spray,'Divided jet tracer')));
  let last;
  return (model,time)=>{
    if(last!==model){
      ribbons.forEach((mesh,i)=>mesh.setGeometry(slick(model,i===0?-1:1)));
      last=model;
    }
    incoming.forEach((mesh,i)=>{
      const span=wheelCenter[0]-nozzleTip;
      const s=(time*jetSpeed/span+i/incoming.length)%1;
      const around=i*2.39996+s*.45;
      mesh.root.setPosition([nozzleTip+span*s,jetHeight+.0085*Math.sin(around),.0085*Math.cos(around)]);
      mesh.root.setScale([1.7,.66,.66]);
    });
    spray.forEach((path,index)=>path.forEach((mesh,i)=>{
      const side=index===0?-1:1;
      const t=.001+((time/.034+i/path.length+.087*side+1)%1)*.033;
      const p=deflected(model,t,side);
      p[1]+=.0017*Math.sin(i*3.73+t*173);
      p[2]+=side*.0018;
      mesh.root.setPosition(p);
      const scale=1.16-.46*t/.034;
      mesh.root.setScale([scale,scale,scale]);
    }));
  };
}

export function buildWheel(engine,shadows){
  const maps=studioMaps();
  const mats={
    studio:new Material({color:'#d4d9cd',roughness:.83}),
    base:new Material({color:'#3c3830',roughness:.62}),
    grain:new Material({color:'#d8c7a8',roughness:.59}),
    enamel:new Material({color:'#315760',roughness:.31,metalness:.19}),
    ceramic:new Material({color:'#e2d7b7',roughness:.30,metalness:.015}),
    spoon:new MatcapMaterial({color:'#fff4dd',matcap:maps.metal}),
    brass:new MatcapMaterial({color:'#deb17a',matcap:maps.metal}),
    nickel:new MatcapMaterial({color:'#ced8ce',matcap:maps.metal}),
    index:new Material({shading:'basic',color:'#d99149'}),
    reservoir:new Material({color:'#ccf4f3',roughness:.22,metalness:.12}),
    jet:new MatcapMaterial({color:'#e1fffa',matcap:maps.water}),
    sheet:new Material({shading:'basic',color:'#c7ecea',transparent:true,opacity:.83,depthWrite:false}),
    glint:new Material({shading:'basic',color:'#dfede3'}),
    spray:new Material({shading:'basic',color:'#73d3dd'}),
  };
  const meshes=[];
  const add=(shape,material,name,shadow)=>{
    const mesh=createMesh(engine,shape,material);
    mesh.root.name=name;meshes.push(mesh);
    if(shadow)shadows.add(mesh,{static:true,castShadow:shadow==='static'});
    return mesh;
  };
  installSet(add,mats);
  const rotor=rotatingWheel(add,mats);
  const flow=water(add,mats);
  return {
    anchors:[[-.205,jetHeight+.044,.018],[.220,jetHeight+.065,.052]],
    update(model,phase,time){
      rotor.root.setRotation([0,0,-phase]);
      flow(model,time);
    },
    dispose(){
      for(const mesh of meshes.reverse())mesh.dispose();
      for(const material of Object.values(mats))material.dispose();
      for(const t of Object.values(maps))t.dispose();
    },
  };
}
