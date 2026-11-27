// Which documented shell commands start a server, for scripts/check-dev-servers.mjs. `vite build` and `next build`
// write files and exit, so a README that builds an app before packing it names no server; the check took any line with
// the word `vite` for a start command (KB-DEVSERVERS-BUILD1).
const TOOL = /^(npx |pnpm |yarn |bun |vite\b|next\b|npm (create|init|exec))/;
const START = /\b(vite|next|dev|start|serve|preview)\b/;
const BUILD = /^(?:(?:npx|pnpm(?: exec| dlx)?|yarn(?: dlx)?|bun x|bunx|npm exec(?: --)?) +)?(?:vite|next) +build\b/;

/** True when a command line, or a command chained on it, starts a server. */
export function startsServer(line) {
  return TOOL.test(line) && line.split(/&&|\|\||;/).some((part) => !BUILD.test(part.trim()) && START.test(part));
}
