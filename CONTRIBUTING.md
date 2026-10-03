# Contributing

Anton v2 is a personal project, but contributions and forks are welcome. Keep changes focused, and make sure `check:types` and `test` pass before opening a pull request.

## Setup

Node.js `>=22.19` is required (the repo pins `.nvmrc` to 22.22.2):

```sh
nvm use
npm install
```

CI installs with `npm ci` for a clean, lockfile-exact install.

## Typecheck

```sh
npm run check:types
```

This runs `tsc --noEmit` twice: once for the server, core and agent code, and once for the React UI via `-p src/web/tsconfig.json`.

## Tests

```sh
npm test
```

Tests run on Node's built-in test runner with `--experimental-strip-types` over `tests/*.test.ts`. They use fakes and temporary directories, so no API keys or network access are needed. To run a single file:

```sh
node --experimental-strip-types --test tests/diff.test.ts
```

## Before opening a pull request

Run both checks:

```sh
npm run check:types
npm test
```

CI (`.github/workflows/ci.yml`) runs `npm ci`, `npm run check:types`, `npm test` and `npm run build` on every pull request and on pushes to `main`, so it is worth running `npm run build` locally too.

See `AGENTS.md` for a short guide to the code layout, and `README.md` for how to run the app.
