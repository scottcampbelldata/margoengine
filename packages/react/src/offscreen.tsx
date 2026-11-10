import { useRef, useState, type CSSProperties, type ReactNode } from 'react';
import type { AutoScene, AutoSceneOptions } from '@margoengine/worker/auto';
import { useCommit, useResourceEffect } from './internal.js';
import { optionalPeer } from './optional.js';

/** React stays on the page; createScene in this URL runs on the selected thread. */
export interface OffscreenCanvasProps extends AutoSceneOptions {
  /** Absolute module URL exporting createScene(context). Required. */
  scene: URL;
  /** Initial backing width. Default 300; the scene controls subsequent rendering size. */
  width?: number;
  /** Initial backing height. Default 150; the scene controls subsequent rendering size. */
  height?: number;
  /** Page DOM children, for controls/overlays. Never cloned or executed in the worker. */
  children?: ReactNode;
  /** Canvas CSS. Default display block, width/height 100%. */
  style?: CSSProperties;
  className?: string;
  /** Accessible canvas name. Default Margo scene. */
  label?: string;
  /** Receives the selected mode and lifetime owner after startup. Default none. */
  onCreated?: (scene: AutoScene) => void;
  /** Startup and cleanup failures. Default an alert in the DOM. */
  onError?: (error: unknown) => void;
}
/** Worker canvas with automatic page fallback before transfer. Changing startup inputs owns a fresh canvas. */
export function OffscreenCanvas({ scene, width = 300, height = 150, children, style, className, label = 'Margo scene', onCreated, onError, ...options }: OffscreenCanvasProps) {
  const host = useRef<HTMLDivElement>(null);
  const latest = useRef({ onCreated, onError, style, className, label });
  latest.current = { onCreated, onError, style, className, label };
  const [error, setError] = useState<unknown>(null);
  useResourceEffect(() => {
    const element = host.current!;
    const canvas = element.ownerDocument.createElement('canvas');
    canvas.width = width; canvas.height = height;
    canvas.style.cssText = 'display:block;width:100%;height:100%';
    Object.assign(canvas.style, latest.current.style);
    canvas.className = latest.current.className ?? '';
    canvas.setAttribute('role', 'img'); canvas.setAttribute('aria-label', latest.current.label);
    element.appendChild(canvas);
    const lifetime = new AbortController();
    const signal = AbortSignal.any([lifetime.signal, ...(options.signal ? [options.signal] : [])]);
    let running: AutoScene | undefined;
    setError(null);
    const failed = (error: unknown) => { if (!lifetime.signal.aborted) setError(error); latest.current.onError?.(error); };
    void optionalPeer('@margoengine/worker/auto', () => import('@margoengine/worker/auto'))
    .then(({ runScene }) => runScene(canvas, scene, { ...options, signal })).then(async (value) => {
      running = value;
      if (signal.aborted) await value.dispose();
      else latest.current.onCreated?.(value);
    }).catch(error => { if (!signal.aborted) failed(error); });
    return () => {
      lifetime.abort(); canvas.remove();
      void running?.dispose().catch(failed);
    };
  }, [scene.href, width, height, options.mode, options.backend, options.data, options.transfer, options.signal, options.timeout, options.worker]);
  useCommit(() => {
    const canvas = host.current?.querySelector('canvas');
    if (!canvas) return;
    canvas.style.cssText = 'display:block;width:100%;height:100%';
    Object.assign(canvas.style, style);
    canvas.className = className ?? '';
    canvas.setAttribute('aria-label', label);
  }, [style, className, label]);
  return <><div ref={host} />{children}{error !== null && <p role="alert">{String(error)}</p>}</>;
}
