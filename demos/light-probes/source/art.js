import {Geometry,PbrMaterial} from '@margoengine/core';

export const radius=.435,railTop=.034,xLimit=2.25,zTrack=.486;
const tau=Math.PI*2;

function surfaces(){
  const positions=[],normals=[],indices=[];
  return {
    tri(a,b,c,shared){
      const i=positions.length/3;
      positions.push(...a,...b,...c);
      if(shared){normals.push(...shared);}
      else{
        const ux=b[0]-a[0],uy=b[1]-a[1],uz=b[2]-a[2],vx=c[0]-a[0],vy=c[1]-a[1],vz=c[2]-a[2];
        const nx=uy*vz-uz*vy,ny=uz*vx-ux*vz,nz=ux*vy-uy*vx,len=Math.hypot(nx,ny,nz)||1;
        for(let n=0;n<3;n++)normals.push(nx/len,ny/len,nz/len);
      }
      indices.push(i,i+1,i+2);
    },
    quad(a,b,c,d){this.tri(a,b,c);this.tri(a,c,d);},
    finish(){return new Geometry(positions,normals,indices);},
  };
}

function beveled(g,x,y,z,w,h,d,r){
  const px=w*.5,py=h*.5,pz=d*.5,b=Math.min(r,px*.5,py*.5,pz*.5);
  const ring=(Y,a,c,cut)=>[
    [x-a+cut,Y,z+c],[x+a-cut,Y,z+c],[x+a,Y,z+c-cut],[x+a,Y,z-c+cut],
    [x+a-cut,Y,z-c],[x-a+cut,Y,z-c],[x-a,Y,z-c+cut],[x-a,Y,z+c-cut],
  ];
  const rings=[ring(y-py,px-b,pz-b,b*.35),ring(y-py+b,px,pz,b),ring(y+py-b,px,pz,b),ring(y+py,px-b,pz-b,b*.35)];
  for(let row=0;row<3;row++)for(let k=0;k<8;k++){
    const j=(k+1)%8;
    g.quad(rings[row][k],rings[row][j],rings[row+1][j],rings[row+1][k]);
  }
  for(let j=1;j<7;j++){
    g.tri(rings[0][0],rings[0][j+1],rings[0][j]);
    g.tri(rings[3][0],rings[3][j],rings[3][j+1]);
  }
}

function ring(g,x,base,z,r,w,depth){
  const steps=38;
  const point=(i,r,d)=>[x+r*Math.cos(i*Math.PI/steps),base+r*Math.sin(i*Math.PI/steps),z+d];
  for(let i=0;i<steps;i++){
    const ro=r+w, j=i+1;
    g.quad(point(i,r,depth/2),point(i,ro,depth/2),point(j,ro,depth/2),point(j,r,depth/2));
    g.quad(point(j,r,-depth/2),point(j,ro,-depth/2),point(i,ro,-depth/2),point(i,r,-depth/2));
    g.quad(point(i,r,-depth/2),point(i,r,depth/2),point(j,r,depth/2),point(j,r,-depth/2));
    g.quad(point(j,ro,-depth/2),point(j,ro,depth/2),point(i,ro,depth/2),point(i,ro,-depth/2));
  }
}

const materials={
  floor:['#656157',.82,0],slate:['#323839',.82,0],char:['#242e32',.75,0],gantry:['#303b3b',.78,0],
  brass:['#bd9d64',.50,.72],light:['#e9dfca',.63,0],ivory:['#aca28b',.80,0],
  amber:['#b0583d',.78,0],amberDeep:['#724538',.86,0],amberLight:['#e2a063',.80,0],
  green:['#4e9782',.78,0],greenDeep:['#316959',.85,0],greenLight:['#93bf91',.80,0],
  blue:['#4375a6',.76,0],blueDeep:['#2d4c73',.84,0],blueLight:['#9baed9',.76,0],
  tileA:['#746d5e',.82,0],tileB:['#77705f',.86,0],tileC:['#646053',.85,0],
};

export function buildArchitecture(){
  const all=new Map();
  const mat=name=>{
    if(!all.has(name))all.set(name,surfaces());
    return all.get(name);
  };
  const B=(name,x,y,z,w,h,d,edge=.018)=>beveled(mat(name),x,y,z,w,h,d,edge);
  B('floor',0,-.147,-.15,7.13,.25,4.65,.028);
  for(let k=0;k<8;k++)for(let j=0;j<4;j++){
    const x=(k-3.5)*.865+(j%2)*.22,z=-1.55+j*.89,n=['tileA','tileB','tileC'][(k*9+j*5)%3];
    B(n,x,-.025,z,.854,.038,.88,.006);
  }
  B('char',0,1.57,-1.921,7.2,3.16,.23,.01);
  B('ivory',0,.141,-1.714,7.16,.26,.19);
  B('gantry',-3.44,1.52,-.18,.20,3.07,3.51);
  B('gantry',3.44,1.52,-.18,.20,3.07,3.51);
  B('char',0,3.17,-.61,7.17,.252,2.93,.061);
  B('brass',0,2.98,.800,6.91,.056,.16,.018);
  B('light',0,2.957,.800,6.71,.014,.136,.009);
  B('brass',0,2.926,-1.57,6.77,.024,.063,.01);
  for(const x of [-3.30,-1.103,1.103,3.30]){
    B('gantry',x,1.42,-.49,.083,2.65,2.10,.014);
    B('ivory',x,1.417,.567,.122,2.69,.085,.026);
    B('brass',x,1.417,.617,.028,2.58,.016,.006);
  }
  for(let room=0;room<3;room++){
    const x=(room-1)*2.205,color=['amber','green','blue'][room],deep=color+'Deep',high=color+'Light';
    B(deep,x,1.57,-1.769,2.14,2.84,.084);
    B(color,x,1.53,-1.666,1.86,2.53,.16,.034);
    for(const side of [-1,1]){
      const sx=x+side*.949;
      B(high,sx,1.20,-1.504,.090,1.86,.124,.018);
      B(deep,sx+side*.088,1.25,-.966,.145,2.0,.877,.026);
      B(color,sx+side*.046,1.25,-.945,.056,1.84,.831,.012);
      for(let n=0;n<3;n++)B(high,sx+side*.013,1.212,-1.19+n*.178,.021,1.65,.025,.005);
    }
    ring(mat(high),x,1.625,-1.501,.833,.123,.135);
    ring(mat(deep),x,1.625,-1.412,.958,.051,.083);
    for(let n=0;n<6;n++){
      const col=x-.656+n*.262;
      B(n%2===0?color:high,col,1.164,-1.570,.096,1.58,.046,.015);
      B(deep,col-.060,1.217,-1.585,.017,1.62,.023,.005);
    }
    B('slate',x,.095,-1.226,1.77,.167,.858,.033);
    B(high,x,.187,-1.241,1.63,.029,.778,.012);
    B('ivory',x,2.643,-.732,1.42,.039,.218,.01);
    B('light',x,2.613,-.722,1.32,.027,.177,.008);
    // Colored return panels are real room geometry on the forward floor and ceiling.
    // Their larger solid angle lights the camera-facing parts of the sphere as it rolls past.
    B(color,x,-.004,1.440,2.13,.030,1.056,.011);
    B(high,x,.011,1.487,2.01,.006,.779,.002);
    B(deep,x,.019,1.919,1.99,.007,.027,.002);
    B(deep,x,2.962,1.314,2.131,.144,1.078,.024);
    B(high,x,2.885,1.314,2.001,.030,.981,.014);
  }
  B('slate',0,-.016,zTrack,6.18,.095,.944,.024);
  B('char',0,.016,zTrack,6.04,.036,.715,.016);
  for(const z of [zTrack-.295,zTrack+.295])B('brass',0,.028,z,5.956,.012,.021,.004);
  for(let n=-24;n<=24;n++){
    const x=n*.108;
    B(n%5===0?'light':'ivory',x,.035,zTrack+.344,.007,.0015,n%5===0 ? .051 : .027,.0003);
  }
  for(const x of [-2.83,2.83])B('brass',x,.054,zTrack,.038,.066,.593,.008);
  return Array.from(all,([name,geo])=>{
    const [color,roughness,metalness]=materials[name];
    return {geometry:geo.finish(),material:new PbrMaterial({color,roughness,metalness,doubleSided:false})};
  });
}

function ballGeometry(){
  const sides=108,steps=80,vertices=[],normals=[],indices=[];
  for(let j=0;j<=steps;j++){
    const turn=Math.PI*j/steps,sy=Math.cos(turn),b=Math.sin(turn);
    for(let i=0;i<=sides;i++){
      const a=tau*(i%sides)/sides,x=b*Math.cos(a),z=b*Math.sin(a);
      vertices.push(x*radius,sy*radius,z*radius);
      normals.push(x,sy,z);
      if(j<steps&&i<sides){
        const q=j*(sides+1)+i,r=q+sides+1;
        if(j>0)indices.push(q,q+1,r+1);
        if(j+1<steps)indices.push(q,r+1,r);
      }
    }
  }
  return new Geometry(vertices,normals,indices);
}

function inlay(){
  const pos=[],norm=[],ind=[],s=190,angles=[-.64,.19,.74];
  for(const base of angles){
    for(let i=0;i<=s;i++){
      const t=tau*i/s;
      for(const side of [-1,1]){
        const lat=base+side*.014,rad=radius+.0006,px=Math.cos(lat)*Math.cos(t),py=Math.sin(lat),pz=Math.cos(lat)*Math.sin(t);
        pos.push(rad*px,rad*py,rad*pz);
        norm.push(px,py,pz);
      }
      if(i){
        const n=pos.length/3-2;
        ind.push(n-2,n-1,n+1,n-2,n+1,n);
      }
    }
  }
  return new Geometry(pos,norm,ind);
}

export function buildSphere(engine){
  const parent=engine.createMesh();
  const main=new PbrMaterial({color:'#d5d2c6',roughness:.124,metalness:.63,doubleSided:true});
  const ribbon=new PbrMaterial({color:'#78594a',roughness:.39,metalness:.56,doubleSided:true});
  const globe=engine.createMesh(parent).setGeometry(ballGeometry()).setMaterial(main);
  const bands=engine.createMesh(parent).setGeometry(inlay()).setMaterial(ribbon);
  return {
    setPosition(x){
      parent.setPosition([x,radius+railTop,zTrack]);
      parent.setRotation([0,0,-x/radius]);
    },
    setSatin(value){main.set({roughness:value ? .52 : .124});},
    hide(value){globe.visible=!value;bands.visible=!value;},
  };
}
