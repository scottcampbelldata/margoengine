# create-margo

Start a [Margo Engine](https://margoengine.com) app with one command:

```sh
npm create margo@latest my-app
# a game, a visualization, React or Next.js:
npm create margo@latest my-game -- --template game
# pnpm create margo my-game --template game / yarn create margo ... / bun create margo ...
```

| Template | Starts |
| --- | --- |
| `web` (default) | A lit scene with image-based lighting, orbit controls, the stats overlay and measured quality tiers |
| `game` | A small physics game: roll a ball into crates, with shadows (the `margoengine/game` kit and Rapier) |
| `viz` | 200,000 points, a grid and an HTML label (`margoengine/viz`) |
| `react` | React + Vite: JSX components from `margoengine/react` |
| `next` | Next.js app router with `margoengine/react` |

Every template depends on `margoengine` alone (plus Rapier for `game`, React for `react` and `next`), asks no
questions and refuses to write into a non-empty directory. No dependencies of its own.

Tests: `node --test tests/create-margo.test.js` from the repository root (scaffolds every template, type-checks and
builds it against the local packages); `node tools/create-margo/test/browser-check.mjs` renders the default one in a
real browser.
