import { createContext, useContext, useMemo, useRef, useSyncExternalStore, type ReactNode } from 'react';
import type { EngineKernel } from '@margoengine/core';
import { MargoError } from '@margoengine/math/errors';
import { useFrame } from './components.js';
import { useCommit, useResourceEffect, useScene } from './internal.js';
import { inXRFrame } from './frame-priority.js';
import { adaptiveResolution } from './adaptive-resolution.js';
import { PerformanceController, type PerformanceCallbacks, type PerformanceOptions, type PerformanceSnapshot } from './performance-controller.js';
export { PerformanceController } from './performance-controller.js';
export type { PerformanceOptions, PerformanceCallbacks, PerformanceSnapshot } from './performance-controller.js';

const Context = createContext<PerformanceController | null>(null);
/** Monitor options, an optional measured-duration source and descendants sharing the quality factor. */
export interface PerformanceMonitorProps extends PerformanceOptions {
  children?: ReactNode;
  /** Optional measured milliseconds source, e.g. a previous GPU result. Null skips a sample. Default frame delta. */
  sample?: (engine: EngineKernel, delta: number) => number | null;
}
/** Average measured frame times with a hysteresis deadband, bidirectional quality and an optional stable fallback. */
export function PerformanceMonitor({ children, sample, ...options }: PerformanceMonitorProps) {
  const { engine, frames } = useScene(), latest = useRef({ sample, options }), last = useRef<number | null>(null);
  useCommit(() => { latest.current = { sample, options }; });
  const controller = useMemo(() => new PerformanceController({
    ...options,
    bounds: rate => latest.current.options.bounds?.(rate) ?? [50, rate > 90 ? 90 : 57],
    onIncline: api => latest.current.options.onIncline?.(api), onDecline: api => latest.current.options.onDecline?.(api),
    onChange: api => latest.current.options.onChange?.(api), onFallback: api => latest.current.options.onFallback?.(api),
  }), [engine, options.ms, options.iterations, options.threshold, options.factor, options.step, options.flipflops, options.fallbackFactor]);
  useResourceEffect(() => {
    const visibility = () => { last.current = null; controller.clear(); };
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', visibility);
    return () => { if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', visibility); controller.dispose(); };
  }, [controller]);
  useFrame((handle, delta) => {
    if (typeof document !== 'undefined' && document.hidden) { last.current = null; controller.clear(); return; }
    if (frames.mode === 'demand' && !inXRFrame(frames) && !latest.current.sample) { last.current = null; controller.clear(); return; }
    const now = performance.now(), measured = latest.current.sample ? latest.current.sample(handle, delta) : last.current === null ? null : now - last.current;
    last.current = now;
    if (measured !== null) controller.sample(measured);
  }, -1000000);
  return <Context.Provider value={controller}>{children}</Context.Provider>;
}
/** Read averaged measurements; callbacks may also live on any descendant of PerformanceMonitor. */
export function usePerformanceMonitor(callbacks: PerformanceCallbacks = {}): PerformanceSnapshot {
  const controller = useContext(Context), latest = useRef(callbacks);
  if (!controller) throw new MargoError('state', 'usePerformanceMonitor requires a PerformanceMonitor parent; wrap the caller in PerformanceMonitor. See https://margoengine.com/errors#state');
  useCommit(() => { latest.current = callbacks; });
  useCommit(() => controller.observe({
    onIncline: api => latest.current.onIncline?.(api), onDecline: api => latest.current.onDecline?.(api),
    onChange: api => latest.current.onChange?.(api), onFallback: api => latest.current.onFallback?.(api),
  }), [controller]);
  return useSyncExternalStore(listener => controller.subscribe(listener), () => controller.state, () => controller.state);
}
/** Per-Canvas resolution bounds and reduced-resolution presentation filtering. */
export interface AdaptiveDprProps {
  /** Minimum fraction of native Canvas resolution. Default 0.5. */
  min?: number;
  /** Maximum fraction of native Canvas resolution. Default 1. */
  max?: number;
  /** Use nearest filtering during reduced-resolution presentation. Default false (linear). */
  pixelated?: boolean;
}
function Resolution({ min = 0.5, max = 1, pixelated = false }: AdaptiveDprProps) {
  const controller = useContext(Context)!, { engine, frames } = useScene();
  if (![min, max].every(Number.isFinite) || min <= 0 || min > max || max > 1)
    throw new RangeError('AdaptiveDpr requires 0 < min <= max <= 1.');
  useResourceEffect(() => adaptiveResolution(engine, frames, () => min + (max - min) * controller.state.factor, pixelated), [engine, frames, controller, min, max, pixelated]);
  return null;
}
/** Lower and restore scene resolution from measured performance, independently per Canvas. */
export function AdaptiveDpr(props: AdaptiveDprProps) {
  const parent = useContext(Context);
  return parent ? <Resolution {...props} /> : <PerformanceMonitor><Resolution {...props} /></PerformanceMonitor>;
}
