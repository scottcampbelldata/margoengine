import { Geometry, PbrMaterial } from '@margoengine/core';

const tau=Math.PI*2;
const shellProfile=[
  [-.109,.046],[-.104,.042],[-.051,.042],[-.047,.040],[.047,.040],[.051,.042],[.104,.042],[.109,.046],
  [.109,.070],[.105,.076],[.085,.076],[.080,.071],[.079,.063],[.068,.060],
  [-.068,.060],[-.079,.063],[-.080,.071],[-.085,.076],[-.105,.076],[-.109,.070],
];
const shaftProfile=[
  [-.158,0],[.158,0],[.158,.0105],[.154,.0144],[.115,.0144],[.111,.017],
  [.073,.017],[.069,.0215],[.043,.0215],[.039,.018],[.029,.018],[.026,.020],
  [-.026,.020],[-.029,.018],[-.039,.018],[-.043,.0215],[-.069,.0215],
  [-.073,.017],[-.111,.017],[-.115,.0144],[-.154,.0144],[-.158,.0105],
];
const metal=(color,roughness,metalness=1)=>new PbrMaterial({color,roughness,metalness});

export function turned(profile,sides=80,offset=[0,0],close=true){
  const positions=[],normals=[],indices=[];
  const steps=close?profile.length:profile.length-1;
  for(let j=0;j<steps;j++){
    const [x0,r0]=profile[j], [x1,r1]=profile[(j+1)%profile.length];
    if(r0===0&&r1===0)continue;
    const dx=x1-x0,dr=r1-r0,length=Math.hypot(dx,dr),base=positions.length/3;
    const nx=dr/length,nr=-dx/length;
    for(let i=0;i<sides;i++){
      const angle=tau*i/sides,y=Math.cos(angle),z=Math.sin(angle);
      positions.push(x0,offset[0]+r0*y,offset[1]+r0*z,x1,offset[0]+r1*y,offset[1]+r1*z);
      normals.push(nx,nr*y,nr*z,nx,nr*y,nr*z);
      const a=base+i*2,b=base+((i+1)%sides)*2;
      if(r1>0)indices.push(a,a+1,b+1);
      if(r0>0)indices.push(a,b+1,b);
    }
  }
  return {positions,normals,indices};
}

function annulus(x0,x1,inner,outer,bevel){
  return [[x0,inner+bevel],[x0+bevel,inner],[x1-bevel,inner],[x1,inner+bevel],
    [x1,outer-bevel],[x1-bevel,outer],[x0+bevel,outer],[x0,outer-bevel]];
}

function cord(x,center,radius){
  return Array.from({length:18},(_,i)=>{
    const a=i*tau/18;
    return [x+.78*radius*Math.cos(a),center+radius*Math.sin(a)];
  });
}

export function buildCartridge(engine){
  const parts=[], shapes=new Map();
  function add(name,p,m,sides,offset=[0,0]){
    let shape=shapes.get(p);
    if(!shape){
      const field=turned(p,sides);
      const geom=new Geometry(field.positions,field.normals,field.indices);
      const bounds=Array.from({length:3},(_,axis)=>{
        let low=Infinity,high=-Infinity;
        for(let i=axis;i<field.positions.length;i+=3){low=Math.min(low,field.positions[i]);high=Math.max(high,field.positions[i]);}
        return [low,high];
      });
      shape={geom,bounds};
      shapes.set(p,shape);
    }
    const origin=[0,...offset], {geom}=shape;
    const mesh=engine.createMesh().setGeometry(geom).setMaterial(m).setPosition(origin);
    const bounds=shape.bounds.map((range,i)=>range.map(value=>value+origin[i]));
    parts.push({name,mesh,geom,bounds,origin});
  }
  add('Anodized housing',shellProfile,metal('#285866',.34,0));
  add('Turned steel shaft',shaftProfile,metal('#aebfc2',.29));
  const yellow=metal('#bd8657',.39);
  const steel=metal('#a7aaa3',.30);
  const graphite=metal('#464949',.83,0);
  const ceramic=metal('#c6c9bd',.45,0);
  add('Central ceramic sleeve',annulus(-.046,.046,.023,.032,.0012),ceramic);
  add('Left bronze bushing',annulus(-.096,-.054,.019,.0414,.0012),yellow);
  add('Right bronze bushing',annulus(.054,.096,.019,.0414,.0012),yellow);
  add('Left retaining ring',annulus(-.114,-.098,.019,.044,.001),steel);
  add('Right retaining ring',annulus(.098,.114,.019,.044,.001),steel);
  add('Left radial seal',cord(-.041,.0364,.0041),graphite,60);
  add('Right radial seal',cord(.041,.0364,.0041),graphite,60);
  add('Inner spacer',annulus(-.031,.031,.0327,.037,.0008),yellow);
  const rightCap=[[.106,0],[.120,0],[.120,.0045],[.119,.0063],[.111,.0063],[.110,.0049],[.106,.0049]];
  const leftCap=rightCap.map(([x,r])=>[-x,r]).reverse();
  for(let i=0;i<6;i++){
    const angle=tau*(i+.5)/6;
    const offset=[.061*Math.cos(angle),.061*Math.sin(angle)];
    add('Retaining fastener',leftCap,steel,12,offset);
    add('Retaining fastener',rightCap,steel,12,offset);
  }

  // Open inlay strips receive the beauty cut and contribute no stencil winding.
  const inlay=metal('#42767e',.44,0);
  for(const x of [-.059,-.023,.023,.059]){
    const turn=turned([[x+.0015,.06055],[x-.0015,.06055]],80,[0,0],false);
    engine.createMesh().setGeometry(new Geometry(turn.positions,turn.normals,turn.indices)).setMaterial(inlay);
  }
  return parts;
}
