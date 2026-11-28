import { applyMatrix4, cylinderGeometry, latheGeometry, mergeGeometries, sphereGeometry, torusGeometry } from '@margoengine/geometry';
import { roundedBoxGeometry } from '@margoengine/geometry/extras';
import { Material, createMesh } from '@margoengine/materials';
import { camOutline, drivePose, width } from './kinematics.js';

const tau=Math.PI*2;
const up=[0,1,0],front=[0,0,1],right=[1,0,0];
const centerY=.390;
const half=width/2;
const rail=.029;
const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const unit=(v)=>v.map((value)=>value/Math.hypot(...v));
const polar=(radius,t,z=0)=>[radius*Math.cos(t),radius*Math.sin(t),z];

const finish={
  floor:{color:[.177,.157,.219],roughness:.96,metalness:0},
  foot:{color:[.052,.046,.072],roughness:.75,metalness:0},
  base:{color:[.133,.110,.184],roughness:.48,metalness:.14},
  violet:{color:[.216,.157,.333],roughness:.41,metalness:.08},
  edge:{color:[.336,.275,.465],roughness:.37,metalness:.22},
  enamel:{color:[.69,.719,.711],roughness:.41,metalness:0},
  steel:{color:[.582,.614,.638],roughness:.30,metalness:.65},
  steelDark:{color:[.243,.270,.335],roughness:.41,metalness:.61},
  black:{color:[.055,.061,.091],roughness:.55,metalness:.24},
  inset:{color:[.096,.108,.164],roughness:.65,metalness:0},
  braze:{color:[.399,.229,.081],roughness:.43,metalness:.59},
  gold:{color:[.781,.501,.151],roughness:.33,metalness:.51},
  lacquer:{color:[.652,.267,.115],roughness:.41,metalness:.08},
  scale:{color:'#554d66',shading:'basic'},
  marks:{color:'#f2d38b',shading:'basic'},
  contact:{color:'#ff8750',shading:'basic'},
  cool:{color:'#8aeeff',shading:'basic'},
  trackEdge:{color:'#215264',shading:'basic'},
};

function mesh(vertices,normals,uvs,indices) {
  return {positions:Float32Array.from(vertices),normals:Float32Array.from(normals),
    uvs:Float32Array.from(uvs),indices:Uint32Array.from(indices)};
}

function place(data,p,axis=up) {
  const x=unit(cross(axis,Math.abs(axis[2])>.87?right:front));
  const z=cross(x,axis);
  return applyMatrix4(data,[...x,0,...axis,0,...z,0,...p,1]);
}

function rod(from,to,w,d,bevel) {
  const direction=to.map((value,i)=>value-from[i]);
  return place(roundedBoxGeometry(w,Math.hypot(...direction),d,2,bevel),
    from.map((value,i)=>(value+to[i])*.5),unit(direction));
}

function annulus(inner,outer,depth,bevel,segments) {
  const a=-depth*.5,b=depth*.5;
  return latheGeometry([
    [inner+bevel,a],[outer-bevel,a],[outer,a+bevel],[outer,b-bevel],[outer-bevel,b],
    [inner+bevel,b],[inner,b-bevel],[inner,a+bevel],[inner+bevel,a],
  ],segments);
}

function solidCam() {
  const outline=camOutline();
  const n=outline.length;
  const levels=[[.031,.981],[.037,1],[.086,1],[.094,.974]];
  const loops=levels.map(([z,scale])=>outline.map(([x,y])=>[x*scale,y*scale,z]));
  const vertices=[],normals=[],uvs=[],indices=[];
  function write(v,normal) { vertices.push(...v); normals.push(...normal); uvs.push(v[0]+.5,v[1]+.5); }
  for(const [side,loop] of [[-1,loops[0]],[1,loops.at(-1)]]) {
    const start=vertices.length/3;
    const normal=[0,0,side];
    write([0,0,loop[0][2]],normal);
    for(const v of loop) write(v,normal);
    for(let i=0;i<n;i++) {
      const next=(i+1)%n;
      indices.push(start,start+1+(side===1?i:next),start+1+(side===1?next:i));
    }
  }
  for(let l=0;l<loops.length-1;l++) {
    const lower=loops[l],upper=loops[l+1];
    for(let i=0;i<n;i++) {
      const j=(i+1)%n,start=vertices.length/3;
      const p=lower[i],q=lower[j],r=upper[j],s=upper[i];
      const normal=unit(cross(q.map((value,k)=>value-p[k]),s.map((value,k)=>value-p[k])));
      for(const v of [p,q,r,s]) write(v,normal);
      indices.push(start,start+1,start+2,start,start+2,start+3);
    }
  }
  return mesh(vertices,normals,uvs,indices);
}

function drawnPath(halfLine,z) {
  const count=200;
  const points=Array.from({length:count},(_,i)=>drivePose(120*i/count).center);
  const vs=[],ns=[],uv=[],is=[];
  for(let i=0;i<count;i++) {
    const before=points[(i+count-1)%count],after=points[(i+1)%count];
    const dx=after[0]-before[0],dy=after[1]-before[1],length=Math.hypot(dx,dy);
    const [x,y]=points[i];
    const nx=dy*halfLine/length,ny=-dx*halfLine/length;
    vs.push(x+nx,y+ny,z,x-nx,y-ny,z);
    ns.push(0,0,1,0,0,1);
    uv.push(0,0,1,0);
    const a=i*2,b=(i+1)%count*2;
    is.push(a,b,a+1,a+1,b,b+1);
  }
  return mesh(vs,ns,uv,is);
}

export function prepareDrive() {
  const batches=new Map();
  function add(owner,material,data) {
    const key=owner+':'+material;
    if(!batches.has(key)) batches.set(key,[]);
    batches.get(key).push(data);
  }
  function box(owner,material,p,dimensions,bevel,axis=up) {
    add(owner,material,place(roundedBoxGeometry(...dimensions,2,bevel),p,axis));
  }
  function barrel(owner,material,p,radius,depth,count=40,axis=front,back=radius) {
    add(owner,material,place(cylinderGeometry(radius,back,depth,count),p,axis));
  }
  function ring(owner,material,p,inner,outer,depth,bevel,segments=60) {
    add(owner,material,place(annulus(inner,outer,depth,bevel,segments),p,front));
  }
  function screw(owner,p,radius,axis=front) {
    barrel(owner,'black',p,radius*1.20,.0032,16,axis);
    const q=p.map((v,i)=>v+axis[i]*.0028);
    barrel(owner,'steel',q,radius,.0058,14,axis);
    const top=q.map((v,i)=>v+axis[i]*.0031);
    box(owner,'black',top,[radius*1.26,.00085,radius*.28],.00024,axis);
  }

  box('world','floor',[0,-.077,0],[106,.028,106],.006);
  box('world','foot',[0,-.046,.045],[.800,.035,.538],.016);
  box('world','base',[0,-.020,.045],[.837,.026,.570],.011);
  box('world','steel',[0,.001,.045],[.855,.018,.589],.0075);
  box('world','base',[0,.024,.045],[.835,.039,.568],.014);
  box('world','violet',[0,.048,.045],[.796,.016,.522],.0056);
  for(const x of [-.354,.354]) for(const z of [-.162,.240]) screw('world',[x,.055,z],.0081,up);

  for(const x of [-.189,.189]) {
    box('world','foot',[x,.060,.016],[.143,.019,.274],.0065);
    box('world','violet',[x,.072,.020],[.152,.032,.267],.0076);
    add('world','violet',rod([x,.085,-.077],[x,.175,-.055],.080,.092,.012));
    add('world','edge',rod([x,.090,.076],[x,.158,.028],.052,.047,.0084));
    for(const dx of [-.046,.046]) screw('world',[x+dx,.088,.117],.0065,up);
  }

  box('frame','violet',[0,0,-.055],[.609,.591,.076],.026);
  box('frame','edge',[0,0,-.017],[.587,.573,.018],.013);
  box('frame','inset',[0,0,-.001],[.511,.510,.024],.011);
  // Working square faces. Their inner surfaces are exactly half a width from center.
  for(const sign of [-1,1]) {
    box('frame','steelDark',[sign*(half+rail*.5),0,.054],[rail,width+.065,.068],.0027);
    box('frame','steelDark',[0,sign*(half+rail*.5),.054],[width,rail,.068],.0027);

    const beyond=half+rail+.027;
    box('frame','enamel',[sign*beyond,0,.058],[.053,.596,.076],.0090);
    box('frame','enamel',[0,sign*beyond,.058],[.508,.053,.076],.0090);
    box('frame','steel',[sign*(half+rail-.009),0,.089],[.014,.520,.0115],.0030);
    box('frame','steel',[0,sign*(half+rail-.009),.089],[.474,.014,.0115],.0030);

    box('frame','violet',[sign*.293,0,-.002],[.048,.550,.062],.012);
    for(const y of [-.268,.268]) {
      box('frame','enamel',[sign*.279,y,.076],[.054,.053,.048],.0092);
      barrel('frame','steelDark',[sign*.279,y,.100],.0155,.0084,36);
      screw('frame',[sign*.279,y,.104],.0108);
    }
  }
  for(let i=-9;i<=9;i++) {
    const f=i*.0215,major=i%3===0,w=major?.012:.006;
    for(const side of [-1,1]) {
      box('frame','scale',[side*.274,f,.0965],[w,.00140,.0008],.00024);
      box('frame','scale',[f,side*.274,.0965],[.00140,w,.0008],.00024);
    }
  }
  for(const side of [-1,1]) {
    box('frame','lacquer',[0,side*.280,.097],[.0068,.018,.0019],.0006);
    box('frame','lacquer',[side*.280,0,.097],[.018,.0068,.0019],.0006);
  }

  add('cam','gold',solidCam());
  ring('cam','braze',[0,0,.097],.048,.085,.0075,.0015,76);
  ring('cam','gold',[0,0,.101],.063,.083,.0045,.0013,76);
  for(let i=0;i<3;i++) {
    const a=Math.PI/2+i*tau/3;
    add('cam','braze',rod(polar(.085,a,.097),polar(.174,a,.097),.016,.0038,.0014));
    add('cam','gold',rod(polar(.100,a+.018,.100),polar(.167,a+.018,.100),.0054,.0028,.0009));
    barrel('cam','braze',polar(.177,a,.097),.026,.0068,52);
    ring('cam','steel',polar(.177,a,.103),.013,.023,.0078,.0021,48);
    screw('cam',polar(.177,a,.107),.0103);
    barrel('cam',i===0?'lacquer':'marks',polar(.211,a,.096),.0053,.0022,18);
    for(let j=-1;j<=1;j++) {
      const t=a+(j+.2)*.131;
      add('cam','marks',rod(polar(.099,t,.095),polar(j===0?.112:.107,t,.095),.0022,.00092,.00025));
    }
  }
  barrel('cam','braze',[0,0,.106],.048,.025,62);
  ring('cam','steel',[0,0,.119],.028,.044,.0097,.0028,66);
  barrel('cam','steelDark',[0,0,.127],.025,.015,55);
  barrel('cam','gold',[0,0,.138],.017,.0097,45);
  screw('cam',[0,0,.142],.0098);

  add('trace','trackEdge',drawnPath(.0033,.157));
  add('trace','cool',drawnPath(.0016,.1581));
  for(const [a,b] of [
    [[-.009,0,.156],[.009,0,.156]],
    [[0,-.009,.156],[0,.009,.156]],
  ]) add('trace','trackEdge',rod(a,b,.0014,.0011,.00035));
  add('centroid','trackEdge',torusGeometry(.0107,.0022,7,30));
  add('centroid','cool',sphereGeometry(.0056,18,12));
  add('contact','trackEdge',torusGeometry(.0099,.0016,6,38));
  add('contact','contact',sphereGeometry(.0063,18,12));

  const parts=Array.from(batches,([key,data])=>({key,data:data.length===1?data[0]:mergeGeometries(data)}));
  return (engine,shadows)=>{
    const world=engine.createMesh();
    const frame=engine.createMesh().setPosition([0,centerY,0]).setParent(world);
    const addNode=()=>engine.createMesh().setParent(frame);
    const cam=addNode(),trace=addNode(),centroid=addNode();
    const contact=Array.from({length:4},addNode);
    const owners={world:[world],frame:[frame],cam:[cam],trace:[trace],centroid:[centroid],contact};
    const guides=[];
    const materials=new Map(Object.entries(finish).map(([name,value])=>[name,new Material(value)]));
    for(const {key,data} of parts) {
      const [group,name]=key.split(':');
      for(const owner of owners[group]) {
        const mesh=createMesh(engine,data,materials.get(name));
        mesh.root.name=group+' '+name;
        mesh.root.setParent(owner);
        if(group==='trace'||group==='centroid'||group==='contact') guides.push(mesh.root);
        else shadows.add(mesh,{static:group==='world'||group==='frame',castShadow:name!=='floor'&&name!=='scale'});
      }
    }
    return {
      pose({angle,center,contacts}) {
        cam.setPosition([center[0],center[1],0]).setRotation([0,0,angle]);
        centroid.setPosition([center[0],center[1],.1615]);
        contact.forEach((node,i)=>node.setPosition([...contacts[i],.111]));
      },
      show(value) { for(const mesh of guides) mesh.visible=value; },
    };
  };
}
