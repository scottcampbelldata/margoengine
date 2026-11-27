import { Animation } from '@margoengine/animation';
import { cloneModel } from '@margoengine/animation/skeleton-utils';
import { Animator } from '@margoengine/animator';
import { addFullBodyIK } from '@margoengine/animator/fbik';
import { palettes } from './palettes.js';

const dot=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
const divide=(v,n)=>v.map(value=>value/n);
const point=node=>[node.matrix[12],node.matrix[13],node.matrix[14]];
const span=(a,b)=>Math.hypot(a[0]-b[0],a[1]-b[1],a[2]-b[2]);

function twist(axis,radians,q){
  const s=Math.sin(radians*.5),w=Math.cos(radians*.5);
  const [x,y,z]=axis.map(v=>s*v),[a,b,c,d]=q;
  return [w*a+x*d+y*c-z*b,w*b-x*c+y*d+z*a,w*c+x*b-y*a+z*d,w*d-x*a-y*b-z*c];
}

function buildActor(model,agent,palette,index,startingYaw){
  const {coat,skin,size}=palette;
  const materials=model.asset.doc.materials;
  for(const primitive of model.primitives){
    const name=materials[primitive.definition.material]?.name ?? '';
    const tint=name.includes('jacket')?coat:name.endsWith('.body')?skin:null;
    if(!tint)continue;
    const {base}=primitive.material;
    primitive.material={...primitive.material,base:[base[0]*tint[0],base[1]*tint[1],base[2]*tint[2],base[3]]};
  }
  const animation=Animation.attach(model);
  const animator=Animator.attach(animation,{initial:'idle',states:{idle:'Balance'}});
  animator.playing=false;
  const nodeId=name=>model.asset.doc.nodes.findIndex(node=>node.name?.endsWith(':'+name));
  const localAxis=(index,axis)=>{
    const node=model.nodes[index], parent=model.root.engine.meshes.get(model.root.engine.store.parents[node.id]);
    const m=parent.matrix;
    const component=offset=>{
      const column=[m[offset],m[offset+1],m[offset+2]];
      return dot(divide(column,Math.hypot(...column)||1),axis);
    };
    return [component(0),component(4),component(8)];
  };
  const pelvis=nodeId('Hips'), chest=nodeId('Spine2'), head=nodeId('Head');
  const legData=['Left','Right'].map(side=>{
    const upper=nodeId(side+'UpLeg'),lower=nodeId(side+'Leg'),end=nodeId(side+'Foot');
    const ankle=point(model.nodes[end]);
    return {upper,lower,end,ankle,target:[0,0,0],pole:[0,0,1],
      reach:span(point(model.nodes[upper]),point(model.nodes[lower]))+span(point(model.nodes[lower]),ankle)};
  });
  const swing=['LeftArm','RightArm','LeftForeArm','RightForeArm'].map(name=>{
    const index=nodeId(name);
    return {index,axis:localAxis(index,[1,0,0])};
  });
  const chestAxis=localAxis(chest,[0,1,0]), headAxis=localAxis(head,[0,1,0]);
  const ik=addFullBodyIK(animator,{pelvis,spine:[],legs:legData,balance:false,reach:.995,iterations:1,tolerance:.005});
  let yaw=startingYaw;
  let gait=index*.17, weight=0, turn=0;
  function pose(_,rotations){
    const cycle=gait*Math.PI*2;
    const swingAngle=Math.sin(cycle)*.34*weight;
    for(const [i,part] of swing.entries()){
      const angle=(i%2?-1:1)*(i<2?swingAngle:.15*weight*Math.sin(cycle+.55));
      rotations[part.index]=twist(part.axis,angle,rotations[part.index]);
    }
    rotations[chest]=twist(chestAxis,.115*Math.sin(cycle+.22)*weight,rotations[chest]);
    rotations[head]=twist(headAxis,turn,rotations[head]);
  }
  animator.addPoseStep(pose);
  return {
    model,
    update(delta,gaze){
      const velocity=agent.velocity;
      const speed=Math.hypot(velocity[0],velocity[2]);
      const easing=1-Math.exp(-Math.max(delta,1/60)*8.1);
      if(speed>.09){
        const targetYaw=Math.atan2(velocity[0],velocity[2]);
        const difference=Math.atan2(Math.sin(targetYaw-yaw),Math.cos(targetYaw-yaw));
        yaw+=easing*difference;
      }
      weight+=(Math.min(1,speed/1.02)-weight)*easing;
      gait=(gait+speed*delta/(1.20*size))%1;
      const forward=[Math.sin(yaw),0,Math.cos(yaw)], right=[forward[2],0,-forward[0]];
      const bodyPosition=[agent.position[0],-.012+.013*weight*Math.cos(gait*4*Math.PI),agent.position[2]];
      model.root.setPosition(bodyPosition).setRotation([0,yaw,0]).setScale([size,size,size]);
      for(const [i,leg] of legData.entries()){
        const phase=(gait+i*.5)%1, swing=phase/.43;
        const t=Math.min(1,swing);
        const spline=t*t*(3-2*t);
        const step=.275*size*weight;
        const offset=swing<1?step*(spline*2-1):step*(1-2*(phase-.43)/.57);
        const lift=swing<1?.125*weight*Math.sin(Math.PI*t)**2:0;
        const foot=leg.target;
        const lateral=leg.ankle[0]*size;
        foot[0]=agent.position[0]+right[0]*lateral+forward[0]*(offset+leg.ankle[2]*size);
        foot[1]=leg.ankle[1]*size+lift;
        foot[2]=agent.position[2]+right[2]*lateral+forward[2]*(offset+leg.ankle[2]*size);
        leg.pole[0]=foot[0]+forward[0]*.5;
        leg.pole[1]=.6;
        leg.pole[2]=foot[2]+forward[2]*.5;
        leg.support=swing>=1;
      }
      if(gaze){
        const toward=Math.atan2(gaze[0],gaze[2]);
        const angle=Math.atan2(Math.sin(toward-yaw),Math.cos(toward-yaw));
        turn+=(Math.max(-.42,Math.min(.42,angle))-turn)*easing;
      }
    },
    dispose(){ik.dispose();animator.dispose();animation.dispose();model.dispose();},
  };
}

export async function buildVisitors(world,model,lights,signal){
  const agents=[world.player,world.guard,...world.guests.map(guest=>guest.agent)];
  const models=[model];
  const actors=[];
  try{
    for(let index=1;index<agents.length;index++){
      await new Promise(resolve=>setTimeout(resolve,0));
      signal.throwIfAborted();
      models.push(await cloneModel(model));
    }
    for(const [index,agent] of agents.entries()){
      if(index>0)await new Promise(resolve=>setTimeout(resolve,0));
      signal.throwIfAborted();
      const current=models[index];
      lights.add(current);
      const actor=buildActor(current,agent,palettes[index],index,index===1?0:Math.PI*.96);
      actors.push(actor);
      actor.update(0,index===1?world.focus:undefined);
    }
    return actors;
  }catch(error){
    for(const actor of actors)actor.dispose();
    for(const pending of models.slice(actors.length))pending.dispose();
    throw error;
  }
}
