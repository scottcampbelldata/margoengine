import {
  GridHelper,
  LabelRenderer,
  Lines,
  OrbitControls,
  PointCloud,
  PointsPlugin,
  createStage,
} from 'margoengine/viz';
import { Bloom } from 'margoengine/post/bloom';

// 300,000 stars in a turning three-armed galaxy over a grid, with bloom and labels. Drag to orbit, scroll to zoom.
async function start() {
  const stage = await createStage('#viewport', {
    controls: false,
    camera: { position: [0, 5, 11], target: [0, 0, 0] },
  });
  const engine = stage.engine;
  const orbit = OrbitControls.attach(engine);
  orbit.enableDamping = true;
  orbit.autoRotate = true;
  orbit.autoRotateSpeed = 0.4;
  Bloom.attach(engine, { strength: 0.6, threshold: 0.6 });

  const count = 300_000,
    positions = new Float32Array(count * 3),
    colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const t = Math.pow(Math.random(), 0.7),
      radius = 0.15 + t * 5.5,
      spread = (Math.random() - 0.5) * (0.25 + 0.5 * t),
      angle = (i % 3) * ((2 * Math.PI) / 3) + radius * 1.1 + spread;
    positions.set(
      [Math.cos(angle) * radius, (Math.random() - 0.5) * 0.35 * (1 - t * 0.8), Math.sin(angle) * radius],
      i * 3,
    );
    // White-gold core, blue-violet arms.
    colors.set([1 - t * 0.55, 0.85 - t * 0.35, 0.65 + t * 0.35], i * 3);
  }
  const spin = engine.createMesh(); // an empty node the cloud follows, turned each frame
  const points = PointsPlugin.attach(engine, { pointBudget: count });
  points.add(new PointCloud({ positions, colors, material: { size: 2, shape: 'round' } })).attach(spin);

  const lines = new Lines();
  engine.use(lines);
  lines.add(new GridHelper({ size: 14, divisions: 14 }));

  const labels = LabelRenderer.attach(engine);
  const label = (text: string, position: [number, number, number]) => {
    const element = document.createElement('div');
    element.textContent = text;
    element.style.cssText = 'padding: 2px 8px; border-radius: 4px; background: #0009; color: #fff; font-size: 13px';
    labels.add(element, { position });
  };
  label('Core', [0, 0.7, 0]);
  label('300,000 stars', [4.5, 0.4, 3]);

  stage.onTick((delta) => {
    spin.rotation.y += delta * 0.08;
  });
}

start().catch((error) => {
  document.querySelector('#error')!.textContent = `Could not start: ${error instanceof Error ? error.message : error}`;
});
