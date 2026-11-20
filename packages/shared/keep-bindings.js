// Keeping a shader's declared bindings in an `auto` layout (packages/environment/src/volumetric.ts).

/**
 * Every binding the declarations make, used in a dead branch, for an entry point's body. VolumetricFog's froxels read
 * only the clustered lights and area lights, but the lights' bindings bring every hook's (IES, projector, shapes,
 * layers, bounce): an `auto` layout keeps only the bindings the entry point uses, so a bind group of all of them failed
 * validation as soon as such a hook was set (KB-FOG-HOOK-BINDINGS1). Static use is by syntax, so `if(false)` keeps them
 * in the layout and runs nothing: `_=&name;` for a buffer, `_=name;` for a texture or sampler.
 */
export function keepBindings(...declarations) {
  const uses = [];
  for (const code of declarations)
    for (const m of (code ?? '').matchAll(/@group\(\d+\)\s*@binding\(\d+\)\s*var(<[^>]*>)?\s+(\w+)\s*:/g))
      uses.push(m[1] ? `_=&${m[2]};` : `_=${m[2]};`);
  return uses.length ? `if(false){${uses.join('')}}` : '';
}
