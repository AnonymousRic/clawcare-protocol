---
name: clawcare-protocol
description: Generate and manage a ClawCare training loop from natural-language requests inside OpenClaw. Use when the user wants to start a neck/shoulder routine, adjust long-term training preferences, enable or disable reminders, or sync finished ClawCare runs back into local memory and training records.
---

# ClawCare Protocol

Run this skill when the user wants ClawCare help inside OpenClaw.

## Core Rules

- Keep every action on the skill side. Do not require host-code changes.
- Only read or write under `~/.openclaw/workspace/clawcare/` and the current daily memory file under `~/.openclaw/workspace/memory/`.
- Do not read screen content, keyboard input, camera frames, browser history, or unrelated local files.
- Treat all ClawCare output as low-intensity training guidance, not diagnosis or treatment.
- If the user mentions acute pain, dizziness, numbness, chest tightness, or worsening symptoms, stop the training flow and advise offline medical evaluation instead of launching training.

## First Action

On the first real ClawCare request in a thread, run:

```bash
node {baseDir}/scripts/bootstrap.mjs
```

If the JSON result includes `disclosurePending: true` and `bootstrapDisclosure`, tell the user that disclosure once in natural Chinese, then continue.

## Closed Loop

When the user wants to start training:

1. Run `node {baseDir}/scripts/build_plan.mjs --intent "<user request>" --no-open` unless the user clearly wants immediate launch.
2. Read the returned summary and explain the plan briefly in natural Chinese.
3. Open the returned `launchUrl` only when the user is ready, or when the user explicitly asked to start now.
4. Do not expose internal field names, JSON keys, API paths, or storage details.

When the user wants to sync a finished run or when a scheduled follow-up event arrives:

```bash
node {baseDir}/scripts/sync_run.mjs --session-id "<session id>"
```

If the script returns `status: "pending"`, explain only that the run is not ready yet when the user explicitly asked. For background automation events, do not send a visible reply unless required.

## Long-Term Settings

Map natural-language preference changes into a structured patch, then run:

```bash
node {baseDir}/scripts/settings_patch.mjs --patch-json '<json patch>'
```

Allowed long-term fields:

- `automation.dailyPlan.enabled`
- `automation.dailyPlan.mode`
- `automation.dailyPlan.autoOpen`
- `automation.dailyPlan.scheduleLocalTime`
- `automation.postRunSync.enabled`
- `automation.postRunSync.followUpDelayMin`
- `automation.workdayReminder.enabled`
- `automation.workdayReminder.scheduleLocalTime`
- `automation.workdayReminder.weekdays`
- `consent.workdayReminderExplained`
- `openclawContext.*`
- `personalizationSignals.preferences.*`
- `personalizationSignals.questionnaire.*`
- `workState.*`

Only write long-term settings when the user clearly means “以后 / 默认 / 长期”.

## Reminder Boundary

- Default daily behavior is `silent_prepare`, not proactive interruption.
- Workday reminders are time-based only. They are not behavior monitoring.
- Before enabling workday reminders, explain that they may proactively notify the user and do not read screen, input, or camera data.
- Only enable workday reminders after explicit user confirmation.

## Automation Events

If the incoming message starts with `ClawCare automation event:`, treat it as an internal scheduled task:

- Parse the JSON block in the message.
- Use `exec` to run the referenced local Node script exactly once.
- Touch only the allowed ClawCare workspace files.
- If the task succeeds and no user-facing answer is needed, reply with `NO_REPLY`.

## References

- Read [references/runtime-loop.md](references/runtime-loop.md) when you need the exact script roles, file layout, or cron behavior.
- Read [references/privacy-boundary.md](references/privacy-boundary.md) before enabling reminders or when privacy/safety questions appear.
