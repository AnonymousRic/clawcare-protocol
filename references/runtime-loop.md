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
4. host reads `activationSpec`, `hostSchedulerSpec`, `hostMemorySpec`
5. host applies native abilities when available

## Script Roles

- `bootstrap.mjs`
  creates the state root
  normalizes config
  writes `locator.json`
  returns `locatorPath` and `hostProfile`
- `build_plan.mjs`
  reads local history, `recent_analysis.md`, and local memory mirror
  produces a personalized plan or reminder payload
  returns `activationSpec`
  may return `followUpSync` with `hostSchedulerSpec`
- `launch_prepared_reminder.mjs`
  activates a delayed reminder
  creates the real training session
  may arm post-run sync
  returns a final `activationSpec` for the ready session
- `sync_run.mjs`
  fetches a completed run
  writes stable local artifacts
  returns `hostMemorySpec` when the host has native memory
- `settings_patch.mjs`
  applies a controlled config patch
  reconciles recurring jobs
  returns `hostSchedulerSpec` whenever the host scheduler must apply the job natively
- `schedule_sync.mjs`
  explicitly creates a one-shot follow-up sync arrangement
- `write_memory.mjs`
  materializes local memory files from an existing run and returns the same memory contract as `sync_run.mjs`

## Scheduler Contract

- OpenClaw hosts may create or edit jobs directly.
- Hermes or generic hosts should treat the returned `hostSchedulerSpec` as the authoritative desired job state.
- Do not invent a different job name, schedule, or file target unless the host has a hard platform limit.
- If the host has no native scheduler, keep the reminder as stored preference only. Do not pretend delivery is active.

## Memory Contract

Every completed sync should always:

1. write or update `runs/<run-id>.json`
2. append exactly one block for that run into `memory/YYYY-MM-DD.md`
3. rewrite `recent_analysis.md`

After that:

- OpenClaw may run native memory indexing directly.
- Hermes or another host with native memory should use `hostMemorySpec` to mirror the summary into its own memory system.
- If the host has no native memory, the local files remain the source of truth.

## Reminder Routing

- Direct start may open the page only when the host explicitly supports local browser launch and the caller requested `--open`.
- Timed reminder generation must never create the real session before activation.
- Reminder activation is the only path that may create the real session for reminder scenarios.
- Hermes should prefer `message`, `webhook`, or `web` style activation, not OpenClaw-style URI callbacks.
- OpenClaw may still use deeplink callback routing when supported.

## Payload Hygiene

- Optional text fields that are blank must be omitted, not sent as empty strings.
- Fresh config must not require placeholder text before `build_plan.mjs` can succeed.
- Reminder fallback copy must stay user-facing and must not mention API errors or internal fallback logic.
