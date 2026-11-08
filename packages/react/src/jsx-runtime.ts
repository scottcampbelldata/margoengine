// The automatic JSX runtime for `jsxImportSource: '@margoengine/react'`: React's own runtime, with the lowercase tags
// of `extend` (and the built-in `<mesh>`, `<group>`, `<boxGeometry>`, `<meshStandardMaterial>`, `<directionalLight>`)
// drawing Margo components inside a `<Canvas>`. Every other element is exactly what react/jsx-runtime makes.
import type * as React from 'react';
import { jsx as reactJsx, jsxs as reactJsxs } from 'react/jsx-runtime';
import { resolveTag, type MargoElements } from './intrinsics.js';

export { Fragment } from 'react/jsx-runtime';
/** Creates an element; compilers call it for JSX. */
export function jsx(type: React.ElementType, props: unknown, key?: React.Key): React.ReactElement {
  return reactJsx(resolveTag(type), props, key);
}
/** Creates an element with static children; compilers call it for JSX. */
export function jsxs(type: React.ElementType, props: unknown, key?: React.Key): React.ReactElement {
  return reactJsxs(resolveTag(type), props, key);
}
/** React's JSX types plus the {@link MargoElements} tags. */
export declare namespace JSX {
  type ElementType = React.JSX.ElementType;
  interface Element extends React.JSX.Element {}
  interface ElementClass extends React.JSX.ElementClass {}
  interface ElementAttributesProperty extends React.JSX.ElementAttributesProperty {}
  interface ElementChildrenAttribute extends React.JSX.ElementChildrenAttribute {}
  type LibraryManagedAttributes<C, P> = React.JSX.LibraryManagedAttributes<C, P>;
  interface IntrinsicAttributes extends React.JSX.IntrinsicAttributes {}
  interface IntrinsicClassAttributes<T> extends React.JSX.IntrinsicClassAttributes<T> {}
  interface IntrinsicElements extends React.JSX.IntrinsicElements, MargoElements {}
}
