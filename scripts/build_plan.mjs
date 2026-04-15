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
import { requestReminderPreparationWithFallback } from './lib/reminder_prepare.mjs';

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
    })
    : await requestReminderPlan(
      planContext.payload,
      apiBaseCandidates,
    );
  const cachePath = await cacheDailyPlan(bootstrap.workspacePaths, reminderPlan);
  const skillRoot = resolveSkillRoot(import.meta.url);
  const opened = buildDailyPlanShouldOpen(bootstrap.config, {
    forceOpen: hasFlag(args, '--open'),
    forceNoOpen: hasFlag(args, '--no-open'),
  });
  const launchUrl = reminderPlan.session?.launch_url ?? reminderPlan.reminder?.launch_url;
  if (opened && launchUrl) {
    await openUrl(launchUrl);
  }

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
      sessionId: reminderPlan.session?.session_id,
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
