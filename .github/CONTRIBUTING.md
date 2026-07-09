# Contributing to Atlas Agent

Thanks for your interest! Atlas is a monorepo with four parts:

| Path | What | Stack |
|------|------|-------|
| `agent/` | Autonomous agent + HTTP API | Node/Express, TypeScript (ESM) |
| `web/` | Dashboard | Next.js 15 / React 19 |
| `services/` | x402 data marketplace | Node/Express, TypeScript |
| `contracts/` | TreasuryVault + DecisionRegistry | Rust / Odra |

## Getting started

```bash
npm install                 # root install (workspaces)
# run each part:
npm --prefix agent run dev
npm --prefix services run start
npm --prefix web run dev
```

Copy `.env.example` where present and fill in values. Never commit secrets —
they belong in a local `.env` only.

## Before you open a PR

Run the checks the CI runs:

```bash
# per workspace
npm --prefix agent run typecheck && npm --prefix agent test
npm --prefix services run typecheck && npm --prefix services test
npm --prefix web run build
```

- Keep the diff focused; match the surrounding code style (no reformatting).
- All money-moving code must stay **non-custodial** — the user's wallet signs
  every transfer; the server only builds unsigned deploys and forwards signatures.
- Update the README / docs when you change user-facing behavior.

## Reporting bugs / requesting features

Use the issue templates. For security issues, follow
[SECURITY.md](./SECURITY.md) instead of opening a public issue.

## License

By contributing you agree that your contributions are licensed under the
repository's [LICENSE](../LICENSE).
