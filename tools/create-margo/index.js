#!/usr/bin/env node
// npm create margo@latest [dir]: copies ./template into dir. Node stdlib only, no prompts.
import { cpSync, existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const arg = process.argv[2];
if (arg === '-h' || arg === '--help') {
  console.log('Usage: npm create margo@latest [directory]   (default: margo-app)');
  process.exit(0);
}
if (arg?.startsWith('-')) {
  console.error(`create-margo: unknown option ${arg}. Usage: npm create margo@latest [directory]`);
  process.exit(1);
}

const target = resolve(arg || 'margo-app');
if (existsSync(target) && readdirSync(target).length) {
  console.error(`create-margo: ${target} is not empty. Pick a new directory name.`);
  process.exit(1);
}

cpSync(fileURLToPath(new URL('template', import.meta.url)), target, { recursive: true });
// npm drops .gitignore from published packages, so the template ships it as _gitignore.
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
const dir = relative(process.cwd(), target) || '.';
console.log(
  `\nCreated ${dir}. Next:\n\n  cd ${dir.includes(' ') ? JSON.stringify(dir) : dir}\n  ${pm} install\n  ${run}\n`,
);
