// No 'use client' here: bundlers warn for a module-level directive, so the "react-server" entry
// (dist/rsc/react.js, written by scripts/react-server-entries.js) is the client boundary for server components.
import type { EngineKernel } from '@margoengine/core';
import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import { fault } from '../../shared/errors.js';
import { Button as ButtonWidget, Slider as SliderWidget, Toggle as ToggleWidget } from './controls.js';
import { HealthBar as HealthBarWidget, ProgressBar as ProgressBarWidget } from './meters.js';
import { Inventory as InventoryWidget, List as ListWidget, Menu as MenuWidget } from './collections.js';
import { Label as LabelWidget, Panel as PanelWidget } from './basic.js';
import { UiRenderer, type UiRendererOptions } from './renderer.js';
import { Ui, type ScaleOptions, type UiOptions } from './ui.js';
import type { Theme } from './theme.js';
import type { LayoutStyle } from './layout.js';
import type { Widget, UiEvent } from './widget.js';
import type { LabelOptions, PanelOptions } from './basic.js';
import type { ButtonOptions, SliderOptions, ToggleOptions } from './controls.js';
import type { HealthBarOptions, ProgressBarOptions } from './meters.js';
import type { InventoryOptions, ListOptions, MenuOptions } from './collections.js';

const UiContext = createContext<Ui | null>(null);
const ParentContext = createContext<Widget | null>(null);

/**
 * The `Ui` of the enclosing {@link UiRoot}: call `ui.toast()`, `ui.dialog()`, `ui.confirm()` or `ui.announce()` from an event handler.
 * @throws Error when used outside a `UiRoot`.
 */
export function useUi(): Ui {
  const ui = useContext(UiContext);
  if (!ui)
    throw fault('state', 'useUi must be used inside <UiRoot>; wrap the interface in <UiRoot engine={engine}>', 'ui');
  return ui;
}

/** Props of {@link UiRoot}. */
export interface UiRootProps {
  /** Draw the UI on this engine (a `UiRenderer` is attached on mount and removed on unmount). Get it from `useEngine()` of `@margoengine/react`. */
  engine?: EngineKernel;
  /** Use a `Ui` you made yourself instead of creating one. It is not disposed on unmount. */
  ui?: Ui;
  /** Options for the `Ui` UiRoot creates (ignored when `ui` is given): size, font, safe area, reduced motion. */
  options?: UiOptions;
  /** Options for the renderer (`input`, `mirror`, `order`, atlas sizes). */
  renderer?: UiRendererOptions;
  /** Restyle the whole UI: `themes.dark`, `themes.highContrast`, or your own. */
  theme?: Theme;
  /** The user's text size, 0.5 to 3. */
  textScale?: number;
  /** Resolution scaling: CSS pixels per UI unit, or a reference size. */
  scale?: number | ScaleOptions;
  children?: ReactNode;
}

/**
 * Hosts a game UI in a React tree. It renders no DOM: the widgets you nest inside are drawn on the engine's canvas. Create
 * it where the engine is known, for example in a child of `<Canvas>` that calls `useEngine()`.
 *
 * @example
 * <UiRoot engine={engine} theme={themes.dark}>
 *   <Panel background="surface" padding={16} anchor="top-left" margin={16}>
 *     <HealthBar value={hp} max={100} width={240} />
 *   </Panel>
 * </UiRoot>
 */
export function UiRoot({
  engine,
  ui: given,
  options,
  renderer,
  theme,
  textScale,
  scale,
  children,
}: UiRootProps): ReactElement {
  const [owned] = useState(() => given ?? new Ui(options));
  const ui = given ?? owned;
  const leaving = useRef(false);
  useEffect(() => {
    leaving.current = false;
    return () => {
      leaving.current = true;
      // StrictMode runs a cleanup and an effect back to back; a real unmount leaves `leaving` set.
      if (!given)
        queueMicrotask(() => {
          if (leaving.current) owned.dispose();
        });
    };
  }, [given, owned]);
  useEffect(() => {
    if (!engine) return;
    const plugin = UiRenderer.attach(engine, ui, renderer);
    return () => engine.removePlugin(plugin.name);
    // The renderer options are read once per attach; change `engine` or `ui` to attach again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, ui]);
  useLayoutEffect(() => {
    if (theme && ui.theme !== theme) ui.theme = theme;
  }, [ui, theme]);
  useLayoutEffect(() => {
    if (textScale !== undefined && ui.textScale !== textScale) ui.textScale = textScale;
  }, [ui, textScale]);
  useLayoutEffect(() => {
    if (scale !== undefined) ui.setScale(scale);
  }, [ui, scale]);
  return (
    <UiContext.Provider value={ui}>
      <ParentContext.Provider value={ui.root}>{children}</ParentContext.Provider>
    </UiContext.Provider>
  );
}

// --- Widget components ---------------------------------------------------------------------------------------------

const STYLE_KEYS = [
  'direction',
  'gap',
  'align',
  'justify',
  'padding',
  'margin',
  'width',
  'height',
  'minWidth',
  'maxWidth',
  'minHeight',
  'maxHeight',
  'grow',
  'shrink',
  'alignSelf',
  'anchor',
  'position',
  'offset',
  'bleed',
  'columns',
  'cellWidth',
  'cellHeight',
  'overflow',
  'wrap',
] as const;
const COMMON_KEYS = ['id', 'visible', 'enabled', 'label', 'description', 'tooltip', 'pointerEvents'] as const;

type Props = Record<string, unknown>;

/** The layout style fields of a props object. */
function styleOf(props: Props): LayoutStyle {
  const style: Record<string, unknown> = {};
  for (const key of STYLE_KEYS) if (props[key] !== undefined) style[key] = props[key];
  return style as LayoutStyle;
}

/**
 * One widget for the life of the component, made during the first render (so children can attach to it) and recreated
 * when `key` changes (options only a constructor reads, such as a slider's range). It joins its parent widget in a layout
 * effect, children before parents, in mount order.
 */
function useWidget<W extends Widget>(create: () => W, key: string, props: Props, apply?: (widget: W) => void): W {
  const made = useRef<{ key: string; widget: W } | null>(null);
  if (!made.current || made.current.key !== key) made.current = { key, widget: create() };
  const widget = made.current.widget;
  const parent = useContext(ParentContext);
  useLayoutEffect(() => {
    if (!parent)
      throw fault('state', 'A widget must be inside <UiRoot>; wrap the interface in <UiRoot engine={engine}>', 'ui');
    parent.add(widget);
    return () => {
      widget.removeFromParent();
    };
  }, [parent, widget]);
  const style = JSON.stringify(styleOf(props));
  const applied = useRef({ widget, style });
  useLayoutEffect(() => {
    if (applied.current.widget !== widget || applied.current.style !== style) {
      if (applied.current.widget === widget) widget.setStyle(JSON.parse(style));
      applied.current = { widget, style };
    }
    if (props.visible !== undefined) widget.visible = props.visible as boolean;
    if (props.enabled !== undefined) widget.enabled = props.enabled as boolean;
    if (props.tooltip !== undefined || widget.tooltip !== undefined)
      widget.tooltip = props.tooltip as string | undefined;
    if (props.label !== undefined) widget.label = props.label as string;
    if (props.description !== undefined || widget.description !== undefined)
      widget.description = props.description as string | undefined;
    apply?.(widget);
  });
  return widget;
}

/** Call `handler` for `type` events of the widget, always the latest function. */
function useEvent(widget: Widget, type: string, handler: ((event: UiEvent) => void) | undefined): void {
  const latest = useRef(handler);
  latest.current = handler;
  useEffect(() => {
    const off = widget.on(type, (event) => latest.current?.(event));
    return off;
  }, [widget, type]);
}

function Nest({ widget, children }: { widget: Widget; children?: ReactNode }): ReactElement {
  return <ParentContext.Provider value={widget}>{children}</ParentContext.Provider>;
}

function creation(props: Props, extra: unknown[] = []): string {
  return JSON.stringify([extra, props.id]);
}
function pick<T extends object>(props: Props, keys: readonly string[]): T {
  const out: Record<string, unknown> = { ...styleOf(props) };
  for (const key of [...COMMON_KEYS, ...keys]) if (props[key] !== undefined) out[key] = props[key];
  return out as T;
}

/** Props of {@link Panel}: its options and React children. */
export type PanelProps = Omit<PanelOptions, 'children'> & { children?: ReactNode };
/** A container with an optional background. Its React children become its child widgets. */
export function Panel(props: PanelProps): ReactElement {
  const p = props as Props;
  const widget = useWidget(
    () => new PanelWidget(pick(p, ['background', 'border', 'shadow', 'radius'])),
    creation(p, [p.radius]),
    p,
    (w) => {
      if (p.background !== undefined) w.background = p.background as never;
      if (p.border !== undefined) w.border = p.border as boolean;
      if (p.shadow !== undefined) w.shadow = p.shadow as boolean;
    },
  );
  return <Nest widget={widget}>{props.children}</Nest>;
}

/** Props of {@link Label}. */
export type LabelProps = LabelOptions;
/** Text. */
export function Label(props: LabelProps): ReactElement | null {
  const p = props as Props;
  useWidget(
    () => new LabelWidget(pick(p, ['text', 'size', 'color', 'align', 'wrap', 'outline', 'lineHeight'])),
    creation(p),
    p,
    (w) => {
      if (p.text !== undefined) w.text = p.text as string;
      if (p.size !== undefined) w.size = p.size as never;
      if (p.color !== undefined) w.color = p.color as string;
      if (p.align !== undefined) w.align = p.align as never;
      if (p.wrap !== undefined) w.wrap = p.wrap as boolean;
      if (p.outline !== undefined) w.outline = p.outline as boolean;
    },
  );
  return null;
}

/** Props of {@link Button}. */
export type ButtonProps = Omit<ButtonOptions, 'onClick'> & { onClick?: (event: UiEvent) => void };
/** A push button. */
export function Button(props: ButtonProps): ReactElement | null {
  const p = props as Props;
  const widget = useWidget(
    () => new ButtonWidget(pick(p, ['text', 'icon', 'variant', 'size'])),
    creation(p),
    p,
    (w) => {
      if (p.text !== undefined) w.text = p.text as string;
      if (p.icon !== undefined) w.icon = p.icon as string;
      if (p.variant !== undefined) w.variant = p.variant as never;
    },
  );
  useEvent(widget, 'click', props.onClick);
  return null;
}

/** Props of {@link Toggle}. */
export type ToggleProps = Omit<ToggleOptions, 'onChange'> & { onChange?: (event: UiEvent) => void };
/** A switch or checkbox; `checked` is controlled: set it from your state, update the state in `onChange`. */
export function Toggle(props: ToggleProps): ReactElement | null {
  const p = props as Props;
  const widget = useWidget(
    () => new ToggleWidget(pick(p, ['text', 'checked', 'variant'])),
    creation(p, [p.variant]),
    p,
    (w) => {
      if (p.text !== undefined) w.text = p.text as string;
      if (p.checked !== undefined) w.checked = p.checked as boolean;
    },
  );
  useEvent(widget, 'change', props.onChange);
  return null;
}

/** Props of {@link Slider}. */
export type SliderProps = Omit<SliderOptions, 'onChange'> & { onChange?: (event: UiEvent) => void };
/** A slider; `value` is controlled like a Toggle's `checked`. */
export function Slider(props: SliderProps): ReactElement | null {
  const p = props as Props;
  const widget = useWidget(
    () => new SliderWidget(pick(p, ['min', 'max', 'step', 'value', 'text', 'showValue', 'format'])),
    creation(p, [p.min, p.max, p.step, p.showValue]),
    p,
    (w) => {
      if (p.value !== undefined) w.value = p.value as number;
    },
  );
  useEvent(widget, 'change', props.onChange);
  return null;
}

/** Props of {@link ProgressBar}. */
export type ProgressBarProps = ProgressBarOptions;
/** A meter with its value written in it. */
export function ProgressBar(props: ProgressBarProps): ReactElement | null {
  const p = props as Props;
  useWidget(
    () => new ProgressBarWidget(pick(p, ['value', 'max', 'text', 'variant', 'display', 'smooth', 'trail'])),
    creation(p, [p.max, p.display, p.trail]),
    p,
    (w) => {
      if (p.value !== undefined) w.value = p.value as number;
      if (p.text !== undefined) w.text = p.text as string;
      if (p.variant !== undefined) w.variant = p.variant as never;
    },
  );
  return null;
}

/** Props of {@link HealthBar}. */
export type HealthBarProps = HealthBarOptions;
/** A progress bar for hit points, with a damage trail. */
export function HealthBar(props: HealthBarProps): ReactElement | null {
  const p = props as Props;
  useWidget(
    () => new HealthBarWidget(pick(p, ['value', 'max', 'text', 'display', 'smooth'])),
    creation(p, [p.max, p.display]),
    p,
    (w) => {
      if (p.value !== undefined) w.value = p.value as number;
      if (p.text !== undefined) w.text = p.text as string;
    },
  );
  return null;
}

/** Props of {@link List}. */
export type ListProps = Omit<ListOptions, 'onSelect' | 'children'> & { onSelect?: (event: UiEvent) => void };
/** A scrolling list of selectable rows; `items` and `selected` are controlled. */
export function List(props: ListProps): ReactElement | null {
  const p = props as Props;
  const widget = useWidget(
    () => new ListWidget(pick(p, ['items', 'selected'])),
    creation(p),
    p,
    (w) => {
      if (p.items !== undefined && JSON.stringify(p.items) !== JSON.stringify(w.items)) w.items = p.items as never;
      if (p.selected !== undefined && p.selected !== w.selected) w.select(p.selected as number);
    },
  );
  useEvent(widget, 'select', props.onSelect);
  return null;
}

/** Props of {@link Inventory}. */
export type InventoryProps = Omit<InventoryOptions, 'onSelect' | 'onMove' | 'onUse'> & {
  onSelect?: (event: UiEvent) => void;
  onMove?: (event: UiEvent) => void;
  onUse?: (event: UiEvent) => void;
};
/** A grid of item slots; `items` is controlled: update your state in `onMove`. */
export function Inventory(props: InventoryProps): ReactElement | null {
  const p = props as Props;
  const widget = useWidget(
    () => new InventoryWidget(pick(p, ['columns', 'slots', 'slotSize', 'slotGap', 'items'])),
    creation(p, [p.columns, p.slots, p.slotSize, p.slotGap]),
    p,
    (w) => {
      if (p.items !== undefined && p.items !== w.items && JSON.stringify(p.items) !== JSON.stringify(w.items))
        w.items = p.items as never;
    },
  );
  useEvent(widget, 'select', props.onSelect);
  useEvent(widget, 'move', props.onMove);
  useEvent(widget, 'use', props.onUse);
  return null;
}

/** Props of {@link Menu}. */
export type MenuProps = Omit<MenuOptions, 'children'>;
/** A titled column of buttons. Entries are created once; give the component a new `key` to change them. */
export function Menu(props: MenuProps): ReactElement | null {
  const p = props as Props;
  useWidget(
    () => new MenuWidget(pick(p, ['title', 'items'])),
    creation(p, [JSON.stringify((p.items as { label: string }[] | undefined)?.map((i) => i.label))]),
    p,
    (w) => {
      if (p.title !== undefined) w.title = p.title as string;
    },
  );
  return null;
}
