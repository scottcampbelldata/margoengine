export const eye=[.31,1.72,5.37];
export function roomCamera(w,h,cropped){
  const fov=(w/h<1?53:37)*(cropped ? .61 : 1);
  return {position:[...eye],target:cropped?[.03,1.28,-2.51]:[.015,1.54,-2.48],fov,near:.16,far:32};
}
export function lightRoom(engine,room){
  engine.scene.background='#252827';
  engine.lighting.direction.set([.34,.77,.51]);
  engine.lighting.radiance.set([.70,.687,.657]);
  engine.lighting.ambient.set([.23,.235,.26]);
  for(const {geometry,material} of room)engine.createMesh().setGeometry(geometry).setMaterial(material);
}
