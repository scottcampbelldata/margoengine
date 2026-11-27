import { count, layout, platforms, pitch, tile } from './route.js';

const approachWindow = 23;
const settlingWindow = 39;

export function populate(physics, meshAt = () => null) {
  for(const {center,half} of platforms()){
    physics.addBody(null,{type:'fixed',position:center,colliders:{shape:'box',halfExtents:half,friction:.83}});
  }
  const halfExtents = [tile.width/2,tile.height/2,tile.thick/2];
  return layout.map((p,i)=>{
    const position=[p.x,p.y+tile.height/2,p.z];
    const rotation=[0,Math.sin(.5*p.yaw),0,Math.cos(.5*p.yaw)];
    const body = physics.addBody(meshAt(i,position,rotation),{
      type:i<approachWindow ? 'dynamic' : 'fixed',position,rotation,sleeping:true,
      colliders:{shape:'box',halfExtents,friction:.12,density:'pine',restitution:0},
    });
    body.enabled = i<approachWindow;
    return body;
  });
}

export function trigger(bodies) {
  const start=layout[0];
  const first=bodies[0];
  const impulse=.92*Math.sqrt(9.81*tile.height)*first.mass;
  first.applyImpulseAtPoint([Math.sin(start.yaw)*impulse,0,Math.cos(start.yaw)*impulse],
    [start.x,start.y+tile.height,start.z]);
}

export function reset(bodies) {
  for(let i=0;i<count;i++){
    const {x,y,z,yaw}=layout[i];
    bodies[i].setType(i<approachWindow ? 'dynamic' : 'fixed',false)
      .setPosition([x,y+tile.height/2,z],false)
      .setRotation([0,Math.sin(.5*yaw),0,Math.cos(.5*yaw)],false)
      .setLinearVelocity([0,0,0],false).setAngularVelocity([0,0,0],false).sleep();
    bodies[i].enabled = i<approachWindow;
  }
}

export function track(bodies){
  const touched=new Uint8Array(count);
  const rested=new Uint8Array(count);
  let liveUntil=approachWindow;
  let leading=-1, total=0, since=0, speed=0, previousMeter=0, previousTime=0;
  const threshold=1-Math.cos(.25);
  return {
    reset(){touched.fill(0);rested.fill(0);liveUntil=approachWindow;leading=-1;total=0;since=0;speed=0;previousMeter=0;previousTime=0;},
    observe(time){
      const far=Math.min(count-1,leading+30);
      for(let i=Math.max(leading-15,0);i<=far;i++){
        if(touched[i])continue;
        const q=bodies[i].rotation;
        if(2*(q[0]*q[0]+q[2]*q[2])>threshold){
          touched[i]=1;
          total++;
          if(i>leading){leading=i;since=time;}
        }
      }
      // Keep the approach dynamic well beyond the possible contact range.
      const horizon=Math.min(count,leading+approachWindow);
      for(;liveUntil<horizon;liveUntil++){
        bodies[liveUntil].enabled = true;
        bodies[liveUntil].setType('dynamic',true);
      }
      // Keep the settled shapes as fixed colliders after the wave has passed.
      // Moving, settling or supporting pieces near the leading edge stay dynamic.
      for(let i=0;i<leading-settlingWindow;i++){
        const body=bodies[i];
        if(!touched[i] || !body.enabled)continue;
        if(body.type==='fixed'){
          if(i<leading-settlingWindow-24)body.enabled=false;
          continue;
        }
        const v=body.linearVelocity, omega=body.angularVelocity;
        if(!body.sleeping && (Math.hypot(...v)>.008 || Math.hypot(...omega)>.10)) {
          rested[i]=0;
          continue;
        }
        if(body.sleeping || ++rested[i]>=22)body.setType('fixed',false);
      }
      if(time-previousTime>.29 && leading>=0){
        const meter=leading*pitch;
        speed=(meter-previousMeter)/(time-previousTime);
        previousTime=time;
        previousMeter=meter;
      }
      return {leading,total,since,speed};
    },
  };
}
