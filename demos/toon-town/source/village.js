
import {Geometry,PbrMaterial,box} from '@margoengine/core';

const paint=color=>new PbrMaterial({color,roughness:.86,metalness:0});
const palette={cream:paint('#e9c995'),cherry:paint('#bc635c'),rust:paint('#bb674a'),pine:paint('#718951'),
  chartreuse:paint('#b5ae5f'),jade:paint('#82a380'),sand:paint('#d1b179'),row:paint('#af8874'),
  canal:paint('#4a9dab'),foam:paint('#a7d5c2'),glass:paint('#43657b'),glint:paint('#a6c6bd'),
  midnight:paint('#536273'),faded:paint('#9796a5'),chimney:paint('#79576a'),cobalt:paint('#6486a7'),
  brick:paint('#c18470'),paper:paint('#e4d6b1'),cloud:paint('#dbd5b9'),saffron:paint('#e3a560')};
const tau=2*Math.PI;
function extrude(outline,depth){
  const pos=[],normal=[],ix=[];
  function quad(a,b,c,d,n){
    const f=pos.length/3;pos.push(...a,...b,...c,...d);
    for(let i=0;i<4;i++)normal.push(...n);
    ix.push(f,f+1,f+2,f,f+2,f+3);
  }
  for(let i=0;i<outline.length;i++){
    const [ax,ay]=outline[i],[bx,by]=outline[(i+1)%outline.length];
    const dx=bx-ax,dy=by-ay,len=Math.hypot(dx,dy);
    quad([ax,ay,depth/2],[ax,ay,-depth/2],[bx,by,-depth/2],[bx,by,depth/2],[dy/len,-dx/len,0]);
  }
  for(const face of [-1,1]){
    const base=pos.length/3;
    for(const [x,y] of outline){pos.push(x,y,face*depth/2);normal.push(0,0,face);}
    for(let i=1;i+1<outline.length;i++){
      if(face>0)ix.push(base,base+i,base+i+1);
      else ix.push(base,base+i+1,base+i);
    }
  }
  return new Geometry(pos,normal,ix);
}
function vessel(profile,segments=24){
  const p=[],n=[],indices=[];
  for(let i=0;i<profile.length;i++){
    const [r,y]=profile[i],lo=profile[Math.max(0,i-1)],hi=profile[Math.min(profile.length-1,i+1)];
    const a=hi[1]-lo[1],b=lo[0]-hi[0],d=Math.hypot(a,b)||1;
    for(let j=0;j<=segments;j++){
      const phase=tau*j/segments,c=Math.cos(phase),s=Math.sin(phase),k=i*(segments+1)+j;
      p.push(r*c,y,r*s);n.push(a*c/d,b/d,a*s/d);
      if(i&&j){const prev=k-segments-1;indices.push(prev-1,k-1,k,prev-1,k,prev);}
    }
  }
  return new Geometry(p,n,indices);
}
function craft(){
  const groups=new Map();
  const register=(root,material,geometry,point,heading=0)=>{
    if(!groups.has(root))groups.set(root,new Map());
    const mats=groups.get(root);
    if(!mats.has(material))mats.set(material,{p:[],n:[],ix:[]});
    const target=mats.get(material),first=target.p.length/3,src=geometry.vertices;
    const c=Math.cos(heading),s=Math.sin(heading);
    for(let i=0;i<src.length;i+=6){
      target.p.push(c*src[i]+s*src[i+2]+point[0],src[i+1]+point[1],c*src[i+2]-s*src[i]+point[2]);
      target.n.push(c*src[i+3]+s*src[i+5],src[i+4],c*src[i+5]-s*src[i+3]);
    }
    for(const ix of geometry.indices)target.ix.push(first+ix);
  };
  return {put:register,block(root,material,size,at,heading){register(root,material,box(...size),at,heading);},
    install(engine){
      const added=[];
      for(const [root,group] of groups)for(const [material,b] of group){
        const mesh=engine.createMesh().setGeometry(new Geometry(b.p,b.n,b.ix)).setMaterial(material);
        if(root)mesh.setParent(root);
        added.push(mesh);
      }
      return added;
    }};
}
function facade(builder,x,z,w,h,d,wall,roof){
  const {block,put}=builder,front=z+d/2;
  block(null,wall,[w,h,d],[x,h*.5,z]);
  const cornice=h-.15;
  block(null,palette.paper,[w+.08,.091,.072],[x,cornice,front+.027]);
  for(const side of [-1,1])block(null,palette.paper,[.106,h-.30,.07],[x+side*(w/2-.052),(h-.3)*.5,front+.026]);
  const tone=roof===palette.rust?palette.brick:palette.cobalt;
  put(null,roof,extrude([[-w*.555,0],[w*.555,0],[w*.43,.49],[w*.29,.76],[-w*.29,.76],[-w*.43,.49]],d+.30),[x,h,z]);
  block(null,tone,[w*.70,.043,d+.35],[x,h+.771,z]);
  block(null,tone,[w+.145,.088,.105],[x,h+.092,front+.14]);
  const dx=x+w*.128;
  block(null,palette.chimney,[.238,.77,.215],[dx,h+.57,z-.36]);
  block(null,palette.row,[.303,.10,.265],[dx,h+.981,z-.36]);
  for(let floor=0;floor<2;floor++)for(const shift of [-.245,.24]){
    const fx=x+w*shift,y=.82+floor*(h-.72)*.47;
    block(null,palette.paper,[.43,.53,.068],[fx,y,front+.033]);
    block(null,palette.glass,[.344,.439,.074],[fx,y+.016,front+.058]);
    block(null,palette.glint,[.024,.449,.078],[fx,y+.015,front+.061]);
    block(null,palette.glint,[.35,.025,.078],[fx,y+.020,front+.061]);
    for(const side of [-1,1])block(null,tone,[.106,.441,.059],[fx+side*.268,y+.011,front+.073],side*.105);
    block(null,palette.paper,[.485,.044,.164],[fx,y-.258,front+.068]);
    if(!floor){
      block(null,palette.brick,[.35,.108,.13],[fx,y-.297,front+.129]);
      for(let j=0;j<3;j++)block(null,palette.jade,[.095,.109,.091],[fx+(j-1)*.107,y-.208,front+.146]);
    }
  }
  block(null,palette.chimney,[.399,.635,.069],[x,.314,front+.052]);
  block(null,palette.midnight,[.325,.587,.073],[x,.297,front+.070]);
  block(null,palette.saffron,[.054,.047,.057],[x+.114,.301,front+.111]);
}

const bridgeHeight=z=>.34+.69*(1-(z/1.72)**2);
function bridge(b){
  const p=[],n=[],ix=[];
  const hand=.96,steps=20;
  for(let i=0;i<=steps;i++){
    const z=-1.79+3.58*i/steps,y=bridgeHeight(z),g=Math.hypot(1,1.38*z/(1.72**2));
    for(const x of [-hand,hand]){p.push(x,y,z);n.push(0,1/g,1.38*z/(1.72**2)/g);}
    if(i){const d=i*2+1,c=d-1,b=d-2,a=d-3;ix.push(a,c,b,b,c,d);}
  }
  b.put(null,palette.sand,new Geometry(p,n,ix),[2.6,0,.0]);
  for(let i=0;i<13;i++){
    const z=-1.68+i*.28,y=bridgeHeight(z);
    b.block(null,i%2?palette.brick:palette.row,[2.01,.106,.25],[2.6,y-.059,z]);
    for(const side of [-1,1]){
      b.block(null,palette.chimney,[.158,.429,.163],[2.6+side*.918,y+.245,z]);
      b.block(null,palette.brick,[.209,.071,.234],[2.6+side*.918,y+.495,z]);
    }
  }
}
function windmill(engine,b){
  const bottom=[-3.98,0,-4.48],wheel=engine.createMesh().setPosition([-3.98,3.64,-3.35]);
  const shape=vessel([[0,0],[.81,0],[.81,.26],[.72,.28],[.535,2.66],[.566,2.78]]);
  b.put(null,palette.cream,shape,bottom);
  b.put(null,palette.cherry,vessel([[.60,2.76],[.60,2.94],[.47,3.52],[.32,3.84],[.096,3.95],[0,3.95]]),bottom);
  b.block(null,palette.glass,[.29,.64,.06],[-3.98,.72,-3.767]);
  b.block(null,palette.paper,[.39,.085,.11],[-3.98,1.08,-3.72]);
  b.block(null,palette.row,[.245,.33,.051],[-3.73,2.2,-3.915]);
  for(let side=0;side<4;side++){
    const heading=tau*side/4;
    const blade=engine.createMesh().setRotation([0,0,heading]).setParent(wheel);
    b.block(blade,palette.chimney,[.082,1.75,.108],[0,.865,0]);
    b.block(blade,palette.cream,[.312,1.00,.056],[.124,1.34,.015]);
    for(let j=0;j<7;j++)b.block(blade,palette.sand,[.345,.024,.067],[.123,.880+j*.156,.027]);
    b.block(blade,palette.rust,[.045,1.04,.060],[.284,1.34,.033]);
  }
  b.block(wheel,palette.midnight,[.22,.22,.22],[0,0,.04]);
  return wheel;
}
function shoreline(engine,b){
  const boat=engine.createMesh();
  const hull=extrude([[-.89,.06],[-.69,-.16],[.60,-.16],[.79,-.004],[.89,.092],[-.89,.092]],.60);
  b.put(boat,palette.rust,hull,[0,.26,0]);
  b.block(boat,palette.paper,[1.58,.062,.553],[0,.366,0]);
  b.block(boat,palette.jade,[.68,.33,.43],[.20,.538,0]);
  b.block(boat,palette.glass,[.248,.14,.049],[.29,.59,.231]);
  b.block(boat,palette.paper,[.73,.047,.49],[.20,.721,0]);
  b.block(boat,palette.chimney,[.05,.82,.054],[-.39,.606,0]);
  b.put(boat,palette.saffron,extrude([[0,0],[.35,.132],[0,.242]],.032),[-.391,.930,0]);
  for(const x of [-1.07,-1.41,-1.68])b.block(boat,palette.foam,[.22,.008,.053],[x,.062,.25*Math.sin(3*x)]);
  return boat;
}
function distantBanks(b){
  const positions=[],normals=[],indices=[];
  const height=x=>.70+.54*Math.cos(x*.22)+.31*Math.sin(x*.48+.7);
  for(let k=0;k<=42;k++){
    const x=-23+k*1.095;
    for(const point of [[x,-.06,-7.7],[x,height(x),-11.3],[x,height(x)+.09,-17.5]]){
      positions.push(...point);normals.push(0,.97,.243);
    }
    if(k)for(let j=0;j<2;j++){
      const a=(k-1)*3+j,c=k*3+j;indices.push(a,c,a+1,a+1,c,c+1);
    }
  }
  b.put(null,palette.faded,new Geometry(positions,normals,indices),[0,0,0]);
  const cone=vessel([[0,0],[.12,0],[.37,.33],[.30,.56],[.25,.61],[.16,.84],[.088,.94],[0,1.16]],14);
  for(let i=0;i<27;i++){
    const x=-13.9+i*1.04,z=-8.0-.48*Math.sin(i*1.6);
    b.put(null,i%3===1?palette.jade:palette.pine,cone,[x,.24,z],i*.42);
  }
  const puffs=vessel([[0,0],[.34,0],[.56,.1],[.60,.22],[.48,.32],[.25,.38],[0,.39]],18);
  for(const [x,y,z] of [[-10.3,4.7,-11.0],[-5.92,5.1,-16.0],[2.7,4.65,-13.0],[10.2,5.38,-16.0]]){
    b.put(null,palette.cloud,puffs,[x,y,z]);
    b.put(null,palette.cloud,puffs,[x+.57,y+.084,z-.04]);
    b.put(null,palette.cloud,puffs,[x+1.08,y+.002,z+.13]);
  }
}
function frontBank(b){
  for(let i=0;i<29;i++){
    const x=-8+i*.61,z=2.64+.060*Math.sin(i*.61);
    const material=i%4===0?palette.paper:i%3===0?palette.row:palette.sand;
    b.block(null,material,[.59,.038,.52],[x,.014,z],.018*Math.cos(i*1.72));
    b.block(null,material,[.58,.037,.39],[x+.29,.013,z+.455],-.025*Math.cos(i*1.4));
  }
  for(const x of [-3.0,-.43,4.42]){
    for(const side of [-1,1]){
      b.block(null,palette.glass,[.112,.36,.11],[x+side*.27,.183,2.36]);
      b.block(null,palette.row,[.105,.37,.14],[x+side*.275,.34,2.18]);
    }
    b.block(null,palette.cobalt,[.65,.073,.32],[x,.32,2.37]);
    for(let i=0;i<2;i++)b.block(null,palette.cobalt,[.68,.099,.035],[x,.40+i*.108,2.119]);
  }
}
export function buildVillage(engine){
  const b=craft();
  distantBanks(b);frontBank(b);
  b.block(null,palette.jade,[26,.41,8.4],[0,-.217,-5.76]);
  b.block(null,palette.sand,[26,.43,5.2],[0,-.224,4.23]);
  b.block(null,palette.canal,[26,.055,3.32],[0,.011,0]);
  for(const sign of [-1,1]){
    b.block(null,palette.row,[26,.26,.13],[0,-.01,sign*1.63]);
    for(let i=0;i<28;i++){
      const x=-9+i*.68;
      b.block(null,palette.brick,[.66,.12,.19],[x,.103,sign*1.66]);
    }
  }
  const homes=[[-6.7,-4.2,1.8,2.1,1.9,palette.rust,palette.midnight],[-1.59,-3.9,1.50,2.49,1.59,palette.saffron,palette.cherry],
    [.20,-4.45,1.68,2.80,1.77,palette.cobalt,palette.chimney],[2.18,-4.33,1.80,2.45,1.61,palette.cream,palette.rust],
    [4.13,-4.45,1.65,2.72,1.79,palette.jade,palette.midnight],[6.01,-4.41,1.53,2.11,1.66,palette.brick,palette.rust]];
  for(const h of homes)facade(b,...h);
  for(let i=-6;i<=6;i++){
    const x=i*1.06;
    b.block(null,palette.sand,[.93,.085,.44],[x,.055,-2.24]);
  }
  const bushes=vessel([[0,0],[.24,0],[.34,.22],[.31,.41],[.24,.56],[.10,.63],[0,.64]],18);
  const trunk=vessel([[0,0],[.06,0],[.052,.66],[0,.66]],10);
  for(const [x,z] of [[-6.8,-2.65],[-4.84,-2.83],[-2.75,-2.55],[1.22,-2.75],[3.65,-2.53],[6.59,-2.7],[-3.51,2.85],[5.42,3.04]]){
    b.put(null,palette.chimney,trunk,[x,0,z]);
    b.put(null,palette.jade,bushes,[x,.43,z]);b.put(null,palette.chartreuse,bushes,[x+.19,.25,z+.11]);
  }
  const rippleA=engine.createMesh(),rippleB=engine.createMesh();
  for(let i=0;i<25;i++){
    const x=-8+i*.645,z=.48*(-1)**i+.35*Math.sin(i*2.81);
    b.block(i%2?rippleA:rippleB,palette.foam,[.13+.20*Math.abs(Math.sin(i*1.17)),.014,.044],[x,.045,z],.11*Math.sin(i));
  }
  bridge(b);
  const sails=windmill(engine,b),boat=shoreline(engine,b);
  const objects=b.install(engine);
  return {sails,boat,objects,frame(time){
    rippleA.setPosition([.14*Math.sin(time*1.24),0,.074*Math.cos(time*.94)]);
    rippleB.setPosition([.17*Math.sin(time*.99+.47),0,-.059*Math.cos(time*1.21)]);
    sails.setRotation([0,0,.50+time*.54]);
    boat.setPosition([-14+(10.05+time*.82)%28,.018*Math.sin(time*2.7),.29*Math.sin(time*.63)]);
    boat.setRotation([0,.045*Math.sin(time*.63),.023*Math.cos(time*2)]);
  }};
}
