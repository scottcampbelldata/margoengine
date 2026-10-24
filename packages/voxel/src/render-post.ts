/**
 * A voxel beauty shader (quads or bevel triangles) turned into a post replay: the same surface, written out as view
 * normal and depth (`gbuffer`), ambient light (`ambient`), both (`occlusion`) or a material capture (`capture`). With a
 * lightmap, charted surfaces replay their baked ambient.
 */
export function voxelPostShader(
  source: string,
  mode: 'gbuffer' | 'ambient' | 'occlusion' | 'capture',
  capture = '',
): string {
  const signature = '@fragment fn fragment(o:Out,@builtin(front_facing) front:bool)->@location(0) vec4f',
    start = source.indexOf(signature),
    tail = source.indexOf('var color=', start),
    end = source.indexOf('\n}', tail),
    ambient = source.includes('let margoAmbient=') ? 'margoAmbient' : 'ambient(s)',
    bakedAmbient = source.includes('var<private> voxelBaked:')
      ? `select(${ambient},s.base.rgb*(1.0-s.metal)*voxelBaked.rgb,voxelBaked.a>0.0)`
      : ambient,
    normal = 'vec4f(normalize((voxelPostView*vec4f(s.n,0)).xyz),-(voxelPostView*vec4f(i.position,1)).z)',
    alpha = 'select(1.0,s.base.a,MODE==3u)',
    dead = source.slice(tail, end).replace(/return (vec4f\([^\n]+?\));/g, '_=$1;');
  if (start < 0 || tail < 0 || end < 0)
    throw new TypeError(
      'VoxelRenderer post replay requires its native material shader; use matching voxel package sources',
    );
  let declarations = '',
    result = '',
    output = '@location(0) vec4f';
  if (mode === 'capture') {
    declarations = capture;
    // SSGI's Surface hook asks for ambient(s). An IBL/sky hook names the actual ambient at the fragment hook point.
    if (ambient === 'margoAmbient') {
      declarations =
        declarations.replace(/ambient\(s\)/g, 'voxelCaptureAmbient') + '\nvar<private> voxelCaptureAmbient:vec3f;\n';
      result += `voxelCaptureAmbient=${bakedAmbient};`;
    }
    if (declarations.includes('var<private> margoPosition:')) result += 'margoPosition=i.position;';
    result += 'return margoCapture(s,v,vec3f(1));';
    output = 'MargoCapture';
  } else if (mode === 'ambient') result = `return vec4f(${bakedAmbient},${alpha});`;
  else {
    declarations = '@group(0) @binding(7) var<uniform> voxelPostView:mat4x4f;\n';
    if (mode === 'gbuffer') result = `return ${normal};`;
    else {
      declarations += 'struct MargoVoxelOcclusion {@location(0) normal:vec4f,@location(1) ambient:vec4f}\n';
      output = 'MargoVoxelOcclusion';
      result = `return MargoVoxelOcclusion(${normal},vec4f(${bakedAmbient},${alpha}));`;
    }
  }
  return (
    declarations +
    source.slice(0, tail).replace(signature, signature.replace('->@location(0) vec4f', `->${output}`)) +
    `if(false){${dead}}${result}` +
    source.slice(end)
  );
}
