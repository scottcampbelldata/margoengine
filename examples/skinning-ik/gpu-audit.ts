import type { Engine } from '@margoengine/core/extension';
import type { Stats } from '@margoengine/stats';

type Context = Record<string, number | boolean | null>;
interface AuditOptions {
  engine?: Pick<Engine, 'onFrame'>;
  /** Current host-side context, such as probe encoding/readback durations. It is not GPU pass attribution. */
  report?: () => Context;
}
interface Action {
  id: number;
  at: number;
  type: string;
  target: string;
  detail?: string | number | boolean;
}
interface Sample {
  id: number;
  observedAt: number;
  encodedAt: number;
  readAt: number;
  passSumMs: number;
  spanMs: number | null;
  passCount: number;
  passesMs: number[];
  largestPass: { index: number; milliseconds: number };
  precedingAction: (Action & { ageAtEncodingMs: number }) | null;
  currentCounters: { drawCalls: number; dispatches: number; cpuSampleIndex: number };
  contextObservedNow: Context;
}

/** Timestamped diagnostic data only; no visible overlay and no causal attribution. */
export function attachGPUAudit(stats: Stats, parent: HTMLElement, { engine, report }: AuditOptions = {}) {
  const doc = parent.ownerDocument,
    view = doc.defaultView,
    now = () => view?.performance.now() ?? performance.now(),
    actions: Action[] = [],
    samples: Sample[] = [],
    pointers = new Set<number>();
  let disposed = false,
    actionId = 0,
    lastId = 0,
    observed = 0,
    missed = 0,
    sized = false,
    publishedAt = -Infinity,
    peak: Sample | null = null;
  const action = (type: string, target: string, detail?: string | number | boolean) => {
    actions.push({ id: ++actionId, at: now(), type, target, ...(detail === undefined ? {} : { detail }) });
    if (actions.length > 20) actions.shift();
  };
  const targetLabel = (target: EventTarget | null): string => {
    const element = target as Element | null;
    if (!element || element.nodeType !== 1) return 'document';
    const control = element.closest('button,input,select,canvas,[role="button"]') ?? element;
    const pose = control.getAttribute('data-pose');
    return (
      pose
        ? 'pose:' + pose
        : control.id
          ? '#' + control.id
          : (control.getAttribute('aria-label') ?? control.tagName.toLowerCase())
    ).slice(0, 100);
  };
  const pointer = (event: Event) => {
    const e = event as PointerEvent;
    if (e.type === 'pointerdown') pointers.add(e.pointerId);
    else pointers.delete(e.pointerId);
    action(e.type, targetLabel(e.target), e.pointerType || 'pointer');
  };
  const input = (event: Event) => {
    const control = event.target as HTMLInputElement;
    let detail: number | boolean | undefined;
    if (control.type === 'checkbox') detail = control.checked;
    else if (control.type === 'range' && Number.isFinite(control.valueAsNumber)) detail = control.valueAsNumber;
    action(event.type, targetLabel(control), detail);
  };
  const click = (event: Event) => {
    const element = event.target as Element | null,
      button = element?.closest?.('button');
    if (button) action(button.id.startsWith('view-') ? 'view' : 'button', targetLabel(button));
  };
  const visibility = () => action('visibility', 'document', doc.visibilityState);
  for (const type of ['pointerdown', 'pointerup', 'pointercancel']) doc.addEventListener(type, pointer, true);
  doc.addEventListener('input', input, true);
  doc.addEventListener('change', input, true);
  doc.addEventListener('click', click, true);
  doc.addEventListener('visibilitychange', visibility);
  const resize = view?.ResizeObserver
    ? new view.ResizeObserver(() => {
        const bounds = parent.getBoundingClientRect();
        action(
          sized ? 'viewport-resize' : 'viewport-initial-size',
          parent.id ? '#' + parent.id : 'viewport',
          `${Math.round(bounds.width)}x${Math.round(bounds.height)}`,
        );
        sized = true;
      })
    : undefined;
  resize?.observe(parent);
  const capture = () => {
    if (disposed) return;
    const id = stats.gpuSampleId,
      encodedAt = stats.gpuSampleEncodedAt,
      readAt = stats.gpuSampleReadAt,
      duration = stats.gpuTime,
      passes = stats.gpuPassMilliseconds,
      count = stats.gpuPassCount;
    if (id <= lastId || duration === null || encodedAt === null || readAt === null || !passes || count < 1) return;
    if (observed) missed += Math.max(0, id - lastId - 1);
    lastId = id;
    observed++;
    const values = Array.from(passes.subarray(0, count));
    let largest = 0;
    for (let i = 1; i < values.length; i++) if (values[i] > values[largest]) largest = i;
    const preceding = [...actions].reverse().find((event) => event.at <= encodedAt);
    let context: Context = {};
    try {
      context = report?.() ?? {};
    } catch {
      /* Diagnostics must not interrupt rendering. */
    }
    const sample: Sample = {
      id,
      observedAt: now(),
      encodedAt,
      readAt,
      passSumMs: duration,
      spanMs: stats.gpuElapsedMilliseconds,
      passCount: count,
      passesMs: values,
      largestPass: { index: largest, milliseconds: values[largest] },
      precedingAction: preceding ? { ...preceding, ageAtEncodingMs: encodedAt - preceding.at } : null,
      currentCounters: { drawCalls: stats.drawCalls, dispatches: stats.dispatches, cpuSampleIndex: stats.sampleIndex },
      contextObservedNow: context,
    };
    samples.push(sample);
    if (samples.length > 20) samples.shift();
    if (!peak || duration > peak.passSumMs) peak = sample;
  };
  const snapshot = () => {
    capture();
    const bounds = parent.getBoundingClientRect();
    return {
      version: 1,
      interpretation: 'Temporal correlation only; the preceding UI action is not proof of causation.',
      timingScope:
        'Sum of timestamped passes on the Stats-tracked main encoder. Separate probe capture/prefilter encoders are excluded.',
      timestampMeaning:
        'Milliseconds from performance.timeOrigin. encodedAt is CPU encoder.finish time; readAt is CPU readback completion. Neither is GPU execution host time.',
      passMeaning:
        'Zero-based profiled pass indices; pass labels are unavailable. Current counters/context are observed later and are not attributed to that sampled encoder.',
      timeOrigin: view?.performance.timeOrigin ?? performance.timeOrigin,
      observedAt: now(),
      viewport: {
        width: Math.round(bounds.width),
        height: Math.round(bounds.height),
        devicePixelRatio: view?.devicePixelRatio ?? 1,
      },
      activePointers: pointers.size,
      currentAction: actions.at(-1) ?? null,
      observedSamples: observed,
      skippedSampleIds: missed,
      latest: samples.at(-1) ?? null,
      peakObservedSinceAttach: peak,
      recentSamples: [...samples],
      recentActions: [...actions],
    };
  };
  const update = () => {
    if (disposed) return;
    capture();
    const at = now();
    if (at - publishedAt < 500) return;
    publishedAt = at;
    parent.dataset.gpuAudit = JSON.stringify(snapshot());
  };
  const removeFrame = engine?.onFrame(update),
    timer = setInterval(update, 500);
  action('audit-attached', parent.id ? '#' + parent.id : 'viewport');
  update();
  return {
    snapshot,
    mark(type: string, detail?: string | number | boolean) {
      if (!disposed) action(type, 'application', detail);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      clearInterval(timer);
      removeFrame?.();
      resize?.disconnect();
      pointers.clear();
      for (const type of ['pointerdown', 'pointerup', 'pointercancel']) doc.removeEventListener(type, pointer, true);
      doc.removeEventListener('input', input, true);
      doc.removeEventListener('change', input, true);
      doc.removeEventListener('click', click, true);
      doc.removeEventListener('visibilitychange', visibility);
      delete parent.dataset.gpuAudit;
    },
  };
}
