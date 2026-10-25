import { GridHelper, LabelRenderer, Lines, PointCloud, PointsPlugin, createStage } from 'margoengine/viz';

// 200,000 points on a spiral galaxy, coloured by radius, over a grid with a label at the core.
async function start() {
  const stage = await createStage('#viewport', { camera: { position: [0, 6, 10], target: [0, 0, 0] } });
  const engine = stage.engine;

  const count = 200_000,
    positions = new Float32Array(count * 3),
    colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const arm = i % 3,
      t = Math.random(),
      radius = 0.2 + t * 5,
      angle = arm * ((2 * Math.PI) / 3) + t * 6 + (Math.random() - 0.5) * 0.6;
    positions.set([Math.cos(angle) * radius, (Math.random() - 0.5) * 0.3 * (1 - t), Math.sin(angle) * radius], i * 3);
    colors.set([1 - t * 0.6, 0.6 + t * 0.2, 0.4 + t * 0.6], i * 3);
  }
  const points = PointsPlugin.attach(engine, { pointBudget: count });
  points.add(new PointCloud({ positions, colors, material: { size: 2, shape: 'round' } }));

  const lines = new Lines();
  engine.use(lines);
  lines.add(new GridHelper({ size: 12, divisions: 12 }));

  const labels = LabelRenderer.attach(engine);
  const core = document.createElement('div');
  core.textContent = 'Core';
  core.style.cssText = 'padding: 2px 8px; border-radius: 4px; background: #000a; color: #fff; font-size: 13px';
  labels.add(core, { position: [0, 0.6, 0] });
}

start().catch((error) => {
  document.querySelector('#error')!.textContent = `Could not start: ${error instanceof Error ? error.message : error}`;
});
