# Host Adapter Examples

These are examples, not required behavior.

## OpenClaw

- Bootstrap with `hostKind=openclaw` when the host can prove it is running inside an OpenClaw workspace.
- The host may use OpenClaw cron and OpenClaw memory indexing directly.
- If the host supports callback activation, it may use `deeplink` routing.
- Use `postRunSyncSpec` as the main `run_completed` contract and consume the JSON result from `sync_run.mjs`.
- Even on OpenClaw, treat immediate post-run sync as the main path.
  Delayed follow-up sync is only a short fallback.

## Hermes

- Bootstrap with `hostKind=hermes` when the host can prove Hermes-native memory or scheduler support.
- Prefer native message delivery, webhook delivery, or standard web entry.
- Do not simulate OpenClaw URI callbacks.
- Use `hostSchedulerSpec`, `hostMemorySpec`, `hostWritebackSpec`, `postRunSyncSpec`, `syncPolicy`, and `hostActionHints` as contracts, then let Hermes decide the concrete native implementation.
- When `hostWritebackSpec.required` is true, Hermes should immediately store the returned summary in Hermes-managed long-term memory and feed recent ClawCare history back through `--host-history-json` or `--host-history-file` on the next planning call.

## Generic Agent

- Bootstrap with `hostKind=generic_agent` when no stronger host identity is available.
- Keep using the skill-owned local artifacts as the stable mirror.
- The host may still use its own browser, memory, or scheduler features, but the skill does not assume they exist.
- If the generic host does have a memory system, it should still follow `hostWritebackSpec` and feed recent history back through the same host-history flags instead of inventing a skill-specific storage path.

## Copy Guard

- Keep the fixed training route whenever possible and adjust intensity first.
- Only switch route or replace actions for explicit user refusal or clear safety restrictions.
- Generate user-facing summary, warning, and reminder copy from the final executable session, not from an earlier draft decision.
