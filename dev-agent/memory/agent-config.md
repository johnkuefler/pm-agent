# Agent config cache

Populated by `copilot-intake` on first run. Update when a cached value proves stale or returns an unexpected result.

Do not store credentials or tokens here. Use `GH_TOKEN` env var for GitHub auth; Teamwork auth is handled by the MCP server.

## Teamwork: development@ user ID

```
tw_dev_user_id: [populate on first run via twprojects-list_users]
cached: [YYYY-MM-DD]
```

Look up via `twprojects-list_users`, filter by email `development@limelightmarketing.com`. Cache the numeric ID. Used by intake step 1 to filter `twprojects-list_tasks` without re-querying users on every run.

## Teamwork: Dev Maintenance category ID

```
tw_dev_maintenance_category_id: [populate on first run via twprojects-list_projects]
cached: [YYYY-MM-DD]
```

Used to scope the project list to Dev Maintenance projects only when cross-referencing `context/repo-mapping.md`.

## Cache hygiene

- If a cached value returns a 404 or empty result on a live API call, re-query, update this file, and note the date.
- If `tw_dev_user_id` is stale, intake will silently pull zero tasks. If intake returns nothing unexpectedly, re-verify this value first.
