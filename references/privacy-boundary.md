# Privacy Boundary

## Allowed Data

Use only:

- ClawCare-generated training records under `~/.openclaw/workspace/clawcare/`
- Daily memory summaries under `~/.openclaw/workspace/memory/`
- The user's current natural-language request
- Long-term preferences the user explicitly asked to store

These data stay on the user side for planning and memory updates. Do not add any new outbound data channel beyond the existing ClawCare training APIs.

## Forbidden Data Sources

Do not read:

- Screen content
- Keyboard input or clipboard content
- Camera frames
- Browser history
- Arbitrary local files outside the ClawCare workspace and current daily memory file

## Reminder Consent

Workday reminders can proactively interrupt the user, so they require an explicit opt-in.

Before enabling them, explain all three points:

1. The reminder is time-based, not behavior monitoring.
2. The skill does not read screen, input, or camera data.
3. The reminder can be turned off at any time.

If the user has not clearly consented, keep `automation.workdayReminder.enabled` off or keep consent false so the cron job is not activated.
