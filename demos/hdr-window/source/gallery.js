import { Geometry, PbrMaterial, box } from '@margoengine/core';

const unit=box(1,1,1);
const mat=(color,roughness,metalness=0)=>new PbrMaterial({color,roughness,metalness,doubleSided:false});
const charcoal=mat('#363e45',.78), plaster=mat('#c2a589',.77), floor=mat('#766b5c',.55);
const smokedTimber=mat('#625244',.57), timberEnd=mat('#836a57',.51), ceiling=mat('#777172',.87);
const warmDark=mat('#50443a',.82), dyedFelt=mat('#695b50',.80);
const seam=mat('#37332d',.88), graphite=mat('#363b42',.54), lacquer=mat('#e6ccae',.22);
const pale=mat('#beafa1',.50), chrome=mat('#a8b4c1',.062,1), brushed=mat('#8a97a2',.26,1);
const copper=mat('#b6916d',.27,1), blackRubber=mat('#333840',.82);
const red=mat('#ce5638',.24), fern=mat('#69aa50',.33);
const pi=Math.PI;
const from=(a,b,t)=>a+(b-a)*t;

function revolution(profile,segments,limit=2*pi,start=0){
  const vertices=[],normals=[],indices=[];
  for(let j=0;j<profile.length;j++){
    const [radius,y]=profile[j],previous=profile[Math.max(0,j-1)],next=profile[Math.min(j+1,profile.length-1)];
    const dr=next[0]-previous[0],dy=next[1]-previous[1],inv=1/Math.hypot(dr,dy);
    for(let i=0;i<=segments;i++){
      const a=start+limit*i/segments,c=Math.cos(a),s=Math.sin(a);
      vertices.push(radius*c,y,radius*s);
      normals.push(dy*inv*c,-dr*inv,dy*inv*s);
      if(i>0&&j>0){
        const k=j*(segments+1)+i,b=k-(segments+1);
        indices.push(b-1,k-1,b,b,k-1,k);
      }
    }
  }
  return new Geometry(vertices,normals,indices);
}

function track(radius,start,length,size){
  const vertices=[],normals=[],indices=[],segments=Math.ceil(Math.abs(length)*24),sides=14;
  for(let i=0;i<=segments;i++){
    const a=from(start,start+length,i/segments),ca=Math.cos(a),sa=Math.sin(a);
    for(let j=0;j<=sides;j++){
      const b=j*2*pi/sides,c=Math.cos(b),s=Math.sin(b),r=radius+size*c;
      vertices.push(r*ca,r*sa,size*s);
      normals.push(c*ca,c*sa,s);
      if(i>0&&j>0){
        const k=i*(sides+1)+j,v=k-sides-1;
        indices.push(v-1,k-1,v,v,k-1,k);
      }
    }
  }
  return new Geometry(vertices,normals,indices);
}

export function gallery(engine){
  function mesh(name,geometry,material,position=[0,0,0],scale=[1,1,1],rotation=[0,0,0]){
    const part=engine.createMesh();
    part.name=name;
    return part.setGeometry(geometry).setMaterial(material).setPosition(position).setScale(scale).setRotation(rotation);
  }
  const block=(name,material,x,y,z,w,h,d)=>mesh(name,unit,material,[x,y,z],[w,h,d]);
  const lathe=(name,material,profile,origin,divisions=80)=>mesh(name,revolution(profile,divisions),material,origin);

  block('Polished basalt gallery floor',floor,0,-.115,.6,14,.23,16);
  for(let n=-5;n<=5;n++){
    block('Recessed floor joint',seam,n*1.65,.001,.3,.012,.002,15);
    block('Transverse floor cut',seam,0,.002,n*1.65,14,.001,.012);
  }
  block('Continuous acoustic ceiling',ceiling,0,4.044,.285,11.7,.24,10.0);
  for(let n=0;n<9;n++){
    const x=-4.83+n*1.18;
    block('Ceiling longitudinal joint',warmDark,x,3.914,.4,.013,.019,9.2);
  }
  block('Oiled walnut west display panel',smokedTimber,-4.178,1.31,.69,.077,2.62,7.21);
  for(let n=0;n<9;n++){
    const z=-1.625+.605*n;
    block('Display panel seam',warmDark,-4.125,1.340,z,.04,2.586,.012);
    block('Grain-matched timber edge',timberEnd,-4.131,1.35,z+.008,.029,2.586,.013);
  }
  block('Felt optics case',dyedFelt,-4.07,1.90,-1.48,.31,1.03,1.02);
  block('Flush optics label plate',brushed,-3.90,1.48,-1.55,.024,.046,.52);
  block('Upper aperture wall',plaster,-.05,3.70,-3.45,10,.47,.87);
  block('Basalt window seat',graphite,-.05,.365,-3.37,10,.71,1.13);
  block('East precast return',plaster,2.63,1.85,-3.45,.72,3.70,.87);
  block('West structural wall',plaster,-3.73,1.85,-3.45,1.02,3.70,.87);
  block('West observation wall',charcoal,-4.35,1.95,1.05,.27,3.90,9.7);
  block('East column and edge shadow',charcoal,3.55,1.95,-2.97,.64,3.9,.70);
  block('Upper steel cap',graphite,-.275,3.415,-2.968,5.18,.045,.081);
  block('Window gasket and sill edge',charcoal,-.275,.73,-2.775,5.18,.035,.107);
  block('Lower ventilation plane',charcoal,1.53,.34,-2.74,1.51,.42,.06);
  for(let i=0;i<13;i++)block('Vent blade',brushed,1.53,.16+i*.029,-2.695,1.44,.010,.045);
  for(let i=0;i<6;i++){
    const x=-3.09+i*.92;
    block('Tall turned window mullion',charcoal,x,2.073,-3.822,.038,2.686,.073);
    block('Mullion edge',copper,x+.012,2.073,-3.786,.008,2.685,.012);
  }
  block('Façade centre transom',charcoal,-.25,2.81,-3.822,5.88,.046,.070);
  block('Brushed metal sill trim',copper,-.35,.723,-2.79,5.65,.035,.062);
  block('Far structural jamb',plaster,4.17,1.98,-4.14,.37,3.97,2);
  block('West rail',brushed,-4.14,1.28,.42,.032,.025,7.23);

  lathe('Basalt exhibition drum',graphite,[
    [.02,.003],[.868,.003],[.883,.017],[.885,.079],[.846,.096],[.846,.809],
    [.865,.825],[.865,.954],[.856,.969],[.020,.969],
  ],[0,0,.03]);
  lathe('Honed warm limestone cap',pale,[
    [.015,.950],[.850,.950],[.881,.962],[.884,1.016],[.870,1.034],[.025,1.034],
  ],[0,0,.03]);
  lathe('Cap bronze inlay',copper,[
    [.879,.979],[.885,.982],[.886,.994],[.880,.995],
  ],[0,0,.03]);
  lathe('Sculpture mount',blackRubber,[
    [.021,1.033],[.351,1.033],[.359,1.044],[.358,1.073],[.332,1.078],[.01,1.078],
  ],[0,0,.03]);
  lathe('Machined suspension collar',brushed,[
    [.010,1.078],[.258,1.078],[.266,1.097],[.257,1.154],[.198,1.192],[.01,1.192],
  ],[0,0,.03]);

  const focal=[-.06,1.798,.038];
  const profiles=[];
  for(let j=0;j<=54;j++){
    const a=-pi*.5+pi*j/54,r=Math.max(.003,.654*Math.cos(a));
    const y=.626*Math.sin(a);
    profiles.push([r*(1+.009*Math.cos(a*7)),y]);
  }
  const pearl=revolution(profiles,100);
  mesh('Pearl glazed optical body',pearl,lacquer,focal,[1,1,.94]);
  for(let i=0;i<3;i++){
    const relativeY=-.189-.045*i;
    const a=Math.asin(relativeY/.626);
    const radius=.654*Math.cos(a)*(1+.009*Math.cos(a*7));
    const trimProfile=[[radius+.004,relativeY-.007],[radius+.009,relativeY-.004],
      [radius+.009,relativeY+.004],[radius+.004,relativeY+.007]];
    mesh('Metallic slip line '+i,revolution(trimProfile,100),brushed,focal,[1,1,.94]);
  }
  const ringAngles=[.26,-.21,-.51];
  const bands=[
    ['Outer magnesium orbit',.800,.15,pi*1.61,.041,chrome],
    ['Copper calibration arc',.796,pi*1.82,pi*.145,.035,copper],
    ['Inner steel guide',.708,pi*.985,pi*.69,.022,brushed],
    ['Ceramic collar enamel',.660,pi*.04,pi*.76,.016,red],
    ['Green ceramic enamel',.667,pi*.79,pi*.19,.017,fern],
  ];
  for(const [name,radius,start,span,tube,material] of bands){
    mesh(name,track(radius,start,span,tube),material,focal,[1,1,1],ringAngles);
  }
  const screws=revolution([[.001,-.009],[.024,-.009],[.027,-.004],[.026,.005],[.021,.009],[.001,.009]],18);
  for(let i=0;i<5;i++){
    const angle=pi*(.77+i*.075);
    mesh('Orbit fastener with chamfer',screws,brushed,
      [focal[0]+Math.cos(angle)*.706,focal[1]+Math.sin(angle)*.687,focal[2]+.147],[1,1,1],[pi/2,0,0]);
  }
  lathe('Calibrated polished sample',chrome,revolutionProfile(.177,26),[.55,1.213,.393],56);
  lathe('Sample keeper',blackRubber,[[.002,1.034],[.194,1.034],[.196,1.048],[.186,1.053],[.002,1.053]],[.55,0,.393]);
  block('Exhibit label holder',graphite,-.54,1.042,.463,.245,.016,.081);
  block('Brushed exhibit plate',copper,-.54,1.054,.463,.225,.009,.075);
  for(let i=0;i<6;i++)block('Inset plate score',seam,-.648+i*.039,1.059,.467,.016,.001,.013);
}

function revolutionProfile(radius,steps){
  return Array.from({length:steps+1},(_,j)=>{
    const a=-pi*.5+pi*j/steps;
    return [Math.max(.001,radius*Math.cos(a)),radius*Math.sin(a)];
  });
}
