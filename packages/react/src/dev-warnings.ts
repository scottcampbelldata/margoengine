import { MargoError } from '@margoengine/math/errors';

// Development-only hints. Every call site is wrapped in the guard of dev-mode.ts, so a production
// bundle drops the call and, with `sideEffects: false`, this module with it. Each hint prints once per page load.
const printed = new Set<string>();
function hint(code: 'state' | 'unsupported', key: string, message: string): void {
  if (printed.has(key)) return;
  printed.add(key);
  console.warn(new MargoError(code, message));
}

// Lowercase tag (as written in React Three Fiber JSX) -> the Margo component that does the same job.
const r3fTags: Record<string, string> = {
  mesh: '<Mesh>',
  group: '<Group>',
  boxGeometry: '<BoxGeometry> or <Box>',
  sphereGeometry: '<Sphere>',
  planeGeometry: '<Plane>',
  meshStandardMaterial: '<PbrMaterial>',
  meshPhysicalMaterial: '<PbrMaterial>',
  ambientLight: '<AmbientLight>',
  hemisphereLight: '<HemisphereLight>',
  directionalLight: '<Sun>',
};
const selector = Object.keys(r3fTags)
  .map((tag) => tag.toLowerCase())
  .join(',');
const byLowercase = new Map(Object.entries(r3fTags).map(([tag, component]) => [tag.toLowerCase(), [tag, component]]));

/**
 * Looks for lowercase React Three Fiber tags such as `<mesh>` below `root`. React renders them as unknown DOM
 * elements, so nothing shows in the canvas; the hint names the Margo component to use. Returns true once it found one.
 */
export function warnLowercaseTags(root: ParentNode): boolean {
  const found = root.querySelector(selector);
  if (!found) return false;
  const [tag, component] = byLowercase.get(found.localName)!;
  hint(
    'state',
    `tag:${tag}`,
    `<${tag}> is a DOM element in React, not a Margo component, so it draws nothing; use ${component}, or the namespace form <Margo.${tag}> (import * as Margo from '@margoengine/react').`,
  );
  return true;
}

/** Explains that pointer handlers need `engine.pick`, which the WebGL2 fallback has only with `webglPicking`. */
export function warnPickingWithoutWebGPU(): void {
  hint(
    'unsupported',
    'pick:webgl2',
    'onClick, onPointerOver and onPointerOut never fire on the WebGL2 fallback without webglPicking, because engine.pick needs WebGPU; ' +
      "use loadFallback={() => import('margoengine/webgl/pick')}, handle input on the canvas element yourself, or show fallbackContent without WebGPU (see \"Pointer events and picking\" in the @margoengine/react README).",
  );
}
