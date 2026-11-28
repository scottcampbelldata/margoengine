import { applyMatrix4, cylinderGeometry, extrudeGeometry, mergeGeometries, Shape, torusGeometry } from '@margoengine/geometry';
import { roundedBoxGeometry } from '@margoengine/geometry/extras';
import { createMesh, Material } from '@margoengine/materials';
import { centerDistance, crankRadius, rollerRadius } from './mechanism.js';
import { camOutline, wheelOutline } from './profile.js';

const tau=Math.PI*2;
const quarter=Math.PI/2;
const halfSpan=centerDistance/2;
const polar=(r,t)=>[r*Math.cos(t),r*Math.sin(t)];
const rotated=([x,y],a)=>[x*Math.cos(a)-y*Math.sin(a),x*Math.sin(a)+y*Math.cos(a)];
const plus=(a,b)=>a.map((v,i)=>v+b[i]);

const finish={
  backdrop:{color:[.292,.366,.300],roughness:.96,metalness:0},
  felt:{color:[.085,.114,.102],roughness:.91,metalness:0},
  casting:{color:[.061,.177,.155],roughness:.36,metalness:0},
  edge:{color:[.173,.280,.241],roughness:.30,metalness:0},
  plate:{color:[.69,.719,.568],roughness:.57,metalness:0},
  phosphor:{color:[.155,.186,.106],roughness:.52,metalness:0},
  steel:{color:[.60,.639,.61],roughness:.28,metalness:.81},
  nickel:{color:[.28,.359,.344],roughness:.39,metalness:.66},
  black:{color:[.047,.063,.055],roughness:.66,metalness:0},
  rust:{color:[.49,.066,.033],roughness:.32,metalness:0},
  brass:{color:[.73,.389,.117],roughness:.35,metalness:.73},
  oxide:{color:[.31,.174,.063],roughness:.53,metalness:.57},
  cream:{color:[.846,.782,.552],roughness:.61,metalness:0},
};

function plane(points,y,depth,bevel) {
  const shape=new Shape();
  points.forEach(([x,z],i)=>i===0?shape.moveTo(x,z):shape.lineTo(x,z));
  shape.closePath();
  const solid=extrudeGeometry(shape,{depth,bevelEnabled:true,bevelSegments:2,bevelThickness:bevel,bevelSize:bevel,bevelOffset:-bevel});
  return applyMatrix4(solid,[1,0,0,0,0,0,-1,0,0,1,0,0,0,y,0,1]);
}

function translate(geometry,x,y,z) {
  return applyMatrix4(geometry,[1,0,0,0,0,1,0,0,0,0,1,0,x,y,z,1]);
}

export function prepareDrive() {
  const family=new Map();
  function add(owner,material,geometry) {
    const key=owner+':'+material;
    if(!family.has(key)) family.set(key,[]);
    family.get(key).push(geometry);
  }

  function rounded(owner,material,x,y,z,w,h,d,bevel) {
    add(owner,material,translate(roundedBoxGeometry(w,h,d,2,bevel),x,y,z));
  }

  function collar(owner,material,x,y,z,rad,height,segments=40,bottom=rad) {
    add(owner,material,translate(cylinderGeometry(rad,bottom,height,segments),x,y,z));
  }

  function outline(owner,material,points,y,depth,bevel) {
    add(owner,material,plane(points,y,depth,bevel));
  }

  function line(owner,material,from,to,y,width,height=.0015) {
    const [x,z]=from,[ex,ez]=to,length=Math.hypot(ex-x,ez-z);
    const cos=(ex-x)/length,sin=(ez-z)/length;
    add(owner,material,applyMatrix4(roundedBoxGeometry(length,height,width,1,Math.min(height,width)*.24),
      [cos,0,-sin,0,0,1,0,0,sin,0,cos,0,(x+ex)/2,y,-(z+ez)/2,1]));
  }

  function ring(owner,material,x,y,z,r,micro) {
    add(owner,material,applyMatrix4(torusGeometry(r,micro,7,70),[1,0,0,0,0,0,-1,0,0,1,0,0,x,y,z,1]));
  }

  function screw(owner,x,y,z,r,turn) {
    collar(owner,'black',x,y,z,r*1.24,.0022,20);
    collar(owner,'steel',x,y+.0017,z,r,.0034,18,r*1.04);
    const p=polar(r*.70,turn);
    line(owner,'black',[x-p[0],-z-p[1]],[x+p[0],-z+p[1]],y+.00365,r*.33,.0011);
  }

  rounded('fixed','backdrop',0,-.074,0,25,.04,25,.006);
  for(const x of [-.350,.350]) for(const z of [-.235,.229])
    collar('fixed','felt',x,-.042,z,.032,.027,24,.036);
  rounded('fixed','felt',0,-.025,0,.823,.025,.539,.016);
  rounded('fixed','edge',0,-.016,0,.856,.025,.565,.010);
  rounded('fixed','casting',0,.012,0,.856,.050,.565,.019);
  rounded('fixed','edge',0,.038,0,.829,.012,.544,.0042);
  rounded('fixed','plate',0,.045,0,.805,.012,.522,.0052);
  for(const x of [-.378,.378]) for(const z of [-.236,.236])
    screw('fixed',x,.052,z,.0094,x+z);
  for(const side of [-1,1]) {
    const x=side*halfSpan;
    collar('fixed','nickel',x,.057,0,.058,.016,56,.066);
    ring('fixed','steel',x,.066,0,.049,.0022);
    collar('fixed','black',x,.072,0,.034,.016,36);
    collar('fixed','steel',x,.079,0,.021,.023,28);
  }

  const stationGlyphs={
    I:[[0,0,1,0],[.5,0,.5,1],[0,1,1,1]],
    N:[[0,1,0,0],[0,0,1,1],[1,1,1,0]],
    P:[[0,1,0,0],[0,0,1,0],[1,0,1,.52],[1,.52,0,.52]],
    U:[[0,0,0,1],[0,1,1,1],[1,1,1,0]],
    T:[[0,0,1,0],[.5,0,.5,1]],
    O:[[0,0,1,0],[1,0,1,1],[1,1,0,1],[0,1,0,0]],
  };
  for(const [label,center] of [['INPUT',-halfSpan],['OUTPUT',halfSpan]]) {
    [...label].forEach((letter,i)=>{
      const offset=center+(i-(label.length-1)*.5)*.010;
      for(const [x1,y1,x2,y2] of stationGlyphs[letter]) {
        const from=[offset+(x1-.5)*.0057,.020-y1*.0095];
        const to=[offset+(x2-.5)*.0057,.020-y2*.0095];
        const width=.0010;
        const length=Math.hypot(to[0]-from[0],to[1]-from[1])+width;
        const angle=Math.atan2(to[1]-from[1],to[0]-from[0]);
        const c=Math.cos(angle),s=Math.sin(angle);
        add('fixed','cream',applyMatrix4(roundedBoxGeometry(length,width,.0009,1,.00022),
          [c,s,0,0,-s,c,0,0,0,0,1,0,(from[0]+to[0])/2,(from[1]+to[1])/2,.283,1]));
      }
    });
  }
  // Inlaid datum rays are machined into the pale stationary bed.
  for(const side of [-1,1]) {
    for(let i=0;i<80;i++) {
      const angle=i*tau/80;
      const distance=.247;
      const edge=polar(distance,angle),inner=polar(distance-(i%5===0?.009:.0045),angle);
      const center=[halfSpan*side,0];
      line('fixed',i%5===0?'phosphor':'nickel',plus(center,edge),plus(center,inner),.0525,i%5===0?.0017:.0009,.001);
    }
  }
  for(const side of [-1,1]) {
    const y=-.220;
    line('fixed','phosphor',[-.05,y*side],[.05,y*side],.053,.0018,.001);
    for(let index=-2;index<=2;index++) {
      const x=index*.014;
      line('fixed','phosphor',[x,(.224)*side],[x,(.230+(index===0?.004:0))*side],.053,.0015,.001);
    }
  }

  // The thin crank arm and counterweight pass under the bronze plate.
  outline('driver','casting',[[-.205,-.026],[-.172,-.061],[-.102,-.067],[-.041,-.041],[crankRadius+.015,-.018],
    [crankRadius+.017,.016],[crankRadius,.023],[-.047,.036],[-.113,.065],[-.171,.060],[-.202,.037]],.078,.011,.0028);
  rounded('driver','nickel',-.155,.092,0,.105,.015,.095,.012);
  for(const z of [-.024,.024]) screw('driver',-.167,.102,z,.007,z);
  outline('driver','casting',camOutline(),.092,.029,.0018);
  const shoulder=camOutline().map((p)=>p.map((c)=>c*.984));
  outline('driver','edge',shoulder,.121,.0035,.0012);
  ring('driver','phosphor',0,.126,0,.074,.0011);
  ring('driver','edge',0,.125,0,.049,.0014);
  collar('driver','nickel',0,.132,0,.041,.016,48,.046);
  collar('driver','steel',0,.145,0,.028,.017,44,.033);
  screw('driver',0,.155,0,.014,Math.PI/4);
  const pinX=crankRadius;
  collar('driver','steel',pinX,.100,0,rollerRadius,.034,36);
  collar('driver','rust',pinX,.122,0,rollerRadius*.99,.015,40);
  collar('driver','steel',pinX,.130,0,.007,.0038,24);
  collar('driver','black',pinX,.1325,0,.0036,.0027,12);
  for(let i=0;i<20;i++) {
    const t=tau*i/32+1.15;
    const small=i%4===0;
    line('driver','cream',polar(small?.130:.137,t),polar(.143,t),.126,small?.0016:.001,.0014);
  }
  line('driver','cream',[-.112,0],[-.148,0],.126,.0032,.0014);

  outline('wheel','brass',wheelOutline(),.092,.031,.0018);
  collar('wheel','oxide',0,.128,0,.065,.0098,52,.071);
  ring('wheel','cream',0,.134,0,.056,.0016);
  collar('wheel','steel',0,.139,0,.037,.020,44,.04);
  screw('wheel',0,.151,0,.014,.3);
  for(let i=0;i<4;i++) {
    const a=i*quarter;
    const p=polar(.095,a);
    screw('wheel',p[0],.125,-p[1],.0073,a+.3);
    // Distinct tally groups expose the quarter-turn even on a symmetric plate.
    for(let j=0;j<=i;j++) {
      const local=(j-i*.5)*.007;
      const start=rotated([.116,local],a),end=rotated([.134,local],a);
      line('wheel','oxide',start,end,.126,.0021,.0014);
    }
  }
  const groups=Array.from(family,([key,geometry])=>({key,data:geometry.length===1?geometry[0]:mergeGeometries(geometry)}));
  return (engine,shadows)=>{
    const world=engine.createMesh();
    const driver=engine.createMesh().setPosition([-halfSpan,0,0]).setParent(world);
    const wheel=engine.createMesh().setPosition([halfSpan,0,0]).setParent(world);
    const parents={fixed:world,driver,wheel};
    const materials=new Map();
    for(const {key,data} of groups) {
      const [owner,name]=key.split(':');
      if(!materials.has(name)) materials.set(name,new Material(finish[name]));
      const mesh=createMesh(engine,data,materials.get(name));
      mesh.root.name=owner+' '+name;
      mesh.root.setParent(parents[owner]);
      shadows.add(mesh,{static:owner==='fixed',castShadow:name!=='backdrop'});
    }
    return ({driver:driveAngle,turnWheel:wheelAngle})=>{
      driver.setRotation([0,driveAngle,0]);
      wheel.setRotation([0,wheelAngle,0]);
    };
  };
}
