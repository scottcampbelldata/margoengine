/**
 * The texture coordinate sets of one material: `names[n]` is the primvar TEXCOORD_n reads. Textures that name the same
 * primvar share a set, and one that names none reads `st`.
 */
export function uvSets(soft: (message: string) => void, limit = 4) {
  const names: string[] = [];
  return {
    names,
    /** Points a texture info at the set that reads `primvar`, which is added when no set reads it yet. */
    bind(info: { texCoord?: number }, primvar = 'st'): void {
      let set = names.indexOf(primvar);
      if (set < 0) {
        if (names.length >= limit)
          return soft(`unsupported: a material reads more than ${limit} texture coordinate primvars; drop ${primvar}`);
        set = names.push(primvar) - 1;
      }
      if (set) info.texCoord = set;
    },
  };
}
