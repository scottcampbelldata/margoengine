// Clean-room adapters to documented public APIs. Implementations stay external.
import { BACKGROUND, COLOR, SIZE, copyCanvas } from './margo.mjs';

export async function rivalRenderer(name, host, data, signal) {
  signal?.throwIfAborted();
  if (name === 'plotly') {
    const { default: Plotly } = await import('plotly.js-dist-min');
    const heat = data.id === 'heatmap';
    const traces = heat
      ? [
          {
            type: 'heatmap',
            z: Array.from({ length: data.scale }, (_, y) =>
              Array.from(data.values.subarray(y * data.scale, (y + 1) * data.scale)),
            ),
            x0: -1 + 1 / data.scale,
            dx: 2 / data.scale,
            y0: -1 + 1 / data.scale,
            dy: 2 / data.scale,
            zmin: 0,
            zmax: data.maximum,
            colorscale: data.colorscale,
            showscale: false,
            zsmooth: false,
          },
        ]
      : [
          {
            type: 'scattergl',
            x: data.points.map((p) => p[0]),
            y: data.points.map((p) => p[1]),
            mode: data.id === 'scatter' ? 'markers' : 'lines',
            marker: { color: COLOR, size: 3, opacity: 1 },
            line: { color: COLOR, width: 1 },
          },
        ];
    await Plotly.newPlot(
      host,
      traces,
      {
        width: SIZE,
        height: SIZE,
        autosize: false,
        paper_bgcolor: BACKGROUND,
        plot_bgcolor: BACKGROUND,
        showlegend: false,
        margin: { l: 0, r: 0, t: 0, b: 0, pad: 0 },
        xaxis: { range: [-1, 1], visible: false, fixedrange: true },
        yaxis: { range: [-1, 1], visible: false, fixedrange: true },
      },
      { staticPlot: true, displayModeBar: false, responsive: false, plotGlPixelRatio: 1 },
    );
    return {
      memory: () => ({ gpuBytes: null, jsDataBytes: null, reason: 'No public live allocation inventory' }),
      async frame() {
        // PNG export on BOTH sides for this adapter, including the heatmap's SVG/image composition.
        const url = await Plotly.toImage(host, { format: 'png', width: SIZE, height: SIZE, scale: 1 });
        const bitmap = await createImageBitmap(await (await fetch(url)).blob());
        const out = new OffscreenCanvas(SIZE, SIZE),
          ctx = out.getContext('2d');
        ctx.drawImage(bitmap, 0, 0);
        bitmap.close();
        return { width: SIZE, height: SIZE, rgba: ctx.getImageData(0, 0, SIZE, SIZE).data };
      },
      dispose() {
        Plotly.purge(host);
        host.replaceChildren();
      },
    };
  }
  if (name === 'regl') {
    const { default: createScatterplot } = await import('regl-scatterplot');
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = SIZE;
    host.append(canvas);
    const chart = createScatterplot({
      canvas,
      width: SIZE,
      height: SIZE,
      pointColor: COLOR,
      pointSize: 3,
      opacity: 1,
      backgroundColor: BACKGROUND,
      cameraDistance: 1,
      showReticle: false,
      lassoInitiator: false,
      performanceMode: false,
    });
    await chart.draw(
      data.points.map((p) => p.slice()),
      { transition: false },
    );
    return {
      canvas,
      memory: () => ({ gpuBytes: null, jsDataBytes: null, reason: 'No public live allocation inventory' }),
      async frame() {
        await new Promise((resolve) => {
          chart.subscribe('draw', resolve, 1);
          chart.redraw();
        });
        return copyCanvas(canvas);
      },
      dispose() {
        chart.destroy();
        host.replaceChildren();
      },
    };
  }
  if (name === 'echarts') {
    const echarts = await import('echarts');
    await import('echarts-gl');
    const chart = echarts.init(host, null, { width: SIZE, height: SIZE, devicePixelRatio: 1 });
    const series =
      data.id === 'scatter'
        ? {
            type: 'scatterGL',
            data: data.points.map((p) => p.slice()),
            symbolSize: 3,
            itemStyle: { color: COLOR, opacity: 1 },
            progressive: 0,
            blendMode: 'source-over',
          }
        : {
            type: 'linesGL',
            coordinateSystem: 'cartesian2d',
            polyline: true,
            data: [{ coords: data.points.map((p) => p.slice()) }],
            lineStyle: { color: COLOR, width: 1, opacity: 1 },
            progressive: 0,
            effect: { show: false },
          };
    chart.setOption({
      animation: false,
      backgroundColor: BACKGROUND,
      grid: { left: 0, right: 0, top: 0, bottom: 0 },
      xAxis: { type: 'value', min: -1, max: 1, show: false },
      yAxis: { type: 'value', min: -1, max: 1, show: false },
      series: [series],
    });
    chart.getZr().refreshImmediately();
    const capture = async () => {
      const out = new OffscreenCanvas(SIZE, SIZE),
        ctx = out.getContext('2d');
      ctx.fillStyle = BACKGROUND;
      ctx.fillRect(0, 0, SIZE, SIZE);
      for (const canvas of host.querySelectorAll('canvas')) ctx.drawImage(canvas, 0, 0, SIZE, SIZE);
      return { width: SIZE, height: SIZE, rgba: ctx.getImageData(0, 0, SIZE, SIZE).data };
    };
    return {
      memory: () => ({ gpuBytes: null, jsDataBytes: null, reason: 'No public live allocation inventory' }),
      async frame() {
        chart.getZr().refreshImmediately();
        return capture();
      },
      dispose() {
        chart.dispose();
        host.replaceChildren();
      },
    };
  }
  if (name === 'deck') {
    const { Deck, OrthographicView, COORDINATE_SYSTEM } = await import('@deck.gl/core');
    const { ScatterplotLayer, BitmapLayer } = await import('@deck.gl/layers');
    let layers;
    if (data.id === 'scatter')
      layers = [
        new ScatterplotLayer({
          id: 'shared-points',
          data: data.points,
          coordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
          getPosition: (p) => [p[0], p[1], 0],
          getFillColor: [34, 203, 238, 255],
          getRadius: 1.5,
          radiusUnits: 'pixels',
          stroked: false,
          pickable: false,
          opacity: 1,
        }),
      ];
    else {
      const n = 2 ** data.scale;
      const bitmaps = await Promise.all(
        Array.from({ length: n * n }, async (_, i) => {
          const x = i % n,
            y = Math.floor(i / n),
            src = `/examples/assets/sciviz/geo-lod/2-${x % 4}-${y % 4}.png`;
          const response = await fetch(src, { signal });
          if (!response.ok) throw new Error(`Tile ${src}: ${response.status}`);
          return createImageBitmap(await response.blob());
        }),
      );
      layers = bitmaps.map((image, i) => {
        const x = i % n,
          y = Math.floor(i / n);
        return new BitmapLayer({
          id: `tile-${i}`,
          image,
          coordinateSystem: COORDINATE_SYSTEM.CARTESIAN,
          bounds: [-1 + (2 * x) / n, 1 - (2 * (y + 1)) / n, -1 + (2 * (x + 1)) / n, 1 - (2 * y) / n],
        });
      });
    }
    let resolveLoad, rejectLoad, afterRender, afterError;
    const loaded = new Promise((resolve, reject) => {
      resolveLoad = resolve;
      rejectLoad = reject;
    });
    const deck = new Deck({
      parent: host,
      width: SIZE,
      height: SIZE,
      useDevicePixels: false,
      views: [new OrthographicView({ flipY: false })],
      controller: false,
      initialViewState: { target: [0, 0, 0], zoom: 7 },
      layers,
      parameters: { clearColor: [15 / 255, 20 / 255, 28 / 255, 1] },
      onLoad: () => resolveLoad(),
      onAfterRender: () => {
        if (layers.every((layer) => layer.isLoaded) && afterRender) {
          const ready = afterRender;
          afterRender = undefined;
          ready();
        }
      },
      onError: (error) => {
        rejectLoad(error);
        afterError?.(error);
      },
    });
    await loaded;
    deck.redraw(true);
    const canvas = host.querySelector('canvas');
    return {
      canvas,
      memory: () => ({ gpuBytes: null, jsDataBytes: null, reason: 'No public live allocation inventory' }),
      async frame(frameSignal) {
        frameSignal?.throwIfAborted();
        return new Promise((resolve, reject) => {
          const cleanup = () => {
            frameSignal?.removeEventListener('abort', cancel);
            afterRender = afterError = undefined;
          };
          const cancel = () => {
            cleanup();
            reject(frameSignal.reason);
          };
          frameSignal?.addEventListener('abort', cancel, { once: true });
          afterRender = () => {
            cleanup();
            resolve(copyCanvas(canvas));
          };
          afterError = (error) => {
            cleanup();
            reject(error);
          };
          deck.redraw(true);
        });
      },
      dispose() {
        deck.finalize();
        host.replaceChildren();
      },
    };
  }
  if (name === 'cosmograph') {
    const { Cosmograph } = await import('@cosmograph/cosmograph');
    const graph = new Cosmograph(host, { pixelRatio: 1 });
    const points = Array.from({ length: data.positions.length / 3 }, (_, i) => ({
      id: String(i),
      x: data.positions[3 * i],
      y: data.positions[3 * i + 1],
    }));
    const links = Array.from({ length: data.edges.length / 2 }, (_, i) => ({
      source: String(data.edges[2 * i]),
      target: String(data.edges[2 * i + 1]),
    }));
    await graph.setConfig({
      points,
      links,
      pointIdBy: 'id',
      pointXBy: 'x',
      pointYBy: 'y',
      linkSourceBy: 'source',
      linkTargetBy: 'target',
      enableSimulation: false,
      pixelRatio: 1,
      backgroundColor: BACKGROUND,
      // Documented 2.x names; deprecated aliases and distance fading would change the shared style.
      pointColorStrategy: 'single',
      pointDefaultColor: COLOR,
      linkDefaultColor: COLOR,
      pointDefaultSize: 3,
      linkDefaultWidth: 1,
      linkOpacity: 1,
      linkVisibilityMinTransparency: 1,
      scalePointsOnZoom: false,
      scaleLinksOnZoom: false,
      curvedLinks: false,
      renderLabels: false,
      rescalePositions: false,
      fitViewOnInit: false,
    });
    const sx = graph.rescaleXFn,
      sy = graph.rescaleYFn;
    const corners = new Float32Array([sx ? sx(-1) : -1, sy ? sy(-1) : -1, sx ? sx(1) : 1, sy ? sy(1) : 1]);
    if (![...corners].every(Number.isFinite)) throw new Error('Cosmograph coordinate mapping is not ready');
    graph.setZoomTransformByPointPositions(corners, 0, undefined, 0);
    graph.pause();
    graph.step();
    const canvas = graph.getCanvas();
    return {
      canvas,
      memory: () => ({
        gpuBytes: null,
        jsDataBytes: null,
        stats: graph.stats,
        cameraCorners: [...corners],
        reason: 'No public live allocation inventory',
      }),
      async frame() {
        graph.step();
        return new Promise((resolve) => requestAnimationFrame(() => resolve(copyCanvas(canvas))));
      },
      dispose() {
        graph.destroy();
        host.replaceChildren();
      },
    };
  }
  if (name === 'vtk') return (await import('./vtk.mjs')).vtkRenderer(host, data, signal);
  throw new RangeError(`No rival adapter ${name}`);
}
