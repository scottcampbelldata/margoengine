#!/usr/bin/env node
// npm create margo@latest [dir] [-- --template <name>]: copies a template into dir. Node stdlib only, no prompts.
import { cpSync, existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Each template and what it starts; `shared` adds the Vite files (tsconfig, public/, .gitignore) every Vite app uses. */
const TEMPLATES = {
  web: { about: 'a lit scene with orbit controls and quality tiers (default)', shared: true },
  game: { about: 'a small physics game with the margoengine/game kit and Rapier', shared: true },
  cad: { about: 'a CAD viewer: CAD mouse profiles, view cube, section plane, STEP/IGES/STL import', shared: true },
  viz: { about: 'a point-cloud visualization with grid and labels (margoengine/viz)', shared: true },
  react: { about: 'React + Vite with margoengine/react', shared: true },
  next: { about: 'Next.js (app router) with margoengine/react', shared: false },
};
const usage = `Usage: npm create margo@latest [directory] [-- --template <name>]   (default: margo-app, web)

Templates:
${Object.entries(TEMPLATES)
  .map(([name, { about }]) => `  ${name.padEnd(6)} ${about}`)
  .join('\n')}`;

let dir,
  template = 'web';
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '-h' || arg === '--help') {
    console.log(usage);
    process.exit(0);
  }
  if (arg === '--template' || arg === '-t') template = args[++i];
  else if (arg.startsWith('--template=')) template = arg.slice('--template='.length);
  else if (arg.startsWith('-')) {
    console.error(`create-margo: unknown option ${arg}.\n\n${usage}`);
    process.exit(1);
  } else if (dir === undefined) dir = arg;
  else {
    console.error(`create-margo: one directory only, got ${dir} and ${arg}.\n\n${usage}`);
    process.exit(1);
  }
}
if (!Object.hasOwn(TEMPLATES, template ?? '')) {
  console.error(`create-margo: unknown template ${template}; use one of ${Object.keys(TEMPLATES).join(', ')}.`);
  process.exit(1);
}

const target = resolve(dir || 'margo-app');
if (existsSync(target) && readdirSync(target).length) {
  console.error(`create-margo: ${target} is not empty. Pick a new directory name.`);
  process.exit(1);
}

const templates = fileURLToPath(new URL('templates', import.meta.url));
if (TEMPLATES[template].shared) cpSync(join(templates, 'shared'), target, { recursive: true });
cpSync(join(templates, template), target, { recursive: true });
// npm drops .gitignore from published packages, so the templates ship it as _gitignore.
renameSync(join(target, '_gitignore'), join(target, '.gitignore'));
const manifest = join(target, 'package.json');
const name =
  basename(target)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[._-]+/, '') || 'margo-app';
writeFileSync(
  manifest,
  readFileSync(manifest, 'utf8').replace('"name": "margo-app"', `"name": ${JSON.stringify(name)}`),
);

const pm = (process.env.npm_config_user_agent ?? 'npm').split('/')[0];
const run = pm === 'npm' ? 'npm run dev' : `${pm} dev`;
const where = relative(process.cwd(), target) || '.';
console.log(
  `\nCreated ${where} (${template} template). Next:\n\n  cd ${where.includes(' ') ? JSON.stringify(where) : where}\n  ${pm} install\n  ${run}\n`,
);
