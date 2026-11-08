// The development JSX runtime for `jsxImportSource: '@margoengine/react'` (bundlers use it in dev builds): React's
// jsxDEV with the lowercase Margo tags resolved as in ./jsx-runtime.js.
import type * as React from 'react';
import { jsxDEV as reactJsxDEV } from 'react/jsx-dev-runtime';
import { resolveTag } from './intrinsics.js';

export { Fragment } from 'react/jsx-dev-runtime';
export type { JSX } from './jsx-runtime.js';
/** Creates an element with its source position; development compilers call it for JSX. */
export function jsxDEV(
  type: React.ElementType,
  props: unknown,
  key: React.Key | undefined,
  isStatic: boolean,
  source?: unknown,
  self?: unknown,
): React.ReactElement {
  return reactJsxDEV(resolveTag(type), props, key, isStatic, source as never, self);
}
