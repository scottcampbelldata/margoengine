import {Geometry,PbrMaterial,box} from '@margoengine/core';
import {roundedBoxGeometry} from '@margoengine/geometry/extras';

const pi=Math.PI,tau=pi*2;
const palette={
  salt:'#c7c6b3',lime:'#a3aaa2',rail:'#3c5659',ink:'#182a35',iron:'#475d64',teal:'#537b81',
  glass:'#b4c6ac',darkGlass:'#729891',gold:'#c09853',oldGold:'#927044',copper:'#9c553e',light:'#ebbe71',
  wood:'#6f6252',paint:'#536477',undercut:'#747973',slate:'#535c60',rock:'#4f5d5c',sand:'#827e67',
  warm:'#d9c99b',sea:'#337080',seaDark:'#3b6573',seaLight:'#739994',whitecap:'#a3bcb4',
};
const unit=box(1,1,1);
function rounded(width,height,depth,radius){
  const {positions,normals,indices}=roundedBoxGeometry(width,height,depth,2,radius);
  return new Geometry(positions,normals,indices);
}
function plate(profile,segments=56,forward=false){
  const p=[],n=[],ix=[];
  for(let row=0;row<profile.length;row++){
    const [r,h]=profile[row];
    const from=profile[Math.max(0,row-1)],to=profile[Math.min(profile.length-1,row+1)];
    const dh=to[1]-from[1],dr=to[0]-from[0],length=Math.hypot(dh,dr)||1;
    for(let k=0;k<=segments;k++){
      const phi=tau*k/segments,c=Math.cos(phi),s=Math.sin(phi);
      if(forward){p.push(r*c,r*s,h);n.push(-c*dh/length,-s*dh/length,dr/length);}
      else{p.push(r*c,h,r*s);n.push(c*dh/length,-dr/length,s*dh/length);}
      if(row+1<profile.length&&k<segments){
        const a=row*(segments+1)+k,b=a+segments+1;
        if(forward)ix.push(a,b,a+1,a+1,b,b+1);else ix.push(a,b,a+1,a+1,b,b+1);
      }
    }
  }
  return new Geometry(p,n,ix);
}
function landscape(sizes,seed,peak){
  const P=[],N=[],T=[],sides=34;
  for(const [row,[r,y]] of sizes.entries()){
    for(let j=0;j<=sides;j++){
      const a=tau*j/sides,c=Math.cos(a),s=Math.sin(a);
      const k=1+.16*Math.sin(3*a+seed)+.11*Math.cos(6*a-seed)+.05*Math.sin(15*a);
      const rise=.33*Math.sin(a*4+seed)+.28*Math.cos(a*7);
      P.push(r*c*k,y+rise*peak,r*s*k*.62);
      N.push(c*.61,.71,s*.61);
      if(row+1<sizes.length&&j<sides){
        const i=row*(sides+1)+j;T.push(i,i+sides+1,i+1,i+1,i+sides+1,i+sides+2);
      }
    }
  }
  return new Geometry(P,N,T);
}
function waveField(){
  const rows=[[],[],[]];
  for(let i=0;i<275;i++){
    const a=((Math.imul(i+14,1460893)>>>9)%10009)/10009;
    const b=((Math.imul(i+221,943439709)>>>8)%69031)/69031;
    const x=(a-.5)*96,z=(b-.5)*96-2;
    const rise=.027+((i*53)%31)*.0026,length=.44+((i*59)%63)*.073;
    const r=rows[i%3];
    r.push([x,z,rise,length]);
  }
  return rows.map((marks,index)=>{
    const p=[],n=[],indices=[];
    for(const [x,z,w,length] of marks){
      const a=p.length/3;
      p.push(x,-13.525,z,x+length*.72,-13.526,z-.08,x+length,-13.525,z,x+length*.31,-13.524,z+w);
      n.push(0,1,0,0,1,0,0,1,0,0,1,0);indices.push(a,a+2,a+1,a,a+3,a+2);
    }
    return new Geometry(p,n,indices);
  });
}
function cloudBand(center,span,depth,index){
  const p=[],n=[],tri=[];
  const samples=33;
  for(let i=0;i<samples;i++){
    const x=i/(samples-1),fall=Math.sin(Math.PI*x)**.60,a=x*span-span/2;
    const ridge=(Math.sin(x*24+index)+.44*Math.sin(x*57+index*.3))*.47;
    const scale=fall*(1.24+.54*Math.sin(x*11+index));
    p.push(a,center+ridge*fall-scale,depth,a,center+ridge*fall+scale*.54,depth);
    n.push(0,.17,.986,0,.17,.986);
    if(i+1<samples){
      const j=i*2;tri.push(j,j+2,j+1,j+1,j+2,j+3);
    }
  }
  return new Geometry(p,n,tri);
}
function shaft(){
  const points=[],normals=[],faces=[];
  for(let i=0;i<990;i++){
    const u=((Math.imul(i+27,5157993)>>>9)%16691)/16691;
    const t=((Math.imul(i+123,9416973)>>>10)%25903)/25903;
    const w=((Math.imul(i+30,1959637)>>>9)%20521)/20521;
    const z=.45+22*u,r=(.085+.63*u)*Math.sqrt(t),a=tau*w;
    const size=(.024+.047*u)*(1-.56*u),x=Math.cos(a)*r,y=Math.sin(a)*r;
    const at=points.length/3;
    points.push(x-size,y-size,z,x+size,y-size,z,x,y+size,z);
    normals.push(0,.57,.82,0,.57,.82,0,.57,.82);faces.push(at,at+1,at+2);
  }
  return new Geometry(points,normals,faces);
}
function mirrorStrip(){
  const p=[],n=[],indices=[];
  for(let j=0;j<38;j++){
    const k=j/37,z=2.8+26*k,width=.36+4*k;
    const widthHere=width*(.33+.66*Math.sin(j*6.23)**2);
    const x=(.26+.23*k)*Math.sin(j*1.62);
    const a=p.length/3,d=.046+.08*k;
    p.push(-widthHere+x,-13.509,z,widthHere+x,-13.509,z+.07,widthHere*.68-x,-13.509,z+d,-widthHere*.7-x,-13.509,z+d);
    n.push(0,1,0,0,1,0,0,1,0,0,1,0);indices.push(a,a+2,a+1,a,a+3,a+2);
  }
  return new Geometry(p,n,indices);
}
export function makeSet(engine){
  const pool=new Map();
  const surface=(name,roughness=.66,metalness=0)=>{
    const color=palette[name]??name,key=[color,roughness,metalness].join('/');
    if(!pool.has(key))pool.set(key,new PbrMaterial({color,roughness,metalness}));
    return pool.get(key);
  };
  const mesh=(shape,color,position=[0,0,0],spec={})=>
    engine.createMesh(spec.parent).setGeometry(shape).setMaterial(surface(color,spec.rough,spec.metal)).setPosition(position);
  const rect=(color,position,scale,spec)=>mesh(unit,color,position,spec).setScale(scale);
  const round=rounded(.82,.25,.52,.027);
  const turntable=engine.createMesh().setPosition([-.28,.94,-.57]);

  mesh(plate([[0,-.52],[2.78,-.52],[2.78,-.29],[2.66,-.22],[0,-.21]],84),'rail');
  mesh(plate([[0,-.212],[2.62,-.212],[2.62,-.151],[2.59,-.113],[0,-.110]],84),'ink');
  for(let k=0;k<22;k++){
    const x=(k-10.5)*.224,half=Math.sqrt(Math.max(.1,2.53**2-x*x));
    rect(k%5===0?'wood':k%4===0?'slate':'undercut',[x,-.080,0],[.219,.038,half*2]);
  }
  mesh(plate([[2.48,-.060],[2.55,-.062],[2.59,-.044],[2.60,-.025],[2.48,-.025]],80),'iron');
  const uprights=[];
  for(let k=0;k<12;k++){
    const a=k*tau/12,x=Math.cos(a)*2.51,z=Math.sin(a)*2.51;
    const column=rect('rail',[x,1.46,z],[.114,3.04,.128]);
    column.rotation.y=-a;
    const cleat=rect('oldGold',[x,.80,z],[.128,.105,.143]);
    cleat.rotation.y=-a;
    const upper=rect('rail',[x,2.93,z],[.15,.15,.152]);
    upper.rotation.y=-a;
    uprights.push([column,cleat,upper]);
  }
  const roof=mesh(plate([[2.72,2.94],[2.66,3.08],[2.43,3.27],[1.99,3.66],[1.49,3.96],[.86,4.15],[.34,4.25],[.3,4.36],[0,4.40]],72),'ink');
  const rim=mesh(plate([[2.69,3.01],[2.75,3.00],[2.75,3.085],[2.62,3.09]],72),'iron');
  mesh(plate([[.28,4.24],[.22,4.40],[.19,4.54],[.072,4.66],[0,4.72]],28),'copper');
  mesh(plate([[1.86,-15.7],[1.83,-13.2],[1.74,-10.0],[1.64,-7.5],[1.57,-4.8],[1.47,-.53]],84),'salt');
  for(const [y,r,height] of [[-14.6,1.86,.13],[-11.1,1.79,.20],[-7.2,1.64,.18],[-3.5,1.54,.14],[-.55,1.52,.14]]){
    mesh(plate([[r,y],[r+.07,y+.008],[r+.07,y+height],[r,y+height+.018]],64),'lime');
  }
  for(const [y,angle] of [[-12.03,.36],[-8.4,1.13],[-4.72,-.12],[-1.9,1.52]]){
    const r=1.87-((y+15.7)/15.2)*.41;
    const x=Math.sin(angle)*r,z=Math.cos(angle)*r;
    const frame=rect('lime',[x,y,z],[.39,.72,.050]);
    frame.rotation.y=angle;
    const aperture=rect('ink',[x+Math.sin(angle)*.031,y,z+Math.cos(angle)*.031],[.25,.57,.022]);
    aperture.rotation.y=angle;
    const rail=rect('teal',[x+Math.sin(angle)*.051,y-.113,z+Math.cos(angle)*.051],[.25,.035,.013]);
    rail.rotation.y=angle;
  }
  mesh(landscape([[8.1,-14.12],[6.3,-13.45],[4.8,-12.47],[2.7,-12.33],[.05,-12.28]],2.3,1),'rock',[.45,0,-.22]);
  mesh(landscape([[5.9,-13.35],[4.1,-12.85],[2.2,-12.55],[.12,-12.48]],.14,.45),'slate',[2.1,0,-.39]).setScale([1,.995,.95]);
  mesh(landscape([[3.7,-13.7],[2.6,-13.15],[.04,-13.06]],3.18,.44),'sand',[-5.73,0,2.84]);
  rect('sea',[0,-13.61,-5],[420,.15,396]);
  const cloudLayers=[
    mesh(cloudBand(-6.3,180,-70,4),'#93a7af',[-24,0,0]),
    mesh(cloudBand(-2.9,183,-77,6),'#9aaeb3',[-12,0,0]),
    mesh(cloudBand(.2,141,-71,1),'#a9b4b2',[-19,0,0]),
    mesh(cloudBand(5.6,110,-61,9),'#90a8b6',[-26,0,0]),
    mesh(cloudBand(8.1,154,-76,13),'#a8b7bc',[-21,0,0]),
  ];
  for(let i=0;i<14;i++){
    const a=2*pi*i/14, r=4.18+.64*Math.sin(i*2.9);
    const j=i%3,base=-13.32+.25*Math.sin(a*4);
    mesh(landscape([[1.25,base-.51],[1.08,base+.03],[.69,base+.49],[.08,base+.73]],i*2.20,.44),
      ['rock','undercut','slate'][j],[r*Math.cos(a),0,r*Math.sin(a)*.61]).setScale([1.26,1,1]);
  }
  for(const [i,shape] of waveField().entries())mesh(shape,['seaDark','seaLight','whitecap'][i]);

  const opticalMount={parent:turntable,rough:.32,metal:.49};
  mesh(plate([[.62,-.20],[.70,-.18],[.728,-.137],[.695,-.08],[.65,-.073]],72,true),'oldGold',[0,0,0],opticalMount);
  mesh(plate([[.08,-.166],[.24,-.157],[.54,-.14],[.62,-.123],[.67,-.09]],72,true),'darkGlass',[0,0,0],{parent:turntable,rough:.29,metal:.13});
  for(let i=0;i<15;i++){
    const r=.116+i*.036,depth=.102-.36*r*r;
    const shade=['glass','darkGlass','glass','teal','glass'][i%5];
    mesh(plate([[r-.014,depth-.024],[r-.012,depth+.011],[r+.004,depth+.026],[r+.017,depth-.014]],64,true),
      shade,[0,0,0],{parent:turntable,rough:.22+(i%3)*.036,metal:.12});
  }
  mesh(plate([[0,.124],[.079,.141],[.106,.072]],28,true),'warm',[0,0,0],{parent:turntable,rough:.23,metal:.12});
  const lantern=mesh(plate([[.048,-.28],[.182,-.24],[.283,-.21],[.386,-.19],[.44,-.166]],44,true),
    'warm',[0,0,0],{parent:turntable,rough:.40});
  for(let i=0;i<8;i++){
    const a=i*tau/8;
    const tab=rect('gold',[Math.sin(a)*.675,Math.cos(a)*.675,-.065],[.038,.099,.056],opticalMount);
    tab.rotation.z=-a;
  }
  mesh(plate([[.44,-.088],[.47,-.033],[.48,.028],[.438,.071],[.393,.093]],56),'oldGold',[-.28,.07,-.57],{rough:.41,metal:.42});
  mesh(plate([[.288,.090],[.309,.236],[.215,.310],[.238,.411]],48),'iron',[-.28,.075,-.57],{rough:.44,metal:.30});
  mesh(plate([[.273,.524],[.315,.541],[.315,.597],[.259,.625]],42),'gold',[-.28,.02,-.57],{rough:.41,metal:.48});
  rect('iron',[-1.24,.16,-.68],[.061,.48,1.2]);
  for(let i=0;i<6;i++)rect(i%3===0?'oldGold':'rail',[-1.22,.299-i*.056,-.67],[.050,.026,1.17]);

  rect('iron',[1.49,.466,.36],[.83,.76,.576]);
  mesh(round,'rail',[1.49,.944,.36]);
  const switchPlate=rect('paint',[1.50,1.104,.47],[.57,.078,.311]);
  switchPlate.rotation.x=-.27;
  for(let i=0;i<4;i++)rect(i===0?'light':'ink',[1.34+i*.101,1.144,.458],[.051,.022,.036]);
  for(const [x,z] of [[1.15,.139],[1.81,.139],[1.15,.64],[1.81,.64]])rect('ink',[x,.261,z],[.051,.45,.048]);
  rect('ink',[1.74,1.199,.277],[.031,.214,.036]);
  rect('iron',[1.74,1.312,.30],[.073,.035,.086]);
  const reflection=mesh(mirrorStrip(),'light');
  const spill=new PbrMaterial({color:'#c8ae67',roughness:.83});
  reflection.setMaterial(spill);
  const ray=mesh(shaft(),'warm',[-.28,.94,-.57]);
  const rayFinish=new PbrMaterial({color:'#d6bc81',roughness:.85});
  ray.setMaterial(rayFinish);
  const quartz=new PbrMaterial({color:'#c5bb86',roughness:.21,metalness:.11});
  lantern.setMaterial(quartz);
  cloudLayers.forEach((mesh,index)=>{mesh.name='Haze band '+(index+1);});
  const range=new Set([0,1,2,3,10,11]);
  return {
    draw({outside,sweep,power,wind}){
      turntable.rotation.y=sweep;
      ray.rotation.y=sweep;
      ray.visible=outside&&power>.75;
      rayFinish.set({color:[.52+.30*power,.43+.23*power,.24+.09*power]});
      reflection.rotation.y=sweep;
      reflection.visible=outside&&power>.24;
      spill.set({color:[.369+.24*power,.307+.27*power,.142+.06*power]});
      quartz.set({color:[.47+.38*power,.43+.30*power,.20+.14*power]});
      roof.visible=outside;
      rim.visible=outside;
      for(const [index,nodes] of uprights.entries())for(const n of nodes)n.visible=outside||!range.has(index);
      engine.scene.background=outside?'#748b9a':'#83969d';
      engine.lighting.direction.set([-.44,.64,.62,2.99+.40*power]);
      engine.lighting.radiance.set([1,.79+.045*wind,.62+.05*wind,.20]);
      engine.lighting.ambient.set(outside?[.49,.57,.71]:[.61,.68,.74]);
    }
  };
}
