import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
import { decodePNG } from '../../../tests/support/png.js';

const browser=await openBrowser({startPath:'/tests/modern-game.html',port:'free'});
try {
  for(const backend of ['webgpu','webgl2']) {
    const result=await browser.page.evaluate(async (backend)=>{
      const {EngineKernel}=await import('/packages/core/dist/index.js');
      if (backend==='webgl2') {
        const {install}=await import('/packages/webgl2-compat/dist/index.js');
        const installed=await install({force:true});
        if(!installed.installed) throw new Error(installed.reason);
      }
      const {loadGLTF}=await import('/packages/gltf-pro/dist/index.js');
      const {Animation}=await import('/packages/animation/dist/index.js');
      const {Animator}=await import('/packages/animator/dist/index.js');
      const {addFullBodyIK}=await import('/packages/animator/dist/fbik.js');
      const {ChainAvoidanceSolver,createLimbAvoidance}=await import('/packages/kinematics-constraints/dist/chain.js');
      const {SphereVolume}=await import('/packages/kinematics-constraints/dist/index.js');
      const canvas=document.createElement('canvas');
      document.body.replaceChildren(canvas);
      const engine=await EngineKernel.create(canvas,{backend:'webgpu',exactSize:[192,192],capacity:256,camera:{position:[3,2,4],target:[0,1,0]}});
      const model=await loadGLTF(engine,'/examples/assets/khronos/RiggedFigure/RiggedFigure.glb');
      const animator=Animator.attach(Animation.attach(model),{initial:'walk',states:{walk:'Animation 0'}});
      animator.onPreUpdate(0.1);
      const index=(name)=>model.nodes.findIndex(n=>n.name===name);
      const position=(id)=>Array.from(model.nodes[id].matrix).slice(12,15);
      const limb={upper:index('arm_joint_L_1'),lower:index('arm_joint_L_2'),end:index('arm_joint_L_3')};
      const root=position(limb.upper), tip=position(limb.end);
      limb.target=[(root[0]+tip[0])/2,(root[1]+tip[1])/2,(root[2]+tip[2])/2+0.1];
      const ik=addFullBodyIK(animator,{pelvis:index('torso_joint_1'),spine:[index('torso_joint_2'),index('torso_joint_3')],arms:[limb],balance:false});
      animator.onPreUpdate(0);
      const obstacle=new SphereVolume({center:position(limb.lower),radius:0.015});
      limb.avoidance=createLimbAvoidance(new ChainAvoidanceSolver([obstacle],{radius:0.005,minClearance:0.003,candidates:128}));
      animator.onPreUpdate(0);
      const clear=ik.result.clear;
      const gap=Math.min(obstacle.segmentClearance(position(limb.upper),position(limb.lower),0.005),obstacle.segmentClearance(position(limb.lower),position(limb.end),0.005));
      const reached=ik.result.reached;
      await engine.render({delta:0});
      window.avoidanceEngine=engine;
      return {backend:engine.backend,clear,gap,reached};
    },backend);
    assert.equal(result.clear,true,JSON.stringify(result));
    assert.equal(result.reached,true,JSON.stringify(result));
    assert.ok(result.gap>=0.003-1e-6,JSON.stringify(result));
    const png=await decodePNG(await browser.page.locator('canvas').screenshot());
    const colors=new Set();
    for(let i=0;i<png.data.length;i+=4) colors.add(`${png.data[i]},${png.data[i+1]},${png.data[i+2]}`);
    assert.ok(colors.size>8,`${backend}: model rendered ${colors.size} colors`);
    await browser.page.evaluate(()=>window.avoidanceEngine.dispose());
    console.log('Full-body avoidance rendered',backend,result.gap);
  }
} finally {
  await browser.close();
}
