// Material capture for a lit Scatter (`Scatter.setCapture`): the colour pass's own stage (core's lit shader with
// scatter's vertex, LOD dither, blade normal and maps) ending in the capture hook's `margoSSR` instead of a colour,
// the G-buffer idea of Saito and Takahashi (1990): one pass writes the surface values later passes read. SSR,
// SceneTargets and LightBounce (`@margoengine/post`) all take this contract, shared per model by
// packages/shared/capture.js.

/**
 * What `Scatter.setCapture` takes: `@margoengine/post` SSR's material capture hook (its `SSRCapture`), declared here so
 * scatter does not depend on post. `declarations(code)` returns WGSL declaring `struct MargoSSR` and `fn margoSSR(n:
 * vec3f, v: vec3f, base: vec3f, metal: f32, rough: f32) -> MargoSSR`; `begin()` returns the open pass to draw into.
 */
export interface ScatterCapture {
  declarations(code: string): string;
  readonly targets: readonly GPUColorTargetState[];
  begin(): GPURenderPassEncoder;
}

const head = /(@fragment fn fragment\((?:[^()]|\([^()]*\))*\))->@location\(0\) vec4f \{/;
const tail = /(let direct=[\s\S]*)return (vec4f\([^\n]+\));/;

/**
 * The capture stage of a lit colour stage: its fragment returns `MargoSSR`, the lighting from `let direct=` through the
 * final colour stays in a dead block (so every binding stays statically used, as SSR's material replay does), and
 * `margoPosition` is set where the declarations declare it. Text only; undefined when the stage is not core's lit
 * fragment (a plugin replaced it), so the caller raises a coded error. Runs before the maps' `texturedFragment`, which
 * then reads the base colour, roughness and metalness from the maps and keeps its cut-out discard.
 */
export function captureStage(lit: string, declarations: string): string | undefined {
  if ((lit.match(new RegExp(head, 'g')) ?? []).length !== 1) return undefined;
  // Core's fragment ends at its first closing brace on a line of its own; code appended after it (the LOD fade) stays.
  const at = lit.search(head),
    end = lit.indexOf('\n}', at),
    fragment = end < 0 ? '' : lit.slice(at, end);
  if (!tail.test(fragment)) return undefined;
  const position = declarations.includes('var<private> margoPosition:') ? 'margoPosition=i.position;' : '';
  const body = fragment
    .replace(head, '$1->MargoSSR {')
    .replace(
      tail,
      (_, dead: string, colour: string) =>
        `if(false){${dead}_=${colour};}${position}return margoSSR(n,v,i.color,i.material.y,i.material.x);`,
    );
  return declarations + '\n' + lit.slice(0, at) + body + lit.slice(end);
}
