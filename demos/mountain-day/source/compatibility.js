export async function installCompatibility(signal) {
  const [compat] = await Promise.all([
    import('@margoengine/webgl2-compat'),
    import('@margoengine/webgl2-compat/device'),
  ]);
  return compat.install({force:true,signal});
}