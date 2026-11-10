import { useCallback, useRef, useState, type ReactNode } from 'react';
import type { PresentationControls as Controller, PresentationOptions } from '@margoengine/controls/presentation';
import { Group, useFrame, type MeshRef } from './components.js';
import { useCommit, useCreated, useScene } from './internal.js';
import { optionalPeer } from './optional.js';

/** Product rotation with spring motion, bounded angles, polar zoom and snap-back. */
export interface PresentationControlsProps extends PresentationOptions {
  children?: ReactNode;
  enabled?: boolean;
  cursor?: boolean;
  rotation?: readonly [number, number, number];
  domElement?: HTMLElement;
  onError?: (error: unknown) => void;
}
/** Rotate a child group while leaving the camera and React parent transforms intact. */
export function PresentationControls({ children, enabled = true, cursor = true, rotation, domElement, onError, ...options }: PresentationControlsProps) {
  const scene = useScene(), [object, setObject] = useState<MeshRef | null>(null), latest = useRef(options);
  latest.current = options;
  const ref = useCallback((value: MeshRef | null) => { setObject(value); }, []);
  const control = useCreated(scene, {
    load: () => optionalPeer('@margoengine/controls', () => import('@margoengine/controls/presentation')),
    create(api): Controller | null { return object ? new api.PresentationControls(scene.engine, object, { ...latest.current, element: domElement ?? options.element }) : null; },
    dispose(value) { value?.dispose(); }, onError,
  }, [object, domElement, options.element, options.polar?.[0], options.polar?.[1], options.azimuth?.[0], options.azimuth?.[1], options.spring, rotation?.[0], rotation?.[1], rotation?.[2]]);
  useCommit(() => {
    if (!control) return;
    control.enabled = enabled; control.snap = options.snap ?? false; control.speed = options.speed ?? 1;
    control.zoom = options.zoom ?? 1; control.global = options.global ?? false;
    const element = domElement ?? scene.engine.canvas, previous = element.style.cursor;
    if (!cursor || !enabled) return;
    element.style.cursor = 'grab';
    const start = () => { element.style.cursor = 'grabbing'; }, end = () => { element.style.cursor = 'grab'; };
    control.addEventListener('start', start); control.addEventListener('end', end);
    return () => { control.removeEventListener('start', start); control.removeEventListener('end', end); element.style.cursor = previous; };
  }, [control, enabled, cursor, domElement, scene.engine, options.snap, options.speed, options.zoom, options.global]);
  useFrame((_, delta) => { control?.update(delta); }, -1);
  return <Group ref={ref} rotation={rotation}>{children}</Group>;
}
