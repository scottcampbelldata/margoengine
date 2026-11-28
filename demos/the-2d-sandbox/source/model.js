import {banks,crateSize,deck,opening,planks,shelves,shore,width} from './layout.js';

export function createModel(Physics2D){
  const physics=new Physics2D(null,{pixelsPerMeter:62,gravity:[0,650],fixedTimestep:1/60,maxSubsteps:7});
  physics.setSolver({substeps:4});
  const settings={density:.91,friction:.64,restitution:.085};
  const start=physics.addBody(null,{type:'fixed',position:[deck.start,deck.y],colliders:[]});
  const end=physics.addBody(null,{type:'fixed',position:[deck.end,deck.y],colliders:[]});
  for(const {p,w,h} of [...banks,...shelves])physics.addBody(null,{type:'fixed',position:p,colliders:{shape:'box',width:w,height:h,friction:.68}});
  for(const contour of shore)physics.addBody(null,{type:'fixed',colliders:{shape:'polygon',points:contour,friction:.68}});
  let timber=[],joints=[],crates=[],weights=[],number=0,events=0;
  physics.on('contactstart',()=>events++);
  function addCrate(x,y,theme){
    const index=number++;
    const paint=theme??index%4;
    const body=physics.addBody(null,{position:[x,y],rotation:0,
      colliders:{shape:'box',width:crateSize,height:crateSize,borderRadius:1.0,...settings}});
    const item={id:'crate-'+index,kind:'crate',paint,body};
    crates.push(item);
    return item;
  }
  function build(){
    for(const joint of joints)physics.removeJoint(joint);
    for(const piece of timber)piece.body.remove();
    timber=[];joints=[];
    let previous=start,anchor=[0,0];
    for(const {x,y,rotation,length} of planks()){
      const body=physics.addBody(null,{position:[x,y],rotation,colliders:{
        shape:'box',width:length,height:deck.thickness,friction:.70,density:1.30,
      }});
      joints.push(physics.addJoint(previous,body,{type:'revolute',anchorA:anchor,anchorB:[-length/2,0]}));
      anchor=[length/2,0];previous=body;
      timber.push({id:'plank-'+timber.length,kind:'plank',paint:timber.length%2,length,body});
    }
    joints.push(physics.addJoint(previous,end,{type:'revolute',anchorA:anchor,anchorB:[0,0]}));
  }
  function knock(){
    if(joints.length!==deck.planks+1)return;
    const pin=joints.pop();
    physics.removeJoint(pin);
    const index=number++;
    const body=physics.addBody(null,{position:[423,116],linearVelocity:[-38,70],ccd:true,
      colliders:{shape:'circle',radius:25,friction:.38,density:5.5,restitution:.17}});
    weights.push({id:'weight-'+index,kind:'weight',paint:0,body});
  }
  function step(){
    physics.step();
    const inBounds=item=>{
      const [x,y]=item.body.position;
      if(y<655&&x>-120&&x<width+120)return true;
      item.body.remove();
      return false;
    };
    crates=crates.filter(inBounds);
    weights=weights.filter(inBounds);
  }
  function items(){return [...timber,...crates,...weights];}
  function report(){
    const end=timber.at(-1)?.body.position;
    return {crates:crates.length,joints:joints.length,planks:timber.length,weights:weights.length,
      bridgeEnd:end?.[1]??0,events};
  }
  build();
  for(const {x,y,theme} of opening)addCrate(x,y,theme);
  return {step,items,addCrate,build,knock,report,dispose:()=>physics.dispose()};
}
