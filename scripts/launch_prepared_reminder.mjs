import {
  ensureBootstrap,
  getApiBaseCandidates,
  openUrl,
  parseHostCapabilityFlags,
  parseFlagValue,
  requestPreparedReminderLaunch,
  requestReminderPlan,
  readPreparedReminderRef,
  resolveSkillRoot,
  scheduleFollowUpSyncJob,
} from './lib/runtime.mjs';

export const main = async (args = process.argv.slice(2)) => {
  const reminderId = parseFlagValue(args, '--reminder-id');
  const activationRef = parseFlagValue(args, '--activation-ref');
  if (!reminderId && !activationRef) {
    throw new Error('missing_activation_target');
  }

  const configPath = parseFlagValue(args, '--config');
  const locatorPath = parseFlagValue(args, '--locator');
  const openclawBin = parseFlagValue(args, '--openclaw-bin');
  const family = parseFlagValue(args, '--family');
  const baseUrl = parseFlagValue(args, '--base');
  const delayMin = Number.parseInt(parseFlagValue(args, '--delay-min') ?? '', 10) || undefined;
  const hostCapabilities = parseHostCapabilityFlags(args);
  const bootstrap = await ensureBootstrap({
    configPath,
    locatorPath,
    markDisclosureShown: true,
    hostCapabilities,
  });
  let launchResult;
  if (reminderId) {
    launchResult = await requestPreparedReminderLaunch({
      reminderId,
      family,
      baseCandidates: getApiBaseCandidates(baseUrl ?? bootstrap.config.baseUrl),
    });
  } else {
    const preparedRef = await readPreparedReminderRef({
      workspacePaths: bootstrap.workspacePaths,
      activationRef,
    });
    const payload = JSON.parse(JSON.stringify(preparedRef.record.payload ?? {}));
    const preferredFamily = family ?? preparedRef.record.preferredFamily;
    if (preferredFamily) {
      const currentFamilies = Array.isArray(payload.openclawContext?.preferredFamilies)
        ? payload.openclawContext.preferredFamilies
        : [];
      payload.openclawContext = {
        ...(payload.openclawContext ?? {}),
        preferredFamilies: [
          preferredFamily,
          ...currentFamilies.filter((entry) => entry !== preferredFamily),
        ],
      };
    }
    const planned = await requestReminderPlan(
      payload,
      getApiBaseCandidates(baseUrl ?? payload.baseUrl ?? bootstrap.config.baseUrl),
    );
    launchResult = {
      apiBase: planned.apiBase,
      reminderId: planned.reminder?.reminder_id ?? `fallback-${preparedRef.activationRef}`,
      session: planned.session,
      filePath: planned.paths?.sessionPath,
      activationRef: preparedRef.activationRef,
      preparedRefPath: preparedRef.filePath,
    };
  }

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

  const opened = !args.includes('--no-open') && hostCapabilities.canOpenLocalBrowser;
  if (opened && launchResult.session?.launch_url) {
    await openUrl(launchResult.session.launch_url);
  }

  console.log(JSON.stringify({
    status: 'ok',
    apiBase: launchResult.apiBase,
    configPath: bootstrap.workspacePaths.configPath,
    locatorPath: bootstrap.workspacePaths.locatorPath,
    hostProfile: bootstrap.hostProfile,
    reminderId: launchResult.reminderId,
    activationRef: launchResult.activationRef,
    sessionId: launchResult.session?.session_id,
    protocolFamily: launchResult.session?.protocol_family,
    launchUrl: launchResult.session?.launch_url,
    activationUrl: launchResult.session?.launch_url,
    browserLaunchUrl: launchResult.session?.launch_url,
    activationMode: 'session_launch',
    activationSpec: launchResult.session?.launch_url
      ? {
        kind: 'web',
        url: launchResult.session.launch_url,
      }
      : null,
    followUpArmed: Boolean(followUpSync),
    followUpSync,
    filePath: launchResult.filePath,
    preparedRefPath: launchResult.preparedRefPath,
    localArtifacts: {
      preparedRefPath: launchResult.preparedRefPath,
    },
    opened,
  }, null, 2));
};

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
