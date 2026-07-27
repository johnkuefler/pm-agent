# Claude repository guidance

Read and follow `AGENTS.md` and `ARCHITECTURE.md` before editing. They are the canonical repository
instructions and apply even when a task prompt does not repeat them.

The critical constraints are:

- `server.js` is a transitional composition root. Do not add inline routes or new business,
  integration, persistence, or worker logic there.
- Put HTTP surfaces in named factories under `src/routes/`; inject dependencies from `server.js`.
- Put provider protocols in `src/integrations/`, domain/evidence logic in `src/intelligence/`, and
  scheduling/concurrency/lifecycle code in `src/runtime/`.
- Do not import `server.js` or `db.js` from `src/`, import routes from non-route modules, or couple
  integrations directly to intelligence/runtime modules.
- Treat external effects as retryable, idempotent, durable work that remains correct across process
  restarts and multiple replicas. Never acknowledge before the durable acceptance point.
- Preserve evidence provenance and distinguish observed results from inference or attempted work.
- Never add secrets or production data to code, docs, tests, logs, or fixtures.
- Add focused unit/route tests plus failure, replay, and multi-replica tests when those risks exist.
- Do not grow a legacy module or raise a ceiling to bypass the guardrail. Extract first.

Before handoff, run `node scripts/check-architecture.js`, the focused tests for the change, and
`npm test` when practical. Report any test not run or any unrelated failure.
