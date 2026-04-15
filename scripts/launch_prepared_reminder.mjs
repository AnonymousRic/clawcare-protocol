import {
  ensureBootstrap,
  getApiBaseCandidates,
  openUrl,
  parseFlagValue,
  requestPreparedReminderLaunch,
  resolveSkillRoot,
  scheduleFollowUpSyncJob,
} from './lib/runtime.mjs';

export const main = async (args = process.argv.slice(2)) => {
  const reminderId = parseFlagValue(args, '--reminder-id');
  if (!reminderId) {
    throw new Error('missing_reminder_id');
  }

  const configPath = parseFlagValue(args, '--config');
  const openclawBin = parseFlagValue(args, '--openclaw-bin');
  const family = parseFlagValue(args, '--family');
  const baseUrl = parseFlagValue(args, '--base');
  const delayMin = Number.parseInt(parseFlagValue(args, '--delay-min') ?? '', 10) || undefined;
  const bootstrap = await ensureBootstrap({
    configPath,
    markDisclosureShown: true,
  });
  const launchResult = await requestPreparedReminderLaunch({
    reminderId,
    family,
    baseCandidates: getApiBaseCandidates(baseUrl ?? bootstrap.config.baseUrl),
  });

  let followUpSync = null;
  if (
    bootstrap.config.automation.postRunSync.enabled
    && launchResult.session?.session_id
  ) {
    followUpSync = await scheduleFollowUpSyncJob({
      config: bootstrap.config,
      workspacePaths: bootstrap.workspacePaths,
      skillRoot: resolveSkillRoot(import.meta.url),
      sessionId: launchResult.session.session_id,
      delayMin,
      openclawBin,
    });
  }

  const opened = !args.includes('--no-open');
  if (opened && launchResult.session?.launch_url) {
    await openUrl(launchResult.session.launch_url);
  }

  console.log(JSON.stringify({
    status: 'ok',
    apiBase: launchResult.apiBase,
    configPath: bootstrap.workspacePaths.configPath,
    reminderId: launchResult.reminderId,
    sessionId: launchResult.session?.session_id,
    protocolFamily: launchResult.session?.protocol_family,
    launchUrl: launchResult.session?.launch_url,
    activationUrl: launchResult.session?.launch_url,
    browserLaunchUrl: launchResult.session?.launch_url,
    activationMode: 'session_launch',
    followUpArmed: Boolean(followUpSync),
    followUpSync,
    filePath: launchResult.filePath,
    opened,
  }, null, 2));
};

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
