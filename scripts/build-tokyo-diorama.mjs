// Rebuilds examples/assets/tokyo-diorama.glb (and the .blend source) in headless Blender 5.3.
import {execFileSync} from 'node:child_process';

const blender = process.env.BLENDER ?? 'C:/Tools/Blender/5.3-Beta/blender-5.3.0-beta+v53.2ebd15112ac6-windows.amd64-release/blender.exe';
execFileSync(blender, ['--background', '--factory-startup', '--python', 'examples/assets/source/tokyo_diorama/build.py', '--',
  '--out', 'examples/assets/tokyo-diorama.glb', '--blend', 'examples/assets/source/tokyo-diorama.blend'], {stdio: 'inherit'});
