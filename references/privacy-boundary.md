# Privacy Boundary

## Allowed Data

Use only:

- ClawCare training records under the resolved ClawCare state root
- the local memory mirror under `memory/YYYY-MM-DD.md` when present
- the user's current natural-language request
- long-term preferences the user explicitly asked to store

These data stay on the user side for planning and memory updates. Do not add any new outbound data channel beyond the existing ClawCare training APIs.

## Forbidden Data Sources

Do not read:

- screen content
- keyboard input or clipboard content
- camera frames
- browser history
- arbitrary local files outside the resolved ClawCare state root

## Reminder Consent

- `scheduledReminder` does not need a second confirmation. If the user explicitly asks to set a reminder or timed task, treat that request as confirmed.
- `proactiveReminder` needs a clear opt-in because it can interrupt the user without a fresh request.
- Fresh install should not silently enable recurring proactive reminders.

Before enabling `proactiveReminder`, explain only these points:

1. it is based on recent ClawCare signals or time-based checks, not screen or input monitoring
2. the skill does not read screen, input, or camera data
3. the reminder can be turned off at any time

If the user has not clearly opted in, keep `automation.proactiveReminder.enabled` off or keep `consent.proactiveReminderExplained` false.
