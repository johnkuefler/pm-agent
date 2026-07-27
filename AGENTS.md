# Agent instructions

**Read [CLAUDE.md](CLAUDE.md) first.** It is the authoritative guide for this repo and applies to
every coding agent working here, not just Claude Code. This file exists so agents that look for
`AGENTS.md` find the same rules.

The short version, all of which is expanded in CLAUDE.md:

1. **No em dashes.** Anywhere. Code, comments, commits, PR bodies, docs, and any string the agent
   can say to a human. Check before committing: `git diff | grep "^+" | grep "—"` must be empty.

2. **Do not grow `server.js`.** It is a 16.5k-line monolith being dismantled. New functions, route
   groups, and subsystems go in `src/`. Code extracted out of `server.js` goes in `src/surfaces/`
   specifically, because the source-text contract tests only read that directory.

3. **Never add `fs.readFileSync('server.js')` to a test.** Use
   `require('../helpers/server-source').readServerSource()`. Roughly 862 assertions depend on this
   indirection; a direct read re-pins the code to the file and blocks future extraction.

4. **Do not edit `test/fixtures/routes.txt` to fix a failure.** That fixture pins all 443 routes in
   registration order. A diff there means the HTTP surface changed.

5. **Move code verbatim.** Never combine a move with a rename, reformat, or behavior change in one
   diff.

6. **Safety floors are code, not prompts.** The financial disclosure gate, the external-email
   draft-and-approve rule, and treating tool-returned content as data rather than instructions are
   not adjustable. If a task seems to require weakening one, stop and ask.

7. **Verify before shipping.** `node --check server.js`, then the contract suite, then `npm test`.
   A grep does not prove a moved function's dependencies came with it. Run the tests.
