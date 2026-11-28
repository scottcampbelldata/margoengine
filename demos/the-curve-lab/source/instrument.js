import {PbrMaterial, box} from '@margoengine/core';
import {GeometryBuilder, placeGeometry} from '@margoengine/geometry/builder';
import {ringSectorGeometry, scaleMarksGeometry, strokeGeometry, turnedGeometry} from '@margoengine/geometry/parts';
import {loftGeometry} from '@margoengine/geometry/sweep';
import {toGeometry} from '@margoengine/geometry/utils';
import {TubePainter} from '@margoengine/lines/tube-painter';
import {add, diff, knots, mult, scale, space, tangents} from './study.mjs';

// The chassis: chamfered octagon rings stacked and skinned with flat caps.
const prism=rings=>toGeometry(loftGeometry(rings,{smooth:false,creaseAngle:30}));

const octagon=(w,y,d,c)=>[
  [-w+c,-d],[w-c,-d],[w,-d+c],[w,d-c],[w-c,d],[-w+c,d],[-w,d-c],[-w,-d+c],
].map(([x,z])=>space([x,y,z]));

// Turned brass and steel parts from [radius, height] profiles.
const lathe=(profile,sides=24)=>toGeometry(turnedGeometry(profile,{segments:sides}));

// One band of the baked contact shadow under the bench: a soft-cornered ring (superellipse, exponent 3).
const contactShape=(inner,outer)=>toGeometry(placeGeometry(ringSectorGeometry(inner,outer,{segments:48,exponent:3.03}),
  {scale:[3.12*scale,1,1.87*scale],position:space([.16,-.1766,.21])}));

// Etched marks: the front ruler, or the bed's minor or major grid.
function engravedGrid(key){
  const builder=new GeometryBuilder();
  const etch=(data,position,yaw=0)=>builder.append(data,{position:space(position),yaw,scale});
  if(key==='ruler'){
    etch(scaleMarksGeometry({count:49,start:-2.4,spacing:.1,major:4,width:.005,majorWidth:.012,length:.032,majorLength:.09}),[0,.245,1.41]);
    etch(scaleMarksGeometry({count:13,start:-2.4,spacing:.4,major:0,width:.024,length:.024,align:'center'}),[0,.2445,1.297]);
  } else {
    const major=key==='major', size=major?.018:.0068, lift=major?.0003:0;
    const lines=(count,start,length)=>scaleMarksGeometry({count,start,spacing:.1,major:4,marks:key,
      width:size,majorWidth:size,length,majorLength:length,align:'center'});
    etch(lines(49,-2.4,2.32),[0,.2244+lift,-.076]);
    etch(lines(23,-1.2,4.8),[0,.2243+lift,0],-Math.PI/2);
    if(major){
      etch(strokeGeometry([[[-2.447,-1.235],[2.447,-1.235]],[[-2.447,1.087],[2.447,1.087]]],.028),[0,.225,0]);
      etch(strokeGeometry([[[-2.435,-1.241],[-2.435,1.095]],[[2.435,-1.241],[2.435,1.095]]],.026),[0,.225,0]);
    }
  }
  return builder.geometry();
}

function splineTube(curve) {
  const pen=new TubePainter({radius:.00535,sides:14,minDistance:1e-7,maxPoints:257,caps:true});
  pen.begin(curve.at(0),.86);
  for(let i=1;i<=240;i++)pen.add(curve.at(i/240),.89+.11*Math.sin(i*Math.PI/240));
  pen.end();
  return pen.toGeometry();
}

function dashedControl() {
  const pen=new TubePainter({radius:.00090,sides:6,minDistance:1e-7});
  for(let i=1;i<knots.length;i++){
    const a=knots[i-1], v=diff(knots[i],a), count=Math.ceil(Math.hypot(...v)/.014);
    for(let j=0;j<count;j++){
      pen.begin(add(a,mult(v,j/count)));
      pen.add(add(a,mult(v,(j+.52)/count)));
      pen.end();
    }
  }
  return pen.toGeometry();
}

function setAxis(mesh, from, into, geometryLength, placeMiddle=true){
  const direction=diff(into,from), length=Math.hypot(...direction);
  if(length<1e-8){mesh.visible=false;return;}
  const [x,y,z]=mult(direction,1/length);
  const q=[z,0,-x,1+y], safe=Math.hypot(...q);
  mesh.visible=true;
  mesh.setPosition(placeMiddle?add(from,mult(direction,.5)):from)
    .setScale([1,length/geometryLength,1]).setQuaternion(safe>1e-7?q.map(value=>value/safe):[1,0,0,0]);
}

export function createInstrument(engine, curves) {
  engine.scene.background='#1b2c35';
  engine.lighting.direction.set([-.41,.78,.47,3.5]);
  engine.lighting.radiance.set([1,.92,.79,.72]);
  engine.lighting.ambient.set([.62,.81,1.0]);
  const material=(color,roughness=.53,metalness=0)=>new PbrMaterial({color,roughness,metalness});
  const bed=material('#263b45',.9), rim=material('#16303c',.31,.27), enamel=material('#386172',.78);
  const brass=material('#bb8250',.40,.56);
  const darkMark=material('#497180',.72), mainMark=material('#658992',.72);
  const pinMetal=material('#eab279',.38,.46), pale=material('#ffe1a4',.32,.23);
  const controlMetal=material('#b59d87',.56,.23), copper=material('#f69669',.41,.22);
  const cyan=material('#75c9df',.39,.15), azure=material('#399fc1',.29,.23), ink=material('#203445',.61);
  const frameColors=[material('#fa9170',.47),material('#6be4bf',.44),material('#b0a0ee',.46)];
  const create=(name,g,paint,at=[0,0,0])=>{
    const item=engine.createMesh().setGeometry(g).setMaterial(paint).setPosition(at);
    item.name=name;
    return item;
  };
  create('Slate bench',box(...space([90,.055,90])),bed,space([0,-.205,0]));
  for(let i=0;i<14;i++) {
    const t=i/14, alpha=.51*Math.pow(1-t,2.15);
    const color='#'+[38,59,69].map(v=>Math.round(v*(1-alpha)).toString(16).padStart(2,'0')).join('');
    create('Baked contact shadow '+i,contactShape(i===0?0:.65+.04*(i-1),.65+.04*i),material(color,.9));
  }
  const feet=lathe([[0,-.016],[.019,-.016],[.021,-.012],[.021,.009],[.017,.015],[0,.015]]);
  for(const [x,z] of [[-2.13,-.88],[2.17,-.88],[-2.13,.98],[2.17,.98]])
    create('Instrument foot',feet,ink,space([x,-.065,z]));
  create('Anodized chassis',prism([
    octagon(2.58,.02,1.47,.13),octagon(2.68,.058,1.535,.19),
    octagon(2.68,.132,1.535,.19),octagon(2.65,.164,1.51,.17),
  ]),rim);
  create('Braze bead',prism([
    octagon(2.651,.137,1.510,.171),octagon(2.672,.148,1.528,.181),octagon(2.671,.165,1.527,.180),
  ]),brass);
  create('Enamel grid bed',prism([
    octagon(2.645,.164,1.501,.167),octagon(2.646,.192,1.501,.171),octagon(2.595,.223,1.449,.153),
  ]),enamel);
  create('Minor etch',engravedGrid('minor'),darkMark);
  create('Major etch',engravedGrid('major'),mainMark);
  create('Brass front ruler',box(...space([5.00,.015,.185])),brass,space([0,.235,1.334]));
  create('Scale ticks',engravedGrid('ruler'),ink);
  const fastener=lathe([[0,0],[.006,0],[.007,.0009],[.007,.002],[.006,.0027],[0,.0027]],16);
  for(const [x,z] of [[-2.49,-1.30],[2.49,-1.30],[-2.49,1.22],[2.49,1.22]]) {
    create('Inset fastener',fastener,pinMetal,space([x,.222,z]));
    create('Fastener slot',box(.006,.00030,.0008),ink,space([x,.245,z])).rotation.y=.21;
  }

  const button=lathe([[0,0],[.0075,0],[.010,.002],[.010,.006],[.0086,.008],[0,.008]],16);
  const post=lathe([[0,-.5],[.0013,-.5],[.0013,.5],[0,.5]],8);
  const supports=lathe([[0,0],[.009,0],[.011,.002],[.010,.0038],[0,.0038]],16);
  const landmarks=knots.map((position,index)=>{
    const [x,y,z]=position, base=[x,.224*scale,z];
    create('Landmark seat',supports,brass,base);
    create('Landmark stem',post,brass,[x,(y+base[1])/2,z]).setScale([1,y-base[1],1]);
    return create('Curve point '+(index+1),button,pinMetal,[x,y-.0036,z]);
  });
  const control=create('Control polygon',dashedControl(),controlMetal);
  const rail=lathe([[0,-.5],[.0018,-.5],[.0018,.5],[0,.5]],12);
  const tangentArms=knots.map((p,i)=>{
    const rod=create('Hermite tangent '+(i+1),rail,copper);
    setAxis(rod,add(p,mult(tangents[i],-.20)),add(p,mult(tangents[i],.32)),1);
    return rod;
  });
  const shapes=curves.map(({spline},i)=>create('Spline '+i,splineTube(spline),pale));
  const sphere=lathe(Array.from({length:13},(_,i)=>{
    const t=Math.PI*i/12;
    return [i===0||i===12?0:.0078*Math.sin(t),-.0078*Math.cos(t)];
  }),20);
  const ring=lathe([[.010,-.002],[.014,-.002],[.016,-.001],[.016,.002],[.014,.003],[.010,.003],[.010,-.002]],32);
  const carriage=create('Probe slide foot',box(...space([.27,.023,.13])),rim);
  const footInset=create('Probe slide clamp',box(...space([.125,.032,.09])),brass);
  const probeCore=create('Cyan probe',sphere,azure);
  const probeRing=create('Cyan probe bezel',ring,cyan);
  const probeStem=create('Probe support',post,controlMetal);
  const nearest=create('Nearest point bead',sphere,cyan);
  const needle=lathe([[0,-.5],[.00145,-.5],[.00145,.5],[0,.5]],10);
  const dashes=Array.from({length:9},()=>create('Nearest distance dash',needle,cyan));
  const arrow=lathe([[0,0],[.0048,0],[0,1]],12);
  const origin=create('Frame station bead',sphere,ink);
  const arrows=frameColors.map((paint,i)=>({
    shaft:create('Frame vector '+i,rail,paint), tip:create('Frame arrowhead '+i,arrow,paint),
  }));

  let active=-1;
  function select(index){
    if(index===active)return;
    active=index;
    for(const [i,shape] of shapes.entries())shape.visible=i===index;
    control.visible=index===1||index===3;
    for(const rod of tangentArms)rod.visible=index===2;
    landmarks.forEach((pin,i)=>{
      const guide=index===1&&i%3!==0||index===3&&i>0&&i<6;
      pin.setMaterial(guide?controlMetal:pinMetal).setScale([guide?.80:1,1,guide?.80:1]);
    });
  }
  return {
    update(index,probe,closest,frame){
      select(index);
      const [x]=probe;
      const base=space([x/scale,.264,1.38]);
      carriage.setPosition(base);
      footInset.setPosition(space([x/scale,.285,1.37]));
      const stemFrom=space([x/scale,.27,1.37]);
      probeStem.setScale([1,1,1]);
      setAxis(probeStem,stemFrom,probe,1);
      probeCore.setPosition(probe);
      probeRing.setPosition(probe);
      nearest.setPosition(closest.point);
      const span=diff(closest.point,probe);
      dashes.forEach((dash,i)=>setAxis(dash,add(probe,mult(span,(i+.25)/9)),add(probe,mult(span,(i+.75)/9)),1));
      origin.setPosition(frame.position);
      const axis=[frame.tangent,frame.normal,frame.binormal];
      for(const [i,{shaft,tip}] of arrows.entries()){
        const shoulder=add(frame.position,mult(axis[i],.079));
        const end=add(frame.position,mult(axis[i],.096));
        setAxis(shaft,frame.position,shoulder,1);
        setAxis(tip,shoulder,end,1,false);
      }
    },
  };
}
