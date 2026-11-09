// Vite aliases for the points rival. Module names stay in this file, outside packages/.
import { createReadStream, statSync } from 'node:fs';

/** Plugin that serves the Potree folder and lets the page load potree-core from outside the repository. */
export function pointsRivalPlugin(modules, repo, folder) {
  return {
    name: 'allow-rival-points',
    config() {
      return {
        resolve: {
          alias: [
            {
              find: 'potree-core',
              replacement: `${modules}\\potree-core\\dist\\index.js`,
            },
            { find: /^three$/, replacement: `${modules}\\three\\build\\three.module.js` },
            { find: /^three\/(.*)$/, replacement: `${modules}\\three\\$1` },
          ],
        },
        server: { fs: { allow: [repo, modules, folder] } },
      };
    },
    configureServer(server) {
      server.middlewares.use('/rival-data', (req, res, next) => {
        const name = decodeURIComponent((req.url ?? '/').split('?')[0].replace(/^\//, ''));
        if (name !== 'metadata.json' && name !== 'hierarchy.bin' && name !== 'octree.bin') return next();
        const file = `${folder}\\${name}`;
        const size = statSync(file).size;
        const type = name.endsWith('.json') ? 'application/json' : 'application/octet-stream';
        res.setHeader('Accept-Ranges', 'bytes');
        res.setHeader('Content-Type', type);
        const header = req.headers.range;
        const match = typeof header === 'string' ? /^bytes=(\d+)-(\d*)$/.exec(header) : null;
        if (!match) {
          res.setHeader('Content-Length', String(size));
          createReadStream(file).pipe(res);
          return;
        }
        const start = Number(match[1]);
        const end = match[2] ? Number(match[2]) : size - 1;
        res.statusCode = 206;
        res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
        res.setHeader('Content-Length', String(end - start + 1));
        createReadStream(file, { start, end }).pipe(res);
      });
    },
  };
}
