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
- `build_plan.mjs`: read local ClawCare context, recent run history, `recent_analysis.md`, and recent daily memory summaries.
  - Direct start flows call the reminder API that creates a real session and can return `followUpSync`.
  - `dailyPlan`, `scheduledReminder`, and `proactiveReminder` use reminder preparation first. They prioritize reliable reminder delivery and return a delayed launch link that creates the real session only when clicked.
  - If reminder preparation fails, timed reminders still return a conservative visible reminder instead of failing silently.
- `launch_prepared_reminder.mjs`: activate a prepared reminder after the user clicks an activation link, create the real session, arm `followUpSync` when enabled, then open the training page.
- `schedule_sync.mjs`: create or refresh the one-shot follow-up sync job for a session.
- `sync_run.mjs`: pull a completed run from `/api/runs/:id/sync` or `/api/openclaw/history`, write the run record, append the daily memory note, refresh `recent_analysis.md`, and re-index memory.
- `settings_patch.mjs`: apply a controlled JSON patch to local config and reconcile owned cron jobs.
- `write_memory.mjs`: materialize the memory and recent-analysis files from an existing run record or from the sync endpoints.

## Reminder Modes

- `dailyPlan`: silent background preparation. No visible reminder. It stays off by default on fresh install.
- `scheduledReminder`: user-requested timed reminder. At trigger time it must produce a visible message with a personalized summary and an activation-first link.
- `proactiveReminder`: optional proactive reminder. It may skip delivery when current signals do not justify a reminder.
- Reminder generation does not mean a real session already exists. `followUpSync` is armed only after activation succeeds on a full activation host.

## Cron Usage

Use native cron support from the host agent only.

- Recurring ClawCare jobs are workspace-scoped: `clawcare-*-<scope>`.
- `dailyPlan` stays in `main` and uses a system event.
- `scheduledReminder` uses an isolated run with announce delivery to `channel: last`.
- `proactiveReminder` uses an isolated run with announce delivery to `channel: last`.
- `clawcare-followup-sync-<session>` stays in `main` and uses a one-shot system event.
- Timed reminder generation must not pre-create `clawcare-followup-sync-*` jobs.

Ownership rules:

1. match the current workspace by scoped name first
2. migrate old global jobs only when the cron payload clearly references the current `configPath`
3. leave uncertain old global jobs untouched

For isolated reminder runs, the prompt should:

1. run the local Node script exactly once with `exec`
2. read the JSON result
3. reply with `messageText` only
4. reply with `ANNOUNCE_SKIP` only when the script explicitly returns `announceToken`

Activation rules:

1. OpenClaw is a `full_activation_host`
2. use `activationUrl` as the primary CTA in reminder messages
3. clicking `activationUrl` should route back into OpenClaw and run `launch_prepared_reminder.mjs`
4. only after that step succeeds may the skill claim that local write-back is armed
5. hosts that cannot route reminder clicks back into the skill are `limited_host`; they should keep only the browser link and must not promise automatic local sync

If cron is unavailable, treat job registration as deferred state rather than a hard failure.

## Payload Hygiene

- Optional text fields that are blank must be omitted, not sent as empty strings.
- Fresh config must not require the user to fill placeholder text before `build_plan.mjs` can succeed.
- Request payload cleanup must still protect old config files and partial patches.
- Reminder fallback text must stay user-facing and must not mention API errors, timeouts, rate limits, or internal fallback logic.

## Memory Usage

Every completed sync should:

1. write or update `runs/<run-id>.json`
2. append exactly one block for that run into `memory/YYYY-MM-DD.md`
3. rewrite `recent_analysis.md`
4. best-effort run `openclaw memory index --force`

Deduplicate by run marker. Repeated syncs must not append duplicate memory blocks.
