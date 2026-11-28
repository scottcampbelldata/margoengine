import { applyMatrix4, cylinderGeometry, latheGeometry, mergeGeometries, sphereGeometry, torusGeometry } from '@margoengine/geometry';
import { roundedBoxGeometry } from '@margoengine/geometry/extras';
import { Material, createMesh } from '@margoengine/materials';
import { ballArm, linkLength, lowSleeve, pivotHeight, rackPitchRadius } from './mechanism.js';

const tau=Math.PI*2;
const up=[0,1,0],front=[0,0,1],across=[1,0,0];
const axisX=-.138, valveX=.405, gearX=.253;
const shaftY=.373, shaftZ=.119, rackZ=shaftZ+rackPitchRadius;
const toothCount=36;
const pitch=tau*rackPitchRadius/toothCount;
const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const normal=(v)=>v.map((c)=>c/Math.hypot(...v));

const finish={
  floor:{color:[.111,.088,.071],roughness:.96,metalness:0},
  base:{color:[.086,.098,.093],roughness:.59,metalness:0},
  enamel:{color:[.093,.193,.174],roughness:.41,metalness:0},
  waist:{color:[.172,.277,.239],roughness:.34,metalness:0},
  brass:{color:[.744,.471,.203],roughness:.31,metalness:.62},
  bronze:{color:[.479,.264,.118],roughness:.44,metalness:.55},
  steel:{color:[.60,.61,.587],roughness:.30,metalness:.61},
  iron:{color:[.09,.086,.072],roughness:.54,metalness:.24},
  paper:{color:[.77,.69,.505],roughness:.76,metalness:0},
  red:{color:[.59,.092,.036],roughness:.37,metalness:.06},
  enamelDark:{color:[.049,.096,.084],roughness:.53,metalness:0},
  marks:{color:'#373226',shading:'basic'},
};

function place(data,position,axis=up) {
  const x=normal(cross(axis,Math.abs(axis[2])>.86?across:front));
  const z=cross(x,axis);
  return applyMatrix4(data,[...x,0,...axis,0,...z,0,...position,1]);
}

function strut(from,to,width,depth,bevel) {
  const direction=to.map((value,i)=>value-from[i]);
  return place(roundedBoxGeometry(width,Math.hypot(...direction),depth,2,bevel),
    from.map((value,i)=>(value+to[i])/2),normal(direction));
}

function turnedRing(inner,outer,depth,edge,segments=66) {
  const a=-depth*.5,b=depth*.5;
  return latheGeometry([
    [inner+edge,a],[outer-edge,a],[outer,a+edge],[outer,b-edge],[outer-edge,b],
    [inner+edge,b],[inner,b-edge],[inner,a+edge],[inner+edge,a],
  ],segments);
}

function toothedGear() {
  const outline=[];
  for(let i=0;i<toothCount;i++) {
    for(const [position,radius] of [[-.50,-.0065],[-.27,-.0065],[-.18,.0065],[.18,.0065],[.27,-.0065]]) {
      const a=(i+position)*tau/toothCount,r=rackPitchRadius+radius;
      outline.push([r*Math.cos(a),r*Math.sin(a)]);
    }
  }
  const pos=[], normals=[],uv=[],indices=[];
  const half=.0074;
  for(const sign of [-1,1]) {
    const start=pos.length/3;
    pos.push(0,half*sign,0); normals.push(0,sign,0); uv.push(.5,.5);
    for(const [x,z] of outline) { pos.push(x,half*sign,-z); normals.push(0,sign,0); uv.push(x+.5,z+.5); }
    for(let i=0;i<outline.length;i++) {
      const a=start+i+1,b=start+(i+1)%outline.length+1;
      indices.push(start,sign===1?a:b,sign===1?b:a);
    }
  }
  outline.forEach(([x,z],i)=>{
    const [nx,nz]=outline[(i+1)%outline.length], dx=nx-x,dz=nz-z,k=Math.hypot(dx,dz);
    const start=pos.length/3,n=[dz/k,0,dx/k];
    pos.push(x,-half,-z,nx,-half,-nz,nx,half,-nz,x,half,-z);
    normals.push(...n,...n,...n,...n);
    uv.push(0,0,1,0,1,1,0,1);
    indices.push(start,start+1,start+2,start,start+2,start+3);
  });
  return {positions:Float32Array.from(pos),normals:Float32Array.from(normals),
    uvs:Float32Array.from(uv),indices:Uint32Array.from(indices)};
}

const glyph={
  M:[[0,0,0,1],[0,1,.50,.49],[.50,.49,1,1],[1,1,1,0]],
};

export function prepareGovernor() {
  const families=new Map();
  function add(group,name,data) {
    const key=group+':'+name;
    if(!families.has(key)) families.set(key,[]);
    families.get(key).push(data);
  }
  function slab(group,name,point,dim,bevel,axis=up) {
    add(group,name,place(roundedBoxGeometry(...dim,bevel<.003?1:2,bevel),point,axis));
  }
  function barrel(group,name,point,radius,length,segments=32,axis=up,bottom=radius) {
    add(group,name,place(cylinderGeometry(radius,bottom,length,segments),point,axis));
  }
  function rim(group,name,point,radius,t,axis=up) {
    const geometry=torusGeometry(radius,t,6,64);
    const rotate=applyMatrix4(geometry,[1,0,0,0,0,0,-1,0,0,1,0,0,0,0,0,1]);
    add(group,name,place(rotate,point,axis));
  }
  function bolt(group,point,r,axis=up) {
    barrel(group,'iron',point,r*1.24,.0038,18,axis);
    const head=point.map((v,i)=>v+axis[i]*.0033);
    barrel(group,'steel',head,r,.0067,6,axis);
    const cap=head.map((v,i)=>v+axis[i]*.0034);
    barrel(group,'bronze',cap,r*.42,.0027,12,axis);
  }
  function mark(group,name,from,to,z,width) {
    const dx=to[0]-from[0],dy=to[1]-from[1],length=Math.hypot(dx,dy);
    const c=dx/length,s=dy/length;
    add(group,name,applyMatrix4(roundedBoxGeometry(length+width*.1,width,.00076,1,.00019),
      [c,s,0,0,-s,c,0,0,0,0,1,0,(from[0]+to[0])/2,(from[1]+to[1])/2,z,1]));
  }

  slab('world','floor',[0,-.084,0],[100,.034,100],.005);
  slab('world','base',[0,-.043,.022],[1.219,.047,.564],.019);
  slab('world','waist',[0,-.017,.022],[1.255,.017,.585],.010);
  slab('world','enamel',[0,.013,.022],[1.249,.055,.589],.019);
  slab('world','waist',[0,.044,.022],[1.207,.018,.554],.006);
  slab('world','enamelDark',[0,.053,.022],[1.162,.011,.531],.0037);
  for(const x of [-.559,.559]) for(const z of [-.216,.256]) {
    barrel('world','base',[x,-.059,z],.035,.019,28,up,.040);
    bolt('world',[x,.061,z],.0092);
  }

  // Foot casting, lower bearings and belt pulley on the vertical drive shaft.
  slab('world','base',[axisX,.069,0],[.368,.037,.338],.012);
  slab('world','enamel',[axisX,.091,0],[.278,.027,.255],.008);
  for(const x of [-.123,.123]) for(const z of [-.107,.107]) bolt('world',[axisX+x,.107,z],.0090);
  barrel('world','enamel',[axisX,.138,0],.106,.088,56,up,.127);
  barrel('world','waist',[axisX,.182,0],.081,.020,60,up,.093);
  barrel('world','bronze',[axisX,.201,0],.060,.033,54);
  rim('world','steel',[axisX,.216,0],.047,.0037);
  barrel('world','steel',[axisX,.463,0],.016,.530,64);
  barrel('world','bronze',[axisX,.679,0],.024,.029,42);
  rim('world','steel',[axisX,.687,0],.021,.0022);
  for(const sign of [-1,1]) {
    const x=axisX+sign*.072;
    add('world','enamel',strut([x,.105,-.090],[axisX+sign*.054,.169,-.057],.045,.042,.0055));
  }
  add('drive','bronze',turnedRing(.017,.082,.036,.0041));
  add('drive','steel',place(turnedRing(.069,.084,.007,.0015),[0,.014,0]));
  add('drive','iron',place(turnedRing(.057,.078,.015,.0027),[0,.0005,0]));
  for(let i=0;i<6;i++) {
    const a=i*tau/6;
    bolt('drive',[.048*Math.cos(a),.019,.048*Math.sin(a)],.0049);
  }

  // Sliding sleeve with a polished groove and a stationary follower at its waist.
  add('sleeve','steel',turnedRing(.0173,.040,.074,.0036));
  add('sleeve','bronze',place(turnedRing(.027,.053,.019,.0032),[0,-.031,0]));
  add('sleeve','bronze',place(turnedRing(.027,.053,.019,.0032),[0,.031,0]));
  rim('sleeve','steel',[0,-.041,0],.050,.0027);
  rim('sleeve','steel',[0,.041,0],.050,.0027);
  const collar=turnedRing(.042,.057,.028,.0025,54);
  add('follower','bronze',place(collar,[axisX,0,0]));
  slab('follower','bronze',[.017,0,.001],[.271,.023,.028],.0056);
  slab('follower','steel',[.080,.007,.014],[.129,.007,.008],.002);
  bolt('follower',[axisX+.053,.015,.012],.0064);
  add('follower','bronze',strut([.139,0,.014],[gearX,0,rackZ+.010],.024,.022,.0049));
  bolt('follower',[gearX,.015,rackZ+.012],.0051);
  slab('follower','bronze',[gearX,-.005,rackZ+.015],[.025,.342,.020],.0028);
  slab('follower','steel',[gearX-.016,-.006,rackZ+.016],[.008,.315,.009],.0025);
  for(let i=-7;i<=4;i++) {
    const at=shaftY-lowSleeve+pitch*(i+.5);
    if(Math.abs(at)>.154) continue;
    slab('follower','brass',[gearX,at,rackZ+.001],[.021,.010,.019],.0014,[0,1,0]);
  }

  // Graduated fixed plate with a small index attached to the moving fork.
  const gaugeX=-.410;
  slab('world','enamel',[gaugeX,.080,-.133],[.119,.034,.117],.0091);
  add('world','enamel',strut([gaugeX,.080,-.139],[gaugeX,.443,-.108],.022,.027,.006));
  slab('world','bronze',[gaugeX,.409,-.085],[.053,.296,.014],.0038);
  slab('world','paper',[gaugeX,.409,-.075],[.037,.277,.006],.0020);
  for(let i=0;i<=22;i++) {
    const y=lowSleeve+i*.00994;
    mark('world','marks',[gaugeX-.016,y],[gaugeX+(i%5===0?.012:.004),y],-.0718,i%5===0?.0019:.0010);
  }
  const gaugeLetters='MM';
  [...gaugeLetters].forEach((letter,i)=>{
    for(const [x1,y1,x2,y2] of glyph[letter]) {
      const x=gaugeX+(i-1)*.009-.003;
      mark('world','marks',[x+x1*.006,.537+y1*.009],[x+x2*.006,.537+y2*.009],-.0718,.0010);
    }
  });
  bolt('world',[gaugeX,.268,-.068],.0061,front);
  bolt('world',[gaugeX,.550,-.068],.0061,front);
  add('follower','bronze',strut([axisX-.052,0,-.010],[gaugeX+.031,0,-.067],.009,.007,.0025));
  slab('follower','red',[gaugeX+.023,0,-.066],[.024,.0058,.008],.0021);

  // Deep-bore demonstration valve. The disc is exposed through the flanged inspection mouth.
  slab('world','base',[valveX,.071,.132],[.304,.039,.348],.011);
  slab('world','enamel',[valveX,.101,.133],[.238,.025,.280],.008);
  for(const x of [-.097,.097]) for(const z of [-.106,.106]) bolt('world',[valveX+x,.116,.133+z],.0077);
  add('world','enamel',strut([valveX,.101,.133],[valveX,.309,.133],.115,.111,.017));
  slab('world','waist',[valveX,.262,.133],[.126,.032,.123],.010);
  for(const [z,r,d] of [[-.010,.101,.057],[.087,.092,.145],[.172,.113,.035],[.194,.114,.017]]) {
    add('world','bronze',place(turnedRing(.073,r,d,.004),[valveX,shaftY,z],front));
  }
  add('world','enamel',place(turnedRing(.087,.104,.065,.0042),[valveX,shaftY,.069],front));
  add('world','steel',place(turnedRing(.073,.106,.007,.0017),[valveX,shaftY,.204],front));
  rim('world','brass',[valveX,shaftY,.208],.079,.0028,front);
  // The rear is set back far enough for the open bore to read as a cavity.
  barrel('world','iron',[valveX,shaftY,-.023],.070,.009,64,front);
  for(let i=0;i<8;i++) {
    const a=i*tau/8+.20;
    bolt('world',[valveX+Math.cos(a)*.095,shaftY+Math.sin(a)*.095,.206],.0062,front);
  }
  for(const x of [.307,.508]) {
    barrel('world','bronze',[x,shaftY,shaftZ],.030,.028,40,across);
    barrel('world','steel',[x-.008,shaftY,shaftZ],.023,.012,36,across);
  }
  // Stationary guide rods keep the rack follower in one plane.
  for(const x of [gearX-.031,gearX+.031]) {
    barrel('world','steel',[x,.391,rackZ+.031],.005,.290,20);
    for(const y of [.252,.537]) barrel('world','bronze',[x,y,rackZ+.031],.011,.015,26);
  }
  slab('world','enamel',[gearX+.056,.243,rackZ+.031],[.151,.025,.028],.0047);
  slab('world','enamel',[gearX+.066,.543,rackZ+.030],[.154,.025,.029],.005);
  add('world','enamel',strut([gearX+.122,.226,.049],[gearX+.125,.544,.051],.023,.027,.005));
  for(const y of [.246,.543]) add('world','enamel',strut([gearX+.117,y,.071],[gearX+.121,y,rackZ+.027],.021,.025,.005));

  add('gear','bronze',place(toothedGear(),[0,0,0],across));
  add('gear','enamel',place(turnedRing(.032,rackPitchRadius-.014,.0043,.0013),[-.010,0,0],across));
  add('gear','brass',place(turnedRing(rackPitchRadius-.032,rackPitchRadius-.017,.0037,.0010),[-.014,0,0],across));
  barrel('gear','bronze',[-.011,0,0],.036,.018,45,across);
  barrel('gear','steel',[-.024,0,0],.023,.018,36,across);
  for(let i=0;i<6;i++) {
    const a=i*tau/6;
    add('gear','bronze',strut([-.014,.037*Math.cos(a),.037*Math.sin(a)],
      [-.014,(rackPitchRadius-.026)*Math.cos(a),(rackPitchRadius-.026)*Math.sin(a)],.008,.009,.0022));
    bolt('gear',[-.020,.088*Math.cos(a),.088*Math.sin(a)],.0044,[-1,0,0]);
  }
  barrel('gear','steel',[.064,0,0],.0073,.193,38,across);
  barrel('flap','red',[0,0,0],.0698,.010,68,front);
  rim('flap','brass',[0,0,.005],.0655,.0018,front);
  rim('flap','bronze',[0,0,-.005],.0655,.0018,front);
  const discWeb=strut([-.063,0,0],[.063,0,0],.012,.017,.0029);
  add('flap','steel',discWeb);
  for(const x of [-.032,.032]) {
    bolt('flap',[x,0,.007],.0062,front);
    bolt('flap',[x,0,-.007],.0062,[0,0,-1]);
  }

  // Spindle crown and fixed-length links in the rotating frame.
  barrel('crown','bronze',[0,-.001,0],.034,.045,48);
  barrel('crown','steel',[0,.025,0],.026,.017,44);
  barrel('crown','brass',[0,.040,0],.034,.019,48,up,.029);
  for(const sign of [-1,1]) bolt('crown',[0,0,sign*.031],.013,[0,0,sign]);
  for(const side of [-1,1]) slab('upper','brass',[0,0,side*.011],[.017,ballArm,.012],.0049);
  slab('upper','bronze',[0,-.012,.019],[.005,ballArm-.055,.003],.0013);
  slab('lower','bronze',[0,0,0],[.015,linkLength,.018],.0053);
  slab('lower','steel',[0,0,.011],[.0055,linkLength-.050,.0039],.0012);
  add('ball','brass',sphereGeometry(.055,48,32));
  rim('ball','bronze',[0,.004,0],.055,.0012);
  rim('ball','steel',[0,.046,0],.028,.0016);
  barrel('ball','bronze',[0,.055,0],.015,.018,36,up,.020);
  barrel('ball','steel',[0,.066,0],.0108,.0073,30);
  bolt('joint',[0,0,.021],.0076,front);
  barrel('joint','bronze',[0,0,0],.013,.043,28,front);
  barrel('joint','steel',[0,0,0],.0058,.061,22,front);

  const pieces=new Map();
  for(const [key,parts] of families) pieces.set(key,parts.length===1?parts[0]:mergeGeometries(parts));
  return (engine,shadows)=>{
    const world=engine.createMesh();
    const spin=engine.createMesh().setParent(world).setPosition([axisX,0,0]);
    const point=(parent,position)=>engine.createMesh().setParent(parent).setPosition(position);
    const materials=new Map(Object.entries(finish).map(([key,value])=>[key,new Material(value)]));
    const prefix=(name)=>name+':';
    function parts(group,owner,stationary=false) {
      for(const [key,data] of pieces) {
        if(!key.startsWith(prefix(group))) continue;
        const material=key.split(':')[1];
        const mesh=createMesh(engine,data,materials.get(material));
        mesh.root.name=group+' '+material;
        mesh.root.setParent(owner);
        shadows.add(mesh,{static:stationary,castShadow:material!=='floor'&&material!=='marks'&&group!=='joint'});
      }
    }
    function assemble(group,parent,position=[0,0,0]) {
      const owner=point(parent,position);
      parts(group,owner);
      return owner;
    }
    parts('world',world,true);
    assemble('crown',spin,[0,pivotHeight,0]);
    assemble('drive',spin,[0,.242,0]);
    const sleeve=assemble('sleeve',spin);
    const follower=assemble('follower',world);
    const gear=assemble('gear',world,[gearX,shaftY,shaftZ]);
    const flap=assemble('flap',world,[valveX,shaftY,shaftZ]);
    const pairs=[-1,1].map((sign)=>({
      sign,upper:assemble('upper',spin),lower:assemble('lower',spin),
      ball:assemble('ball',spin),joint:assemble('joint',spin),
    }));
    return {
      spin(angle) { spin.setRotation([0,angle,0]); },
      pose({ballX,ballY,jointRadius,jointY,sleeveY,valveAngle}) {
        sleeve.setPosition([0,sleeveY,0]);
        follower.setPosition([0,sleeveY,0]);
        gear.setRotation([-valveAngle,0,0]);
        flap.setRotation([-Math.PI*.5-valveAngle,0,0]);
        for(const {sign,upper,lower,ball,joint} of pairs) {
          const bx=sign*ballX,jx=sign*jointRadius;
          upper.setPosition([bx*.5,(pivotHeight+ballY)*.5,0]).setRotation([0,0,Math.atan2(-bx,ballY-pivotHeight)]);
          lower.setPosition([jx*.5,(sleeveY+jointY)*.5,0]).setRotation([0,0,Math.atan2(-jx,jointY-sleeveY)]);
          ball.setPosition([bx,ballY,0]).setRotation([0,0,Math.atan2(bx,pivotHeight-ballY)]);
          joint.setPosition([jx,jointY,0]);
        }
      },
    };
  };
}
