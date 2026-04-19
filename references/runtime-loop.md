# Runtime Loop

## Local Files

The skill may maintain only:

- `config.json`
- `cache/daily_plan.json`
- `cache/automation_state.json`
- `cache/prepared_reminders/*.json`
- `runs/*.json`
- `recent_analysis.md`
- `locator.json`
- `memory/YYYY-MM-DD.md`

The exact root is chosen once by the host and then stored in `locator.json`.

Do not touch `AGENTS.md`, `SOUL.md`, `TOOLS.md`, other skills, or unrelated workspace files.

## Host Model

Use this division of responsibility:

- Skill:
  stable scripts
  fixed local artifact layout
  strict output contracts
  privacy and training rules
- Host agent:
  decide which native abilities exist
  decide whether to use browser, message, webhook, hook, API server, or deeplink routing
  decide how native memory and native scheduler are actually applied

The normal flow is:

1. `bootstrap.mjs` once
2. keep `locatorPath`
3. later scripts use `--locator`
4. host reads `activationSpec`, `postRunSyncSpec`, `hostSchedulerSpec`, `hostMemorySpec`,
   `hostWritebackSpec`, `syncPolicy`, and `hostActionHints`
5. host applies native abilities when available

## Script Roles

- `bootstrap.mjs`
  creates the state root
  normalizes config
  writes `locator.json`
  returns `locatorPath` and `hostProfile`
- `build_plan.mjs`
  reads local history, `recent_analysis.md`, and local memory mirror
  may also accept host-managed ClawCare history through `--host-history-json` or `--host-history-file`
  produces a personalized plan or reminder payload
  returns `activationSpec`
  returns `postRunSyncSpec`
  returns `syncPolicy` and `hostActionHints`
  may return `followUpSync` with `hostSchedulerSpec` as a short fallback only
- `launch_prepared_reminder.mjs`
  activates a delayed reminder
  creates the real training session
  may arm short-window post-run sync fallback
  returns a final `activationSpec` for the ready session
  returns `postRunSyncSpec`
- `sync_run.mjs`
  fetches a completed run
  writes stable local artifacts
  returns `hostMemorySpec` when the host has native memory
  returns `hostWritebackSpec` for immediate host-side long-term memory writeback and next-plan reinjection
- `settings_patch.mjs`
  applies a controlled config patch
  reconciles recurring jobs
  returns `hostSchedulerSpec` whenever the host scheduler must apply the job natively
- `schedule_sync.mjs`
  explicitly creates a one-shot follow-up sync arrangement
- `write_memory.mjs`
  materializes local memory files from an existing run and returns the same memory contract as `sync_run.mjs`

## Scheduler Contract

- Immediate sync after run completion is the preferred path.
- `postRunSyncSpec` is the primary machine-readable contract for `run_completed -> sync_run.mjs`.
- Delayed follow-up sync is only a short fallback when the host cannot complete immediate sync.
- OpenClaw hosts may create or edit jobs directly.
- Hermes or generic hosts should treat the returned `hostSchedulerSpec` as the authoritative desired job state.
- Do not invent a different job name, schedule, or file target unless the host has a hard platform limit.
- If `hostSchedulerSpec.channel` is omitted for `scheduledReminder` or `proactiveReminder`, the host should choose delivery itself.
  Prefer the user's most-used IM-style channel when known; otherwise fall back to the host default reminder channel.
- If the host has no native scheduler, keep the reminder as stored preference only. Do not pretend delivery is active.

## Memory Contract

Every completed sync should always:

1. write or update `runs/<run-id>.json`
2. append exactly one block for that run into `memory/YYYY-MM-DD.md`
3. rewrite `recent_analysis.md`

After that:

- OpenClaw may run native memory indexing directly.
- Hermes or another host with native memory should use `hostMemorySpec` to mirror the summary into its own memory system.
  The skill provides summary, tags, and related local artifacts, not a forced native target path.
- When `hostWritebackSpec.required` is true, the host should complete that writeback immediately after local sync finishes.
- The host should treat that long-term memory entry as reusable ClawCare history and pass recent items back into the next `build_plan.mjs` call through `--host-history-json` or `--host-history-file`.
- Host-provided history is supplemental.
  The skill still prefers local synced runs when the same `runId` exists in both places.
- If the host has no native memory, the local files remain the source of truth.

## Reminder Routing

- Direct start may open the page only when the host explicitly supports local browser launch and the caller requested `--open`.
- Timed reminder generation must never create the real session before activation.
- Reminder activation is the only path that may create the real session for reminder scenarios.
- Omitted reminder `channel` means the host picks the best delivery path on its own instead of requiring a fixed channel from the skill.
- Hermes should prefer `message`, `webhook`, or `web` style activation, not OpenClaw-style URI callbacks.
- OpenClaw may still use deeplink callback routing when supported.

## Payload Hygiene

- Optional text fields that are blank must be omitted, not sent as empty strings.
- Fresh config must not require placeholder text before `build_plan.mjs` can succeed.
- Reminder fallback copy must stay user-facing and must not mention API errors or internal fallback logic.
- Pre-check copy must reflect the final action graph.
  If final nodes still include a motion category, use comfort-range wording instead of "skip" or "avoid" wording.
