import {Geometry, PbrMaterial, box} from '@margoengine/core';
import {TubePainter} from '@margoengine/lines/tube-painter';
import {add, diff, knots, mult, scale, space, tangents} from './study.mjs';

const tau=2*Math.PI;

function prism(rings) {
  const vertices=[], normals=[], indices=[];
  const unit=([x,y,z])=>{const l=Math.hypot(x,y,z);return [x/l,y/l,z/l];};
  function tri(a,b,c) {
    const u=diff(b,a), v=diff(c,a);
    const n=unit([u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]]);
    const i=vertices.length/3;
    vertices.push(...a,...b,...c);normals.push(...n,...n,...n);indices.push(i,i+1,i+2);
  }
  const n=rings[0].length;
  for(let j=1;j<rings.length;j++)for(let i=0;i<n;i++){
    const k=(i+1)%n, a=rings[j-1], b=rings[j];
    tri(a[i],b[i],a[k]);tri(a[k],b[i],b[k]);
  }
  const low=rings[0], top=rings.at(-1);
  for(let i=1;i<n-1;i++){tri(low[0],low[i],low[i+1]);tri(top[0],top[i+1],top[i]);}
  return new Geometry(vertices,normals,indices);
}

const octagon=(w,y,d,c)=>[
  [-w+c,-d],[w-c,-d],[w,-d+c],[w,d-c],[w-c,d],[-w+c,d],[-w,d-c],[-w,-d+c],
].map(([x,z])=>space([x,y,z]));

function lathe(profile, sides=24){
  const p=[],n=[],ids=[];
  for(let row=1;row<profile.length;row++){
    const [r0,y0]=profile[row-1], [r1,y1]=profile[row];
    const dr=r1-r0, dy=y1-y0, distance=Math.hypot(dr,dy), first=p.length/3;
    for(let i=0;i<sides;i++){
      const a=i*tau/sides, x=Math.cos(a), z=Math.sin(a);
      p.push(x*r0,y0,z*r0,x*r1,y1,z*r1);n.push(x*dy/distance,-dr/distance,z*dy/distance,x*dy/distance,-dr/distance,z*dy/distance);
    }
    for(let i=0;i<sides;i++){
      const j=first+2*i, k=first+2*((i+1)%sides);
      if(r0>0)ids.push(j,j+1,k);
      if(r1>0)ids.push(k,j+1,k+1);
    }
  }
  return new Geometry(p,n,ids);
}

function contactShape(inner,outer) {
  const base=.1766, p=[],n=[],ix=[], sides=48;
  const point=(angle,radius)=>{
    const soften=value=>Math.sign(value)*Math.pow(Math.abs(value),.66);
    return space([.16+3.12*radius*soften(Math.cos(angle)), -base, .21+1.87*radius*soften(Math.sin(angle))]);
  };
  for(let i=0;i<sides;i++){
    const angle=i*tau/sides;
    p.push(...point(angle,inner),...point(angle,outer));
    n.push(0,1,0,0,1,0);
    const a=i*2,b=((i+1)%sides)*2;
    if(inner>0)ix.push(a,b,a+1);
    ix.push(a+1,b,b+1);
  }
  return new Geometry(p,n,ix);
}

function engravedGrid(key){
  const p=[],n=[],indices=[];
  const quad=(x,z,w,d,y)=>{
    const j=p.length/3;
    p.push(...space([x-w,y,z-d]),...space([x-w,y,z+d]),...space([x+w,y,z+d]),...space([x+w,y,z-d]));
    n.push(0,1,0,0,1,0,0,1,0,0,1,0);indices.push(j,j+1,j+2,j,j+2,j+3);
  };
  if(key==='ruler'){
    for(let i=-24;i<=24;i++){
      const major=i%4===0, d=major?.045:.016;
      quad(i*.1,1.41-d,major?.006:.0025,d,.245);
    }
    for(let i=-6;i<=6;i++){
      const x=i*.4;
      quad(x,1.297,.012,.012,.2445);
    }
  } else {
    const major=key==='major';
    const size=major?.009:.0034;
    for(let i=-24;i<=24;i++){
      if((i%4===0)!==major)continue;
      quad(i*.10,-.076,size,1.16,.2244+(major?.0003:0));
    }
    for(let i=-12;i<=10;i++){
      if((i%4===0)!==major)continue;
      quad(0,i*.10,2.40,size,.2243+(major?.0003:0));
    }
    if(major){
      quad(0,-1.235,2.447,.014,.225);
      quad(0,1.087,2.447,.014,.225);
      for(const x of [-2.435,2.435])quad(x,-.073,.013,1.168,.225);
    }
  }
  return new Geometry(p,n,indices);
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
