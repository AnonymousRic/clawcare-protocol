# Runtime Loop

## Local Files

The skill may maintain only:

- `~/.openclaw/workspace/clawcare/config.json`
- `~/.openclaw/workspace/clawcare/cache/daily_plan.json`
- `~/.openclaw/workspace/clawcare/cache/automation_state.json`
- `~/.openclaw/workspace/clawcare/runs/*.json`
- `~/.openclaw/workspace/clawcare/recent_analysis.md`
- `~/.openclaw/workspace/memory/YYYY-MM-DD.md`

Do not touch `AGENTS.md`, `SOUL.md`, `TOOLS.md`, other skills, or unrelated workspace files.

## Script Roles

- `bootstrap.mjs`: ensure the local ClawCare workspace exists, normalize config, and reconcile owned cron jobs when the host supports cron.
- `build_plan.mjs`: read local ClawCare context, recent run history, `recent_analysis.md`, and recent daily memory summaries; request a personalized plan from `/api/reminders`; cache the latest plan; optionally open the launch URL; and schedule follow-up sync.
- `schedule_sync.mjs`: create or refresh the one-shot follow-up sync job for a session.
- `sync_run.mjs`: pull a completed run from `/api/runs/:id/sync` or `/api/openclaw/history`, write the run record, append the daily memory note, refresh `recent_analysis.md`, and re-index memory.
- `settings_patch.mjs`: apply a controlled JSON patch to local config and reconcile owned cron jobs.
- `write_memory.mjs`: materialize the memory and recent-analysis files from an existing run record or from the sync endpoints.

## Reminder Modes

- `dailyPlan`: silent background preparation. No visible reminder. It stays off by default on fresh install.
- `scheduledReminder`: user-requested timed reminder. At trigger time it must produce a visible message with a personalized summary and `launchUrl`.
- `proactiveReminder`: optional proactive reminder. It may skip delivery when current signals do not justify a reminder.

## Cron Usage

Use native cron support from the host agent only.

- Recurring ClawCare jobs are workspace-scoped: `clawcare-*-<scope>`.
- `dailyPlan` stays in `main` and uses a system event.
- `scheduledReminder` uses an isolated run with announce delivery to `channel: last`.
- `proactiveReminder` uses an isolated run with announce delivery to `channel: last`.
- `clawcare-followup-sync-<session>` stays in `main` and uses a one-shot system event.

Ownership rules:

1. match the current workspace by scoped name first
2. migrate old global jobs only when the cron payload clearly references the current `configPath`
3. leave uncertain old global jobs untouched

For isolated reminder runs, the prompt should:

1. run the local Node script exactly once with `exec`
2. read the JSON result
3. reply with `messageText` only
4. reply with `ANNOUNCE_SKIP` only when the script explicitly returns `announceToken`

If cron is unavailable, treat job registration as deferred state rather than a hard failure.

## Payload Hygiene

- Optional text fields that are blank must be omitted, not sent as empty strings.
- Fresh config must not require the user to fill placeholder text before `build_plan.mjs` can succeed.
- Request payload cleanup must still protect old config files and partial patches.

## Memory Usage

Every completed sync should:

1. write or update `runs/<run-id>.json`
2. append exactly one block for that run into `memory/YYYY-MM-DD.md`
3. rewrite `recent_analysis.md`
4. best-effort run `openclaw memory index --force`

Deduplicate by run marker. Repeated syncs must not append duplicate memory blocks.
