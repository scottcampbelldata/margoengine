import { createMesh, Material, MatcapMaterial } from '@margoengine/materials';
import { board, box, brass, contour, leather, merge, move, pin, sweep, turn, walnut } from './craft.js';
import { angleAt, gap, intake, nozzle, response } from './pump.js';

export const bedY = .066;
const intakeHeight = .024;
const vertex = (angle,[x,y,z]) => [x*Math.cos(angle)-y*Math.sin(angle),bedY+gap+x*Math.sin(angle)+y*Math.cos(angle),z];
const port = [intake[0],intakeHeight,intake[2]];
const calm = [0,-20,0];

function cradle(add,mats) {
  add(sweep(),mats.sweep,'Warm workshop cyclorama and grounded shadows','floor');
  add(box(.925,.034,.458,.015,[.080,.013,0]),mats.base,'Deeply stained oak exhibit bench','static');
  add(box(.905,.011,.438,.006,[.080,.032,0]),mats.liner,'Recessed petrol-grey bench insert','static');
  const brass=[];
  const dark=[];
  const numbers=[];
  for(const x of [-.285,.454]){
    for(const z of [-.171,.171]){
      brass.push(pin(.015,.0041,[x,.038,z],22));
      dark.push(box(.017,.0016,.0015,.0006,[x,.0402,z],.23));
      dark.push(pin(.028,.009,[x,-.007,z],20));
    }
  }
  brass.push(box(.150,.004,.044,.006,[-.229,.039,.174]));
  dark.push(box(.126,.0012,.00125,.00049,[-.230,.04135,.177]));
  for(let i=0;i<12;i++){
    const size=i%3===0?.009:.0055;
    numbers.push(box(.0018,.001, size,.00042,[-.286+i*.0104,.04135,.174-size/2]));
  }
  const foot=[];
  for(const x of [.067,.326]){
    foot.push(box(.064,.014,.199,.003,[x,.047,0]));
    for(const z of [-.068,.068])foot.push(pin(.022,.014,[x,.053,z],18));
  }
  add(merge(foot),mats.dark,'Sculpted iron cradles supporting the lower board','static');
  add(merge(brass),mats.brass,'Flush brass corner fasteners and scale plate');
  add(merge(dark),mats.dark,'Screw slots and recessed floor glides','static');
  add(merge(numbers),mats.dark,'Stamped witness lines on the mounting rail');
}

function join(add,mats) {
  const hinge=[];
  hinge.push(box(.073,.030,.112,.010,[.007,bedY+.016,0]));
  for(const z of [-.048,.048]){
    hinge.push(turn([[.0101,-.016],[.0101,.008],[.012,.008],[.012,.016],[0,.016]],[.030,bedY+gap,z],0,22));
  }
  hinge.push(box(.047,.012,.018,.004,[.021,bedY+.028,-.061]));
  hinge.push(box(.047,.012,.018,.004,[.021,bedY+.028,.061]));
  add(merge(hinge),mats.dark,'Gunmetal offset hinge and fixed horn block','static');
  const rivets=[];
  for(const z of [-.041,.041]){
    rivets.push(pin(.0058,.0025,[.043,bedY+.032,z],14));
  }
  add(merge(rivets),mats.brass,'Nickel hinge screw caps');
}

function tacks(y) {
  const dark=[];
  const brass=[];
  const points=contour(1.018);
  const collar=pin(.0051,.0017,[0,0,0],12);
  const head=pin(.00345,.00192,[0,0,0],14);
  for(let i=1;i<points.length;i+=2){
    const [x,z]=points[i];
    dark.push(move(collar,[x,y-.0006,z]));
    brass.push(move(head,[x,y+.00043,z]));
  }
  return {dark,brass};
}

function handles(up) {
  const y=up?.008:-.008;
  return [
    box(.215,.022,.055,.009,[.479,y,0]),
    box(.088,.025,.065,.011,[.560,y,0]),
    box(.055,.016,.038,.007,[.383,y,0]),
  ];
}

function fixedBoard(add,mats) {
  const at=(shape)=>move(shape,[0,bedY,0]);
  const edge=at(board(-.002,.002,false,1.034));
  add(at(merge([board(-.020,0,false),...handles(false)])),mats.wood,'Shaped lower walnut paddle and rounded grip','static');
  add(edge,mats.edge,'Lower leather seam with moulded wood lip','static');
  const attachment=tacks(.0011);
  add(at(merge(attachment.dark)),mats.dark,'Lower fastener trim');
  add(at(merge(attachment.brass)),mats.brass,'Lower burnished leather tacks');
}

function liftBoard(add,mats) {
  const objects=[];
  const mount=(shape,material,name)=>{
    const mesh=add(shape,material,name);
    objects.push(mesh);
    return mesh;
  };
  mount(merge([board(0,.019,true),...handles(true)]),mats.wood,'Hinged upper walnut paddle');
  const attachment=tacks(.0199);
  mount(merge(attachment.dark),mats.dark,'Blackened recesses around tack heads');
  mount(merge(attachment.brass),mats.brass,'Individually placed brass tacks');
  const [x,,z]=port;
  const finish=turn([[.0218,.0187],[.0317,.0187],[.0334,.0205],[.0336,.0234],
    [.0315,.025],[.0234,.025],[.0218,.0238],[.0218,.0187]],[x,0,z],0,40);
  mount(finish,mats.brass,'Machined intake port collar');
  const dark=[];
  const gold=[];
  for(let i=0;i<6;i++){
    const a=i*Math.PI/3;
    const px=x+.0285*Math.sin(a),pz=z+.0285*Math.cos(a);
    dark.push(pin(.003,.0009,[px,.0256,pz],12));
    gold.push(box(.0037,.001,.0008,.00033,[px,.0262,pz],.13));
  }
  dark.push(box(.006,.007,.034,.0015,[x-.018,.0145,z]));
  mount(merge(dark),mats.dark,'Recessed inlet screws and reed hinge');
  mount(merge(gold),mats.brass,'Intake mounting screw slots');
  mount(box(.019,.0042,.033,.0015,[.586,.0201,0]),mats.brass,'Brass strap on the handle end');
  const reed=add(move(pin(.0208,.0022,[0,0,0],26),[.018,0,0]),mats.reed,'Inward-opening leather intake flap');
  return (angle,opening)=>{
    for(const {root} of objects){
      root.setPosition([0,bedY+gap,0]);
      root.setRotation([0,0,angle]);
    }
    reed.root.setPosition(vertex(angle,[x-.018,.0093,z]));
    reed.root.setRotation([0,0,angle-opening*.71]);
  };
}

function outlet(add,mats) {
  const center=[.029,bedY+nozzle[1],0];
  const stem=turn([[.019,0],[.035,0],[.043,.013],[.042,.037],[.031,.060],
    [.023,.163],[.018,.242],[.0174,.257],[.0127,.257],[.0121,.248],[.0121,.087],[.016,.035],[.019,0]],
    center,Math.PI/2,48);
  add(stem,mats.brass,'Formed brass discharge horn with open bore','static');
  add(turn([[.0405,.021],[.0433,.021],[.0452,.025],[.0452,.035],[.0419,.039]],
    center,Math.PI/2,42),mats.dark,'Blackened nozzle neck collar','static');
  add(turn([[.0182,.230],[.0200,.235],[.0205,.241],[.0193,.247],[.0173,.251]],
    center,Math.PI/2,42),mats.dark,'Outlet circlip and rolled edge');
  const hingeX=-.220;
  const hingeY=center[1]+.012;
  const spool=[];
  spool.push(box(.016,.0049,.025,.002,[hingeX,hingeY+.0041,0]));
  spool.push(box(.017,.0087,.0084,.002,[hingeX,hingeY-.002,.012]));
  spool.push(box(.017,.0087,.0084,.002,[hingeX,hingeY-.002,-.012]));
  add(merge(spool),mats.brass,'Nozzle check valve external hinge');
  const flap=add(move(pin(.0120,.0014,[0,0,0],24),[0,-.0116,0],Math.PI/2),
    mats.reed,'Outward-opening discharge reed');
  return opening=>{
    flap.root.setPosition([hingeX,hingeY,0]);
    flap.root.setRotation([0,0,-1.27*opening]);
  };
}

function flowArrow(){
  return merge([
    turn([[.0017,-.014],[.0017,.007],[0,.007]],[0,0,0],-Math.PI/2,8),
    turn([[0,.004],[.0044,.004],[.0002,.016]],[0,0,0],-Math.PI/2,10),
  ]);
}

function airflow(add,mats) {
  const shape=flowArrow();
  const streams=Array.from({length:9},()=>add(shape,mats.breathe,'Directional air trace above the active valve'));
  return (model,time)=>{
    const intake=model.intake>=.055;
    const flow=intake?model.intake:model.outlet;
    for(const [i,mesh] of streams.entries()){
      if(flow<.055){mesh.root.setPosition(calm);continue;}
      const desired=intake?mats.breathe:mats.blast;
      if(mesh.material!==desired)mesh.material=desired;
      if(intake) {
        const u=(time*.64+i*.194)%1;
        const z=(i%3-1)*(.044-.032*u);
        const reach=.188*(1-u);
        mesh.root.setPosition(vertex(model.angle,[port[0]-.032*(1-u)**2,port[1]+.009+reach,port[2]+z]));
        mesh.root.setRotation([0,0,model.angle-Math.PI/2]);
      } else {
        const u=(time*.80+i*.167)%1;
        const z=(i%3-1)*(.008+.029*u);
        const offset=(i%2?1:-1)*(.002+.008*u);
        mesh.root.setPosition([nozzle[0]-.008-.189*u,bedY+nozzle[1]+offset,z]);
        mesh.root.setRotation([0,0,Math.PI]);
      }
      const size=(intake?.61:.63)+(intake?.39:.42)*Math.min(1,flow/9);
      mesh.root.setScale([size,size,size]);
    }
  };
}

export function buildBellows(engine,shadows,initial) {
  const wood=walnut();
  const metal=brass();
  const mats={
    sweep:new Material({color:'#e4ded4',roughness:.91}),
    base:new Material({color:'#56463f',roughness:.62}),
    liner:new Material({color:'#3d5053',roughness:.67}),
    dark:new Material({color:'#45474b',roughness:.59}),
    wood:new Material({color:'#e8d4bb',map:wood,roughness:.41}),
    edge:new Material({color:'#70453d',roughness:.67}),
    leather:new Material({color:'#6b444a',roughness:.71}),
    reed:new Material({color:'#875149',roughness:.54}),
    brass:new MatcapMaterial({color:'#eee3cc',matcap:metal}),
    breathe:new Material({shading:'basic',color:'#83e3dc'}),
    blast:new Material({shading:'basic',color:'#f1bc77'}),
  };
  const owned=[];
  const add=(geometry,mat,name,role)=>{
    const mesh=createMesh(engine,geometry,mat);
    mesh.root.name=name;
    owned.push(mesh);
    if(role==='static')shadows.add(mesh,{static:true});
    if(role==='floor')shadows.add(mesh,{static:true,castShadow:false});
    return mesh;
  };
  cradle(add,mats);
  join(add,mats);
  fixedBoard(add,mats);
  const swing=liftBoard(add,mats);
  const reed=outlet(add,mats);
  const markers=airflow(add,mats);
  const flex=add(leather(angleAt(initial),initial),mats.leather,'Four rounded full-circumference leather folds');
  flex.root.setPosition([0,bedY,0]);
  let pose=initial;
  let current=response(initial,0);
  function update(lift,model,airTime){
    if(lift!==pose){
      flex.setGeometry(leather(model.angle,lift));
      pose=lift;
    }
    current=model;
    swing(model.angle,Math.min(1,model.intake/7));
    reed(Math.min(1,model.outlet/7));
    markers(model,airTime);
  }
  update(initial,current,0);
  return {
    update,
    anchors(){return [vertex(current.angle,[port[0]+.032,port[1]+.046,port[2]]),[nozzle[0]-.046,bedY+nozzle[1]+.029,.013]];},
    dispose(){for(const mesh of owned.reverse())mesh.dispose();for(const mat of Object.values(mats))mat.dispose();wood.dispose();metal.dispose();},
  };
}