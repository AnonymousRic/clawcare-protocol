import fs from 'node:fs/promises';
import path from 'node:path';

import {
  ensureBootstrap,
  fetchSyncBundle,
  getApiBaseCandidates,
  parseHostCapabilityFlags,
  parseFlagValue,
  parseBooleanValue,
  syncRunToWorkspace,
} from './lib/runtime.mjs';

const loadExistingRunRecord = async (workspacePaths, runId) => {
  if (!runId) {
    return null;
  }
  const filePath = path.join(workspacePaths.runsDir, `${String(runId).replace(/[^a-z0-9_-]+/gi, '_').toLowerCase()}.json`);
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
};

export const main = async (args = process.argv.slice(2)) => {
  const configPath = parseFlagValue(args, '--config');
  const locatorPath = parseFlagValue(args, '--locator');
  const openclawBin = parseFlagValue(args, '--openclaw-bin');
  const baseUrl = parseFlagValue(args, '--base');
  const runId = parseFlagValue(args, '--run-id');
  const sessionId = parseFlagValue(args, '--session-id');
  const skipIndex = parseBooleanValue(parseFlagValue(args, '--skip-index'), false);
  const hostCapabilities = parseHostCapabilityFlags(args);

  const bootstrap = await ensureBootstrap({
    configPath,
    locatorPath,
    markDisclosureShown: false,
    hostCapabilities,
  });
  const workspacePaths = bootstrap.workspacePaths;

  const existingRecord = await loadExistingRunRecord(workspacePaths, runId);
  const bundle = existingRecord
    ? {
      apiBase: existingRecord.apiBase,
      run: existingRecord.run,
      session: existingRecord.session,
      reminder: existingRecord.reminder,
      note: existingRecord.note,
      hook: existingRecord.hook,
      markdown: '',
    }
    : await fetchSyncBundle(
      getApiBaseCandidates(baseUrl ?? bootstrap.config.baseUrl),
      { runId, sessionId },
    );

  if (!bundle) {
    console.log(JSON.stringify({
      status: 'pending',
      runId,
      sessionId,
      configPath: workspacePaths.configPath,
    }, null, 2));
    return;
  }

  const result = await syncRunToWorkspace(workspacePaths, bundle, {
    openclawBin,
    skipMemoryIndex: skipIndex,
  });

  console.log(JSON.stringify({
    status: 'ok',
    configPath: workspacePaths.configPath,
    locatorPath: workspacePaths.locatorPath,
    runId: bundle.note.run_id,
    sessionId: bundle.note.session_id,
    hostProfile: bootstrap.hostProfile,
    memoryPath: result.memoryPath,
    memoryAppended: result.memoryAppended,
    recentAnalysisPath: result.recentAnalysisPath,
    memoryIndex: result.memoryIndex,
    hostMemorySpec: result.hostMemorySpec,
    hostWritebackSpec: result.hostWritebackSpec,
    localArtifacts: result.localArtifacts,
  }, null, 2));
};

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
