import { box, PbrMaterial } from '@margoengine/core';
import { Figure } from '@margoengine/sciviz';
import { PointsPlugin, PointCloud } from '@margoengine/points';
import { Lines, Line } from '@margoengine/lines';
import { LabelRenderer } from '@margoengine/labels';
import { createCompute } from '@margoengine/compute';
import { parseXYZ } from '@margoengine/loaders';
import { Video } from '@margoengine/video';
import { HTML } from '@margoengine/html';
import { check, expose } from './harness.ts';

expose('sciviz', async (engine) => {
  const data = parseXYZ(new TextEncoder().encode('-1 0 0\n0 1 0\n1 0 0\n'), { layout: 'xyz' });
  const calculate = async () => {
    const gpu = await createCompute({ engine, signal: AbortSignal.timeout(30_000) });
    try {
      const values = gpu.array(new Float32Array([1, 2, 3, 4]));
      return await values.mul(2).sum().item();
    } finally {
      gpu.dispose();
    }
  };
  const total = await calculate();
  const figure = Figure.attach(engine, { axes: false });
  const scatter = await figure.scatter({ positions: data.positions }, { size: 8, color: '#56b4e9' });
  const points = PointsPlugin.attach(engine, { name: 'integration-points', pointBudget: 16 });
  points.add(new PointCloud({ positions: new Float32Array([1.2, 0.5, 0]), material: { size: 10, color: '#e69f00' } }));
  const lines = new Lines();
  engine.use(lines);
  lines.add(new Line({ positions: [-1, 0, 0, 0, 1, 0, 1, 0, 0], width: 3, color: '#84d6bd' }));
  const mesh = engine
    .createMesh()
    .setGeometry(box(1.2, 1.2, 1.2))
    .setMaterial(new PbrMaterial({ color: '#567fa0' }));
  const labels = LabelRenderer.attach(engine, { name: 'integration-labels' });
  const label = document.createElement('span');
  label.textContent = 'Sensor';
  labels.add(label, { mesh, offset: [0, 1, 0] });
  const html = HTML.attach(engine);
  const status = document.createElement('span');
  status.textContent = 'Ready';
  html.add(status, { position: [1, 1, 0] });
  const source = new OffscreenCanvas(8, 8),
    drawing = source.getContext('2d')!;
  drawing.fillStyle = '#4080c0';
  drawing.fillRect(0, 0, 8, 8);
  const frame = new VideoFrame(source, { timestamp: 0 });
  const video = Video.attach(engine, frame, { rect: [0.1, 0.2, 0.3, 0.3] });
  await figure.ready();
  return {
    async assert() {
      check(total === 20 && (await calculate()) === 20, 'compute reduction changed');
      check(data.kind === 'points' && data.positions.length === 9, 'XYZ points missing');
      check(scatter.cloud.count === 3, 'figure scatter missing');
      check(points.stats.pointsDrawn === 1 && lines.stats.segments === 2, 'point or line pass did not draw');
      check(label.isConnected && status.isConnected, 'DOM annotations missing');
      check(video.import(engine.gpu!), 'video frame missing');
      return { points: 4, loadedPoints: 3, computeSum: total, video: true, labels: true, html: true };
    },
    dispose() {
      video.dispose();
      frame.close();
      html.dispose();
      labels.dispose();
      lines.dispose();
      points.dispose();
      figure.dispose();
      mesh.dispose();
    },
    assertDisposed() {
      check(!label.isConnected && !status.isConnected, 'annotations retained DOM');
    },
  };
});
