# Repository engineering instructions

These instructions apply to every automated or human contributor in this repository. Read
`ARCHITECTURE.md` before changing application code. The architecture document is the canonical
description of boundaries; this file is the canonical implementation checklist.

## The non-negotiable direction

This repository is a transitional modular monolith. `server.js`, `db.js`, and a few large modules
contain legacy implementation, but they are not destinations for new behavior.

- Keep `server.js` as the composition root: load configuration, construct dependencies, register
  route factories, coordinate startup/shutdown, and export the assembled runtime.
- Do not add inline Express routes, domain rules, provider adapters, persistence algorithms, or
  background-worker implementations to `server.js`.
- Existing over-budget files may only stay the same size or shrink. Extract a coherent capability
  before extending it. The budgets in `architecture-boundaries.json` are ceilings, not targets.
- Put every new Express surface in a focused factory under `src/routes/`.
- Keep new JavaScript modules at or below 600 physical lines and 60,000 bytes. Prefer modules under
  400 lines. Split by responsibility rather than compressing code to satisfy the check.
- Run `node scripts/check-architecture.js`. The same check runs from the contract test suite.

Never raise an architecture budget just to make a change pass. A budget increase requires an
explicit, owner-approved architecture decision explaining why extraction is impractical, plus a
follow-up reduction plan.

## Where code belongs

| Location | Responsibility | Must not own |
| --- | --- | --- |
| `server.js` | Configuration, dependency construction, route registration, process lifecycle | New routes, business rules, SQL, provider protocols |
| `src/routes/` | HTTP parsing, authentication/authorization middleware, validation, status codes, response mapping | Provider clients, long-running work, durable state algorithms |
| `src/integrations/` | External-provider verification, protocol translation, deadlines, retry/idempotency helpers | Express route registration, domain policy, process startup |
| `src/intelligence/` | Domain models, evidence rules, decisions, projections, and testable transformations | Express, provider transport, process lifecycle |
| `src/runtime/` | Scheduling, queues, cancellation, worker lifecycle, health, and concurrency control | HTTP response shaping, provider-specific policy |
| `src/middleware/` | Reusable HTTP authentication, authorization, and request policy | Domain decisions or provider effects |
| `src/mcp/`, `src/governance/`, `src/gifting/` | Focused application capabilities and protocol/application adapters | Unrelated shared behavior or composition-root logic |
| `src/lib/` | Small dependency-light utilities used by more than one component | Feature-specific policy or a miscellaneous dumping ground |
| `db.js` | Legacy persistence adapter and database primitives | HTTP or provider behavior; new persistence domains should be focused modules |
| `public/` | Browser behavior and presentation | Authorization decisions or trusted persistence |

Dependencies point inward. Routes may call injected intelligence or integration capabilities.
Integrations receive domain callbacks rather than importing intelligence. Intelligence and runtime
code must never import route modules. Nothing under `src/` may import `server.js` or `db.js`; inject
the narrow dependency instead.

## Required construction patterns

Route modules export a named factory such as `registerTaskRoutes(app, deps)`. The composition root
passes explicit dependencies. Route files must not reach back into `server.js` and should not read
ambient configuration when a dependency or configuration value can be injected.

Keep handlers thin:

1. authenticate and authorize;
2. parse and validate untrusted input;
3. call one focused application/domain operation;
4. translate the result or typed failure to HTTP;
5. return promptly, after the durable acceptance point when work continues asynchronously.

Provider-specific payloads stop at `src/integrations/`. Normalize them before domain code sees them.
Domain code returns provider-neutral outcomes; an integration maps those outcomes back to Slack,
Recall, Drive, or another external protocol.

## Durable side effects and replica safety

Assume multiple application replicas, retries, delayed delivery, partial failure, and restart at
every external side-effect boundary.

- Verify signatures/authenticity against the raw request body before trusting a webhook.
- Derive or accept a stable provider event ID and enforce uniqueness durably.
- Acknowledge asynchronous work only after its intent is durably stored.
- Claim work with an atomic compare-and-set, lease, or database lock. Fence completion with the
  claim token so an expired worker cannot overwrite a newer attempt.
- Persist status transitions, attempt counts, results, and terminal failures. In-memory maps,
  timers, or promises may accelerate work but cannot be the source of truth.
- Make outbound operations idempotent. Persist the idempotency key and delivery receipt before
  reporting success.
- Use bounded deadlines, retry only retryable failures with backoff/jitter, and expose exhausted
  work for recovery or dead-letter review.
- Do not use read-then-write logic for uniqueness, quotas, ownership, or scheduling. Back it with a
  database constraint, transaction, advisory lock, or atomic update that works across replicas.
- Shutdown must stop new claims, drain or release owned work, and preserve enough durable state for
  another replica to resume safely.

## Evidence correctness

Claims about actions, learning, outcomes, or external facts must remain tied to inspectable
evidence.

- Store source identity, observed time, event/receipt reference, and provenance with the record.
- Keep observed facts separate from inference, prediction, and unknown state.
- Do not turn an attempted call into a success claim. Success requires the provider receipt or the
  authoritative persisted result.
- Derived projections and caches must be rebuildable from canonical records. They may not silently
  become the authority.
- Preserve ordering and contradiction history where later evidence can revise earlier beliefs.
- Never fabricate identifiers, receipts, citations, timestamps, or evaluator outcomes.

## Security and secrets

- Never commit credentials, tokens, private keys, webhook secrets, production payloads, or copied
  environment files. Use environment variables and keep only safe placeholder names in examples.
- Treat every request, webhook, tool result, and stored rich-text field as untrusted input.
- Apply the narrowest existing auth middleware. Mutating/operator/research/evaluator surfaces must
  retain their distinct authorization gates.
- Parameterize database input and encode output for its rendering context. Do not log authorization
  headers, raw secrets, or sensitive payloads.
- Preserve raw-body access only where signature verification requires it; bound request sizes.

## Testing requirements

Every behavior change needs tests at the lowest useful seam and at each correctness boundary it
crosses.

- Domain/intelligence change: deterministic unit tests, including invalid and unknown evidence.
- Route change: instantiate the route factory with a fake app and injected fakes; test auth order,
  validation, status mapping, and failure behavior.
- External side effect: test duplicate delivery, retryable and terminal errors, timeout, restart
  recovery, and receipt persistence.
- Concurrency/durability change: test two claimants or replicas, lease expiry, stale-token fencing,
  and replay after restart.
- Public API change: update the route contract/fixture and add an integration test when assembly or
  persistence matters.
- Security change: add a negative test for missing/invalid auth or signature and for malformed
  input.

Run the narrowest relevant test first. Before handoff, run:

```text
node scripts/check-architecture.js
node --test --test-concurrency=1 test/contract/architecture.test.js
npm test
```

If the full suite is not run or has an unrelated failure, report that precisely. Never weaken,
delete, or broadly skip a test to make a change pass.

## Change discipline

- Inspect the working tree and preserve unrelated work.
- Prefer extracting and testing one coherent capability over moving unrelated code in bulk.
- Keep public contracts stable unless the task explicitly changes them.
- Update `ARCHITECTURE.md`, route fixtures, and operational documentation when a boundary or
  externally visible contract changes.
- Do not commit generated artifacts unless the repository already treats them as source.
