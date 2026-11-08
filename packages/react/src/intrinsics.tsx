import { createElement, forwardRef, useContext, type ElementType, type RefAttributes } from 'react';
import type { Vec3 } from '@margoengine/core/extension';
import type { ColorInput } from '@margoengine/math';
import { Mesh, BoxGeometry, PbrMaterial, type MeshProps, type MeshRef, type PbrMaterialProps } from './components.js';
import { Sun } from './sun.js';
import { Context } from './internal.js';

/** Props of `<directionalLight>`: the light shines from `position` towards the origin, as `<Sun direction>` does. */
export interface DirectionalLightProps {
  /** Where the light sits; it shines towards [0, 0, 0]. Default [0, 1, 0], straight down. */
  position?: Vec3;
  /** Hex is sRGB, `[r, g, b]` linear. Default '#ffffff'. */
  color?: ColorInput;
  /** Default 3, the `<Sun>` default. */
  intensity?: number;
}
const up: Vec3 = [0, 1, 0];
/** `<directionalLight>`: `<Sun>` with the light's position as the direction towards it. */
function DirectionalLight({ position = up, color, intensity }: DirectionalLightProps) {
  return <Sun direction={position} color={color} intensity={intensity} />;
}

/**
 * The lowercase tags `@margoengine/react/jsx-runtime` turns into Margo components inside a `<Canvas>`, by tag name.
 * Add your own with {@link extend}, and their prop types by augmenting this interface:
 * `declare module '@margoengine/react' { interface MargoElements { sphereGeometry: ComponentProps<typeof SphereGeometry> } }`.
 */
export interface MargoElements {
  mesh: MeshProps & RefAttributes<MeshRef>;
  group: MeshProps & RefAttributes<MeshRef>;
  boxGeometry: { args?: Vec3 };
  meshStandardMaterial: PbrMaterialProps;
  directionalLight: DirectionalLightProps;
}

// Tag -> component. Built-ins are root components only, so this entry reaches no optional package.
const components = new Map<string, ElementType>([
  ['mesh', Mesh],
  ['group', Mesh],
  ['boxGeometry', BoxGeometry],
  ['meshStandardMaterial', PbrMaterial],
  ['directionalLight', DirectionalLight],
]);
// Tag -> the stable element type the JSX runtime hands React, so a tag keeps its identity across extend() calls.
const elements = new Map<string, ElementType>();

const isComponent = (value: unknown) =>
  typeof value === 'function' || (typeof value === 'object' && value !== null && '$$typeof' in value);

/**
 * Makes more lowercase JSX tags draw Margo components, like react-three-fiber's `extend`: each key, with its first
 * letter lowercased, becomes a tag (`extend({ SphereGeometry })` gives `<sphereGeometry>`). Values are React
 * components (from any `@margoengine/react/<entry>` or your own), not engine classes. Tags work in files compiled with
 * `jsxImportSource: '@margoengine/react'`. A later call for the same tag replaces it; the tags are shared by the page.
 */
export function extend(table: Record<string, ElementType>): void {
  for (const [name, component] of Object.entries(table)) {
    if (!name || !isComponent(component))
      throw new TypeError(
        `extend({ ${name || '""'} }) needs a React component as the value; pass the component itself, for example extend({ SphereGeometry }) with SphereGeometry imported from '@margoengine/react/geometry'.`,
      );
    components.set(name[0].toLowerCase() + name.slice(1), component);
  }
}

/**
 * The element type the JSX runtime renders for `type`: a known lowercase tag becomes an element that draws its Margo
 * component inside a `<Canvas>` and stays the plain DOM tag outside one (so an SVG `<line>` keeps working after
 * `extend({ line: ... })`); every other type passes through unchanged.
 */
export function resolveTag(type: ElementType): ElementType {
  if (typeof type !== 'string' || !components.has(type)) return type;
  let element = elements.get(type);
  if (!element) {
    const tag = type;
    element = forwardRef<unknown, Record<string, unknown>>(function MargoTag(props, ref) {
      const inside = useContext(Context) !== null;
      return createElement(inside ? components.get(tag)! : tag, ref == null ? props : { ...props, ref });
    });
    (element as { displayName?: string }).displayName = tag;
    elements.set(tag, element);
  }
  return element;
}
