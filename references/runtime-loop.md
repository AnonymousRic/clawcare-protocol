# Runtime Loop

## Local Files

This skill is allowed to maintain only these files:

- `~/.openclaw/workspace/clawcare/config.json`
- `~/.openclaw/workspace/clawcare/cache/daily_plan.json`
- `~/.openclaw/workspace/clawcare/cache/automation_state.json`
- `~/.openclaw/workspace/clawcare/runs/*.json`
- `~/.openclaw/workspace/clawcare/recent_analysis.md`
- `~/.openclaw/workspace/memory/YYYY-MM-DD.md`

Do not modify `AGENTS.md`, `SOUL.md`, `TOOLS.md`, other skills, or unrelated workspace files.

## Script Roles

- `bootstrap.mjs`: Ensure the local ClawCare workspace exists, normalize config, and reconcile default cron jobs if OpenClaw cron is available.
- `build_plan.mjs`: Read local ClawCare context, request a personalized plan from `/api/reminders`, cache the latest plan, optionally open the launch URL, and schedule a one-shot follow-up sync.
- `schedule_sync.mjs`: Create or refresh the one-shot follow-up sync job for a session.
- `sync_run.mjs`: Pull a completed run from `/api/runs/:id/sync` or `/api/openclaw/history`, write the run record, append the daily memory note, refresh `recent_analysis.md`, and re-index memory.
- `settings_patch.mjs`: Apply a controlled JSON patch to local config and reconcile related cron jobs.
- `write_memory.mjs`: Materialize the memory and recent-analysis files from an existing run record or from the sync endpoints.

## Cron Usage

Use OpenClaw native cron commands only. The skill runtime schedules:

- `clawcare-daily-plan`
- `clawcare-workday-reminder`
- `clawcare-followup-sync-<session>`

Recurring jobs should stay in the `main` session and use system events that tell the agent to execute the local skill script via `exec`.

If OpenClaw cron is unavailable, treat cron writes as deferred state, not as a hard failure.

## Memory Usage

Every completed sync should:

1. Write or update `runs/<run-id>.json`
2. Append exactly one block for that run into the current `memory/YYYY-MM-DD.md`
3. Rewrite `recent_analysis.md`
4. Best-effort run `openclaw memory index --force`

Deduplicate by run marker. Repeated syncs must not append duplicate memory blocks.
