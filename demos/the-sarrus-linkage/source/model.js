import { applyMatrix4, latheGeometry, mergeGeometries, sphereGeometry } from '@margoengine/geometry';
import { roundedBoxGeometry } from '@margoengine/geometry/extras';
import { Material, createMesh } from '@margoengine/materials';
import { apertureRadius, armLength, datumRadius, families } from './mechanism.js';

const up=[0,1,0], front=[0,0,1], right=[1,0,0];
const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const unit=(v)=>v.map((value)=>value/Math.hypot(...v));

const finishes={
  terrain:{color:[1,1,1],roughness:.99},
  sandstone:{color:[.344,.231,.156],roughness:.98},
  darkStone:{color:[.224,.174,.127],roughness:.95},
  concrete:{color:[.475,.433,.365],roughness:.91},
  tile:{color:[.584,.535,.445],roughness:.86},
  grout:{color:[.185,.172,.143],roughness:.92},
  frame:{color:[.098,.132,.127],roughness:.59},
  trim:{color:[.224,.280,.264],roughness:.44},
  slate:{color:[.250,.290,.266],roughness:.53},
  deck:{color:[.490,.502,.436],roughness:.55},
  steel:{color:[.528,.594,.580],roughness:.30,metalness:1},
  pin:{color:[.564,.650,.628],roughness:.33},
  orange:{color:[.733,.239,.078],roughness:.43},
  orangeLift:{color:[.898,.378,.111],roughness:.37},
  teal:{color:[.098,.342,.335],roughness:.43},
  tealLift:{color:[.141,.462,.442],roughness:.37},
  chalk:{color:[.749,.724,.602],roughness:.64},
  datum:{color:'#c3ef8a',shading:'basic'},
};

function place(data,p,axis=up) {
  const x=unit(cross(axis,Math.abs(axis[2])>.87?right:front));
  const z=cross(x,axis);
  return applyMatrix4(data,[...x,0,...axis,0,...z,0,...p,1]);
}

function terrainHeight(x,z) {
  const away=Math.min(1,Math.max(0,(Math.max(Math.abs(x)*.89,Math.abs(z)) - 1.45)/2.6));
  const ridge=.17*Math.sin(.85*x+.47*z)+.115*Math.cos(.4*x-1.05*z)+.063*Math.sin(x*2.4-z*1.71);
  return -.114+(ridge-.090)*away*away;
}

function fieldTerrain() {
  const steps=72,side=steps+1,extent=24;
  const positions=[],normals=[],uvs=[],colors=[],indices=[];
  for(let j=0;j<=steps;j++) for(let i=0;i<=steps;i++) {
    const x=(i/steps*2-1)*extent,z=(j/steps*2-1)*extent;
    const edge=Math.min(.68,Math.hypot(x,z)/25);
    const sand=.033*Math.sin(1.13*x+.61*z)+.024*Math.cos(.52*x-1.2*z)+.014*Math.sin(x*5.4+z*4.3);
    const shelf=.009*Math.sin(z*9.2+x*.84);
    const dx=(terrainHeight(x+.02,z)-terrainHeight(x-.02,z))/.04;
    const dz=(terrainHeight(x,z+.02)-terrainHeight(x,z-.02))/.04;
    positions.push(x,terrainHeight(x,z),z);
    normals.push(...unit([-dx,1,-dz]));
    uvs.push(i/steps,j/steps);
    colors.push(.441+sand+shelf-edge*.083,.303+.8*sand+shelf-edge*.006,.199+.56*sand+edge*.058);
    if(i>0&&j>0) {
      const v=j*side+i;
      indices.push(v-side-1,v-1,v-side,v-side,v-1,v);
    }
  }
  return {positions:Float32Array.from(positions),normals:Float32Array.from(normals),uvs:Float32Array.from(uvs),
    colors:Float32Array.from(colors),indices:Uint32Array.from(indices)};
}

export function prepareSarrus() {
  const batches=new Map();
  function add(group,material,data) {
    const key=group+':'+material;
    if(!batches.has(key)) batches.set(key,[]);
    batches.get(key).push(data);
  }
  function box(group,material,p,size,bevel,axis=up) {
    add(group,material,place(roundedBoxGeometry(...size,2,bevel),p,axis));
  }
  function barrel(group,material,p,r,depth,axis=up,segments=44) {
    const h=depth/2,b=Math.min(r*.20,depth*.17);
    add(group,material,place(latheGeometry([[0,-h],[r-b,-h],[r,-h+b],[r,h-b],[r-b,h],[0,h]],segments),p,axis));
  }
  function ring(group,material,p,inner,outer,depth,bevel,axis=up,segments=54) {
    const a=-depth/2,b=depth/2;
    add(group,material,place(latheGeometry([
      [inner+bevel,a],[outer-bevel,a],[outer,a+bevel],[outer,b-bevel],[outer-bevel,b],
      [inner+bevel,b],[inner,b-bevel],[inner,a+bevel],[inner+bevel,a],
    ],segments),p,axis));
  }
  function beam(group,material,a,b,width,thickness,bevel) {
    const vector=b.map((v,i)=>v-a[i]);
    box(group,material,a.map((v,i)=>(v+b[i])/2),[width,Math.hypot(...vector),thickness],bevel,unit(vector));
  }
  function bolt(group,p,r,axis=up) {
    barrel(group,'frame',p,r*1.35,.008,axis,16);
    barrel(group,'pin',p.map((value,i)=>value+axis[i]*.009),r,.017,axis,6);
  }

  add('world','terrain',fieldTerrain());
  for(let i=0;i<100;i++) {
    const phase=i*2.399963;
    const distance=1.98+(i%17)*.161;
    const x=distance*Math.cos(phase),z=distance*Math.sin(phase);
    if(Math.abs(x)<1.72&&Math.abs(z)<1.65) continue;
    const s=.032+(i%13)*.0069;
    const rock=sphereGeometry(1,8,5);
    for(let j=0;j<rock.positions.length;j+=3) {
      const f=.78+.28*Math.sin(j*1.8+i);
      rock.positions[j]*=f;
      rock.positions[j+1]*=f;
      rock.positions[j+2]*=f;
    }
    add('world',i%3===0?'darkStone':'sandstone',applyMatrix4(rock,[
      s*1.35,0,0,0,0,s*.61,0,0,0,0,s*.91,0,x,terrainHeight(x,z)-s*.09,z,1,
    ]));
  }
  box('world','concrete',[-.045,-.066,.013],[3.56,.155,2.96],.077);
  box('world','grout',[-.04,.011,.012],[3.42,.032,2.85],.012);
  for(const x of [-1.174,-.040,1.094]) for(const z of [-.460,.483]) {
    box('world','tile',[x,.028,z],[1.122,.046,.925],.012);
  }
  // Edge markings and anchored bearing cradles set the mechanism into the field slab.
  for(const x of [-1.17,1.10]) {
    box('world','concrete',[x,-.026,1.118],[.390,.071,.358],.022);
    for(let i=0;i<6;i++) box('world','chalk',[x-.133+.053*i,.057,1.064],[.023,.005,.173],.002);
  }
  box('world','frame',[0,.087,-.061],[2.035,.087,1.702],.024);
  box('world','trim',[0,.135,-.061],[1.936,.027,1.602],.012);
  for(const x of [-.84,.84]) for(const z of [-.737,.618]) {
    box('world','slate',[x,.139,z],[.225,.035,.183],.010);
    for(const offset of [-.074,.074]) bolt('world',[x+offset,.16,z],.014);
  }
  for(let i=0;i<16;i++) {
    box('world','frame',[-.72+i*.095,.116,.808],[.021,.027,.010],.004);
  }
  for(const [index,{pivot,axis,spread}] of families.entries()) {
    const color=index===0?'teal':'orange';
    const axisIsX=index===1;
    const dims=axisIsX?[.79,.144,.168]:[.167,.144,.79];
    const p=[pivot[0],pivot[1]-.063,pivot[2]];
    box('world','frame',p,dims,.020);
    barrel('world','steel',pivot,.027,spread+.19,axis);
    const deckPivot=[pivot[0],0,pivot[2]];
    box('deck','frame',[pivot[0],.065,pivot[2]],dims,.021);
    barrel('deck','steel',deckPivot,.027,spread+.19,axis);
    for(const side of [-1,1]) {
      const elbow=pivot.map((v,i)=>v+axis[i]*side*(spread*.5+.054));
      const upper=deckPivot.map((v,i)=>v+axis[i]*side*(spread*.5+.054));
      ring('world',color,elbow,.026,.054,.037,.007,axis,58);
      ring('deck',color,upper,.026,.054,.037,.007,axis,58);
      bolt('world',elbow.map((v,i)=>v+axis[i]*side*.023),.025,axis.map((v)=>v*side));
      bolt('deck',upper.map((v,i)=>v+axis[i]*side*.023),.025,axis.map((v)=>v*side));
    }
  }

  // The slim datum post is stationary. The platform has a generous open ring around it.
  barrel('world','frame',[0,.159,0],.101,.040,up,66);
  ring('world','datum',[0,.183,0],.060,.072,.004,.0014,up,66);
  barrel('world','trim',[0,.195,0],.040,.032,up,54);
  barrel('world','datum',[0,1.123,0],datumRadius,1.855,up,32);
  for(let y=.275;y<2.042;y+=.102) {
    ring('world','frame',[0,y,0],datumRadius,.0136,.018,.0006,up,22);
  }
  barrel('world','pin',[0,2.065,0],.015,.031,up,34);

  // Thin, beveled deck strips sit in a structural perimeter with a true witness aperture.
  for(const z of [-.70,.70]) box('deck','frame',[0,.153,z],[1.960,.154,.131],.018);
  for(const x of [-.908,.908]) box('deck','frame',[x,.153,0],[.136,.154,1.488],.016);
  for(const z of [-.713,.713]) box('deck','trim',[0,.229,z],[1.950,.029,.070],.009);
  for(const x of [-.930,.930]) box('deck','trim',[x,.229,0],[.069,.030,1.47],.009);
  for(const side of [-1,1]) {
    for(let i=0;i<7;i++) {
      const x=side*(.171+.097*i);
      box('deck',i%2===0?'deck':'slate',[x,.207,0],[.090,.063,1.283],.008);
      box('deck','trim',[x,.240,-.560],[.070,.008,.060],.002);
      box('deck','trim',[x,.240,.558],[.070,.008,.060],.002);
    }
    box('deck','deck',[0,.204,side*.404],[.239,.060,.466],.007);
  }
  ring('deck','frame',[0,.224,0],apertureRadius,.170,.045,.009,up,74);
  ring('deck','datum',[0,.250,0],apertureRadius+.006,.103,.009,.002,up,74);
  for(let i=0;i<4;i++) {
    const angle=i*Math.PI/2,x=Math.cos(angle),z=Math.sin(angle);
    beam('deck','datum',[x*.106,.255,z*.106],[x*.149,.255,z*.149],.010,.009,.002);
  }
  for(const x of [-.802,.799]) {
    box('deck','trim',[x,.256,-.629],[.124,.034,.123],.010);
    box('deck','trim',[x,.256,.461],[.124,.034,.123],.010);
    barrel('deck','trim',[x,.536,-.629],.030,.556,up,38);
    barrel('deck','trim',[x,.517,.461],.029,.517,up,38);
    beam('deck','frame',[x,.809,-.629],[x,.763,.461],.062,.055,.024);
    beam('deck','trim',[x,.526,-.629],[x,.504,.461],.047,.039,.013);
    for(const z of [-.411,-.157,.114,.339]) {
      beam('deck','slate',[x,.524,z],[x,.779,z],.023,.021,.005);
    }
  }
  beam('deck','frame',[-.802,.809,-.629],[.799,.809,-.629],.064,.058,.024);
  beam('deck','trim',[-.802,.526,-.629],[.799,.526,-.629],.047,.039,.013);
  for(const x of [-.51,-.255,.0,.254,.511]) {
    beam('deck','slate',[x,.525,-.629],[x,.797,-.629],.025,.023,.005);
  }
  for(const [x,c] of [[-.738,'tealLift'],[.724,'orangeLift']]) {
    box('deck',c,[x,.194,.759],[.260,.025,.006],.002);
  }

  // Upper-arm knuckles sit inside the lower-arm knuckles on the common knee pin.
  for(const [index,{spread}] of families.entries()) {
    const color=index===0?'teal':'orange',edge=index===0?'tealLift':'orangeLift';
    for(const upper of [false,true]) {
      const group='arm'+index+(upper?'Upper':'Lower');
      const shift=(y)=>upper ? .102*(1-y/armLength) : 0;
      for(const side of [-1,1]) {
        const zAt=(y)=>side*(spread/2-shift(y));
        beam(group,color,[0,.032,zAt(.032)],[0,armLength-.032,zAt(armLength-.032)],.086,.097,.018);
        beam(group,edge,[0,.160,zAt(.160)],[0,.630,zAt(.630)],.096,.061,.012);
        for(const y of [0,armLength]) {
          const z=zAt(y);
          ring(group,color,[0,y,z],.029,.065,.065,.010,front,60);
          ring(group,'pin',[0,y,z+side*.039],.031,.049,.014,.0035,front,48);
        }
        for(const y of [.14,.664]) {
          box(group,'trim',[0,y,zAt(y)],[.102,.065,.112],.010);
        }
      }
      const w=(y)=>spread*.46-shift(y);
      for(const y of [.155,.645]) box(group,color,[0,y,0],[.071,.080,w(y)*2],.013);
      beam(group,edge,[0,.176,-w(.176)],[0,.619,w(.619)],.068,.047,.011);
      beam(group,color,[0,.625,-w(.625)],[0,.182,w(.182)],.063,.047,.010);
      for(const y of [.168,.632]) for(const sign of [-1,1]) {
        bolt(group,[.046,y,sign*w(y)],.015,right);
      }
    }
    barrel('knee'+index,'steel',[0,0,0],.026,spread+.156,front,54);
    for(const z of [-spread*.5-.066,spread*.5+.066]) {
      ring('knee'+index,edge,[0,0,z],.023,.049,.025,.005,front,52);
      bolt('knee'+index,[0,0,z+Math.sign(z)*.012],.024,[0,0,Math.sign(z)]);
    }
  }
  const groups=Array.from(batches,([key,parts])=>[key,parts.length===1?parts[0]:mergeGeometries(parts)]);
  return (engine,shadows)=>{
    const world=engine.createMesh();
    const deck=engine.createMesh().setParent(world);
    const roots=families.map(()=>Array.from({length:3},()=>engine.createMesh().setParent(world)));
    const rotateToX=[0,Math.PI/2,0];
    const meshes=roots.map(([base,upper,knee],i)=>{
      const oriented=(parent)=>engine.createMesh().setParent(parent).setRotation(i===1?rotateToX:[0,0,0]);
      return {arms:[oriented(base),oriented(upper)],knee:oriented(knee)};
    });
    const parents={world:[world],deck:[deck],arm0Lower:[meshes[0].arms[0]],arm0Upper:[meshes[0].arms[1]],
      arm1Lower:[meshes[1].arms[0]],arm1Upper:[meshes[1].arms[1]],
      knee0:[meshes[0].knee],knee1:[meshes[1].knee]};
    const materials=new Map(Object.entries(finishes).map(([name,options])=>[name,new Material(options)]));
    for(const [key,data] of groups) {
      const [group,material]=key.split(':');
      for(const parent of parents[group]) {
        const mesh=createMesh(engine,data,materials.get(material));
        mesh.root.name=key;
        mesh.root.setParent(parent);
        if(material!=='datum') shadows.add(mesh,{static:group==='world',castShadow:material!=='terrain'});
      }
    }
    return (pose)=>{
      deck.setPosition(pose.center);
      for(const [i,[lower,upper,knee]] of roots.entries()) {
        const points=pose.joints[i],a=pose.jointAngle;
        lower.setPosition(points.base).setRotation(i===0?[0,0,a]:[a,0,0]);
        upper.setPosition(points.knee).setRotation(i===0?[0,0,-a]:[-a,0,0]);
        knee.setPosition(points.knee);
      }
    };
  };
}
