import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';
process.chdir(fileURLToPath(new URL('../../..', import.meta.url)));
const small = process.argv.includes('--small');
for (const compat of [false, true]) {
  const browser = await openBrowser({ startPath: '/examples/sciviz-graph-gpu.html', port: 'free', compat }),
    errors = [];
  browser.page.on('pageerror', (error) => errors.push(error.message));
  browser.page.on('console', (message) => {
    if (message.type() === 'error') console.error(message.text());
  });
  browser.page.setDefaultTimeout(180000);
  try {
    await browser.page.waitForFunction(
      () => document.querySelector('#status').dataset.ready === 'true' || document.querySelector('vite-error-overlay'),
    );
    assert.deepEqual(errors, []);
    await browser.page.screenshot({ path: `test-results/j5-demo-${compat ? 'webgl2' : 'webgpu'}.png` });
    const report = await browser.page.evaluate(
      async ({ compat, small }) => {
        const demo = await import('/examples/sciviz-graph-gpu.ts');
        const { GPUGraphLayout, GraphLayoutReference, gpuGraphLayer, bundleGraphEdges, bundleGraphEdgesReference } =
          await import('/packages/sciviz/dist/graph-gpu.js');
        const { ForceLayout } = await import('/packages/sciviz/dist/graph.js');
        demo.figure.engine.stop();
        const check = (ok, why) => {
          if (!ok) throw new Error(why);
        };
        const close = (a, b, why, tolerance = 2e-4) =>
          check(
            a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= tolerance * Math.max(1, Math.abs(b[i]))),
            why,
          );
        const startRoutes = demo.gpu.device.dispatches ? { ...demo.gpu.device.dispatches } : undefined;
        const graph = { nodes: 5, edges: [0, 1, 0, 1, 1, 2, 2, 3, 3, 0, 2, 2], weights: [1, 2, 0.5, 1, 2, 3] };
        const positions = Float32Array.of(-2, -1, 1, 2, -1, -1, 1, 2, 0, -1, 2, 1, 9, 5, -2);
        const checks = [];
        for (const dimensions of [2, 3])
          for (const model of ['fruchterman-reingold', 'forceatlas2'])
            for (const variant of [false, true]) {
              const options = {
                model,
                dimensions,
                positions,
                theta: 0,
                gridSide: 4,
                temperature: 0.3,
                gravity: 0.02,
                ...(variant
                  ? {
                      linLog: true,
                      strongGravity: true,
                      dissuadeHubs: true,
                      radii: [0.1, 0.2, 0.1, 0.3, 0],
                      fixed: [1, 0, 0, 0, 0],
                      weightInfluence: 0.5,
                    }
                  : {}),
              };
              const reference = new GraphLayoutReference(graph, options),
                layout = new GPUGraphLayout(demo.gpu, graph, options);
              for (let i = 0; i < 5; i++) {
                reference.step();
                layout.step();
                close(
                  await layout.read(),
                  reference.positions,
                  `${model} ${dimensions}D variant=${variant} iteration ${i}`,
                );
              }
              if (model === 'fruchterman-reingold' && !variant) {
                const original = new ForceLayout(graph, options);
                for (let i = 0; i < 5; i++) original.step();
                close(await layout.read(), original.positions, 'retained exact CPU layout');
              }
              check(
                (await layout.diagnostics()).interactions === 20,
                'exact traversal includes all n*(n-1) pairs including isolates',
              );
              check(
                layout.work.sortComparisons === 240,
                'all comparator threads including both sides of each pair are counted',
              );
              checks.push({ model, dimensions, variant, work: layout.work });
              layout.dispose();
            }
        // Nonuniform mass, boundary leaves, large translations, and coincident nodes exercise tree construction and opening.
        const cloud = { nodes: 128, edges: [] },
          p = Float32Array.from({ length: 128 * 3 }, (_, i) =>
            i % 3 === 2 ? 0 : i % 13 === 0 ? 2000 : Math.sin(i * 7.13) * 11 + (i % 2) * 80,
          );
        const exact = new GPUGraphLayout(demo.gpu, cloud, {
          model: 'fruchterman-reingold',
          positions: p,
          theta: 0,
          gridSide: 16,
          temperature: 1e6,
          gravity: 0,
        });
        const tree = new GPUGraphLayout(demo.gpu, cloud, {
          model: 'fruchterman-reingold',
          positions: p,
          theta: 0.5,
          gridSide: 16,
          temperature: 1e6,
          gravity: 0,
        });
        exact.step();
        tree.step();
        const a = await exact.read(),
          b = await tree.read();
        let err = 0,
          size = 0;
        for (let i = 0; i < a.length; i++) {
          err += (a[i] - b[i]) ** 2;
          size += (a[i] - p[i]) ** 2;
        }
        check(Math.sqrt(err / size) < 0.04, 'GPU tree matches all-pairs on nonuniform boundary cloud');
        check((await tree.diagnostics()).interactions < 128 * 127, 'tree reduces evaluated interactions');
        exact.dispose();
        tree.dispose();
        const coincident = new GPUGraphLayout(
          demo.gpu,
          { nodes: 4, edges: [0, 1] },
          { positions: new Float32Array(12), gridSide: 4 },
        );
        coincident.step();
        const cp = await coincident.read();
        check(cp.every(Number.isFinite) && cp.some((v) => v !== 0), 'coincident points separate with finite forces');
        coincident.dispose();
        const g = { nodes: 4, edges: [0, 1, 3, 2] },
          bp = Float32Array.of(0, 0, 0, 10, 0, 0, 0, 1, 0, 10, 1, 0),
          opts = { cycles: 3, iterations: 5, step: 0.02 };
        const cpuBundles = bundleGraphEdgesReference(g, bp, opts),
          bundles = await bundleGraphEdges(demo.gpu, g, bp, opts),
          actualBundles = await bundles.read();
        close(actualBundles, cpuBundles.positions, 'GPU FDEB agrees with independent CPU cycles', 4e-4);
        check(actualBundles[9] > 0 && actualBundles[(6 + 3) * 4 + 1] < 1, 'bundles attract');
        bundles.dispose();
        const controller = new AbortController();
        controller.abort();
        let aborted = false;
        try {
          await bundleGraphEdges(demo.gpu, g, bp, { signal: controller.signal });
        } catch (e) {
          aborted = e.name === 'AbortError';
        }
        check(aborted, 'bundle cancellation');
        let runAborted = false;
        try {
          for await (const ignored of demo.layout.run({ signal: controller.signal })) {
            void ignored;
          }
        } catch (e) {
          runAborted = e.name === 'AbortError';
        }
        check(runAborted, 'layout cancellation');
        const pixelHash = async () => {
          const blob = await demo.figure.toPNG(),
            bytes = new Uint8Array(await blob.arrayBuffer());
          return bytes.reduce((n, v) => (Math.imul(n, 31) + v) | 0, 0);
        };
        const withNodes = await pixelHash();
        demo.layer.visible = false;
        const without = await pixelHash();
        check(withNodes !== without, 'graph changes rendered pixels');
        demo.layer.visible = true;
        await demo.layer.refreshLabels();
        check(demo.layer.labelBoxes.length > 0, 'real node labels are placed');
        for (const box of demo.layer.labelBoxes)
          for (const other of demo.layer.labelBoxes)
            if (box !== other)
              check(
                box.x + box.width <= other.x ||
                  other.x + other.width <= box.x ||
                  box.y + box.height <= other.y ||
                  other.y + other.height <= box.y,
                'labels never overlap',
              );
        await demo.bundle();
        check((await pixelHash()) !== withNodes, 'bundled edges change pixels');
        demo.layer.dispose();
        demo.bundles?.dispose();
        demo.layout.dispose();
        const styled = new GPUGraphLayout(demo.gpu, g, { positions: bp, gravity: 0, gridSide: 4 });
        let styleLayer = gpuGraphLayer(demo.figure, styled, {
          bounds: [-1, 11, -2, 3, -1, 1],
          nodeSize: 0,
          edgeWidth: 1,
          edgeColor: '#f00000',
          arrowSize: 0,
        });
        const thin = await pixelHash();
        styleLayer.dispose();
        styleLayer = gpuGraphLayer(demo.figure, styled, {
          bounds: [-1, 11, -2, 3, -1, 1],
          nodeSize: 0,
          edgeWidth: [0, 0],
          arrowSize: 0,
        });
        const noEdges = await pixelHash();
        styleLayer.dispose();
        styleLayer = gpuGraphLayer(demo.figure, styled, {
          bounds: [-1, 11, -2, 3, -1, 1],
          nodeSize: 0,
          edgeWidth: [0, 8],
          arrowSize: 0,
        });
        check(
          (await pixelHash()) !== noEdges,
          'straight-edge instances use every edge index even when the first edge is invisible',
        );
        styleLayer.dispose();
        styleLayer = gpuGraphLayer(demo.figure, styled, {
          bounds: [-1, 11, -2, 3, -1, 1],
          nodeSize: 0,
          edgeWidth: [8, 4],
          edgeColor: ['#00b000', '#0000ff'],
          arrowSize: 18,
        });
        check((await pixelHash()) !== thin, 'widths colours and arrows affect pixels');
        styleLayer.dispose();
        styled.dispose();
        const routes = startRoutes
          ? Object.fromEntries(Object.entries(demo.gpu.device.dispatches).map(([k, v]) => [k, v - startRoutes[k]]))
          : undefined;
        if (routes)
          check(
            routes.cpu === 0 && routes.fragment + routes.scatter > 0,
            'all graph layout and bundling dispatches run on GPU on the compatibility backend',
          );
        let scale;
        if (!small && !compat) {
          const nodes = 1000000,
            copies = Math.floor(nodes / demo.graph.nodes),
            edgeCount = demo.graph.edges.length / 2;
          const edges = new Uint32Array(copies * edgeCount * 2);
          for (let copy = 0; copy < copies; copy++)
            for (let i = 0; i < demo.graph.edges.length; i++)
              edges[copy * demo.graph.edges.length + i] = demo.graph.edges[i] + copy * demo.graph.nodes;
          const rows = [];
          for (const model of ['fruchterman-reingold', 'forceatlas2']) {
            const layout = new GPUGraphLayout(demo.gpu, { nodes, edges }, { model, gridSide: 256, seed: 175 });
            const before = await layout.read();
            layout.step();
            const after = await layout.read(),
              diagnostics = await layout.diagnostics();
            let changed = 0,
              maxMove = 0,
              checksum = 0;
            for (let i = 0; i < nodes; i++) {
              let d = 0;
              for (let j = 0; j < 3; j++) {
                const k = i * 3 + j;
                check(Number.isFinite(after[k]), `finite node ${i}`);
                d += (after[k] - before[k]) ** 2;
                checksum += after[k];
              }
              if (d > 0) changed++;
              maxMove = Math.max(maxMove, Math.sqrt(d));
            }
            check(changed > 999990, 'every million-node output is computed, with nearly all moving');
            check(
              diagnostics.interactions < (nodes * (nodes - 1)) / 50,
              'spatial tree avoids quadratic pair evaluation',
            );
            check(
              diagnostics.totalMass === nodes + (model === 'forceatlas2' ? edges.length : 0),
              'tree represents every node and every degree mass',
            );
            if (model === 'forceatlas2') check(maxMove <= 10.001, 'FA2 per-node move cap holds');
            const layer = gpuGraphLayer(demo.figure, layout, {
              bounds: [-1200, 1200, -1200, 1200, -1, 1],
              nodeSize: 1,
              edgeWidth: 0.3,
              arrowSize: 0,
            });
            const populated = await pixelHash();
            layer.visible = false;
            check((await pixelHash()) !== populated, 'million nodes and all original-copy edges draw');
            layer.dispose();
            rows.push({
              model,
              nodes,
              edges: edges.length / 2,
              copiesOfOpenAlexSubgraph: copies,
              originalWorks: demo.graph.nodes,
              changed,
              maxMove,
              checksum,
              work: layout.work,
              diagnostics,
            });
            layout.dispose();
          }
          scale = rows;
        }
        const report = {
          compat,
          originalWorks: demo.graph.nodes,
          originalEdges: demo.graph.edges.length / 2,
          checks,
          treeRelativeError: Math.sqrt(err / size),
          routes,
          scale,
        };
        demo.gpu.dispose();
        demo.figure.dispose();
        return report;
      },
      { compat, small },
    );
    assert.deepEqual(errors, []);
    console.log(JSON.stringify(report));
    await mkdir('test-results', { recursive: true });
    await writeFile(
      `test-results/batch175-graph-gpu-${compat ? 'webgl2' : 'webgpu'}.json`,
      JSON.stringify({ hardware: browser.hardware, ...report }, null, 2) + '\n',
    );
  } finally {
    await browser.close();
  }
}
