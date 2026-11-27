export async function installCompatibility(signal){
  const {install}=await import('@margoengine/webgl2-compat');
  await install({force:true,signal});
}
