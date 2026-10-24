// 10,000 objects four ways: static meshes, every mesh moving, instanced, instanced and moving.
import { sceneCases } from '../lib/browser.mjs';

export default {
  name: 'objects',
  title: 'Objects: static, animated, instanced',
  uses: 'gpu',
  cases: sceneCases('objects', { primary: ['cpuMs', 'gpuMs'] }),
};
