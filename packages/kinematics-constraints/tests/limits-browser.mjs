import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
import { decodePNG } from '../../../tests/support/png.js';

const browser = await openBrowser({ startPath: '/tests/modern-game.html', port: 'free' });
try {
  for (const backend of ['webgpu', 'webgl2']) {
    const result = await browser.page.evaluate(async (backend) => {
      if (backend === 'webgl2') {
        const { install } = await import('/packages/webgl2-compat/dist/index.js');
        const installed = await install({ force: true });
        if (!installed.installed) throw new Error(installed.reason);
      }
      const { EngineKernel } = await import('/packages/core/dist/index.js');
      const { engineRuntime } = await import('/packages/core/dist/extension.js');
      const { sphere } = await import('/packages/stage/dist/index.js');
      const { AvoidanceSolver } = await import('/packages/kinematics-constraints/dist/index.js');
      const { JointLimitSet, jointLimitPredicate } = await import('/packages/kinematics-constraints/dist/joint-limits.js');
      const limits = new JointLimitSet([{ type: 'hinge', axis: [1, 0, 0], min: 0.4, max: 1 }]);
      const predicate = jointLimitPredicate(limits, (_r, _e, _t, angle) => [[Math.sin(angle / 2), 0, 0, Math.cos(angle / 2)]]);
      const solver = new AvoidanceSolver([], { minClearance: 0, complianceMargin: 0 });
      const pose = solver.solve([0, 0, 0], [1.4, 0, 0], [1.4, 0, 0], 1, 1, 0.03, 0.03, 1,
        (_root, target, angle, out) => {
          const half = target[0] / 2, height = Math.sqrt(1 - half * half);
          out.set([half, height * Math.cos(angle), height * Math.sin(angle)]);
        }, { acceptPose: predicate, searchBudget: 64 });
      const canvas = document.createElement('canvas');
      document.body.replaceChildren(canvas);
      const engine = engineRuntime(await EngineKernel.create(canvas, { backend: 'webgpu', exactSize: [128, 128], camera: { position: [2, 2, 4], target: [0.7, 0.1, 0] } }));
      for (const point of [[0, 0, 0], pose.elbow, pose.target]) engine.createMesh().setGeometry(sphere(0.1, 12)).setPosition(point);
      await engine.render({ delta: 0 });
      window.limitEngine = engine;
      return { resolved: pose.resolved, angle: pose.poleAngle };
    }, backend);
    assert.equal(result.resolved, true);
    assert.ok(result.angle >= 0.4 && result.angle <= 1);
    const png = await decodePNG(await browser.page.locator('canvas').screenshot());
    const colors = new Set();
    for (let i = 0; i < png.data.length; i += 4) colors.add(`${png.data[i]},${png.data[i + 1]},${png.data[i + 2]}`);
    assert.ok(colors.size > 5, `${backend} accepted pose rendered ${colors.size} colors`);
    await browser.page.evaluate(() => window.limitEngine.dispose());
    console.log('Legal swivel rendered', backend, result.angle);
  }
} finally {
  await browser.close();
}
