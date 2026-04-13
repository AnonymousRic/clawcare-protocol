import fs from 'node:fs/promises';
import path from 'node:path';

import {
  appendMemoryFile,
  ensureBootstrap,
  fetchSyncBundle,
  getApiBaseCandidates,
  indexOpenClawMemory,
  parseFlagValue,
  parseBooleanValue,
  resolveWorkspacePaths,
  writeRecentAnalysis,
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
  const openclawBin = parseFlagValue(args, '--openclaw-bin');
  const baseUrl = parseFlagValue(args, '--base');
  const runId = parseFlagValue(args, '--run-id');
  const sessionId = parseFlagValue(args, '--session-id');
  const skipIndex = parseBooleanValue(parseFlagValue(args, '--skip-index'), false);

  const bootstrap = await ensureBootstrap({
    configPath,
    markDisclosureShown: false,
  });
  const workspacePaths = resolveWorkspacePaths({ configPath });

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

  const memoryWrite = await appendMemoryFile(workspacePaths, bundle.note, {
    run: bundle.run,
  });
  const recentAnalysisPath = await writeRecentAnalysis(workspacePaths, bundle.note);
  const memoryIndex = skipIndex
    ? { indexed: false, command: null }
    : await indexOpenClawMemory({
      openclawBin,
      cwd: workspacePaths.workspaceDir,
    });

  console.log(JSON.stringify({
    status: 'ok',
    configPath: workspacePaths.configPath,
    runId: bundle.note.run_id,
    sessionId: bundle.note.session_id,
    memoryPath: memoryWrite.memoryPath,
    memoryAppended: memoryWrite.appended,
    recentAnalysisPath,
    memoryIndex,
  }, null, 2));
};

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
