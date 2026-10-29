// Each promise returns the complete public namespace for one optional feature.
globalThis.modularFeatures = {
  particles: () => import('@margoengine/creative/particles'),
  targets: () => import('@margoengine/creative/targets'),
  toon: () => import('@margoengine/creative/toon'),
  post: () => import('@margoengine/creative/post'),
  grass: () => import('@margoengine/creative/grass'),
  planet: () => import('@margoengine/creative/planet'),
  sky: () => import('@margoengine/scenery/sky'),
};
