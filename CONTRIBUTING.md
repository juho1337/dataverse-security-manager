# Contributing

Thanks for helping. This tool changes Dataverse security settings, so changes are reviewed carefully.

1. Open an issue before a large change.
2. Fork, branch, keep the change small.
3. Run `npm ci --ignore-scripts`, `npm run typecheck`, `npm run lint`, `npm test`, `npm run build` (see `docs/development.md`).
4. Cover new behaviour with a test and update the docs in the same pull request.
5. Never include secrets, tokens, tenant names, user names or environment identifiers in code, tests, screenshots or issues. Use fictional data.

Anything that writes to Dataverse must go through the write boundary (`src/adapters/pptb/writer`): preview, confirmation for the verified environment, read-back. Pull requests that bypass it will not be accepted.

AI-assisted contributions are welcome if you reviewed and understand every line.

By contributing you agree that your contribution is licensed under GPL-3.0-only.
