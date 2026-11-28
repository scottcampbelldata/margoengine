
import { Geometry,PbrMaterial,box } from '@margoengine/core';
const paint=(color,roughness=.72,metalness=0)=>new PbrMaterial({color,roughness,metalness});
const graphite=paint('#303940'),concrete=paint('#4c5a60'),steel=paint('#6e787e',.43,.48),
  bronze=paint('#b78556',.44,.54),rail=paint('#293640'),inset=paint('#202a32'),
  pavement=paint('#555c63'),paper=paint('#bdb1a0',.68);
const colors=['#69c2c6','#df955e','#d47991','#437caa'];
const tau=Math.PI*2;

function disk(radius,height,edge=radius*.02){
  const positions=[],normals=[],indices=[],sides=54;
  const rims=[[0,-height/2],[radius-edge,-height/2],[radius,-height/2+edge],
    [radius,height/2-edge],[radius-edge,height/2],[0,height/2]];
  for(let r=0;r<rims.length;r++){
    const [rad,y]=rims[r],lo=rims[Math.max(0,r-1)],hi=rims[Math.min(rims.length-1,r+1)];
    const a=hi[1]-lo[1],b=lo[0]-hi[0],length=Math.hypot(a,b)||1;
    for(let j=0;j<=sides;j++){
      const t=tau*j/sides,c=Math.cos(t),s=Math.sin(t);
      positions.push(rad*c,y,rad*s);normals.push(a*c/length,b/length,a*s/length);
      if(r&&j){
        const d=r*(sides+1)+j,c=d-1,b=d-sides-1,a=b-1;
        indices.push(a,c,d,a,d,b);
      }
    }
  }
  return new Geometry(positions,normals,indices);
}
export function installStaging(engine){
  const fixture=engine.createMesh(),smoke=[],glazes=[],opaque=[];
  const station=(shape,material,where,parent=undefined)=>{
    const item=engine.createMesh().setGeometry(shape).setMaterial(material).setPosition(where);
    if(parent)item.setParent(parent);
    opaque.push(item);return item;
  };
  const block=(material,extent,where,parent)=>station(box(...extent),material,where,parent);
  block(pavement,[14,.20,12],[0,-.132,0]);
  block(graphite,[15,6,.16],[0,2.85,-5.04]);
  block(inset,[.15,6,10],[-6.65,2.85,.05]);
  block(rail,[15,.32,.36],[0,3.89,-4.86]);
  for(let i=-5;i<=5;i++){
    const x=.98*i;
    block(concrete,[.77,4.75,.08],[x,2.36,-4.88]);
    block(rail,[.042,4.78,.052],[x+.401,2.36,-4.85]);
  }
  block(graphite,[8.9,.21,.365],[0,4.07,-1.2]);
  for(let i=-2;i<=2;i++){
    const x=i*1.36;
    block(rail,[.31,.51,.13],[x,3.84,-1.23]);
    block(paper,[.022,.23,.16],[x+.158,3.69,-1.23]);
  }
  const plate=disk(1.37,.16,.021);
  station(disk(1.31,.29),rail,[0,.135,0],fixture);
  station(plate,graphite,[0,.31,0],fixture);
  station(disk(1.29,.042,.010),bronze,[0,.399,0],fixture);
  station(disk(1.26,.095,.012),inset,[0,.46,0],fixture);
  for(let i=0;i<13;i++){
    const s=(i-6)*.163;
    block(steel,[.019,.027,.13],[s,.519,.93],fixture);
  }
  const panes=[
    {position:[-.39,1.45,.01],rotation:[.10,.63,.15],width:1.36,height:1.82,alpha:.35,color:0},
    {position:[.22,1.44,-.30],rotation:[-.17,-.56,-.22],width:1.38,height:1.76,alpha:.40,color:1},
    {position:[.04,1.60,.28],rotation:[.22,.21,.34],width:1.36,height:1.68,alpha:.27,color:2},
    {position:[-.23,1.72,-.12],rotation:[-.43,.72,-.43],width:1.18,height:1.61,alpha:.25,color:3}
  ];
  for(const pane of panes){
    const support=engine.createMesh().setParent(fixture).setPosition(pane.position).setRotation(pane.rotation);
    const edge=paint(colors[pane.color],.29,.37);
    for(const side of [-1,1]){
      block(edge,[.021,pane.height*.84,.038],[side*pane.width*.492,0,0],support);
      block(edge,[pane.width*.88,.021,.039],[0,side*pane.height*.493,0],support);
    }
    glazes.push({anchor:support,width:pane.width,height:pane.height,opacity:pane.alpha,color:colors[pane.color]});
  }
  const draws=[
    [-.58,1.15,.46,1.81,.28,0],[-.23,1.55,-.06,1.53,-.57,1],[.33,1.08,.14,1.82,.34,3],
    [.10,1.83,.28,1.35,-.57,2],[.61,1.42,-.50,1.65,.46,1],[-.13,1.04,-.44,1.92,.61,0],
    [.35,1.73,.40,1.16,-.18,2],[.15,1.49,.59,1.13,.18,0]
  ];
  for(const [x,y,z,size,yaw,color] of draws){
    const anchor=engine.createMesh().setParent(fixture).setPosition([x,y,z]).setRotation([0,yaw,0]);
    smoke.push({anchor,width:size,height:size*.9,opacity:.76,color:colors[color]});
  }
  return {fixture,glazes,smoke,opaque};
}
