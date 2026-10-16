export type WorkshopDiagnosticKind = 'metrics' | 'reflection';

/** Demo-only inspection surface. Each successful request owns its JSON string. */
export interface WorkshopDiagnosticElement extends HTMLElement {
  readWorkshopDiagnostics?: (kind?: WorkshopDiagnosticKind) => string;
}

/**
 * Install a synchronous, demand-only reader. Providers must read retained state;
 * they must not advance animation, solve constraints, or start GPU work.
 * Legacy DOM publication is an explicit comparison/debug option only.
 */
export function attachWorkshopDiagnostics(
  parent: WorkshopDiagnosticElement,
  metrics: () => unknown,
  reflection: () => unknown,
  legacy = false,
) {
  if (typeof metrics !== 'function' || typeof reflection !== 'function')
    throw new TypeError('Workshop diagnostic providers must be functions');
  const key = 'readWorkshopDiagnostics',
    previous = Object.getOwnPropertyDescriptor(parent, key),
    previousMetrics = parent.getAttribute('data-metrics'),
    previousReflection = parent.getAttribute('data-reflection');
  let active = true,
    metricsProvider: (() => unknown) | undefined = metrics,
    reflectionProvider: (() => unknown) | undefined = reflection,
    publishedMetrics: string | undefined,
    publishedReflection: string | undefined;
  const read = (kind: WorkshopDiagnosticKind = 'metrics'): string => {
    if (!active) throw new Error('Workshop diagnostics disposed');
    if (kind !== 'metrics' && kind !== 'reflection') throw new TypeError('Unknown workshop diagnostic kind');
    const result = JSON.stringify((kind === 'metrics' ? metricsProvider : reflectionProvider)!());
    if (typeof result !== 'string') throw new TypeError('Workshop diagnostics must produce JSON');
    return result;
  };
  Object.defineProperty(parent, key, { configurable: true, enumerable: false, value: read });
  const publishMetrics = () => {
    if (!active || !legacy) return;
    const result = read('metrics');
    if (!active) return;
    parent.setAttribute('data-metrics', result);
    publishedMetrics = result;
  };
  const publishReflection = () => {
    if (!active || !legacy) return;
    const result = read('reflection');
    if (!active) return;
    parent.setAttribute('data-reflection', result);
    publishedReflection = result;
  };
  const dispose = () => {
    if (!active) return;
    active = false;
    // Release the scene closures even if a consumer made our property permanent.
    metricsProvider = reflectionProvider = undefined;
    try {
      if (Object.getOwnPropertyDescriptor(parent, key)?.value === read) {
        if (previous) Object.defineProperty(parent, key, previous);
        else delete parent.readWorkshopDiagnostics;
      }
    } catch {
      // A retained reader is already disabled. Teardown must still release GPU work.
    }
    if (publishedMetrics !== undefined && parent.getAttribute('data-metrics') === publishedMetrics) {
      if (previousMetrics === null) parent.removeAttribute('data-metrics');
      else parent.setAttribute('data-metrics', previousMetrics);
    }
    if (publishedReflection !== undefined && parent.getAttribute('data-reflection') === publishedReflection) {
      if (previousReflection === null) parent.removeAttribute('data-reflection');
      else parent.setAttribute('data-reflection', previousReflection);
    }
  };
  return { read, publishMetrics, publishReflection, dispose };
}
