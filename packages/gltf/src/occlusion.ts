const normal = 'vec4f(normalize((f.view*vec4f(s.n,0)).xyz),-(f.view*vec4f(i.position,1)).z)';
const rest = 'select(1.0,s.base.a,f.settings.x>1.5)';
const signature = '@fragment fn fragment(i:Out,@builtin(front_facing) front:bool)->@location(0) vec4f';
const header = 'struct MargoOcclusionOut {@location(0) normal:vec4f,@location(1) ambient:vec4f}\n';
const returns = [
  `return vec4f(margoAmbient,${rest});`,
  `return vec4f(select(margoAmbient,vec3f(0),f.ext.x>0.5),${rest});`,
];

function appended(code: string): { code: string; entry: string } {
  return {
    entry: 'margoOcclusion',
    code:
      code +
      `\n${header}@fragment fn margoOcclusion(i:Out,@builtin(front_facing) front:bool)->MargoOcclusionOut {\n  let s=surface(i,front);\n  return MargoOcclusionOut(${normal},vec4f(ambient(s),${rest}));\n}\n`,
  };
}

/**
 * One fragment writes the SSAO normal target and the ambient target. An IBL shader keeps the `margoAmbient` expression.
 * A shader whose return does not match falls back to `ambient()` rather than a one-output fragment in a two-target pass.
 */
export function occlusionShader(code: string): { code: string; entry: string } {
  if (!code.includes('margoAmbient') || !code.includes(signature)) return appended(code);
  const found = returns.find((line) => code.includes(line));
  if (!found) return appended(code);
  const inner = found.slice('return vec4f('.length, -2);
  const next = code
    .replace(signature, `${header}@fragment fn fragment(i:Out,@builtin(front_facing) front:bool)->MargoOcclusionOut`)
    .replace(found, `return MargoOcclusionOut(${normal},vec4f(${inner}));`);
  if (!next.includes('->MargoOcclusionOut') || next === code) return appended(code);
  return { code: next, entry: 'fragment' };
}
