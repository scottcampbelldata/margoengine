import { Geometry, PbrMaterial, box } from '@margoengine/core';
import { heightfield, TerrainColors } from '@margoengine/terrain';

const unit=box(1,1,1);
const surface=(color,roughness=.85,metalness=0)=>new PbrMaterial({color,roughness,metalness});
const stone=[surface('#a97656'),surface('#916043'),surface('#807865'),surface('#786858')];
const asphalt=[surface('#484747',.95),surface('#494847',.94),surface('#464546',.95),surface('#4b4847',.94)];
const aggregate=[surface('#655e56'),surface('#514c47'),surface('#3d3a3b')];
const stripe=surface('#c99f48',.98);
const white=surface('#e6dace',.9);
const timber=surface('#614b3c');
const wire=surface('#444440');
const zinc=surface('#8f8c7d',.47,.24);
const route=surface('#b87143',.71);
const sage=[surface('#64705c'),surface('#777961'),surface('#686648'),surface('#59674e')];
const cactus=[surface('#506849',.83),surface('#617757',.92),surface('#465a48',.85)];
const tan=surface('#a07a65');
const adobe=surface('#855d52',.94);
const far=surface('#766978',.94);
const clay=surface('#a87059',.93);
const warmGlass=surface('#5c7174',.35,.14);
const carBody=surface('#963e3b',.46,.22);
const rubber=surface('#383535');
const trim=surface('#bda889',.50,.14);
const shade=surface('#756453');

const clamp=(x,a,b)=>Math.max(a,Math.min(x,b));
const smooth=(a,b,x)=>{const q=clamp((x-a)/(b-a),0,1);return q*q*(3-2*q);};
const norm=v=>{const n=Math.hypot(...v);return v.map(x=>x/n);};
const cross=(u,v)=>[u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]];
const sub=(a,b)=>a.map((v,i)=>v-b[i]);

function basin(seed){
  return ()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
}

class Surface{
  vertices=[];normals=[];indices=[];
  face(a,b,c,d){
    const n=norm(cross(sub(b,a),sub(c,a))),k=this.vertices.length/3;
    for(const v of d?[a,b,c,d]:[a,b,c]){this.vertices.push(...v);this.normals.push(...n);}
    this.indices.push(k,k+1,k+2);
    if(d)this.indices.push(k,k+2,k+3);
  }
  tube(a,b,r1,r2,sides=10,ridges=0,caps=true){
    const axis=norm(sub(b,a)),side=norm(cross(axis,Math.abs(axis[1])<.9?[0,1,0]:[0,0,1]));
    const up=cross(axis,side);
    const ring=(p,r,i)=>{
      const t=i*2*Math.PI/sides,s=Math.sin(t),c=Math.cos(t),fold=1-ridges*(i%2);
      return p.map((x,k)=>x+r*fold*(side[k]*c+up[k]*s));
    };
    for(let i=0;i<sides;i++){
      const u=ring(a,r1,i),v=ring(a,r1,i+1),w=ring(b,r2,i+1),q=ring(b,r2,i);
      this.face(u,v,w,q);
      if(caps){this.face(a,v,u);this.face(b,q,w);}
    }
  }
  geometry(){return new Geometry(this.vertices,this.normals,this.indices);}
}

const laneCenter=z=>10.6*smooth(128,286,-z)-4.5*smooth(330,430,-z);
const roadHeight=z=>.028 + .008*Math.sin(z*.041) + .014*smooth(120,250,-z) + .45*smooth(332,455,-z);
const laneHeight=(offset,z)=>roadHeight(z)-.009*Math.abs(offset);

function mesas(x,z){
  const mound=(cx,cz,rx,rz,h)=>{
    const vx=(x-cx)/rx,vz=(z-cz)/rz;
    if(Math.abs(vx)>1.5||Math.abs(vz)>1.5)return 0;
    const ridge=Math.abs(vx+.14*vz), spur=Math.abs(vz-.18*vx);
    const perimeter=(ridge**1.65+spur**1.65)**(1/1.65);
    const channels=.059*Math.sin(x*.36+z*.12)+.027*Math.cos(x*.61-z*.24)+.032*Math.sin(x*.13+z*.34);
    const d=perimeter+channels*smooth(.14,.39,perimeter);
    const skirt=.23*(1-smooth(.27,1.12,d));
    const basalShelf=.21*(1-smooth(.42,.76,d));
    const lowerCliff=.23*(1-smooth(.39,.53,d));
    const ledge=.09*(1-smooth(.36,.43,d));
    const upperCliff=.24*(1-smooth(.19,.39,d));
    return h*(skirt+basalShelf+lowerCliff+ledge+upperCliff)*(1+.058*Math.sin(z*.092)+.025*Math.cos(x*.24));
  };
  return Math.max(
    mound(-61,-190,55,71,31),mound(-83,-214,62,77,44),
    mound(-125,-145,60,79,26),mound(69,-198,65,68,23),
    mound(111,-233,78,85,45),mound(-97,-297,70,91,34),
    mound(96,-327,92,105,29),
  );
}

function terrainHeight(x,z){
  const shoulder=Math.abs(x-laneCenter(z));
  const cut=smooth(3.9,12.8,shoulder);
  const shape=.14*Math.sin(x*.22-z*.047)+.22*Math.cos(z*.11+x*.09)*Math.sin(x*.27)+.26*Math.sin(x*.087-z*.053);
  return roadHeight(z)-.082+cut*(shape+.40+mesas(x,z));
}

function band(surface,x0,x1,z0,z1,lift=0){
  const p=(x,z)=>[laneCenter(z)+x,laneHeight(x,z)+lift,z];
  surface.face(p(x0,z0),p(x0,z1),p(x1,z1),p(x1,z0));
}

function cactusMesh(){
  const stem=new Surface();
  const cactusArm=(nodes,radius)=>{
    for(let i=0;i<nodes.length-1;i++)stem.tube(nodes[i],nodes[i+1],radius*(1-.34*i/(nodes.length-1)),radius*(1-.34*(i+1)/(nodes.length-1)),20,.14);
  };
  cactusArm([[0,0,0],[.035,1.15,0],[.035,2.4,0],[-.02,3.12,.021]],.174);
  cactusArm([[.025,1.13,0],[.31,1.17,.045],[.55,1.45,.081],[.60,1.85,.104],[.55,2.56,.105]],.113);
  cactusArm([[0,1.53,-.005],[-.28,1.56,-.069],[-.58,1.73,-.119],[-.68,2.03,-.15],[-.68,2.35,-.16]],.104);
  return stem.geometry();
}

function foliage(){
  const branch=new Surface();
  const rng=basin(51246);
  for(let a=0;a<9;a++){
    const dir=2*Math.PI*a/9+.19*rng(),length=.25+.34*rng(),height=.18+.27*rng();
    const u=[Math.sin(dir)*length,height,Math.cos(dir)*length];
    branch.tube([0,.022,0],u,.012,.003,5);
    for(let k=0;k<4;k++){
      const t=.44+k*.16;
      const x=u[0]*t,z=u[2]*t,y=u[1]*t;
      const blade=[x+.2*Math.cos(dir+k),y+.07+.15*rng(),z+.20*Math.sin(dir+k)];
      branch.face([x,y,z],[x+.041,y+.09,z-.021],blade,[x-.026,y+.065,z+.031]);
    }
  }
  return branch.geometry();
}

function chip(){
  const geo=new Surface();
  const v=[[-.55,.02,-.29],[.36,.02,-.49],[.60,.02,.12],[.16,.02,.54],[-.44,.02,.40]];
  const high=[-.13,.46,.08],low=[.22,.21,-.04];
  for(let i=0;i<v.length;i++)geo.face(v[i],v[(i+1)%v.length],i<2?low:high);
  geo.face(v[0],low,high);geo.face(v[2],high,low);
  return geo.geometry();
}

export function buildRoad(engine){
  function object(name,geo,mat,at=[0,0,0],scale=[1,1,1],rotation=[0,0,0]){
    const mesh=engine.createMesh();
    mesh.name=name;
    return mesh.setGeometry(geo).setMaterial(mat).setPosition(at).setScale(scale).setRotation(rotation);
  }
  const block=(name,mat,x,y,z,w,h,d,rz=0)=>object(name,unit,mat,[x,y,z],[w,h,d],[0,0,rz]);
  const generatedBasin=basin(740822);
  const terrain=heightfield(terrainHeight,{size:[350,498],origin:[-175,-467],resolution:156});
  const ground=object('Sonoran basin and layered mesas',terrain,clay);
  TerrainColors.attach(engine,ground,{
    sand:[.48,.282,.174],meadow:[[.38,.211,.145],[.41,.247,.177]],stone:[.274,.132,.095],
    shore:[-.08,.34],meadowHeight:[.07,20],stoneHeight:[6,29],stoneNormal:[.49,.85],
    variation:.25,detail:.45,sandSurface:false,
  });
  const ridge=(x,z)=>Math.max(0,
    18+13*Math.sin(x*.014)+32*Math.cos(x*.009+z*.009)**8+9*Math.sin(z*.079+x*.041)**2)
    *Math.exp(-(((z+719)/262)**2))*smooth(19,84,Math.abs(x))*smooth(526,610,-z);
  object('Distant mauve ridge',heightfield(ridge,{size:[1690,817],origin:[-845,-1340],resolution:82}),far);
  const foot=(x,z)=>(3*Math.sin(x*.04-z*.02)*Math.sin(x*.05+z*.036)+26*Math.cos(x*.017-z*.068)**6
    *smooth(9,63,Math.abs(x)))*Math.exp(-(((z+466)/281)**2))*smooth(320,408,-z);
  object('Copper-gray foothills',heightfield(foot,{size:[1280,448],origin:[-640,-768],resolution:95}),adobe);

  const pavement=asphalt.map(()=>new Surface()), boundary=new Surface();
  for(let z=-455;z<22;z+=2.8){
    const end=Math.min(22,z+2.8);
    for(let col=0;col<4;col++){
      const a=-4.20+col*2.10,b=a+2.10;
      band(pavement[Math.floor(generatedBasin()*pavement.length)],a,b,z,end);
    }
    for(const x of [-3.47,3.47])band(boundary,x-.055,x+.055,z,end,.004);
  }
  for(let i=0;i<asphalt.length;i++)object('Asphalt course '+i,pavement[i].geometry(),asphalt[i]);
  object('White shoulder lines',boundary.geometry(),white);
  const yellow=new Surface();
  for(let z=-448;z<22;z+=7.5){
    for(const x of [-.105,.105])band(yellow,x-.045,x+.045,z,Math.min(22,z+3.7),.006);
  }
  object('Center lane paint',yellow.geometry(),stripe);

  const wear=aggregate.map(()=>new Surface());
  const grit=basin(60423);
  for(let i=0;i<4700;i++){
    const z=18-57*grit(),x=-4.16+8.32*grit(),r=.011+.051*grit()**3;
    const y=laneHeight(x,z)+.0018,worldX=laneCenter(z)+x;
    wear[i%wear.length].face([worldX-r,y,z+r],[worldX+r,y,z+r*.6],[worldX+r*.37,y,z-r]);
  }
  for(let i=0;i<wear.length;i++)object('Exposed asphalt aggregate '+i,wear[i].geometry(),aggregate[i]);

  const stalks=cactusMesh(), leaves=foliage(), stoneShape=chip();
  const plant=(x,z,scale,rot,mat)=>object('Saguaro cluster',stalks,mat,[x,terrainHeight(x,z)-.012,z],[scale,scale,scale],[0,rot,-.025]);
  for(const [x,z,k,r,i] of [[-10.2,-13,1.15,.04,0],[8.6,-23,.96,-.12,1],[-16.2,-48,1.29,-.35,2],[16.8,-59,1.16,.31,0],[-12.5,-93,.82,.22,1],[14,-112,1.29,-.11,1],[-27,-124,.71,.27,2]])plant(x,z,k,r,cactus[i]);
  const fieldShadows=new Surface();
  for(let i=0;i<145;i++){
    const side=i%2===0?-1:1,z=23-generatedBasin()*210,x=side*(4.9+generatedBasin()*23);
    const scale=.48+.80*generatedBasin(),r=generatedBasin()*Math.PI*2;
    const base=terrainHeight(x,z);
    object(i%3===0?'Weathered gravel':'Dry brittlebush',i%3===0?stoneShape:leaves,i%3===0?stone[i%4]:sage[i%4],
      [x,base,z],[scale,scale,scale],[0,r,0]);
    const vertex=a=>{
      const px=x-.16*scale+Math.cos(a)*scale*.54, pz=z-.18*scale+Math.sin(a)*scale*.39;
      return [px,Math.max(base,terrainHeight(px,pz))+.025,pz];
    };
    for(let j=0;j<7;j++){
      fieldShadows.face([x,base+.025,z],vertex((j+1)*2*Math.PI/7),vertex(j*2*Math.PI/7));
    }
  }
  object('Dark scree and shrub skirts',fieldShadows.geometry(),shade);

  const poles=new Surface(), lines=new Surface(), support=[];
  for(let i=0;i<8;i++){
    const z=-29-i*27,x=-8.8-.42*i,y=terrainHeight(x,z),h=4.35+.18*Math.sin(i);
    poles.tube([x,y,z],[x-.11,y+h,z],.104,.075,10);
    block('Pole timber crossarm',timber,x-.11,y+h-.32,z,1.52,.065,.106);
    for(const ox of [-.60,0,.59])block('Glazed line standoff',warmGlass,x+ox-.11,y+h-.24,z,.063,.105,.066);
    support.push([x-.11,y+h-.19,z]);
  }
  for(let i=0;i<support.length-1;i++)for(const x of [-.60,0,.59]){
    const a=support[i],b=support[i+1];
    const p=t=>[a[0]+x+t*(b[0]-a[0]),a[1]+t*(b[1]-a[1])-.38*Math.sin(t*Math.PI),a[2]+t*(b[2]-a[2])];
    for(let j=0;j<8;j++)lines.tube(p(j/8),p((j+1)/8),.008,.008,5,0,false);
  }
  object('Timber utility poles',poles.geometry(),timber);
  object('Catenary utility runs',lines.geometry(),wire);

  for(let z=-14;z>=-195;z-=12.3){
    for(const side of [-1,1]){
      const x=laneCenter(z)+side*4.45,y=terrainHeight(x,z);
      block('Pavement marker post',white,x,y+.407,z,.078,.79,.074);
      block('Dark reflector inset',wire,x,y+.65,z+.039,.078,.19,.009);
      block('Glass road stud',stripe,x,y+.665,z+.046,.052,.066,.013);
    }
  }
  const signAt=[6.1,-31], [sx,sz]=signAt, sy=terrainHeight(sx,sz);
  block('Galvanized road sign post',zinc,sx,sy+1.126,sz,.067,2.2,.067);
  block('Amber warning sign',route,sx,sy+2.052,sz,.66,.66,.035,.7854);
  block('Dark rising arrow',wire,sx,sy+2.053,sz+.020,.038,.35,.008,-.27);
  block('Warning sign detail',wire,sx+.057,sy+2.18,sz+.020,.15,.034,.008,.71);

  const carX=5.30,carZ=-100, carY=terrainHeight(carX,carZ)+.57;
  block('Parked utility truck lower body',carBody,carX,carY,carZ,1.73,.61,4.24);
  block('Cab sill',trim,carX,carY-.18,carZ,1.78,.085,4.28);
  block('Sunlit cab roof',carBody,carX,carY+.66,carZ-.62,1.53,.17,1.58);
  block('Tinted cab glazing',warmGlass,carX,carY+.433,carZ-.58,1.50,.34,1.40);
  block('Raised hood',carBody,carX,carY+.29,carZ-1.65,1.65,.17,1.17);
  block('Open rear bed',tan,carX,carY+.31,carZ+1.27,1.51,.075,1.75);
  for(const x of [-1,1])block('Folded truck side',carBody,carX+x*.79,carY+.38,carZ+1.18,.12,.24,1.89);
  block('Truck rear lip',trim,carX,carY-.24,carZ+2.14,1.78,.11,.081);
  for(const x of [-1,1]){
    block('Tail light',route,carX+x*.68,carY+.07,carZ+2.135,.16,.17,.091);
    for(const z of [-1.25,1.21]){
      const wheel=new Surface();
      wheel.tube([carX+x*.77,carY-.32,carZ+z],[carX+x*.99,carY-.32,carZ+z],.37,.37,17);
      object('Rubber utility tyre',wheel.geometry(),rubber);
    }
  }
  const guard=new Surface();
  for(let i=0;i<11;i++){
    const z=19-2.37*i,x=-4.91-.45*smooth(11,30,i);
    const y=terrainHeight(x,z);
    block('Recessed galvanized guardrail post',zinc,x,y+.381,z,.085,.68,.12);
    if(i<10){
      guard.tube([x,y+.72,z],[x,terrainHeight(x,z-2.37)+.72,z-2.37],.080,.080,6);
      guard.tube([x,y+.53,z],[x,terrainHeight(x,z-2.37)+.53,z-2.37],.061,.061,5);
    }
  }
  object('Twin roll-form guardrail',guard.geometry(),zinc);
}
