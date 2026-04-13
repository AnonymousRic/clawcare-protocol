import {
  ensureBootstrap,
  parseFlagValue,
  resolveSkillRoot,
  scheduleFollowUpSyncJob,
} from './lib/runtime.mjs';

export const main = async (args = process.argv.slice(2)) => {
  const configPath = parseFlagValue(args, '--config');
  const sessionId = parseFlagValue(args, '--session-id');
  if (!sessionId) {
    throw new Error('missing_session_id');
  }
  const openclawBin = parseFlagValue(args, '--openclaw-bin');
  const bootstrap = await ensureBootstrap({
    configPath,
    markDisclosureShown: false,
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
    followUpSync,
  }, null, 2));
};

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
