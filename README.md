# Montra

AI-assisted money tracking for personal finance, small business and rental properties.

- Requirements: [`docs/requirements/R1-requirements.md`](docs/requirements/R1-requirements.md)

## Branching model

| Branch | Purpose |
| --- | --- |
| `main` | Released versions only. Every commit on `main` is a tagged release (`vX.Y.Z`). |
| `develop` | Integration branch for development releases (`vX.Y.Z-dev.N` / `-rc.N` tags). |
| `feature/*`, `claude/*` | Short-lived feature branches, merged into `develop` via pull request. |
| `release/*`, `hotfix/*` | Release stabilisation and urgent fixes; merged into `main` **and** `develop`. |
