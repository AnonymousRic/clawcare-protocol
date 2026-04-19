import {
  ensureBootstrap,
  fetchSyncBundle,
  getApiBaseCandidates,
  parseHostCapabilityFlags,
  parseFlagValue,
  resolveSkillRoot,
  scheduleFollowUpSyncJob,
  syncRunToWorkspace,
} from './lib/runtime.mjs';

export const main = async (args = process.argv.slice(2)) => {
  const configPath = parseFlagValue(args, '--config');
  const locatorPath = parseFlagValue(args, '--locator');
  const openclawBin = parseFlagValue(args, '--openclaw-bin');
  const baseUrl = parseFlagValue(args, '--base');
  const runId = parseFlagValue(args, '--run-id');
  const sessionId = parseFlagValue(args, '--session-id');
  const retryCount = Math.max(0, Number.parseInt(parseFlagValue(args, '--retry-count') ?? '0', 10) || 0);
  const retryDelayMin = Math.max(1, Number.parseInt(parseFlagValue(args, '--retry-delay-min') ?? '10', 10) || 10);
  const hostCapabilities = parseHostCapabilityFlags(args);

  if (!runId && !sessionId) {
    throw new Error('missing_run_id_or_session_id');
  }

  const bootstrap = await ensureBootstrap({
    configPath,
    locatorPath,
    markDisclosureShown: false,
    hostCapabilities,
  });
  const bundle = await fetchSyncBundle(
    getApiBaseCandidates(baseUrl ?? bootstrap.config.baseUrl),
    { runId, sessionId },
  );

  if (!bundle) {
    let retry = null;
    if (sessionId && retryCount > 0) {
      retry = await scheduleFollowUpSyncJob({
        config: bootstrap.config,
        workspacePaths: bootstrap.workspacePaths,
        skillRoot: resolveSkillRoot(import.meta.url),
        sessionId,
        delayMin: retryDelayMin,
        retryCount: retryCount - 1,
        retryDelayMin,
        openclawBin,
      });
    }

    console.log(JSON.stringify({
      status: 'pending',
      sessionId,
      runId,
      configPath: bootstrap.workspacePaths.configPath,
      locatorPath: bootstrap.workspacePaths.locatorPath,
      hostProfile: bootstrap.hostProfile,
      retry,
    }, null, 2));
    return;
  }

  const result = await syncRunToWorkspace(bootstrap.workspacePaths, bundle, {
    openclawBin,
  });
  console.log(JSON.stringify({
    status: 'ok',
    apiBase: bundle.apiBase,
    configPath: bootstrap.workspacePaths.configPath,
    locatorPath: bootstrap.workspacePaths.locatorPath,
    hostProfile: bootstrap.hostProfile,
    sessionId: bundle.note.session_id,
    runId: bundle.note.run_id,
    protocol: bundle.note.protocol,
    localArtifacts: result.localArtifacts,
    hostMemorySpec: result.hostMemorySpec,
    hostWritebackSpec: result.hostWritebackSpec,
    result,
  }, null, 2));
};

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
