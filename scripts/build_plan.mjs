import {
  buildBuildPlanResult,
  buildSkippedBuildPlanResult,
  buildDailyPlanShouldOpen,
  cacheDailyPlan,
  collectPlanContext,
  ensureBootstrap,
  evaluateProactiveReminder,
  getApiBaseCandidates,
  hasFlag,
  openUrl,
  parseFlagValue,
  requestReminderPlan,
  resolveSkillRoot,
  scheduleFollowUpSyncJob,
} from './lib/runtime.mjs';

export const main = async (args = process.argv.slice(2)) => {
  const configPath = parseFlagValue(args, '--config');
  const openclawBin = parseFlagValue(args, '--openclaw-bin');
  const intentText = parseFlagValue(args, '--intent');
  const reminderKind = parseFlagValue(args, '--reminder-kind');
  const baseUrl = parseFlagValue(args, '--base');
  const returnTo = parseFlagValue(args, '--return-to');
  const bootstrap = await ensureBootstrap({
    configPath,
    markDisclosureShown: true,
  });
  const planContext = await collectPlanContext(bootstrap.config, bootstrap.workspacePaths, {
    intentText,
    baseUrl,
    returnTo,
  });
  const proactiveDecision = reminderKind === 'proactive'
    ? evaluateProactiveReminder(planContext)
    : null;

  if (reminderKind === 'proactive' && proactiveDecision && !proactiveDecision.shouldAnnounce) {
    console.log(JSON.stringify(buildSkippedBuildPlanResult({
      bootstrap,
      reminderKind,
      proactiveDecision,
    }), null, 2));
    return;
  }

  const reminderPlan = await requestReminderPlan(
    planContext.payload,
    getApiBaseCandidates(baseUrl ?? bootstrap.config.baseUrl),
  );
  const cachePath = await cacheDailyPlan(bootstrap.workspacePaths, reminderPlan);
  const skillRoot = resolveSkillRoot(import.meta.url);
  const opened = buildDailyPlanShouldOpen(bootstrap.config, {
    forceOpen: hasFlag(args, '--open'),
    forceNoOpen: hasFlag(args, '--no-open'),
  });
  if (opened) {
    await openUrl(reminderPlan.session.launch_url);
  }

  let followUpSync = null;
  if (bootstrap.config.automation.postRunSync.enabled) {
    followUpSync = await scheduleFollowUpSyncJob({
      config: bootstrap.config,
      workspacePaths: bootstrap.workspacePaths,
      skillRoot,
      sessionId: reminderPlan.session.session_id,
      delayMin: Number.parseInt(parseFlagValue(args, '--delay-min') ?? '', 10) || undefined,
      openclawBin,
    });
  }

  console.log(JSON.stringify(buildBuildPlanResult({
    bootstrap,
    reminderPlan,
    cachePath,
    followUpSync,
    opened,
    reminderKind,
    proactiveDecision,
  }), null, 2));
};

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
