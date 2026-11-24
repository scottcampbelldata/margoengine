// decoders installs no engine plugin, but uploadTexture (exported by the dds, ktx, pvr, jxl and ktx2 readers) returns a
// GPU texture whose lifetime its caller owns. The fixture is the smallest caller a game writes: a plugin that reads a
// DDS file, uploads it in setup, uploads it again on a restored device and destroys it on disposal, so the harness sees
// every texture uploadTexture makes released with its owner, on both engines, through loss and repeated attaches.

// A 4x4 RGBA8 DDS with a 2x2 mip: the 128-byte header (DDPF_RGB | DDPF_ALPHAPIXELS, 32 bits, R G B A masks), then the
// level texels.
function dds() {
  const bytes = new Uint8Array(128 + (16 + 4) * 4), view = new DataView(bytes.buffer), u32 = (at, v) => view.setUint32(at, v, true);
  u32(0, 0x20534444);
  u32(4, 124);
  u32(8, 0x2100f);
  u32(12, 4);
  u32(16, 4);
  u32(28, 2);
  u32(76, 32);
  u32(80, 0x41);
  u32(88, 32);
  u32(92, 0xff);
  u32(96, 0xff00);
  u32(100, 0xff0000);
  u32(104, 0xff000000);
  u32(108, 0x401008);
  for (let i = 128; i < bytes.length; i++) bytes[i] = (i * 37) & 255;
  return bytes;
}

export async function fixtures(load = (entry) => import(entry)) {
  const { parseDDS, uploadTexture } = await load('../dist/dds.js');
  const file = parseDDS(dds());
  return [{ name: 'uploadTexture', visible: false, create() {
    let engine, texture, disposed = false;
    const plugin = {
      name: 'owner-decoders-texture',
      setup(e) {
        engine = e;
        texture = uploadTexture(e.gpu, file, { label: 'owner-decoders' });
      },
      // The old texture went with the lost device; the restored one needs its own.
      onDeviceRestored(e) {
        texture = uploadTexture(e.gpu, file, { label: 'owner-decoders' });
      },
      dispose() {
        if (disposed) return;
        disposed = true;
        texture?.destroy();
        texture = undefined;
        engine?.sceneOf(plugin)?.removePlugin(plugin.name);
      },
    };
    return { plugin, dispose: () => plugin.dispose() };
  } }];
}
