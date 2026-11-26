// Serves the Truck scene files (the cloud, the photograph and the cameras) to the truck photograph check
// (packages/splats/scripts/truck-photo.mjs). The scene stays outside the repository.
import { createReadStream, statSync } from 'node:fs';
import { join } from 'node:path';

const FILES = new Set(['truck-7k.ply', 'truck-7k-fit.ply', 'truck-000001.jpg', 'truck-cameras.json']);

/** Plugin that serves the truck scene from `dataDir` at /rival-data/ and isolates the page (COOP and COEP). */
export function splatsTruckPlugin(dataDir, repo) {
  return {
    name: 'allow-splats-truck',
    config() {
      return {
        server: {
          fs: { allow: [repo, dataDir] },
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
