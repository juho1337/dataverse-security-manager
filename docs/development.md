# Development guide

Node 24 (as in CI). Windows PowerShell 5.1, PowerShell 7 and bash all work; the commands are plain `npm`.

```
npm ci --ignore-scripts
npm run typecheck
npm run lint
npm test
npm run build            # dist/: one IIFE bundle, manifest, third-party notices
npm run check:bundle
npm run validate:offline # the official PPTB manifest rules, without URL checks
npm run check:package    # what `npm publish` would upload
```

Layers and rules: [architecture](architecture.md). New behaviour starts in `domain` or `application` with a test; the UI only wires it.

## Run it in PPTB Desktop
Settings > enable **Show Debug Menu** > Debug > **Load Local Tool** > pick the repository root (the folder that *contains* `dist/`; the host appends `dist/`). After a rebuild, reload the tool and compare the footer stamp (`version · commit · build time`) with your build; the host can keep serving an old one. Without a host the tool runs on fictional demo data in a normal browser.

## Tests
- **Unit and component tests** (`npm test`, about 1000): a fake host with an in-memory Dataverse (`src/test`), plus checks that no mutating host call exists outside `src/adapters/pptb/writer`.
- **Host acceptance** is manual, in PPTB Desktop against a disposable Developer environment: role analysis, access, the restore scenarios (apply, restore, refused restore of a changed target), exports and the Business Unit wizard. Use test-owned roles, teams and users only, and compare the user's state before and after.
- Environment lock (optional build option): `VITE_DSM_LOCK_ENVIRONMENT=1` with `VITE_DSM_LOCK_URL`, `VITE_DSM_LOCK_ORGANIZATION_ID` and `VITE_DSM_LOCK_ENVIRONMENT_ID` builds a tool that works against that one environment only. A normal build is never locked.

## Package for npm
The published package is `dist/` plus `package.json`, `README.md` and `LICENSE` (no source maps, tests or sources).

```
npm run build
npm run validate:offline
npm run check:package
npm pack --dry-run
```
`npm run validate` is the full official check (it also fetches the repository and README URLs, so it needs the public repository). `npm publish` runs the whole chain first and is a maintainer action.

## Contribute
Open an issue before a large change. Keep a change small and tested; run the commands above before a pull request. Update these docs in the same pull request when behaviour changes, and edit the existing page instead of adding a new one. See `CONTRIBUTING.md`.

## Gotchas
- vitest hides `console.log`: write diagnostics to a file.
- A source build shows `+local` in the stamp when the working tree has uncommitted changes.
