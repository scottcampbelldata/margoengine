const tau=Math.PI*2;
const clamp=(x,a=0,b=1)=>Math.min(b,Math.max(a,x));

export const sampleInfo={
  wax:{x:-.437,name:'Wax',radius:.015,profile:[1,.71,.43],amount:.76,about:'An amber beeswax form, thin at the ruffled rim.'},
  marble:{x:0,name:'Marble',radius:.009,profile:[1,.88,.73],amount:.49,about:'A carved marble cup, with a narrow field of mineral veining.'},
  jade:{x:.437,name:'Jade',radius:.011,profile:[.56,1,.72],amount:.86,about:'A nephrite study with a curved body and thin carved wings.'},
};

function interpolate(a,b,t){return a.map((x,i)=>x+(b[i]-x)*t);}

function ovalProfile(height,radial,count=22){
  return Array.from({length:count+1},(_,i)=>{
    const a=Math.PI*(i/count-.5);
    return [height*Math.sin(a),Math.max(.0002,radial*Math.cos(a))];
  });
}

function smoothed(profile,subdivisions){
  if(subdivisions===1)return profile;
  const end=profile.length-1;
  return Array.from({length:end*subdivisions+1},(_,index)=>{
    const s=index/subdivisions,lo=Math.min(end-1,Math.floor(s)),u=s-lo;
    const a=profile[Math.max(lo-1,0)],b=profile[lo],c=profile[lo+1],d=profile[Math.min(end,lo+2)];
    return b.map((value,i)=>{
      const p=a[i],q=c[i],r=d[i];
      const result=.5*((2*value)+(-p+q)*u+(2*p-5*value+4*q-r)*u*u+(-p+3*value-3*q+r)*u*u*u);
      return i===1?Math.max(.0002,result):result;
    });
  });
}

function lathe(coordinates,origin,opt={}){
  const profile=smoothed(coordinates,opt.subdivisions??1);
  const sides=opt.count??58,columns=sides+1,rows=profile.length;
  const positions=new Float32Array(rows*columns*3),normals=new Float32Array(positions.length);
  const uvs=new Float32Array(rows*columns*2),indices=new Uint32Array((rows-1)*sides*6);
  const ax=new Float64Array(columns),az=new Float64Array(columns),angles=new Float64Array(columns);
  for(let column=0;column<=sides;column++){
    const t=column%sides/sides*tau;
    angles[column]=t;ax[column]=Math.cos(t);az[column]=Math.sin(t);
  }
  for(let row=0;row<rows;row++){
    const v=row/(rows-1),[y,radius]=profile[row];
    for(let column=0;column<=sides;column++){
      const vertex=row*columns+column,i=vertex*3,t=angles[column];
      const r=radius*(opt.relief?.(t,v)??1);
      positions[i]=origin[0]+r*ax[column]+y*(opt.tilt??0);
      positions[i+1]=origin[1]+y+(opt.wave?.(t,v)??0);
      positions[i+2]=origin[2]+r*az[column]*(opt.flatten??1);
      uvs[vertex*2]=column/sides;
      uvs[vertex*2+1]=v;
    }
  }
  let index=0;
  for(let row=0;row<rows;row++)for(let column=0;column<=sides;column++){
    const vertex=row*columns+column,i=vertex*3;
    const low=(Math.max(0,row-1)*columns+column)*3,high=(Math.min(rows-1,row+1)*columns+column)*3;
    const left=(row*columns+(column+sides-1)%sides)*3,right=(row*columns+(column+1)%sides)*3;
    const dhx=positions[high]-positions[low],dhy=positions[high+1]-positions[low+1],dhz=positions[high+2]-positions[low+2];
    const dx=positions[right]-positions[left],dy=positions[right+1]-positions[left+1],dz=positions[right+2]-positions[left+2];
    const nx=dhy*dz-dhz*dy,ny=dhz*dx-dhx*dz,nz=dhx*dy-dhy*dx,inv=1/(Math.hypot(nx,ny,nz)||1);
    normals[i]=nx*inv;normals[i+1]=ny*inv;normals[i+2]=nz*inv;
    if(row<rows-1&&column<sides){
      const next=vertex+columns;
      indices[index++]=vertex;indices[index++]=next;indices[index++]=next+1;
      indices[index++]=vertex;indices[index++]=next+1;indices[index++]=vertex+1;
    }
  }
  return {positions,normals,uvs,indices};
}
export function waxGeometry(){
  const profile=[
    [.027,.0002],[.027,.071],[.030,.077],[.036,.081],[.049,.083],
    [.061,.080],[.087,.075],[.116,.074],[.148,.075],[.180,.078],
    [.208,.082],[.235,.088],[.256,.097],[.273,.104],[.281,.104],
    [.284,.097],[.277,.086],[.257,.074],[.237,.052],[.227,.028],[.226,.0002],
  ];
  return lathe(profile,[sampleInfo.wax.x,0,-.021],{
    count:100,flatten:.94,subdivisions:3,
    relief:(t,v)=>1+.058*Math.cos(t*9+v*1.12)+.019*Math.cos(t*17-v*3.1),
    wave:(t,v)=>.019*Math.sin(t*4-.34)*Math.pow(Math.sin(Math.PI*v),4)*Math.min(1,v*1.7),
  });
}

export function marbleGeometry(){
  const profile=[
    [.025,.0002],[.025,.049],[.029,.061],[.034,.065],[.044,.064],
    [.061,.047],[.096,.043],[.120,.053],[.143,.068],[.163,.09],
    [.184,.110],[.207,.125],[.227,.139],[.242,.145],[.252,.147],
    [.256,.142],[.251,.132],[.234,.126],[.215,.118],[.191,.100],
    [.175,.083],[.160,.066],[.153,.048],[.150,.027],[.150,.0002],
  ];
  return lathe(profile,[sampleInfo.marble.x,0,-.046],{
    count:110,subdivisions:3,
    relief:(t,v)=>1+.048*Math.cos(t*14+.81*Math.sin(v*tau*.71))*(.28+.72*Math.sin(v*Math.PI)),
    wave:(t,v)=>.0038*Math.sin(t*14)*Math.exp(-((v-.61)**2)/.041),
  });
}

export function jadeGeometry(){
  const x=sampleInfo.jade.x;
  const ellipse=(y,z,hy,rx,flat,opt={})=>lathe(ovalProfile(hy,rx),[x+(opt.x??0),y,z],{
    count:opt.count??48,flatten:flat,tilt:opt.tilt??0,relief:opt.relief,
  });
  const shape=[];
  shape.push({type:'nephrite',geometry:ellipse(.160,-.046,.113,.057,.65)});
  shape.push({type:'nephrite',geometry:ellipse(.252,-.032,.051,.061,.69,{relief:(t,v)=>1+.05*Math.cos(t*4)} )});
  for(const side of [-1,1]){
    const profile=[
      [.039,.0002],[.055,.011],[.079,.019],[.105,.028],[.137,.038],[.170,.042],
      [.196,.041],[.217,.034],[.231,.023],[.239,.009],[.241,.0002],
    ];
    const wingX=x+.018*side;
    const relief=(t,v)=>1+.035*Math.sin(t*7+2*v);
    const wave=(t,v)=>.004*Math.sin(t*5)*v*(1-v);
    shape.push({type:'nephrite',geometry:lathe(profile,[wingX,0,-.009],{
      count:53,flatten:.49,tilt:.091*side,relief,wave,
    })});
    const vein={positions:[],normals:[],uvs:[],indices:[]};
    for(let line=0;line<4;line++){
      const count=24,first=vein.positions.length/3;
      for(let k=0;k<=count;k++){
        const u=k/count,y=.067+u*(.153-line*.008),max=profile.findIndex(r=>r[0]>=y);
        const lo=profile[max-1],hi=profile[max],lerp=(y-lo[0])/(hi[0]-lo[0]);
        const rad=lo[1]+(hi[1]-lo[1])*lerp,v=(max-1+lerp)/(profile.length-1);
        const path=Math.PI*.5+side*(.09+line*.115+(.28-line*.081)*Math.sin(u*Math.PI*.92));
        for(const d of [-1,1]){
          const t=path+d*.027*(.33+Math.sin(Math.PI*u)*.67),r=rad*relief(t,v);
          const px=wingX+y*.091*side+r*Math.cos(t),pz=-.009+r*.49*Math.sin(t)+.00045;
          vein.positions.push(px,y+wave(t,v),pz);
          vein.normals.push(Math.cos(t)*.35,0,Math.sin(t));
          vein.uvs.push(u,0);
        }
        if(k){
          const a=first+(k-1)*2,b=a+2;
          vein.indices.push(a,a+1,b+1,a,b+1,b);
        }
      }
    }
    shape.push({type:'carve',geometry:vein});
    shape.push({type:'eyes',geometry:ellipse(.268,-.001,.017,.021,.57,{x:side*.047,count:28})});
  }
  return shape;
}

function texturePixels(width,height,pixel){
  const data=new Uint8Array(width*height*4);
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){
    const c=pixel(x/(width-1),y/(height-1));
    const i=(y*width+x)*4;
    for(let k=0;k<3;k++)data[i+k]=Math.round(clamp(c[k],0,255));
    data[i+3]=255;
  }
  return {data,width,height};
}

export function thicknessPixels(kind){
  return texturePixels(64,64,(u,v)=>{
    const around=.5+.5*Math.cos(tau*u);
    const ring=kind==='wax' ? .55+.20*Math.sin(Math.PI*v)-.43*Math.exp(-((v-.72)**2)/.019):
      kind==='marble' ? .76-.52*Math.exp(-((v-.61)**2)/.016):.38+.30*Math.sin(Math.PI*v)+.10*around;
    const value=255*clamp(ring,.09,.94);
    return [value,value,value];
  });
}

export function marblePixels(){
  return texturePixels(160,128,(u,v)=>{
    const q=v*5.6+Math.sin(tau*u)*.66+Math.sin(tau*u*2+v*14)*.28+Math.cos(tau*u*5-v*13)*.14;
    const vein=Math.exp(-((q-Math.round(q))**2)/.0065);
    const hair=Math.exp(-((q+.35-Math.round(q+.35))**2)/.0012);
    const grain=1.9*Math.sin(tau*u*19+v*91)*Math.cos(v*117-tau*u*22);
    const a=vein*.52+hair*.19;
    return interpolate([237+grain,227+grain,217+grain],[126,122,138],a);
  });
}

export function jadePixels(){
  return texturePixels(128,128,(u,v)=>{
    const w=.48+.24*Math.sin(tau*u*3-v*9.25)+.11*Math.sin(tau*u*9+v*19.6)+.065*Math.cos(tau*u*19-v*44.1);
    const striation=Math.pow(Math.abs(Math.sin(v*18+Math.sin(tau*u)*1.8)),16);
    return interpolate([47,99,74],[165,195,155],clamp(w-.17*striation));
  });
}
