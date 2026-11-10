import { useRef } from 'react';
import type { XRPointerOptions, XRPointerPicker, XRPointerEvent } from '@margoengine/xr/pointer';
import type { MargoPointerEvent, PointerHandlers, Scene } from './internal.js';
import { useResourceEffect, useScene } from './internal.js';
import { useXR } from './xr.js';
import { optionalPeer } from './optional.js';

/** Canvas mesh event enriched with the original XR input and selection hit. */
export type XRMeshPointerEvent = MargoPointerEvent & { xr: XRPointerEvent };
const handlers: Partial<Record<XRPointerEvent['type'], keyof PointerHandlers>> = {
  click: 'onClick',
  pointerover: 'onPointerOver',
  pointerout: 'onPointerOut',
  pointermove: 'onPointerMove',
  pointerdown: 'onPointerDown',
  pointerup: 'onPointerUp',
};
/** Routes a world pointer through the same mesh and parent handlers as Canvas mouse events. */
export function dispatchXRPointer(scene: Scene, event: XRPointerEvent): void {
  const kind = handlers[event.type];
  if (!kind) return;
  const nativeEvent = new PointerEvent(event.type, {
    pointerId: event.pointerId,
    pointerType: event.pointerType,
    buttons: event.buttons,
    button: 0,
  });
  const seen = new Set<unknown>();
  for (let node = scene.engine.meshes.get(event.target.id); node; ) {
    const record = scene.pointerHandlers.get(node.id);
    if (record && !seen.has(record)) {
      seen.add(record);
      const current = record.owner ?? node;
      const pointer: XRMeshPointerEvent = {
        type: event.type,
        nativeEvent,
        xr: event,
        object: event.target,
        mesh: event.target,
        target: event.target,
        currentTarget: current,
        eventObject: current,
        // XR has no screen pixel position. These match PointerEvent's default coordinates.
        clientX: 0,
        clientY: 0,
        x: 0,
        y: 0,
        delta: 0,
        get stopped() {
          return event.stopped;
        },
        stopPropagation: () => event.stopPropagation(),
        setPointerCapture: () => event.setPointerCapture(current),
        releasePointerCapture: () => event.releasePointerCapture(current),
        hasPointerCapture: () => event.hasPointerCapture(current),
      };
      const fn = record[kind] as ((e: XRMeshPointerEvent) => void) | undefined;
      fn?.(pointer);
      if (event.stopped || scene.engine.disposed) break;
    }
    const parent = scene.engine.store.parents[node.id];
    node = parent < 0 ? undefined : scene.engine.meshes.get(parent);
  }
}
/** Props for the XR pointer event bridge. The selection picker is caller-owned. */
export interface XRPointerEventsProps extends Omit<XRPointerOptions, 'onEvent' | 'onError'> {
  picker: XRPointerPicker;
  onEvent?: (event: XRPointerEvent) => void;
  onError?: (error: unknown) => void;
}
/** Mount inside Canvas and XR; existing Mesh onClick/onPointer handlers also receive XR pointers. */
export function XRPointerEvents({ picker, ...options }: XRPointerEventsProps): null {
  const scene = useScene(),
    { manager } = useXR(),
    latest = useRef(options);
  latest.current = options;
  useResourceEffect(
    (lease) => {
      if (!manager) return;
      let dispose: (() => void) | undefined;
      void optionalPeer('@margoengine/xr/pointer', () => import('@margoengine/xr/pointer'))
        .then((api) => {
          if (!lease.active || scene.engine.disposed) return;
          const pointers = api.XRPointerEvents.attach(manager, picker, {
            ...options,
            onEvent(event) {
              latest.current.onEvent?.(event);
              if (lease.active && !event.stopped) dispatchXRPointer(scene, event);
            },
            onError(error) {
              latest.current.onError?.(error);
              scene.engine.onError(error);
            },
          });
          dispose = () => pointers.dispose();
        })
        .catch((error) => {
          if (lease.active) {
            latest.current.onError?.(error);
            scene.engine.onError(error);
          }
        });
      return () => dispose?.();
    },
    [
      manager,
      picker,
      scene,
      options.signal,
      options.types,
      options.touchRadius,
      options.grabRadius,
      options.near,
      options.far,
    ],
  );
  return null;
}
