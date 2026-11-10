import { createContext, useContext, useMemo, useRef, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { ScrollControls as Controller, ScrollArea, ScrollControlOptions } from '@margoengine/controls/presentation';
import { MargoError } from '@margoengine/math/errors';
import { Group, useFrame, type MeshRef } from './components.js';
import { useCommit, useCreated, useScene } from './internal.js';
import { optionalPeer } from './optional.js';

/** Scroll options plus ownership of the native scroll area. */
export interface ScrollControlsProps extends Omit<ScrollControlOptions, 'element'> {
  children?: ReactNode;
  enabled?: boolean;
  prepend?: boolean;
  style?: CSSProperties;
  onError?: (error: unknown) => void;
}
/** Live damped scroll progress and interval helpers. */
export interface ScrollState {
  readonly offset: number;
  readonly delta: number;
  readonly el: HTMLDivElement;
  readonly fill: HTMLDivElement;
  readonly pages: number;
  readonly horizontal: boolean;
  range(from: number, length: number, margin?: number): number;
  curve(from: number, length: number, margin?: number): number;
  visible(from: number, length: number, margin?: number): boolean;
}
type Value = { area: ScrollArea; control: Controller; state: ScrollState; overlay: HTMLDivElement };
const ScrollContext = createContext<Value | null>(null);
/** Create an accessible native scroller and expose smoothed progress to descendants. */
export function ScrollControls({ children, enabled = true, prepend, style, onError, ...options }: ScrollControlsProps) {
  const scene = useScene(), { pages = 1, distance = 1, horizontal = false, infinite, damping, maxSpeed, eps } = options;
  const value = useCreated(scene, {
    load: () => optionalPeer('@margoengine/controls', () => import('@margoengine/controls/presentation')),
    create(api): Value {
      const area = new api.ScrollArea(scene.engine.canvas, { pages, distance, horizontal, prepend });
      const overlay = area.element.ownerDocument.createElement('div');
      Object.assign(overlay.style, { position: 'sticky', top: '0', left: '0', height: '0', width: '100%' });
      area.element.prepend(overlay);
      let control: Controller;
      try { control = new api.ScrollControls(scene.engine, { ...options, element: area.element }); }
      catch (error) { area.dispose(); throw error; }
      const state: ScrollState = {
        get offset() { return control.offset; }, get delta() { return Math.abs(control.delta); },
        el: area.element, fill: area.content, pages, horizontal,
        range: (...args) => control.range(...args), curve: (...args) => control.curve(...args), visible: (...args) => control.visible(...args),
      };
      return { area, control, state, overlay };
    },
    dispose(value) { value.control.dispose(); value.area.dispose(); }, onError,
  }, [pages, distance, horizontal, infinite, damping, maxSpeed, eps, prepend]);
  useCommit(() => {
    if (!value) return;
    value.control.enabled = enabled;
    value.area.element.style.pointerEvents = enabled ? 'auto' : 'none';
    const saved = value.area.element.style.cssText;
    Object.assign(value.area.element.style, style);
    return () => { value.area.element.style.cssText = saved; };
  }, [value, enabled, style]);
  useFrame((_, delta) => { value?.control.update(delta); }, -1);
  return value ? <ScrollContext.Provider value={value}>{children}</ScrollContext.Provider> : null;
}
function useValue(): Value {
  const value = useContext(ScrollContext);
  if (!value) throw new MargoError('state', 'Scroll helpers require ScrollControls; wrap the component in it.');
  return value;
}
/** Read the live scroll state without scheduling React renders each frame. */
export function useScroll(): ScrollState { return useValue().state; }
/** Contents translated with damped scrolling; html selects an owned DOM portal. */
export interface ScrollProps {
  html?: boolean;
  children?: ReactNode;
  style?: CSSProperties;
}
/** Translate child meshes by the visible world extent or HTML by the CSS viewport extent. */
export function Scroll({ html = false, children, style }: ScrollProps) {
  const { state, overlay } = useValue(), scene = useScene(), group = useRef<MeshRef>(null), node = useRef<HTMLDivElement>(null);
  const projection = useRef(new Float64Array(16));
  const base = useMemo(() => ({ position: 'absolute', inset: 0, ...style }) as CSSProperties, [style]);
  useFrame(() => {
    const span = (state.pages - 1) * state.offset;
    if (html) {
      if (node.current) node.current.style.transform = `translate3d(${state.horizontal ? -span * state.el.clientWidth : 0}px,${state.horizontal ? 0 : -span * state.el.clientHeight}px,0)`;
    } else if (group.current) {
      const camera = scene.engine.camera, distance = Math.hypot(...camera.position.map((v, i) => v - camera.target[i]));
      const aspect = Math.max(1, scene.engine.canvas.clientWidth) / Math.max(1, scene.engine.canvas.clientHeight);
      let height = 2 * distance * Math.tan(camera.fov * Math.PI / 360), width = height * aspect;
      if (camera.project) {
        const matrix = projection.current; matrix.fill(0); camera.project(matrix, aspect, true);
        const extent = matrix[15] ? 1 : distance;
        width = 2 * extent / Math.abs(matrix[0]); height = 2 * extent / Math.abs(matrix[5]);
      }
      group.current.setPosition(state.horizontal ? [-span * width, 0, 0] : [0, span * height, 0]);
    }
  });
  return html ? createPortal(<div ref={node} style={base}>{children}</div>, overlay) : <Group ref={group}>{children}</Group>;
}
