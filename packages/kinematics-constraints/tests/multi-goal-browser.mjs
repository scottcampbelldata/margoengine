import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
import { decodePNG } from '../../../tests/support/png.js';

const browser=await openBrowser({startPath:'/tests/modern-game.html',port:'free'});
try {
  for(const backend of ['webgpu','webgl2']) {
    await browser.page.reload();
    const result=await browser.page.evaluate(async backend=>{
      if(backend==='webgl2') {
        const {install}=await import('/packages/webgl2-compat/dist/index.js');
        const result=await install({force:true});
        if(!result.installed) throw new Error(result.reason);
      }
      const {MultiGoalIKSolver}=await import('/packages/kinematics-constraints/dist/multi-goal.js');
      const {EngineKernel}=await import('/packages/core/dist/index.js');
      const {engineRuntime}=await import('/packages/core/dist/extension.js');
      const {sphere}=await import('/packages/stage/dist/index.js');
      const joints=[
        {type:'revolute',position:[-1,0,0],value:0.7},
        {type:'prismatic',parent:0,position:[1,0,0],axis:[1,0,0],min:0,max:1},
        {type:'revolute',position:[1,0,0],value:2.4},
        {type:'prismatic',parent:2,position:[1,0,0],axis:[1,0,0],min:0,max:1},
      ];
      const solver=new MultiGoalIKSolver(joints);
      const pose=solver.solve({goals:[{frame:{joint:1},position:[0,1.2,0]}],loops:[{a:{joint:1},b:{joint:3}}]});
      const canvas=document.createElement('canvas'); document.body.replaceChildren(canvas);
      const engine=engineRuntime(await EngineKernel.create(canvas,{backend:'webgpu',exactSize:[128,128],camera:{position:[2,2,5],target:[0,0.5,0]}}));
      for(const point of pose.poses) engine.createMesh().setGeometry(sphere(0.14,12)).setPosition(point.position);
      await engine.render({delta:0}); window.multiGoalEngine=engine;
      return {resolved:pose.resolved,values:pose.values,goals:pose.goals,loops:pose.loops};
    },backend);
    assert.equal(result.resolved,true,JSON.stringify(result));
    assert.ok(result.goals[0].position<=1e-5 && result.loops[0].position<=1e-5);
    for(const i of [1,3]) assert.ok(result.values[i]>=0 && result.values[i]<=1);
    const png=await decodePNG(await browser.page.locator('canvas').screenshot());
    const colors=new Set();
    for(let i=0;i<png.data.length;i+=4) colors.add(`${png.data[i]},${png.data[i+1]},${png.data[i+2]}`);
    assert.ok(colors.size>5,`${backend}: solved closed chain rendered ${colors.size} colors`);
    await browser.page.evaluate(()=>window.multiGoalEngine.dispose());
    console.log(`${backend}: multi-goal mixed-joint closed chain rendered`);
  }
} finally { await browser.close(); }
