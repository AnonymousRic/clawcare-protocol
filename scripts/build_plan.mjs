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
  parseHostCapabilityFlags,
  parseFlagValue,
  requestReminderPreparationWithFallback,
  requestReminderPlan,
  resolveSkillRoot,
  scheduleFollowUpSyncJob,
} from './lib/runtime.mjs';

export const main = async (args = process.argv.slice(2)) => {
  const configPath = parseFlagValue(args, '--config');
  const locatorPath = parseFlagValue(args, '--locator');
  const openclawBin = parseFlagValue(args, '--openclaw-bin');
  const intentText = parseFlagValue(args, '--intent');
  const reminderKind = parseFlagValue(args, '--reminder-kind');
  const baseUrl = parseFlagValue(args, '--base');
  const returnTo = parseFlagValue(args, '--return-to');
  const hostHistoryJson = parseFlagValue(args, '--host-history-json');
  const hostHistoryFile = parseFlagValue(args, '--host-history-file');
  const hostCapabilities = parseHostCapabilityFlags(args);
  const bootstrap = await ensureBootstrap({
    configPath,
    locatorPath,
    markDisclosureShown: true,
    hostCapabilities,
  });
  const planContext = await collectPlanContext(bootstrap.config, bootstrap.workspacePaths, {
    intentText,
    baseUrl,
    returnTo,
    hostHistoryJson,
    hostHistoryFile,
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

  const prepareOnly = reminderKind === 'scheduled'
    || reminderKind === 'proactive'
    || reminderKind === 'daily_plan';
  const apiBaseCandidates = getApiBaseCandidates(baseUrl ?? bootstrap.config.baseUrl);
  const reminderPlan = prepareOnly
    ? await requestReminderPreparationWithFallback({
      payload: planContext.payload,
      baseCandidates: apiBaseCandidates,
      reminderKind,
      proactiveDecision,
      workspacePaths: bootstrap.workspacePaths,
    })
    : await requestReminderPlan(
      planContext.payload,
      apiBaseCandidates,
    );
  const cachePath = await cacheDailyPlan(bootstrap.workspacePaths, reminderPlan);
  const skillRoot = resolveSkillRoot(import.meta.url);
  let followUpSync = null;
  if (
    !prepareOnly
    && bootstrap.config.automation.postRunSync.enabled
    && reminderPlan.session?.session_id
  ) {
    followUpSync = await scheduleFollowUpSyncJob({
      config: bootstrap.config,
      workspacePaths: bootstrap.workspacePaths,
      skillRoot,
      sessionId: reminderPlan.session.session_id,
      delayMin: Number.parseInt(parseFlagValue(args, '--delay-min') ?? '', 10) || undefined,
      openclawBin,
    });
  }

  const opened = buildDailyPlanShouldOpen(bootstrap.config, {
    reminderKind,
    forceOpen: hasFlag(args, '--open'),
    forceNoOpen: hasFlag(args, '--no-open'),
    hostCanOpenLocalBrowser: hostCapabilities.canOpenLocalBrowser,
  });
  const result = buildBuildPlanResult({
    bootstrap,
    reminderPlan,
    cachePath,
    followUpSync,
    opened: false,
    reminderKind,
    proactiveDecision,
    hostCapabilities,
    skillRoot,
  });

  if (opened && result.launchUrl) {
    await openUrl(result.launchUrl);
  }

  console.log(JSON.stringify({
    ...result,
    opened,
  }, null, 2));
};

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
