# Repo mapping

Teamwork project → GitHub repo lookup, plus the human who reviews any AI-generated PR on that repo.

Used by `skills/copilot-intake.md`, `skills/copilot-dispatch.md`, `skills/copilot-followup.md`.

Last updated: 2026-05-11. Flag stale entries when you notice them.

## This file is human-curated. Learned candidates live elsewhere.

This file is the **source of truth** and is human-vetted. The agent never edits it — only John adds/promotes rows and commits them.

Nora (the orchestrator) accumulates discovered mappings during her research in a separate disk-only file: `context/repo-mapping-learned.md` (gitignored; survives folder re-copies; never committed). Read it as a **supplement** to this file when resolving a repo:

- This curated file always wins. Only consult the learned file for a TW project that is NOT mapped here.
- A learned entry has `repo`, `confidence`, `source`, `added`, `notes` (see the format Nora writes in `cowork-prompt.md` Step 3.8).
- **When a dispatch would use a learned (not curated) mapping, flag it in the intake proposal** ("repo via learned mapping, confidence X, source Y — confirm") so John eyeballs it before approving. The approval gate + repo-existence verification are the backstops; a wrong learned mapping can't cause a dispatch on its own.
- When John vets a learned entry, he promotes it into this file as a normal row and removes it from the learned file. That's the only path from "learned" to "curated".

## How this file is keyed

The intake skill matches each Teamwork task's **project name** (exact string, as it appears in Teamwork) against the rows below. Client display names like "Greenbush / Educate Kansas" don't match; the real strings look like `GB - Dev Support`. The 9 active Dev Maintenance projects (TW category `Dev Maintenance`) were enumerated 2026-05-11; non-maintenance projects (builds) are not pre-mapped and route to the "unknown" surface on first hit.

PR reviewer is John (`UJYKB4788`) on all rows by default. Agent is `copilot` on all rows by default.

## Confirmed mappings (Dev Maintenance projects)

### GB - Dev Support → Greenbush (multi-repo)

Default repo: `LimeLight-Marketing/gb-blazor-pdp-toolbox`

Routing rules (case-insensitive keyword match against TW task title + body, first match wins):

| If task content matches | Route to |
|---|---|
| "Registration System" or "registration" | `LimeLight-Marketing/gb-dotnet-greenbush-registration-system` |
| "Gated Content" or "gated" | `LimeLight-Marketing/gb-dotnet-greenbush-gated-content-platform` |
| "PDP" or "Professional Development" or "PD Points" | `LimeLight-Marketing/gb-blazor-pdp-toolbox` |
| (no keyword match) | Surface to John; do NOT auto-pick the default repo |

Note: `clients.md` historically listed only the WP FSE migration SOW; the .NET/Blazor work above is the actual active dev queue.

### CoP - Dev Retainer → City of Pittsburg

- Repo: `LimeLight-Marketing/cop-wp-theme-2026`
- Single-repo project; no routing rules needed.

### PE - Website Retainer 2026 → Pitsco Education (multi-repo)

Default repo: `LimeLight-Marketing/pitsco-ecomm`

Routing rules:

| If task content matches | Route to |
|---|---|
| "Computer Science" or "comp sci" or "CS site" | `LimeLight-Marketing/pe-nexjs-computer-science` |
| "RAQ" or "Request a Quote" or "Quote upload" | `LimeLight-Marketing/pe-shopify-extension-raq-upload` |
| "Echo" or "Echo app" | `LimeLight-Marketing/pe-flutter-echo-app` |
| (no keyword match) | `LimeLight-Marketing/pitsco-ecomm` (the main Shopify theme) |

### USAL - Dev Maintenance → US Alliance Life

- Repo: **unknown** — `clients.md` mentions a Policy Conservation Portal SOW but no obvious repo in `LimeLight-Marketing`. Surface as unknown-repo on first task hit.

## Unmapped Dev Maintenance projects (need John's input)

These are real, active Dev Maintenance projects from TW but I don't know which repo each one targets. First task hit from any of these will surface as "unknown repo" until John adds a row.

| TW project | Likely client (guess) | What I'd need to map it |
|---|---|---|
| `CGT - T&M Requests` | Unknown (CGT initials) | Client name + repo |
| `EGC - Monthly Dev Support - 967523` | Unknown (EGC initials) | Client name + repo |
| `Harvesters T&M` | Harvesters Community Food Network? | Repo location (may be outside LimeLight-Marketing org) |
| `MS - Website Training + Consultation` | Morton Salt? | Repo (advisory project; may not have dev work) |
| `PSU - KCCTE Dev Support` | PSU Kansas Center for Career and Technical Education? | Repo location |

## Reference: LimeLight-Marketing repos by best-guess client

Use this when a new TW project comes in via the "unknown" surface and you need to find the right repo. Not all repos correspond to an active Dev Maintenance project; some are build-only.

| Repo | Likely client | Notes |
|---|---|---|
| `le-wp-themes` | Lettermen's Energy | Main site, WP themes |
| `le-data-warehouse` | Lettermen's Energy | Data warehouse work |
| `le-fractal-library` | Lettermen's Energy | Component library |
| `cos-shopify-theme` | Code of Silence | |
| `mdng-shopify-theme` | Martin Dingman | |
| `llm-wp-ukg-plugin-2026` | Morton Salt | UKG plugin piece only; main site may be in `MortonSalt-com` org |
| `kcsy-wp-theme` | Catholic Charities KCSJ? | Prefix is `kcsy` (typo or different abbreviation); verify |
| `cc-2024-update` | Ambiguous | `cc-` could be Catholic Charities, City of Pittsburg, or Creative Candles |
| `gcmc-wp-theme` | Gove County Medical Center | |
| `lmc-wp-theme-2026` | Lenexa Medical Center | |
| `cop-wp-theme-2026` | City of Pittsburg | Mapped above (CoP - Dev Retainer) |
| `gh-shopify-theme` | Gearhaul | |
| `dps-bigcommerce-theme`, `dps-webhook-handler` | Device Pro Solutions | |
| `cmc-wp-theme` | Citizen's Medical Center | |
| `crp-bigcommerce-theme` | Cane River Pecan | |
| `dmcservices-wp-theme` | DMC Services | |
| `stm-csharp-tiresync` | Unknown (STM initials) | |
| `acs-2024` | Unknown (ACS initials) | |
| `llm-nextjs-estimation-tool`, `llm-node-pm-mcp`, `llm-dotnet-teamwork-dashboard` | LimeLight internal tooling | No client TW project |

## Active engagements with no obvious repo (do NOT enable until resolved)

| Client | Status | Action needed |
|---|---|---|
| Lincoln Center Theater (LCT) | Flagship, May 2026 launch | Repo location unknown. May be outside `LimeLight-Marketing` org. Confirm and add a row when the LCT TW project ID is identified. |
| APEX Stages | Refresh delivered | No repo; advisory follow-on. Skip unless build scope returns. |
| NDS (ADS) | Platform advisory | No build scope. Skip. |
| MSG Payment Systems | Analytics/copy | No build scope. Skip. |
| Russell Cellular | SEO architecture SOW | No build scope yet. Skip. |
| VFW Foundation | Marketing program estimate | SOW phase. Skip. |

## Defaults when no row matches

If a Teamwork task assigned to development@ does not match any TW-project row above:

1. Do NOT auto-dispatch.
2. Surface to John in the intake Slack post as "unknown repo, need mapping".
3. John adds the row here and re-runs intake.

If a TW project matches but the multi-repo routing rules return no match (and there is no safe default):

1. Do NOT auto-dispatch.
2. Surface as "ambiguous repo within mapped project; need disambiguation".

This is the safety valve. A wrong-repo dispatch wastes Copilot turns and creates orphan issues.

## Coding agent choice

- `copilot` — assign GitHub issue to `@copilot`. Works on any repo with Copilot enabled. Lower quality first pass.
- `claude-code` — dispatch a remote Claude Code session against the repo (requires Anthropic remote-agent access on the org). Higher quality first pass.

Default to `copilot` until claude-code remote dispatch is verified for this account.

## How to use this file

- `copilot-intake` reads this file to decide where the issue goes and who to ping.
- Multi-repo routing rules are evaluated against the TW task title + body (concatenated, case-insensitive, first match wins).
- If a repo needs to be excluded from the pipeline entirely (e.g., a public OSS repo), omit it from the mapped rows. Claude will surface the task to John instead of dispatching.

## Things John needs to confirm

- [ ] Identify the client + repo for the 5 unmapped Dev Maintenance projects (CGT, EGC, Harvesters, MS, PSU KCCTE).
- [ ] Identify the USAL repo or confirm there is no active dev queue for that engagement yet.
- [ ] Locate the LCT repo and add a row. This is the flagship.
- [ ] Confirm Morton Salt's main repo (the `MortonSalt-com` org vs the UKG plugin piece in LimeLight-Marketing).
- [ ] Whether build projects (non-maintenance) should also feed this pipeline, or whether the pipeline is maintenance-only for v1.
- [ ] Whether claude-code remote agent dispatch is available on this account. If yes, flip high-value repos to `claude-code`.
- [ ] Whether John as sole reviewer is sustainable, or whether a per-engagement dev should review their own client's PRs.
