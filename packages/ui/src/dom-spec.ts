import { Label, Panel } from './basic.js';
import { Inventory, List, type ListItem } from './collections.js';
import { Button, Slider, Toggle } from './controls.js';
import { ProgressBar } from './meters.js';
import { Dialog, Toast, Tooltip } from './overlays.js';
import { VirtualList } from './virtual.js';
import type { Widget } from './widget.js';

/** @internal Attributes of a widget's element; null removes one. */
export type Attrs = Record<string, string | null>;
/** @internal The element a widget maps to: the screen reader mirror and the DOM host both build from it. */
export interface Spec {
  tag: string;
  attrs: Attrs;
  text?: string;
  /** Children are mirrored inside this element. */
  container: boolean;
  /** `value` property of a range input. */
  value?: string;
}

/** @internal The widget has no element and neither do its children. */
export const SKIP = Symbol('skip');

/**
 * @internal Map a widget to its accessible element (WAI-ARIA 1.2 roles and states). `prefix` starts every element id,
 * so the hidden mirror (`margo-ui-`) and a visible DOM host (`margo-dom-`) can share a page. Returns null for a widget
 * that has no element of its own (its children are placed in its parent's element).
 */
export function describeWidget(w: Widget, prefix: string): Spec | typeof SKIP | null {
  if (w instanceof Tooltip) return SKIP;
  if (w instanceof Label) {
    return w.parent instanceof Toast ? SKIP : { tag: 'p', attrs: {}, text: w.text, container: false };
  }
  if (w instanceof Toggle)
    return {
      tag: 'button',
      attrs: { type: 'button', role: w.role, 'aria-checked': String(w.checked), disabled: w.active ? null : '' },
      text: w.label,
      container: false,
    };
  if (w instanceof Button)
    return {
      tag: 'button',
      attrs: { type: 'button', disabled: w.active ? null : '' },
      text: w.label,
      container: false,
    };
  if (w instanceof Slider)
    return {
      tag: 'input',
      attrs: {
        type: 'range',
        min: String(w.min),
        max: String(w.max),
        step: w.step > 0 ? String(w.step) : 'any',
        'aria-label': w.label || 'Slider',
        'aria-valuetext': w.valueText,
        disabled: w.active ? null : '',
      },
      value: String(w.value),
      container: false,
    };
  if (w instanceof ProgressBar)
    return {
      tag: 'div',
      attrs: {
        role: 'progressbar',
        'aria-label': w.label || 'Progress',
        'aria-valuemin': '0',
        'aria-valuemax': String(w.max),
        'aria-valuenow': String(w.value),
        'aria-valuetext': w.valueText,
      },
      container: false,
    };
  if (w instanceof List)
    return { tag: 'div', attrs: { role: 'listbox', 'aria-label': w.label || 'List' }, container: true };
  if (w.role === 'option' && w.parent instanceof List)
    return {
      tag: 'div',
      attrs: {
        role: 'option',
        tabindex: w.active ? '0' : null,
        'aria-selected': String(w.parent.children.indexOf(w) === w.parent.selected),
        'aria-disabled': w.active ? null : 'true',
      },
      text: w.label,
      container: false,
    };
  if (w instanceof VirtualList)
    return { tag: 'div', attrs: { role: 'listbox', 'aria-label': w.label || 'List' }, container: true };
  // A virtual list mirrors only its built rows; each says where it stands in the whole list (WAI-ARIA 1.2 setsize, posinset).
  if (w.role === 'option' && w.parent instanceof VirtualList) {
    const row = w as ListItem;
    return {
      tag: 'div',
      attrs: {
        role: 'option',
        tabindex: w.active ? '0' : null,
        'aria-selected': String(row.selected),
        'aria-disabled': w.active ? null : 'true',
        'aria-setsize': String(w.parent.count),
        'aria-posinset': String(row.index + 1),
      },
      text: w.label,
      container: false,
    };
  }
  if (w instanceof Inventory)
    return { tag: 'div', attrs: { role: 'group', 'aria-label': w.label || 'Inventory' }, container: true };
  if (w.parent instanceof Inventory)
    return {
      tag: 'button',
      attrs: { type: 'button', 'aria-pressed': String(w.parent.carried === w.parent.children.indexOf(w)) },
      text: w.label,
      container: false,
    };
  if (w instanceof Dialog)
    return {
      tag: 'div',
      attrs: {
        role: 'dialog',
        'aria-modal': 'true',
        'aria-label': w.find(`${w.id}-title`) ? null : w.label,
        'aria-labelledby': w.find(`${w.id}-title`) ? `${prefix}${w.id}-title` : null,
        'aria-describedby': w.find(`${w.id}-message`) ? `${prefix}${w.id}-message` : null,
      },
      container: true,
    };
  if (w instanceof Toast) return { tag: 'div', attrs: { role: 'group', 'aria-label': w.label }, container: true };
  if (w instanceof Panel && w.label)
    return { tag: 'div', attrs: { role: 'group', 'aria-label': w.label }, container: true };
  return null;
}
