import { meshWorldMatrix } from '@margoengine/math/mesh';
import type { Mesh } from '@margoengine/core';
import type { USDExtension } from './extension.js';
import { curveGeometry, type CurvesOptions, type Part } from './curve-geometry.js';
export type { CurvesOptions } from './curve-geometry.js';

/** Import BasisCurves and Points with sampled widths and display primvars, using optional Lines and Points renderers. */
export function curves(options: CurvesOptions = {}): USDExtension {
  const hook = curveGeometry(options);
  hook.created = async (engine, model) => {
    const definitions = model.asset.doc.meshes!;
    const partsOf = (mesh: (typeof definitions)[number]) =>
      (mesh.extras as { usdCurves?: Part[] } | undefined)?.usdCurves;
    if (!definitions.some((mesh) => partsOf(mesh))) return;
    const [{ Lines }, { Stroke }, { PointsPlugin, PointCloud }] = await Promise.all([
      import('@margoengine/lines'),
      import('@margoengine/lines/stroke'),
      import('@margoengine/points'),
    ]);
    const scaleOf = (node: Mesh) => {
      const m = meshWorldMatrix(engine, node);
      return m
        ? Math.max(Math.hypot(m[0], m[1], m[2]), Math.hypot(m[4], m[5], m[6]), Math.hypot(m[8], m[9], m[10]))
        : 1;
    };
    const clouds: { node: Mesh; cloud: InstanceType<typeof PointCloud> }[] = [];
    class USDPoints extends PointsPlugin {
      override registerPasses(graph: Parameters<InstanceType<typeof PointsPlugin>['registerPasses']>[0]): void {
        graph.add({
          name: this.name + ':units',
          order: -7,
          execute: () => {
            for (const entry of clouds) entry.cloud.material.size = scaleOf(entry.node);
          },
        });
        super.registerPasses(graph);
      }
    }
    let id = 0;
    while (engine.hasPlugin('usd-curves-lines-' + id) || engine.hasPlugin('usd-curves-points-' + id)) id++;
    let lines: InstanceType<typeof Lines> | undefined, points: InstanceType<typeof PointsPlugin> | undefined;
    model.onDispose(() => {
      // The scenes they were attached to, not whichever scene is active when the model goes.
      if (lines) engine.sceneOf(lines)?.removePlugin(lines.name);
      if (points) engine.sceneOf(points)?.removePlugin(points.name);
    });
    for (let node = 0; node < model.asset.doc.nodes!.length; node++) {
      const mesh = model.asset.doc.nodes![node].mesh;
      const parts = mesh === undefined ? undefined : partsOf(definitions[mesh]);
      for (const part of parts ?? []) {
        const positions = model.asset.accessor(part.points),
          sizes = model.asset.accessor(part.widths),
          colors = model.asset.accessor(part.colors);
        if (part.kind === 'curve') {
          lines ??= Lines.attach(engine, { name: 'usd-curves-lines-' + id });
          const line = lines.add(
            new Stroke({
              positions,
              widths: sizes,
              colors,
              width: 1,
              worldUnits: true,
              mesh: model.nodes[node],
            }),
          );
          line.update = () => {
            line.material.width = scaleOf(model.nodes[node]);
          };
        } else {
          if (!points) {
            points = new USDPoints({ name: 'usd-curves-points-' + id, edlStrength: 0 });
            engine.use(points);
          }
          const cloud = points.add(
            new PointCloud({
              positions,
              sizes,
              colors,
              colorFormat: 'float',
              material: { size: 1, sizeUnits: 'world', shape: 'round', minPixelSize: 0, maxPixelSize: 1e9 },
            }).attach(model.nodes[node]),
          );
          clouds.push({ cloud, node: model.nodes[node] });
        }
      }
    }
  };
  return hook;
}
