---
name: clawcare-protocol
description: Start ClawCare training, set reminders, and sync finished runs inside OpenClaw, Hermes, or other skill-capable agents.
---

# ClawCare Protocol

Use this skill when the user wants ClawCare help.

## Core Rules

- Keep every action inside the installed skill bundle and the resolved ClawCare state root.
- The host agent decides the stable storage root on first run. The skill only reuses the returned `locatorPath` and `hostProfile`.
- The training route stays mostly fixed. Use AI to tune intensity, duration, reps, angle, and pacing first.
- Do not rewrite actions or switch protocol family unless the user explicitly refuses an action or a clear safety restriction blocks it.
- User-facing copy must match the final executable session. If the final nodes still include a motion category, describe it as reduced range, fewer reps, or comfort-first pacing, not as "skip" or "avoid".
- The skill may maintain only:
  - `config.json`
  - `runs/<run-id>.json`
  - `cache/prepared_reminders/<id>.json`
  - `cache/daily_plan.json`
  - `cache/automation_state.json`
  - `recent_analysis.md`
  - `locator.json`
  - `memory/YYYY-MM-DD.md` as a local planning mirror when needed
- Do not read screen content, keyboard input, camera frames, browser history, or unrelated local files.
- Treat all ClawCare output as low-intensity training guidance, not diagnosis or treatment.
- If the user mentions acute pain, dizziness, numbness, chest tightness, or worsening symptoms, stop the training flow and advise offline medical evaluation instead of launching training.

## Host Principle

- The skill gives direction, constraints, and stable local scripts.
- The host agent decides how to use its own native memory, scheduler, hooks, webhooks, browser, or message delivery.
- OpenClaw, Hermes, and generic agents all use the same abstraction:
  bootstrap once, keep `locatorPath`, then reuse it on later script calls.

## First Action

On the first real ClawCare request in a thread, run:

```bash
node {baseDir}/scripts/bootstrap.mjs \
  --host-kind "<openclaw|hermes|generic_agent>" \
  --host-can-open-local-browser "<true|false>" \
  --host-can-handle-openclaw-callback "<true|false>" \
  --host-has-native-memory "<true|false>" \
  --host-has-native-scheduler "<true|false>"
```

Rules:

- Pass only capabilities that the host can explicitly prove.
- Keep the returned `locatorPath`.
- Keep the returned `hostProfile`.
- On later calls, prefer `--locator "<locatorPath>"`.
- Treat later `--host-*` flags only as compatibility overrides, not as the normal path.
- If `disclosurePending: true`, say `bootstrapDisclosure` once in natural Chinese, then continue.

## Required Scripts

- Training or preview: `build_plan.mjs`
- Reminder activation: `launch_prepared_reminder.mjs`
- Finished run sync: `sync_run.mjs`
- Long-term preference update: `settings_patch.mjs`
- Optional explicit follow-up scheduling: `schedule_sync.mjs`
- Optional memory materialization from an existing run: `write_memory.mjs`

## Output Contract

Every script response should be treated as structured host guidance. Important fields:

- `status`
- `locatorPath`
- `hostProfile`
- `activationSpec`
- `syncPolicy`
- `hostActionHints`
- `hostSchedulerSpec` or `null`
- `hostMemorySpec` or `null`
- `localArtifacts`

Interpretation rules:

- `activationSpec` tells the host how to route user entry.
  It may be `deeplink`, `web`, or `message`.
- `syncPolicy` describes the post-run contract.
  The default mode is `event_first`, with only a short fallback suggestion when needed.
- `hostActionHints` are semantic hints for the host agent.
  They describe what to do, not where the host must store data.
- `hostSchedulerSpec` means the host should apply its native scheduler if it has one.
- `hostMemorySpec` means the host should mirror the local summary into its own native memory if it has one.
  It does not prescribe a native path or provider-specific target.
- `localArtifacts` are the stable files the skill already wrote locally. They are the compatibility fallback, not proof that host-native work is complete.

## Workflow

- When the user wants to start now:
  run `build_plan.mjs` with `--locator "<locatorPath>"`.
  Use `--open` only when the host explicitly supports local browser launch.
- When the user only wants preview or comparison:
  run `build_plan.mjs` with `--locator "<locatorPath>" --no-open`.
- When a reminder entry is clicked or activated:
  run `launch_prepared_reminder.mjs` with `--locator "<locatorPath>"` and either `--reminder-id` or `--activation-ref`.
- When a run finishes and should be written back:
  run `sync_run.mjs` with `--locator "<locatorPath>"` and `--session-id` or `--run-id`.
- When the host receives a completed run event or already has the current session/run context:
  prefer immediate sync first.
  Treat delayed follow-up sync only as a short fallback, not as the main path.
- When the user wants long-term defaults or recurring behavior:
  map the request into a JSON patch and run `settings_patch.mjs` with `--locator "<locatorPath>"`.

## Reminder Rules

- `dailyPlan` is silent preparation only.
- `scheduledReminder` is user-confirmed as soon as the user explicitly asks for it.
- `proactiveReminder` stays off by default and needs clear opt-in.
- Timed reminder generation must not create a real training session before activation.
- Hermes should not simulate OpenClaw URI callback routing.
  Prefer native message delivery, webhooks, API-server flows, or browser/web entry.

## References

- Read [references/runtime-loop.md](references/runtime-loop.md) for script roles, host contracts, and reminder delivery rules.
- Read [references/host-adapter-examples.md](references/host-adapter-examples.md) for optional OpenClaw and Hermes adapter examples.
- Read [references/privacy-boundary.md](references/privacy-boundary.md) before enabling proactive reminders or when privacy questions appear.
