import { createMesh, Material } from '@margoengine/materials';
import { batch, box, flight, MeshData, mix, origin, studio, tint, trough, turn, upright, waterBucket, world } from './geometry.js';
import { incline, phaseInTurn, pitch, run, shaftRadius, tau } from './mechanism.js';

function bench(add,mats) {
  add(studio(),mats.sweep,'Blue-grey studio cyclorama','floor');
  add(box(2.204,.044,.601,[.657,-.011,0],.018),mats.base,'Heavy blue-enamel test skid','static');
  add(box(2.169,.014,.575,[.657,.016,0],.006),mats.deck,'Recessed satin mounting field','static');
  add(box(2.128,.0048,.548,[.657,.025,0],.0021),mats.inset,'Dark nitrided top plate','static');
  const caps=[];
  const anchors=[];
  const witness=[];
  for(const x of [-.346,.65,1.676]){
    for(const z of [-.245,.245]){
      caps.push(upright(.024,.0054,[x,.0295,z],18));
      anchors.push(box(.027,.0019,.0030,[x,.0327,z],.00085,x*.11));
      anchors.push(upright(.036,.013,[x,-.037,z],16));
    }
  }
  caps.push(box(.177,.0046,.034,[.208,.029,.238],.0032));
  anchors.push(box(.147,.0014,.0017,[.209,.0321,.239],.00053));
  for(let i=0;i<16;i++){
    const depth=i%5===0?.012:.006;
    witness.push(box(.0018,.0011,depth,[.134+i*.0094,.0325,.240-depth/2],.00045));
  }
  add(batch(caps),mats.copper,'Brass mounting tabs and datum plate');
  add(batch(anchors),mats.dark,'Screw slots and bench isolation feet','static');
  add(batch(witness),mats.dark,'Etched datum plate scale');
}

function pedestals(add,mats) {
  const brackets=[];
  const black=[];
  const fast=[];
  for(const [x,z] of [[.19,.183],[.19,-.183],[.63,.195],[.63,-.195],[1.055,.198],[1.055,-.198]]){
    const shoulder=world([x,-.125,z]);
    const y=shoulder[1];
    const sign=Math.sign(z);
    brackets.push(box(.077,y-.030,.067,[shoulder[0],(y+.030)/2,z],.009));
    brackets.push(box(.116,.024,.117,[shoulder[0],.045,z],.008));
    brackets.push(box(.121,.031,.097,[shoulder[0]-.013,y+.005,z-sign*.017],.009,incline));
    black.push(box(.135,.011,.133,[shoulder[0],.032,z],.003));
    for(const axis of [-1,1]){
      fast.push(upright(.0081,.0058,[shoulder[0]+axis*.046,.061,z],12));
    }
  }
  const receiverBase=[1.495,.520,0];
  for(const z of [-.211,.211]){
    brackets.push(box(.115,.487,.082,[receiverBase[0],.281,z],.012));
    black.push(box(.163,.022,.144,[receiverBase[0],.041,z],.009));
    brackets.push(box(.377,.035,.098,[receiverBase[0],.533,z],.009));
  }
  add(batch(brackets),mats.deck,'Welded inclined frame and upper basin pedestals','static');
  add(batch(black),mats.dark,'Vibration isolators and base washers','static');
  add(batch(fast),mats.steel,'Fasteners on the test frame');
}

function reservoirs(add,mats) {
  const blue=[];
  const metal=[];
  const brackets=[];
  const rims=[];
  const waterLayers=new MeshData();
  const waterColor=tint('#4a9b9e');
  const deep=tint('#326971');
  function tank(x,base,level,width,half){
    const bottom=base+.022,far=level+.064,front=level-.049;
    blue.push(box(width,.036,2*half,[x,base,0],.011));
    blue.push(box(width,far-bottom,.025,[x,(far+bottom)/2,-half],.006));
    blue.push(box(width,front-bottom,.028,[x,(front+bottom)/2,half],.006));
    blue.push(box(.026,far-bottom,2*half,[x+width/2,(far+bottom)/2,0],.006));
    blue.push(box(.026,far-bottom,2*half,[x-width/2,(far+bottom)/2,0],.006));
    metal.push(box(width+.039,.013,.031,[x,far,-half],.004));
    metal.push(box(width+.039,.013,.031,[x,front,half],.004));
    metal.push(box(.028,.014,2*half,[x+width/2,far,0],.004));
    metal.push(box(.028,.014,2*half,[x-width/2,far,0],.004));
    const left=x-width/2+.014,right=x+width/2-.014;
    const z=half-.014;
    for(let i=0;i<26;i++){
      const x0=left+(right-left)*i/26,x1=left+(right-left)*(i+1)/26;
      for(let j=0;j<12;j++){
        const a=-z+2*z*j/12,b=-z+2*z*(j+1)/12;
        const y=(x,z)=>level+.0016*Math.sin(x*49+z*61)+.0012*Math.sin(x*112-z*27);
        waterLayers.quad([x0,y(x0,a),a],[x0,y(x0,b),b],[x1,y(x1,b),b],[x1,y(x1,a),a],
          mix(deep,waterColor,.44+.46*Math.sin(Math.PI*j/12)+.085*Math.sin(i*1.7+j*.32)),[0,1,0]);
      }
    }
    waterLayers.quad([left,front,z],[right,front,z],[right,level,z],[left,level,z],deep,[0,0,1]);
    rims.push(box(width-.029,.0023,.004,[x,level+.001,z],.0008));
    for(const z of [-half,half]){
      for(const edge of [x-width/2,x+width/2]){
        brackets.push(box(.035,.049,.037,[edge,base+.025,z],.008));
      }
    }
  }
  tank(-.071,.051,.151,.516,.238);
  tank(1.495,.568,.647,.405,.223);
  add(batch(blue),mats.deck,'Intake and discharge basins with front sections exposed','static');
  add(batch(metal),mats.steel,'Inlaid satin flanges on the reservoirs','static');
  add(batch(brackets),mats.inset,'Black basin corner castings','static');
  add(waterLayers.data,mats.water,'Calm water on the two reservoir faces');
  add(batch(rims),mats.highlight,'Reservoir section menisci');
  const bubbles=[];
  for(let i=0;i<13;i++){
    const x=1.370+(i*.618033%1)*.208,z=(i*.3429%1-.5)*.23;
    bubbles.push(box(.029+(i%3)*.012,.0015,.004,[x,.650,z],.0006,i*.07));
  }
  add(batch(bubbles),mats.highlight,'Receiving basin surface dashes');
}

function machinery(attach,mats) {
  const frame=[];
  const face=[];
  frame.push(turn([[.064,0],[.088,0],[.090,.011],[.090,.035],[.157,.040],[.162,.050],
    [.162,.079],[.152,.087],[.094,.091],[.092,.126],[.067,.126]], [run-.023,0,0],48));
  frame.push(turn([[.072,0],[.098,0],[.101,.018],[.101,.173],[.094,.191],[.069,.194],[.069,0]],
    [run+.090,0,0],36));
  for(let i=0;i<12;i++){
    const a=i*tau/12,y=.098*Math.cos(a),z=.098*Math.sin(a);
    const cap=attach(box(.145,.011,.013,[0,0,0],.003),mats.dark,'Motor cooling fin');
    cap.root.setPosition([run+.177,y,z]);
    cap.root.setRotation([a,0,0]);
  }
  face.push(turn([[.065,0],[.100,0],[.108,.011],[.108,.029],[.101,.039],[.066,.043]], [run+.277,0,0],44));
  face.push(turn([[.028,0],[.052,0],[.055,.009],[.051,.023],[.026,.028],[0,.028]], [run+.31,0,0],32));
  face.push(turn([[.051,0],[.079,0],[.082,.009],[.081,.026],[.052,.029]], [-.059,0,0],38));
  face.push(turn([[.035,0],[.063,0],[.065,.015],[.064,.037],[.047,.043],[.033,.043]], [-.112,0,0],40));
  attach(batch(frame),mats.deck,'Blue motor and thrust bearing casting');
  attach(batch(face),mats.steel,'Machined motor seal and intake journal');
  const retainer=[];
  const stems=[];
  for(const x of [.017,.285,.604,.925,1.239,1.394]){
    attach(trough(x-.010,x+.011,.181,.204,2.82,5.86),mats.ribs,'Rolled trough stiffener ring');
    for(const a of [2.83,5.85]){
      const y=.194*Math.cos(a),z=.194*Math.sin(a);
      retainer.push(box(.045,.027,.031,[x,y,z],.006));
      stems.push(upright(.0083,.005,[x,y+.017,z],12));
    }
  }
  attach(batch(retainer),mats.inset,'Welded rim gussets');
  attach(batch(stems),mats.copper,'Exposed casing rivets');
  return attach(batch([
    turn([[.064,0],[.105,0],[.108,.009],[.108,.020],[.102,.027],[.064,.027]],
      [run+.019,0,0],40),
    box(.038,.024,.027,[run+.030,.098,0],.006),
  ]),mats.copper,'Drive timing collar with visible rotation fiducial');
}

function buckets(attach,mats) {
  const full=waterBucket();
  const rings=Array.from({length:7},()=>attach(full,mats.water,'Confined water pocket between adjacent turns'));
  let min = Infinity, max = -Infinity;
  for(let i=0;i<full.positions.length;i+=3){
    min=Math.min(min,full.positions[i]);
    max=Math.max(max,full.positions[i]);
  }
  return phase=>{
    const progress=phaseInTurn(phase)/tau;
    for(const [i,mesh] of rings.entries()){
      const position=(i-1+progress)*pitch;
      if(position+max<=0 || position+min>=run){mesh.root.visible=false;continue;}
      const clipped=position+min<0 || position+max>run;
      const geometry=clipped?waterBucket(position,true):full;
      if(!geometry.indices.length){mesh.root.visible=false;continue;}
      mesh.root.visible=true;
      if(mesh.applied!==geometry){mesh.setGeometry(geometry);mesh.applied=geometry;}
      mesh.root.setPosition([position,0,0]);
    }
  };
}

function discharge(add,mats) {
  const dots=Array.from({length:7},(_,i)=>add(box(.018+(i%3)*.009,.013,.016,[0,0,0],.005),
    mats.highlight,'Discharge glint between the weir and receiving pool'));
  return (phase,speed)=>{
    const offset=phaseInTurn(phase)/tau;
    const light=Math.max(0,Math.sin((offset+.56)*Math.PI*2))*(speed>0?1:0);
    for(const [i,mesh] of dots.entries()){
      const f=(offset*2.8+i*.19)%1;
      mesh.root.visible=light>.10 && (i/7)<light+.15;
      mesh.root.setPosition([1.348+.116*f,.746-.094*f*f,(i%3-1)*.032*(.45+f)]);
      mesh.root.setRotation([0,0,-.17-f*1.06]);
    }
  };
}

export function buildScrew(engine,shadows) {
  const mats={
    sweep:new Material({color:'#dde7e6',roughness:.89}),
    base:new Material({color:'#3f515f',roughness:.58}),
    deck:new Material({color:'#4c697b',roughness:.53}),
    inset:new Material({color:'#3d515b',roughness:.64}),
    dark:new Material({color:'#323e46',roughness:.67}),
    steel:new Material({color:'#9baaa8',roughness:.39,metalness:.20}),
    copper:new Material({color:'#b68656',roughness:.35,metalness:.19}),
    rotor:new Material({color:'#f2d19d',roughness:.43,metalness:.13}),
    ribs:new Material({color:'#cfdbd5',roughness:.56}),
    shell:new Material({color:'#becfca',roughness:.54}),
    water:new Material({color:'#c0dfd7',roughness:.21,metalness:.045}),
    highlight:new Material({color:'#81d0cc',roughness:.41,emissive:'#62aab0',emissiveIntensity:.19}),
  };
  const all=[];
  const add=(geometry,mat,name,shadow)=>{
    const mesh=createMesh(engine,geometry,mat);
    mesh.root.name=name;all.push(mesh);
    if(shadow==='static')shadows.add(mesh,{static:true});
    if(shadow==='floor')shadows.add(mesh,{static:true,castShadow:false});
    return mesh;
  };
  bench(add,mats);
  pedestals(add,mats);
  reservoirs(add,mats);
  const shaft=add(turn([[0,-.102],[.029,-.102],[.032,-.083],[.047,-.027],[shaftRadius,0],
    [shaftRadius,run+.044],[.046,run+.086],[.028,run+.124],[0,run+.124]], [0,0,0],48),
    mats.steel,'Inclined central shaft');
  shaft.root.setPosition(origin);
  shaft.root.setRotation([0,0,incline]);
  const attach=(geometry,material,name)=>{
    const object=add(geometry,material,name);
    object.root.setParent(shaft.root);
    return object;
  };
  attach(trough(.012,run-.021,.1753,.188),mats.shell,'Open lower half-casing cutaway');
  const rotor=attach(flight(),mats.rotor,'One continuous solid copper screw flight');
  const collar=machinery(attach,mats);
  const moveWater=buckets(attach,mats);
  const spill=discharge(add,mats);
  return {
    update(phase,speed){
      rotor.root.setRotation([-phase,0,0]);
      collar.root.setRotation([-phase,0,0]);
      moveWater(phase);
      spill(phase,speed);
    },
    anchors:[[-.075,.200,.160],[1.495,.728,.150]],
    dispose(){for(const mesh of all.reverse())mesh.dispose();for(const mat of Object.values(mats))mat.dispose();},
  };
}