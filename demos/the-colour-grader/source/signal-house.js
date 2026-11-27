import { Geometry, PbrMaterial, box } from '@margoengine/core';
import { Lightformer } from '@margoengine/environment/lightformer';
import { Sky } from '@margoengine/sky/base';
import { preetham } from '@margoengine/sky/preetham';
import { look } from '@margoengine/sky/look';

const unit=box(1,1,1);
const surface=(color,roughness=.70,metalness=0)=>new PbrMaterial({color,roughness,metalness,doubleSided:false});
const cast=surface('#34434a',.54,1),dark=surface('#3f4350',.63),wall=surface('#485259',.79);
const rail=surface('#5a696b',.47,1),ceiling=surface('#3d4b58',.77),red=surface('#ab5147',.56);
const copper=surface('#ab7e57',.30,1),brass=surface('#c0a377',.31,1),edge=surface('#b2a682',.47,1);
const metal=surface('#827b72',.56,1),paving=surface('#626873',.78),mortar=surface('#545865',.89);
const timber=surface('#69564e',.78),varnish=surface('#896c59',.58);
const lensGlass=surface('#aa5c34',.18),lampBlack=surface('#474957',.68);
const distant=[surface('#525f76',.92),surface('#48576e',.92),surface('#3a4d65',.95)];
const water=surface('#6b798e',.58);
const prismEmitter=[
  ['#ffb075',3.15],['#ff732e',2.8],['#e95819',2.15],
];
const bulb=['#ffe7c3',6.4],greenPilot=['#4bf0bd',1.65],redPilot=['#f65230',2.5];
const tau=Math.PI*2;

function ring(profile,segments=84){
  const positions=[],normals=[],indices=[];
  for(let j=0;j<profile.length;j++){
    const [radius,z]=profile[j],a=profile[Math.max(0,j-1)],b=profile[Math.min(profile.length-1,j+1)];
    const dr=b[0]-a[0],dz=b[1]-a[1],l=Math.hypot(dr,dz);
    for(let i=0;i<=segments;i++){
      const angle=tau*i/segments,c=Math.cos(angle),s=Math.sin(angle);
      positions.push(radius*c,radius*s,z);
      normals.push(-dz/l*c,-dz/l*s,dr/l);
      if(i>0&&j>0){
        const d=j*(segments+1)+i,c=d-1,b=d-segments-1,a=b-1;
        indices.push(a,c,d,a,d,b);
      }
    }
  }
  return {positions,normals,indices};
}
function hills(front,seed,width,height){
  const positions=[],normals=[],indices=[];
  for(let i=0;i<=72;i++){
    const x=width*(i/72-.5);
    const v=Math.sin(i*.073+seed)*.28+Math.sin(i*.193-seed)*.14+Math.sin(i*.427+seed*.32)*.10;
    const small=.07*Math.cos(i*.738)*Math.sin(i*.816+seed);
    const skyline=front+height*(.42+v+small);
    positions.push(x,-9,0,x,skyline,0);
    normals.push(0,0,1,0,0,1);
    if(i>0){const a=i*2-2;indices.push(a,a+2,a+3,a,a+3,a+1);}
  }
  return new Geometry(positions,normals,indices);
}

export function signalHouse(engine){
  const sun=[-.51,.65,.56];
  engine.lighting.direction.set([...sun,1.8]);
  engine.lighting.radiance.set([.99,.79,.60,.22]);
  engine.lighting.ambient.set([.68,.84,1]);
  engine.scene.background='#5a7093';
  Sky.attach(engine,{timeScale:0,sunDirection:[-.81,-.024,-.58],exposure:-.36,turbidity:3.1,
    look:{gradientStrength:.94,gradientIntensity:1.26,gradient:[
      {elevation:-90,color:[.05,.09,.15]},{elevation:0,color:[.56,.36,.35]},
      {elevation:4,color:[.31,.30,.43]},{elevation:12,color:[.11,.24,.48]},
      {elevation:30,color:[.039,.10,.278]},{elevation:90,color:[.016,.032,.106]},
    ],glowWidth:11,glowColor:[1,.58,.31],glowStrength:.11,glowSunward:.4}}, {preetham,look});

  function part(name,geometry,material,position=[0,0,0],scale=[1,1,1],rotation=[0,0,0]){
    const mesh=engine.createMesh();
    mesh.name=name;
    return mesh.setGeometry(geometry).setMaterial(material).setPosition(position).setScale(scale).setRotation(rotation);
  }
  const block=(name,m,x,y,z,w,h,d,rotation)=>part(name,unit,m,[x,y,z],[w,h,d],rotation);
  const metalRing=(name,m,profile,center,segments)=>{const g=ring(profile,segments);return part(name,new Geometry(g.positions,g.normals,g.indices),m,center);};
  function radiant(name,[color,intensity],radius,at){
    const light=Lightformer.attach(engine,{name,form:'circle',color,intensity});
    light.node.setPosition(at).setScale([radius*2,radius*2,1]);
  }

  for(let i=0;i<3;i++)part('Offshore headland '+i,hills(.52+i*.78,4.4-i*1.8,56+i*16,1.3+i*.24),distant[i],[3,-2.26,-29-i*18]);
  block('Blue hour water plane',water,3,-2.35,-31,72,.1,60);
  block('Upper casement lintel',ceiling,.4,3.48,-2.6,8.2,.31,.4);
  block('Lower casement dado',wall,.4,.42,-2.62,8.2,.92,.36);
  block('West wall',dark,-2.81,1.78,-.5,.41,3.56,6.6);
  block('Old lacquer lower wall panel',wall,-2.59,.865,-.5,.042,1.73,6.22);
  block('Upper railing and panel bead',rail,-2.54,1.754,-.5,.035,.050,6.28);
  for(let i=0;i<7;i++){
    block('Vertical joinery on the west wall',metal,-2.555,.861,-2.82+i*.69,.009,1.69,.018);
  }
  block('Back solid wall',dark,-2.49,2.03,-2.7,1.3,3.05,.38);
  block('East pier',wall,3.40,1.99,-2.82,.31,3.1,.38);
  block('Signal room roof',ceiling,.4,3.72,-.29,7.4,.27,5.9);
  block('Stone sill',metal,.94,.89,-2.49,5.1,.088,.40);
  for(let i=0;i<6;i++){
    const x=-1.74+i*.95;
    block('Riveted vertical window mullion',cast,x,2.16,-2.47,.056,2.49,.074);
    block('Bronze window bead',copper,x+.020,2.16,-2.425,.012,2.49,.019);
  }
  block('Mid-height window rail',cast,.7,2.07,-2.48,5.1,.075,.097);
  block('Pale limestone floor',paving,.4,-.075,.1,8,.15,9.6);
  for(let i=-4;i<=4;i++)block('Floor stone seam',mortar,i*.81,.002,.29,.011,.004,8.2);
  for(let i=-4;i<=4;i++)block('Transverse floor seam',mortar,.35,.002,i*.70,7.4,.003,.010);

  block('Gauges and service cabinet',wall,-1.64,.66,-.83,1.15,1.31,.61);
  block('Cabinet enamel door',red,-1.64,.61,-.515,1.064,1.09,.027);
  block('Walnut work top',varnish,-1.64,1.344,-.79,1.20,.092,.718);
  block('Cabinet dark front frame',timber,-1.64,1.262,-.49,1.01,.081,.056);
  for(let i=0;i<3;i++){
    block('Pull handle',brass,-1.64,.31+i*.30,-.486,.21,.041,.047);
    block('Door groove',dark,-1.64,.44+i*.300,-.497,1.04,.012,.010);
  }
  block('Leaning enamel permit book',lampBlack,-1.79,1.416,-.56,.31,.048,.22,[0,.26,.02]);
  block('Leather binding',red,-1.69,1.443,-.61,.285,.034,.192,[0,-.30,-.03]);
  block('Book page block',edge,-1.689,1.445,-.589,.264,.022,.164,[0,-.30,-.03]);
  block('Work top service toolbox',dark,-2.07,1.522,-.79,.312,.275,.345);
  block('Steel toolkit latch',brass,-2.07,1.522,-.610,.047,.092,.031);
  block('Raised detail of service panel',rail,2.01,1.275,-2.28,.39,.69,.27);
  block('Meter label card',edge,2.01,1.224,-2.133,.28,.138,.030);
  radiant('Green pilot lamp',greenPilot,.038,[1.968,1.47,-2.102]);
  radiant('Red pilot lamp',redPilot,.038,[2.077,1.47,-2.102]);

  const center=[.43,1.89,.44],radius=.81;
  const z=center[2];
  block('Bolted cast lens mounting foot',cast,.43,.146,.22,1.20,.24,.92);
  block('Broad bearing case',dark,.43,.335,.23,.83,.21,.66);
  block('Engraved copper bearing trim',copper,.43,.381,.58,.74,.089,.034);
  block('Canted left cradle arm',cast,.018,.836,.26,.135,.86,.245,[0,0,-.215]);
  block('Canted right cradle arm',cast,.853,.836,.26,.135,.86,.245,[0,0,.215]);
  block('Connecting cradle cross member',rail,.43,1.003,.28,1.02,.126,.32);
  block('Upright backing structure',dark,.43,1.88,.10,1.24,1.24,.21,[0,0,.10]);
  metalRing('Cast lantern rim',cast,[[.748,-.039],[.778,.016],[.815,.052],[.849,.042],[.868,.014],[.863,-.098],[.828,-.155],[.781,-.169]],center);
  metalRing('Outer brass rolled edge',brass,[[.784,.047],[.808,.059],[.829,.060],[.847,.041]],center);
  metalRing('Inside red gasket',red,[[.722,.033],[.749,.041],[.778,.046]],center);
  metalRing('Scrolled copper recess',copper,[[.675,-.006],[.697,.016],[.719,.042],[.734,.052]],center);
  metalRing('Tinted lens substrate',lensGlass,[[.005,-.031],[radius*.844,-.028],[radius*.875,-.042]],center);
  radiant('Outer amber lens light',prismEmitter[2],.643,[center[0],center[1],z+.007]);
  radiant('Middle orange lens light',prismEmitter[1],.467,[center[0],center[1],z+.016]);
  radiant('Inner honey lens light',prismEmitter[0],.286,[center[0],center[1],z+.024]);
  const flutes={positions:[],normals:[],indices:[]};
  for(let i=0;i<9;i++){
    const r=.143+i*.060,depth=.093-.041*(i/9);
    const flute=ring([[r-.005,depth-.007],[r+.001,depth+.012],[r+.008,depth-.008]],84);
    const offset=flutes.positions.length/3;
    flutes.positions.push(...flute.positions);
    flutes.normals.push(...flute.normals);
    flutes.indices.push(...flute.indices.map(value=>value+offset));
  }
  part('Nine concentric profiled prism dividers',
    new Geometry(flutes.positions,flutes.normals,flutes.indices),copper,center);
  radiant('Hot core filament diffuser',bulb,.107,[center[0],center[1],z+.161]);
  metalRing('Central daylight collar',brass,[[.103,.148],[.112,.154],[.128,.132],[.137,.113]],center,76);
  const button=ring([[.001,0],[.020,0],[.025,-.008]],25);
  const bolt=new Geometry(button.positions,button.normals,button.indices);
  for(let i=0;i<16;i++){
    const a=tau*(i+.5)/16,x=center[0]+.809*Math.cos(a),y=center[1]+.809*Math.sin(a);
    part('Fastened countersunk bolt',bolt,i%4===0?edge:brass,[x,y,z+.064]);
    block('Bolt cut',cast,x,y,z+.064,.020,.004,.001,[0,0,.37+i*.11]);
  }
  block('Left datum scale',brass,-.230,1.139,z-.024,.26,.042,.055);
  block('Right datum scale',brass,1.111,1.139,z-.024,.26,.042,.055);

}
