# Copilot instructions for pm-agent

Use `AGENTS.md` and `ARCHITECTURE.md` as the canonical engineering guidance for every suggestion,
edit, and review in this repository.

- Keep `server.js` limited to configuration, dependency construction, route-factory registration,
  and process lifecycle. Do not suggest new inline Express routes or business logic there.
- Create focused named route factories in `src/routes/` and pass explicit dependencies from the
  composition root.
- Keep external-provider details in `src/integrations/`, domain/evidence rules in
  `src/intelligence/`, and queues/scheduling/concurrency/lifecycle in `src/runtime/`.
- Never make `src/` import root `server.js`/`db.js`; never import routes from another layer; do not
  make integrations import intelligence or runtime implementation.
- Existing oversized modules are frozen ceilings. Extract cohesive behavior before extending them.
  New JavaScript modules must remain within 600 physical lines and 60,000 bytes.
- Webhooks and external side effects require raw-body verification where applicable, durable
  deduplication, idempotency, bounded deadlines, retry policy, persisted receipts/results, and
  atomic lease/claim fencing that works across replicas.
- Keep observed evidence, inference, prediction, and unknown state distinct. Never represent an
  attempted external action as completed without an authoritative receipt.
- Never include secrets, tokens, private keys, production payloads, or real credentials.
- Add tests for auth/validation, failure paths, duplicate delivery, restart/replay, and concurrent
  claimants as applicable. Keep route contracts and fixtures current.

Run `node scripts/check-architecture.js` and focused tests. The architecture contract test is part
of `npm test`; do not bypass it or raise budgets merely to make a change pass.
