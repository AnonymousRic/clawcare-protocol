---
name: clawcare-protocol
description: Start ClawCare training, set reminders, and sync finished runs inside OpenClaw or other skill-capable agents.
---

# ClawCare Protocol

Use this skill when the user wants ClawCare help.

## Core Rules

- Keep every action inside the skill bundle.
- Only read or write under `~/.openclaw/workspace/clawcare/` and the current daily memory file under `~/.openclaw/workspace/memory/`.
- Do not read screen content, keyboard input, camera frames, browser history, or unrelated local files.
- Treat all ClawCare output as low-intensity training guidance, not diagnosis or treatment.
- If the user mentions acute pain, dizziness, numbness, chest tightness, or worsening symptoms, stop the training flow and advise offline medical evaluation instead of launching training.

## First Action

On the first real ClawCare request in a thread, run:

```bash
node {baseDir}/scripts/bootstrap.mjs
```

If the result includes `disclosurePending: true` and `bootstrapDisclosure`, say that disclosure once in natural Chinese, then continue.

Fresh install should stay light: do not imply that a recurring `dailyPlan` is enabled unless the stored config actually enables it.

## Training Loop

When the user wants to start training:

1. Run `node {baseDir}/scripts/build_plan.mjs --intent "<user request>" --no-open` unless the user clearly wants immediate launch.
2. Treat the returned plan as personalized by default. The script already reads local run history, `recent_analysis.md`, and recent daily memory summaries.
3. Explain the returned `summary` briefly in natural Chinese.
4. Open the returned `launchUrl` only when the user is ready, or when the user explicitly asked to start now.
5. If the result includes `followUpSync`, treat it as the default post-run sync arrangement. This usually appears in direct start flows, not in timed reminder delivery.
6. Do not expose internal field names, JSON keys, API paths, or storage details.

When the request is a reminder activation, not a new reminder:

- If the request asks to activate a prepared reminder, or the host opens a ClawCare activation link with a `reminderId`, run:

```bash
node {baseDir}/scripts/launch_prepared_reminder.mjs --reminder-id "<id>"
```

- This activation step must create the real training session, arrange `followUpSync` when enabled, then open the training page.
- Do not claim that local auto-sync is armed until this activation step succeeds.

When the user wants to sync a finished run, or when a follow-up sync event arrives:

```bash
node {baseDir}/scripts/sync_run.mjs --session-id "<session id>"
```

If the script returns `status: "pending"`, explain only that the result is not ready yet when the user explicitly asked. Background sync runs should stay silent unless a visible reply is required.

## Reminder Types

- `dailyPlan`: silent preparation only. It never becomes a visible reminder, and it stays off by default on fresh install.
- `scheduledReminder`: the user explicitly asked for a timed reminder. The request itself is confirmation. Do not ask for a second confirmation.
- `proactiveReminder`: OpenClaw may proactively remind the user based on recent training or health signals. This stays off by default and needs a clear opt-in before long-term enablement.
- Timed reminders should prioritize visible delivery. If remote personalization is temporarily unavailable, send a conservative light-activity reminder instead of dropping the reminder.

## Long-Term Settings

Map natural-language preference changes into a structured patch, then run:

```bash
node {baseDir}/scripts/settings_patch.mjs --patch-json '<json patch>'
```

Allowed long-term fields:

- `automation.dailyPlan.enabled`
- `automation.dailyPlan.scheduleLocalTime`
- `automation.postRunSync.enabled`
- `automation.postRunSync.followUpDelayMin`
- `automation.scheduledReminder.enabled`
- `automation.scheduledReminder.scheduleLocalTime`
- `automation.scheduledReminder.weekdays`
- `automation.proactiveReminder.enabled`
- `automation.proactiveReminder.scheduleLocalTime`
- `automation.proactiveReminder.weekdays`
- `consent.proactiveReminderExplained`
- `openclawContext.*`
- `personalizationSignals.preferences.*`
- `personalizationSignals.questionnaire.*`
- `workState.*`

Only write long-term settings when the user clearly means “以后 / 默认 / 长期”.

## Reminder Routing

- Visible reminders should follow the host agent's native routing model.
- In OpenClaw, recurring reminders should use isolated cron runs and announce back to the last visible route.
- For OpenClaw reminder delivery, treat the returned `activationUrl` as the primary link. It should route back into OpenClaw first, then let the skill arm sync and open the real training page.
- Treat `browserLaunchUrl` as a fallback-only link. It is not the default CTA for OpenClaw.
- Recurring ClawCare cron names are scoped to the current workspace. Do not assume a global shared cron name.
- Do not hard-code Feishu, WeChat, Telegram, or any other external app in the skill.
- If the host cannot guarantee a visible outbound route, do not pretend that external delivery is active. Say only what is true.

## Automation Runs

There are two automation patterns:

- `ClawCare automation event:` means an internal system event. Run the referenced local script once. Reply with `NO_REPLY` only when no visible answer is needed.
- `ClawCare reminder run:` means an isolated reminder turn. Run the referenced local script once, then reply with the returned `messageText` only. If the script returns `announceToken`, reply with that token exactly.
- Timed reminder links may be delayed launch links. They create the real training session only when the user clicks them.
- Only full activation hosts such as OpenClaw may promise automatic local write-back after reminder click. Limited hosts should only promise that the training page can be opened.

## References

- Read [references/runtime-loop.md](references/runtime-loop.md) for script roles, cron shape, and reminder delivery rules.
- Read [references/privacy-boundary.md](references/privacy-boundary.md) before enabling proactive reminders or when privacy questions appear.
