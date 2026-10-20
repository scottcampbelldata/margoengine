// The diffuse comparison scene under MagicaVoxel's atmosphere sky (`_env _mode 1`): lit at sun 50, 20 and 5 degrees
// (camera slot 1 of the v2 scenes) and two views tilted up to show the sky. Run in test-results/pt-compare/atm.
const { read, write } = require('./voxchunks.cjs');
const scenes = [
  ['atm-e50', 50],
  ['atm-e20', 20],
  ['atm-e5', 5],
  ['atm-sky-e5', 5, -130],
  ['atm-sky-e20', 20, 50],
];
for (const [name, el, yaw] of scenes) {
  const v = read(`${process.cwd()}/../v2/diffuse.vox`);
  for (const c of v.chunks) {
    if (c.id === 'rOBJ' && c.dict._type === '_env') c.dict._mode = '1';
    if (c.id === 'rOBJ' && c.dict._type === '_inf') c.dict._angle = `${el} 50`;
    if (yaw !== undefined && c.id === 'rCAM' && c.cam === 1) c.dict._angle = `-6 ${yaw} 0`;
  }
  write(`${process.cwd()}/${name}.vox`, v);
  console.log(name);
}
