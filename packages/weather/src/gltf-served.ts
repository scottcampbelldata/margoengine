// The models a GLTFWeather weathers (KB-WEATHER-GLTFTWICE1). A `@margoengine/materials` mesh is a gltf/pbr model, so
// `GLTFWeather.add` takes one too; it then carries the puddles, the snow and the GLTFWeather's own cover, and the
// scene's Puddles, Snow and PrecipitationCover must not join it as well (their WGSL would be declared twice and the
// surface wetted twice). Their `materialSurface` effects skip a model counted here.

const served = new WeakMap<object, number>();

/** Counts `model` in (+1) or out (-1) of the models a GLTFWeather weathers. */
export function serveGLTF(model: object, step: 1 | -1): void {
  const count = (served.get(model) ?? 0) + step;
  if (count > 0) served.set(model, count);
  else served.delete(model);
}

/** True while a GLTFWeather weathers `model`: the scene's surface entries then leave it to that GLTFWeather. */
export const servedByGLTF = (model: object): boolean => served.has(model);
