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
  resolveSkillRoot,
} from './lib/runtime.mjs';

export const main = async (args = process.argv.slice(2)) => {
  const configPath = parseFlagValue(args, '--config');
  const locatorPath = parseFlagValue(args, '--locator');
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

  const apiBaseCandidates = getApiBaseCandidates(baseUrl ?? bootstrap.config.baseUrl);
  const reminderPlan = await requestReminderPreparationWithFallback({
    payload: planContext.payload,
    baseCandidates: apiBaseCandidates,
    reminderKind,
    proactiveDecision,
    workspacePaths: bootstrap.workspacePaths,
  });
  const cachePath = await cacheDailyPlan(bootstrap.workspacePaths, reminderPlan);
  const skillRoot = resolveSkillRoot(import.meta.url);
  const followUpSync = null;

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
