import type { EngineKernel } from '@margoengine/core';
import { Stats } from '@margoengine/stats';

type MemoryPerformance = Performance & { memory?: { usedJSHeapSize?: number } };
interface BuildFootprint {
  builtAt: string;
  coreStageGzipBytes: number;
  javascriptBytes: number;
  javascriptGzipBytes: number;
  javascriptChunkCount: number;
  runtimeModuleCount: number;
  runtimeImportCount: number;
  sceneAssetBytes: number;
}

/** Real engine counters and optional browser heap measurements, refreshed outside the render loop. */
export function attachWorkshopStats(engine: EngineKernel, parent: HTMLElement) {
  const stats = Stats.attach(engine, { parent, samples: 120, profiling: true });
  stats.element.dataset.workshopPerformance = '';
  stats.element.id = 'workshop-performance-panel';
  stats.element.setAttribute('aria-label', 'Workshop performance');
  Object.assign(stats.element.style, {
    position: 'relative',
    top: 'auto',
    left: 'auto',
    bottom: 'auto',
    width: '224px',
    maxWidth: '100%',
    padding: '10px 12px',
    background: 'rgba(16, 25, 28, .94)',
    borderColor: '#4a7378',
    borderRadius: '5px',
    color: '#ddf8f8',
    font: '11px/1.5 ui-monospace, SFMono-Regular, Consolas, monospace',
    boxShadow: '0 4px 18px #0002',
    pointerEvents: 'none',
    display: 'none',
  });
  const doc = parent.ownerDocument,
    namespace = 'http://www.w3.org/2000/svg',
    capacity = 120,
    heap = new Float64Array(capacity),
    gpu = new Float64Array(capacity);
  let heapCount = 0,
    heapIndex = 0,
    gpuCount = 0,
    gpuIndex = 0,
    disposed = false;
  const host = doc.createElement('div'),
    toggle = doc.createElement('button'),
    pillText = doc.createElement('span'),
    arrow = doc.createElement('span');
  host.dataset.workshopPerformanceHost = '';
  host.style.cssText =
    'position:fixed;width:224px;display:flex;flex-direction:column;gap:7px;align-items:flex-end;z-index:10000;pointer-events:none';
  toggle.type = 'button';
  toggle.setAttribute('aria-expanded', 'false');
  toggle.setAttribute('aria-controls', stats.element.id);
  toggle.setAttribute('aria-label', 'Expand performance statistics');
  toggle.style.cssText =
    'display:flex;align-items:center;justify-content:space-between;gap:6px;width:224px;max-width:100%;min-height:28px;padding:5px 9px;border:1px solid #4a7378;border-radius:5px;background:rgba(16,25,28,.94);color:#ddf8f8;font:10px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace;white-space:nowrap;cursor:pointer;pointer-events:auto;box-shadow:0 3px 10px #0001';
  pillText.textContent = 'Performance — FPS · JS — MB';
  arrow.textContent = '▾';
  arrow.setAttribute('aria-hidden', 'true');
  toggle.append(pillText, arrow);
  host.append(toggle, stats.element);
  // Portal above the page's transformed light annotation, which otherwise
  // intercepts clicks across the viewport's fixed stacking context.
  doc.body.append(host);
  const view = doc.defaultView,
    mobile = view?.matchMedia?.('(max-width: 640px)'),
    position = () => {
      const bounds = parent.getBoundingClientRect();
      host.style.top = mobile?.matches ? 'auto' : `${bounds.top + 70}px`;
      host.style.bottom = mobile?.matches ? `${(view?.innerHeight ?? bounds.bottom) - bounds.bottom + 80}px` : 'auto';
      host.style.right = `${(view?.innerWidth ?? bounds.right) - bounds.right + (mobile?.matches ? 14 : 18)}px`;
      host.style.maxWidth = `${Math.max(0, bounds.width - 28)}px`;
      host.style.flexDirection = mobile?.matches ? 'column-reverse' : 'column';
    },
    stopPointer = (event: PointerEvent) => event.stopPropagation(),
    expand = (event: MouseEvent) => {
      event.stopPropagation();
      const open = toggle.getAttribute('aria-expanded') !== 'true';
      toggle.setAttribute('aria-expanded', String(open));
      toggle.setAttribute('aria-label', `${open ? 'Collapse' : 'Expand'} performance statistics`);
      stats.element.style.display = open ? 'block' : 'none';
      arrow.textContent = open ? '▴' : '▾';
    };
  position();
  const resize = view?.ResizeObserver ? new view.ResizeObserver(position) : undefined;
  resize?.observe(parent);
  view?.addEventListener('resize', position);
  doc.addEventListener('scroll', position, { capture: true, passive: true });
  mobile?.addEventListener('change', position);
  toggle.addEventListener('pointerdown', stopPointer);
  toggle.addEventListener('click', expand);

  const sparkline = (label: string, color: string) => {
    const block = doc.createElement('div'),
      title = doc.createElement('div'),
      graph = doc.createElementNS(namespace, 'svg'),
      path = doc.createElementNS(namespace, 'polyline');
    block.style.cssText = 'margin-top:8px;padding-top:7px;border-top:1px solid #345056';
    title.style.cssText = 'white-space:pre-line';
    graph.setAttribute('viewBox', '0 0 196 22');
    graph.setAttribute('role', 'img');
    graph.setAttribute('aria-label', label);
    graph.style.cssText = 'display:block;width:100%;height:22px;margin-top:3px;background:#101719';
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', color);
    path.setAttribute('stroke-width', '1.25');
    path.setAttribute('vector-effect', 'non-scaling-stroke');
    graph.append(path);
    block.append(title, graph);
    stats.element.append(block);
    return { block, title, graph, path };
  };
  const gpuChart = sparkline('Recent measured GPU pass time in milliseconds', '#63d9b0'),
    heapChart = sparkline('Recent JavaScript heap usage in megabytes', '#68e2ef');
  gpuChart.block.title =
    'Timestamped main-frame passes. Reflection capture and prefilter use separate encoders and are excluded.';
  gpuChart.title.textContent = 'GPU trace warming up';
  gpuChart.graph.style.display = 'none';
  const footprint = doc.createElement('div'),
    footprintAbort = new AbortController();
  footprint.dataset.buildFootprint = 'pending';
  footprint.style.cssText =
    'margin-top:8px;padding-top:7px;border-top:1px solid #345056;color:#b8cfd0;font-size:9px;line-height:1.7';
  stats.element.append(footprint);
  const location = doc.defaultView?.location,
    development = location?.port === '5191' || /\/skinning-ik\.html$/.test(location?.pathname ?? '');
  if (development) {
    footprint.textContent = 'Build footprint available in standalone preview';
    footprint.dataset.buildFootprint = 'development';
  } else {
    footprint.textContent = 'Loading build footprint…';
    void fetch(new URL('./build-report.json', doc.baseURI), { signal: footprintAbort.signal, cache: 'no-cache' })
      .then(async (response) => {
        if (!response.ok) throw new Error('Build footprint unavailable');
        const report = (await response.json()) as BuildFootprint;
        if (disposed) return;
        const counts = [
          report.coreStageGzipBytes,
          report.javascriptBytes,
          report.javascriptGzipBytes,
          report.javascriptChunkCount,
          report.runtimeModuleCount,
          report.runtimeImportCount,
          report.sceneAssetBytes,
        ];
        if (typeof report.builtAt !== 'string' || counts.some((value) => !Number.isSafeInteger(value) || value < 0))
          throw new Error('Invalid build footprint');
        footprint.textContent = '';
        const rows = doc.createElement('dl');
        rows.style.cssText = 'display:grid;grid-template-columns:1fr auto;gap:0 5px;margin:0';
        for (const [label, value] of [
          ['Core + stage', `${(report.coreStageGzipBytes / 1024).toFixed(2)} KiB gzip`],
          ['Demo JS · all chunks', `${(report.javascriptGzipBytes / 1024).toFixed(1)} KiB gzip`],
          ['Scene assets', `${(report.sceneAssetBytes / (1024 * 1024)).toFixed(2)} MiB`],
        ]) {
          const term = doc.createElement('dt'),
            detail = doc.createElement('dd');
          term.textContent = label;
          detail.textContent = value;
          detail.style.cssText = 'margin:0;text-align:right;white-space:nowrap';
          rows.append(term, detail);
        }
        footprint.append(rows);
        footprint.title =
          `Built snapshot ${report.builtAt}; ${report.javascriptChunkCount} JavaScript files, ` +
          `${report.runtimeModuleCount} bundled modules, ${report.runtimeImportCount} chunk import references. ` +
          `Demo JavaScript raw ${report.javascriptBytes} bytes. Gzip sizes are build measurements, not measured network transfer.`;
        footprint.setAttribute('aria-label', footprint.title);
        footprint.dataset.buildFootprint = 'ready';
        stats.element.dataset.footprint = JSON.stringify(report);
      })
      .catch(() => {
        if (!disposed && !footprintAbort.signal.aborted) {
          footprint.textContent = 'Build footprint unavailable';
          footprint.dataset.buildFootprint = 'unavailable';
        }
      });
  }

  const draw = (values: Float64Array, count: number, index: number, path: SVGPolylineElement) => {
    let min = Infinity,
      max = -Infinity;
    for (let i = 0; i < count; i++) {
      min = Math.min(min, values[i]);
      max = Math.max(max, values[i]);
    }
    const start = count === capacity ? index : 0,
      range = Math.max(max - min, Math.abs(max) * 0.005, 0.01),
      points: string[] = [];
    for (let i = 0; i < count; i++)
      points.push(
        `${((i / (capacity - 1)) * 196).toFixed(1)},${(20 - ((values[(start + i) % capacity] - min) / range) * 18).toFixed(1)}`,
      );
    path.setAttribute('points', points.join(' '));
    return { min, max };
  };
  const refresh = () => {
    if (disposed) return;
    const bytes = (performance as MemoryPerformance).memory?.usedJSHeapSize;
    let heapLabel = 'JS n/a';
    if (typeof bytes === 'number' && Number.isFinite(bytes) && bytes > 0) {
      const megabytes = bytes / (1024 * 1024);
      heapLabel = `JS ${megabytes.toFixed(0)} MB`;
      heap[heapIndex] = megabytes;
      heapIndex = (heapIndex + 1) % capacity;
      heapCount = Math.min(capacity, heapCount + 1);
      const { min, max } = draw(heap, heapCount, heapIndex, heapChart.path);
      heapChart.title.textContent = `JS heap ${megabytes.toFixed(1)} MB\n${min.toFixed(1)}–${max.toFixed(1)} MB · rolling 60 s`;
      heapChart.graph.style.display = 'block';
    } else {
      heapChart.title.textContent = 'JS heap unavailable\nNot exposed by this browser';
      heapChart.graph.style.display = 'none';
    }
    pillText.textContent = `Performance ${stats.sampleCount ? stats.fps.toFixed(0) : '—'} FPS · ${heapLabel}`;
    const milliseconds = stats.gpuTime;
    if (milliseconds !== null && Number.isFinite(milliseconds)) {
      gpu[gpuIndex] = milliseconds;
      gpuIndex = (gpuIndex + 1) % capacity;
      gpuCount = Math.min(capacity, gpuCount + 1);
      const { min, max } = draw(gpu, gpuCount, gpuIndex, gpuChart.path);
      gpuChart.title.textContent = `GPU passes ${min.toFixed(2)}–${max.toFixed(2)} ms`;
      gpuChart.graph.style.display = 'block';
    } else {
      gpuChart.title.textContent =
        stats.gpuPassMilliseconds === null ? 'GPU trace unavailable' : 'GPU trace warming up';
      gpuChart.graph.style.display = 'none';
    }
  };
  refresh();
  const timer = setInterval(refresh, 500);
  return {
    stats,
    dispose() {
      if (disposed) return;
      disposed = true;
      clearInterval(timer);
      footprintAbort.abort();
      resize?.disconnect();
      view?.removeEventListener('resize', position);
      doc.removeEventListener('scroll', position, true);
      mobile?.removeEventListener('change', position);
      toggle.removeEventListener('pointerdown', stopPointer);
      toggle.removeEventListener('click', expand);
      host.remove();
      // Stage disposal owns the Stats plugin, its profiler, timer and element.
    },
  };
}
