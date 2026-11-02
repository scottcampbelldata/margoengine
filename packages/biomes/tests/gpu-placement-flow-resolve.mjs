import { existsSync, realpathSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { transformSync } from 'rolldown/utils';
import { isAbsolute, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
const repository = realpathSync(new URL('../../../', import.meta.url));
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@margoengine/biomes/toolkit')
      return nextResolve(new URL('../src/toolkit.ts', import.meta.url).href, context);
    if (specifier === '@margoengine/biomes/region')
      return nextResolve(new URL('../src/region.ts', import.meta.url).href, context);
    if (specifier === '@margoengine/biomes/relief')
      return nextResolve(new URL('../src/relief.ts', import.meta.url).href, context);
    if (specifier === '@margoengine/biomes/presets')
      return nextResolve(new URL('../src/presets.ts', import.meta.url).href, context);
    if (specifier === '@margoengine/biomes/digest')
      return nextResolve(new URL('../src/digest.ts', import.meta.url).href, context);
    if (/^\.{1,2}\//.test(specifier) && specifier.endsWith('.js') && context.parentURL?.startsWith('file:')) {
      const js = new URL(specifier, context.parentURL),
        ts = new URL(specifier.slice(0, -3) + '.ts', context.parentURL);
      if (!existsSync(js) && existsSync(ts)) {
        const source = realpathSync(ts),
          within = relative(repository, source);
        if (within !== '..' && !within.startsWith('../') && !within.startsWith('..\\') && !isAbsolute(within))
          return nextResolve(pathToFileURL(source).href, context);
      }
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    if (url.endsWith('.ts') && url.startsWith('file:')) {
      return {
        ...result,
        format: 'module',
        source: transformSync(url, String(result.source), { lang: 'ts', target: 'es2022' }).code,
      };
    }
    return result;
  },
});
