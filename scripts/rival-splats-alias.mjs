// Vite aliases and the truck files for the splat rival. Module names stay in this file, outside packages/.
// The install and the scene stay outside the repository. This file does not read that library's source.
import { createReadStream, statSync } from 'node:fs';
import { join } from 'node:path';

const FILES = new Set(['truck-7k.ply', 'truck-7k-fit.ply', 'truck-000001.jpg', 'truck-cameras.json']);

/** Plugin that lets the page load the rival and the truck scene from outside the repository. */
export function splatsRivalPlugin(modules, dataDir, repo) {
  return {
    name: 'allow-rival-splats',
    config() {
      return {
        resolve: {
          alias: [
            {
              find: '@mkkellogg/gaussian-splats-3d',
              replacement: join(modules, '@mkkellogg', 'gaussian-splats-3d', 'build', 'gaussian-splats-3d.module.js'),
            },
            { find: 'three', replacement: join(modules, 'three', 'build', 'three.module.js') },
          ],
        },
        server: {
          fs: { allow: [repo, modules, dataDir] },
          headers: {
            'Cross-Origin-Opener-Policy': 'same-origin',
            'Cross-Origin-Embedder-Policy': 'require-corp',
          },
        },
      };
    },
    configureServer(server) {
      server.middlewares.use('/rival-data', (req, res, next) => {
        const name = decodeURIComponent((req.url ?? '/').split('?')[0].replace(/^\//, ''));
        if (!FILES.has(name)) return next();
        const file = join(dataDir, name);
        res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
        res.setHeader('Content-Length', String(statSync(file).size));
        createReadStream(file).pipe(res);
      });
    },
  };
}
