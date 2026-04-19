import {
  ensureBootstrap,
  parseHostCapabilityFlags,
  parseFlagValue,
  resolveSkillRoot,
  scheduleFollowUpSyncJob,
} from './lib/runtime.mjs';

export const main = async (args = process.argv.slice(2)) => {
  const configPath = parseFlagValue(args, '--config');
  const locatorPath = parseFlagValue(args, '--locator');
  const sessionId = parseFlagValue(args, '--session-id');
  if (!sessionId) {
    throw new Error('missing_session_id');
  }
  const openclawBin = parseFlagValue(args, '--openclaw-bin');
  const hostCapabilities = parseHostCapabilityFlags(args);
  const bootstrap = await ensureBootstrap({
    configPath,
    locatorPath,
    markDisclosureShown: false,
    hostCapabilities,
  });
  const followUpSync = await scheduleFollowUpSyncJob({
    config: bootstrap.config,
    workspacePaths: bootstrap.workspacePaths,
    skillRoot: resolveSkillRoot(import.meta.url),
    sessionId,
    delayMin: Number.parseInt(parseFlagValue(args, '--delay-min') ?? '', 10) || undefined,
    openclawBin,
  });

  console.log(JSON.stringify({
    status: 'ok',
    sessionId,
    configPath: bootstrap.workspacePaths.configPath,
    locatorPath: bootstrap.workspacePaths.locatorPath,
    hostProfile: bootstrap.hostProfile,
    followUpSync,
  }, null, 2));
};

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
