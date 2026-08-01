# AI Quality Corpus

These fixtures are synthetic and contain no user-uploaded or copyrighted source material.

Run `pnpm quality:replay` from the repository root to validate deterministic quality gates and write the aggregate report to stdout.

Run `pnpm quality:live` to send the same cards, Slot objectives, and limited
evidence to the configured quality model. It is an operator command, not a CI
step: it requires `AI_API_KEY` and `AI_MODEL`, reports only fixture IDs and
aggregate decisions, and fails when the configured automatic thresholds are
not met. Override the defaults with `QUALITY_LIVE_MIN_ACCURACY` and
`QUALITY_LIVE_MIN_VIOLATION_DETECTION` (both default to `0.8`).
