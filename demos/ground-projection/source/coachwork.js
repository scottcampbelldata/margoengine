const tau=2*Math.PI;
const materials=[];
const make=(name,color,metallicFactor,roughnessFactor,emissiveFactor)=>{
  const index=materials.length;
  materials.push({name,doubleSided:true,pbrMetallicRoughness:{baseColorFactor:[...color,1],metallicFactor,roughnessFactor},
    ...(emissiveFactor?{emissiveFactor}:{})});
  return index;
};
const paint=make('Glazed copper', [.64,.141,.041],.62,.27);
const lip=make('Bronze panel edge',[.22,.044,.024],.55,.34);
const fascia=make('Carbon ceramic trim',[.026,.035,.039],.22,.53);
const glass=make('Ink laminate',[.042,.064,.079],.57,.20);
const rubber=make('Graphite tire',[.034,.037,.042],0,.88);
const metal=make('Satin machined alloy',[.43,.45,.47],.84,.31);
const ring=make('Burnished copper accent',[.49,.176,.065],.79,.32);
const light=make('Ice white headlamp',[.40,.61,.77],.19,.24,[.55,.79,1]);
const red=make('Ruby rear light',[.57,.035,.017],.12,.28,[.44,.014,.004]);

const storage=materials.map(()=>({positions:[],normals:[],indices:[]}));
const blend=(a,b,t)=>a+(b-a)*t;
const squeeze=(v,a,b)=>Math.max(a,Math.min(b,v));
function curve(keys,x,axis){
  let i=0;
  while(i<keys.length-2&&x>keys[i+1][0])i++;
  const a=keys[i],b=keys[i+1],before=keys[Math.max(0,i-1)],after=keys[Math.min(keys.length-1,i+2)];
  const dt=b[0]-a[0],t=squeeze((x-a[0])/dt,0,1),sq=t*t,cube=sq*t;
  const slopeA=(b[axis]-before[axis])/(b[0]-before[0]),slopeB=(after[axis]-a[axis])/(after[0]-a[0]);
  return a[axis]*(2*cube-3*sq+1)+b[axis]*(-2*cube+3*sq)+dt*(slopeA*(cube-2*sq+t)+slopeB*(cube-sq));
}
function patch(material,cols,rows,point,flip=false){
  const {positions,normals,indices}=storage[material],offset=positions.length/3;
  const step=.00013;
  for(let y=0;y<=rows;y++)for(let x=0;x<=cols;x++){
    const u=x/cols,v=y/rows,a=point(u,v);
    const au=point(Math.max(0,u-step),v),bu=point(Math.min(1,u+step),v);
    const av=point(u,Math.max(0,v-step)),bv=point(u,Math.min(1,v+step));
    const q=bu.map((value,i)=>value-au[i]),r=bv.map((value,i)=>value-av[i]);
    const n=[q[1]*r[2]-q[2]*r[1],q[2]*r[0]-q[0]*r[2],q[0]*r[1]-q[1]*r[0]];
    const l=Math.hypot(...n),s=flip?-1:1;
    positions.push(...a);
    normals.push(...(l>1e-14?n.map(value=>value*s/l):[0,1,0]));
    if(x&&y){
      const d=offset+y*(cols+1)+x,c=d-1,b=d-cols-1,a=b-1;
      if(flip)indices.push(a,c,b,b,c,d);
      else indices.push(a,b,c,b,d,c);
    }
  }
}
function block(material,center,extent,yaw=0){
  const [rx,ry,rz]=extent.map(x=>x*.5),c=Math.cos(yaw),s=Math.sin(yaw);
  for(let face=0;face<6;face++){
    const axis=Math.floor(face/2),sign=face%2?1:-1;
    patch(material,1,1,(u,v)=>{
      const unit=[0,0,0];
      unit[axis]=sign;
      unit[(axis+1)%3]=u*2-1;
      unit[(axis+2)%3]=(v*2-1)*sign;
      const [x,y,z]=unit.map((q,i)=>q*[rx,ry,rz][i]);
      return [c*x+s*z+center[0],y+center[1],c*z-s*x+center[2]];
    });
  }
}
const body=[[-2.29,.568,.582,.48],[-2.11,.832,.668,.602],[-1.57,.966,.842,.803],
 [-1.23,.988,.871,.840],[-.55,.954,.865,.755],[.11,.918,.850,.697],[.76,.926,.896,.740],
 [1.42,.993,.942,.868],[1.86,.954,.871,.793],[2.10,.873,.730,.646],[2.22,.711,.633,.551]];
const hoodTop=(x,t)=>curve(body,x,2)-Math.abs(t)**2.55*(curve(body,x,2)-curve(body,x,3));
const width=x=>curve(body,x,1);
const archive=[-1.47,1.47];
function sill(x){
  const d=Math.min(...archive.map(c=>Math.abs(x-c)));
  const ar=.419;
  if(d<ar)return .340+Math.sqrt(ar*ar-d*d);
  return .228+Math.max(0,.11*(1-(d-ar)/.073));
}
const minx=body[0][0],maxx=body.at(-1)[0];
patch(paint,112,24,(u,v)=>{
  const x=blend(minx,maxx,u),t=2*v-1,w=width(x);
  return [x,hoodTop(x,t),t*w];
},true);
for(const side of [-1,1]){
  patch(paint,140,9,(u,v)=>{
    const x=blend(minx,maxx,u),top=curve(body,x,3),low=Math.min(top-.009,sill(x));
    const z=width(x)-.105*v**2+.032*Math.sin(Math.PI*v);
    return [x,blend(top,low,v),side*z];
  },side<0);
  patch(fascia,110,4,(u,v)=>{
    const x=blend(minx,maxx,u),w=width(x),y=Math.min(curve(body,x,3)-.012,sill(x))-.008;
    return [x,y-.040*v,side*(w-.104-.095*v)];
  },side>0);
  patch(lip,42,2,(u,v)=>{
    const x=blend(-.98,1.04,u),top=curve(body,x,3),lower=Math.min(top-.01,sill(x));
    return [x,blend(top,lower,.625)+.012*v,side*(width(x)-.014)];
  },side<0);
  block(fascia,[.27,.743,side*.943],[.247,.036,.047]);
  block(metal,[.295,.754,side*.956],[.118,.021,.047]);
  block(fascia,[-.588,1.037,side*.841],[.153,.047,.097],-.19*side);
  block(paint,[-.638,1.067,side*.889],[.223,.081,.133],-.23*side);
}
for(const [x,flip] of [[minx,true],[maxx,false]]){
  patch(paint,23,6,(u,v)=>{
    const t=2*u-1;
    return [x,blend(hoodTop(x,t),.270,v),width(x)*t*(1-.089*v)];
  },flip);
  block(fascia,[x+(flip?-.005:.005),.302,0],[.057,.11,1.13]);
}
block(fascia,[minx-.019,.422,0],[.052,.105,.94]);
for(let i=0;i<13;i++)block(metal,[minx-.048,.409,-.422+i*.07],[.012,.045,.012]);
block(metal,[minx-.022,.365,0],[.032,.022,1.01]);
block(fascia,[maxx+.025,.441,0],[.044,.100,1.31]);
for(let i=0;i<9;i++)block(metal,[maxx+.054,.322,-.380+i*.095],[.012,.052,.012]);
const cabin=[[-.92,.862,.635],[-.62,1.133,.652],[-.32,1.328,.662],
 [.10,1.364,.680],[.49,1.337,.661],[.8,1.264,.599],[1.16,1.111,.526],[1.53,.922,.466]];
function greenhouse(x,t){
  const hood=hoodTop(x,.46),upper=curve(cabin,x,1);
  const z=curve(cabin,x,2)*(t+.068*t**3);
  const y=hood+(upper-hood)*(1-.845*Math.abs(t)**2.52);
  return [x,y,z];
}
for(const [start,end,m] of [[-.92,-.405,glass],[-.405,.74,paint],[.74,1.53,glass]]){
  patch(m,38,21,(u,v)=>greenhouse(blend(start,end,u),blend(-.7,.7,v)),true);
}
for(const side of [-1,1]){
  patch(glass,48,10,(u,v)=>greenhouse(blend(-.884,1.506,u),side*blend(.690,.991,v)),side>0);
  patch(lip,49,3,(u,v)=>greenhouse(blend(-.895,1.516,u),side*blend(.972,1.022,v)),side>0);
  for(const [a,b] of [[-.502,-.447],[.24,.299],[.765,.82]]){
    patch(paint,7,9,(u,v)=>{
      const p=greenhouse(blend(a,b,u),side*blend(.694,1.008,v));
      p[1]+=.012;p[2]+=.008*side;
      return p;
    },side>0);
  }
  patch(paint,40,3,(u,v)=>{
    const p=greenhouse(blend(-.444,.763,u),side*blend(.65,.71,v));
    p[1]+=.009;
    return p;
  },side>0);
}
for(const side of [-1,1]){
  patch(light,25,4,(u,v)=>{
    const x=blend(-2.24,-1.83,u),t=side*(.76+(.17-.07*u)*(v-.49));
    return [x,hoodTop(x,t)+.009,t*width(x)];
  },true);
}
patch(red,40,3,(u,v)=>{
  const t=2*u-1,x=maxx+.008+.007*(1-t*t);
  return [x,.565+.005*t*t-.040*v,t*.683];
},true);
function wheel(cx,side){
  const cy=.351,cz=.861*side;
  function turned(material,rings){
    for(let k=1;k<rings.length;k++){
      const a=rings[k-1],b=rings[k];
      patch(material,44,1,(u,v)=>{
        const t=tau*u,r=blend(a[0],b[0],v),z=blend(a[1],b[1],v);
        return [cx+r*Math.cos(t),cy+r*Math.sin(t),cz+side*z];
      },side<0);
    }
  }
  turned(rubber,[[.274,-.133],[.319,-.134],[.349,-.101],[.351,.073],[.335,.119],[.295,.138],[.254,.136]]);
  turned(metal,[[.253,.143],[.250,.159],[.225,.164],[.213,.154],[.215,.139]]);
  turned(fascia,[[.233,.124],[0,.128]]);
  turned(ring,[[.176,.141],[.125,.142],[.118,.133]]);
  turned(metal,[[.075,.154],[.060,.175],[0,.176]]);
  for(let k=0;k<10;k++){
    const t=tau*k/10;
    patch(k%5===0?ring:metal,8,3,(u,v)=>{
      const r=blend(.051,.238,u),a=t+.17*u+(v-.5)*blend(.26,.12,u);
      return [cx+r*Math.cos(a),cy+r*Math.sin(a),cz+side*(.151+.017*Math.sin(Math.PI*u))];
    },side<0);
  }
}
for(const cx of archive)for(const side of [-1,1])wheel(cx,side);

export function buildAster(){
  const views=[],accessors=[],buffers=[],primitives=[];
  let byteLength=0;
  function store(values,target,format,count,min,max,stride,normalized=false){
    const pad=(4-byteLength%4)%4;
    if(pad){buffers.push(new Uint8Array(pad));byteLength+=pad;}
    views.push({buffer:0,byteOffset:byteLength,byteLength:values.byteLength,target,...(stride?{byteStride:stride}:{})});
    buffers.push(new Uint8Array(values.buffer,values.byteOffset,values.byteLength));
    byteLength+=values.byteLength;
    const item={bufferView:views.length-1,componentType:format,type:target===34963?'SCALAR':'VEC3',count,...(normalized?{normalized:true}:{})};
    if(min){item.min=min;item.max=max;}
    accessors.push(item);
    return accessors.length-1;
  }
  for(const [material,g] of storage.entries()){
    if(!g.indices.length)continue;
    const count=g.positions.length/3,min=[Infinity,Infinity,Infinity],max=[-Infinity,-Infinity,-Infinity];
    for(let i=0;i<g.positions.length;i++){
      const c=i%3;min[c]=Math.min(min[c],g.positions[i]);max[c]=Math.max(max[c],g.positions[i]);
    }
    const positions=new Int16Array(count*4),normals=new Int8Array(count*4),units=10000;
    for(let i=0;i<count;i++)for(let axis=0;axis<3;axis++){
      positions[i*4+axis]=Math.round(g.positions[i*3+axis]*units);
      normals[i*4+axis]=Math.round(g.normals[i*3+axis]*127);
    }
    const POSITION=store(positions,34962,5122,count,min.map(x=>Math.round(x*units)),max.map(x=>Math.round(x*units)),8);
    const NORMAL=store(normals,34962,5120,count,undefined,undefined,4,true);
    const indices=store(Uint16Array.from(g.indices),34963,5123,g.indices.length);
    primitives.push({attributes:{POSITION,NORMAL},indices,material});
  }

  const dictionary={asset:{version:'2.0',generator:'Margo Aster coachwork generator'},
    extensionsUsed:['KHR_mesh_quantization'],extensionsRequired:['KHR_mesh_quantization'],
    scene:0,scenes:[{nodes:[0]}],nodes:[{name:'Aster GT',mesh:0,scale:[.0001,.0001,.0001]}],
    meshes:[{primitives}],materials,accessors,bufferViews:views,buffers:[{byteLength}]};
  const encoded=new TextEncoder().encode(JSON.stringify(dictionary));
  const jsonPad=(4-encoded.length%4)%4,binPad=(4-byteLength%4)%4;
  const jsonSize=encoded.length+jsonPad,binSize=byteLength+binPad;
  const bytes=new ArrayBuffer(28+jsonSize+binSize),view=new DataView(bytes),dst=new Uint8Array(bytes);
  for(const [offset,value] of [[0,0x46546c67],[4,2],[8,bytes.byteLength],[12,jsonSize],[16,0x4e4f534a],
    [20+jsonSize,binSize],[24+jsonSize,0x004e4942]])view.setUint32(offset,value,true);
  dst.set(encoded,20);
  dst.fill(32,20+encoded.length,20+jsonSize);
  let cursor=28+jsonSize;
  for(const buffer of buffers){dst.set(buffer,cursor);cursor+=buffer.byteLength;}
  return bytes;
}

export function buildSurfaceBatches(){
  return storage.map(({positions,normals,indices},i)=>({positions:Float32Array.from(positions),normals:Float32Array.from(normals),
    indices:Uint16Array.from(indices),surface:materials[i].pbrMetallicRoughness,emission:materials[i].emissiveFactor??[0,0,0]}));
}
