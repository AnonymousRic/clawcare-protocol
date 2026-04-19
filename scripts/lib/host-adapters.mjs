import { spawn } from 'node:child_process';
import path from 'node:path';

import {
  CLAWCARE_FOLLOW_UP_DELAY_MIN,
  CLAWCARE_GLOBAL_JOB_NAMES,
  CLAWCARE_JOB_NAMES,
  CLAWCARE_NO_REPLY,
  CLAWCARE_SYNC_RETRY_COUNT,
  CLAWCARE_SYNC_RETRY_DELAY_MIN,
  compactObject,
  deepMerge,
  getScopedAutomationJobNames,
  isRecord,
  normalizeComparablePath,
  parseFlagValue,
  parseJsonFileIfExists,
  readFileIfExists,
  resolveWorkspacePaths,
  sanitizeToken,
  stableStringify,
  trimToUndefined,
  writeJsonFile,
} from './core.mjs';
import {
  appendMemoryFile,
  normalizeConfig,
  readConfig,
  writeConfig,
  writeRecentAnalysis,
  writeRunRecord,
} from './state-store.mjs';

const detectTimeZone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
};

export const buildCronExpressionForLocalTime = (timeText, weekdays = null) => {
  const [hoursText, minutesText] = String(timeText).split(':');
  const hours = Number.parseInt(hoursText, 10);
  const minutes = Number.parseInt(minutesText, 10);
  const weekdayPart = Array.isArray(weekdays) && weekdays.length
    ? weekdays.join(',')
    : '*';
  return `${minutes} ${hours} * * ${weekdayPart}`;
};

export const HOST_HISTORY_INPUT_FLAGS = ['--host-history-json', '--host-history-file'];
export const HOST_HISTORY_REQUIRED_FIELDS = [
  'sessionId',
  'runId',
  'protocol',
  'summary',
  'nextSuggestion',
  'recommendedIntensity',
  'warnings',
  'conflicts',
  'syncedAt',
];

const buildCronSystemEvent = (action, payload) => [
  `ClawCare automation event: ${action}.`,
  'Use the installed `clawcare-protocol` skill.',
  'Use the host agent\'s local execution capability to run the local Node script described below exactly once.',
  'Only touch files inside the resolved ClawCare state root and its local memory mirror.',
  `When the work completes successfully and no direct user reply is required, respond with ${CLAWCARE_NO_REPLY}.`,
  '',
  '```json',
  stableStringify(payload),
  '```',
].join('\n');

const buildReminderTurnMessage = ({
  skillRoot,
  locatorPath,
  reminderKind,
  intentText,
}) => [
  `ClawCare reminder run: ${reminderKind}.`,
  'Use the installed `clawcare-protocol` skill.',
  'Use the host agent\'s local execution capability to run the local Node script below exactly once.',
  'Read the JSON stdout.',
  'If the result contains "announceToken", reply with that token exactly.',
  'Otherwise reply with the field "messageText" only.',
  'Do not open the page, do not output JSON, and do not add extra explanation.',
  '',
  '```json',
  stableStringify({
    script: path.join(skillRoot, 'scripts', 'build_plan.mjs'),
    args: [
      '--locator',
      locatorPath,
      '--intent',
      intentText,
      '--reminder-kind',
      reminderKind,
      '--no-open',
    ],
  }),
  '```',
].join('\n');

export const buildDailyPlanSystemEvent = ({
  skillRoot,
  locatorPath,
  workspaceScope,
}) => buildCronSystemEvent('daily-plan', {
  workspaceScope,
  script: path.join(skillRoot, 'scripts', 'build_plan.mjs'),
  args: [
    '--locator',
    locatorPath,
    '--intent',
    '请静默准备今天的奇点行动训练，并结合本地训练记录、recent_analysis 和最近记忆生成个性化方案，不要主动打开页面。',
    '--reminder-kind',
    'daily_plan',
    '--no-open',
  ],
});

export const buildFollowUpSyncSystemEvent = ({
  skillRoot,
  locatorPath,
  sessionId,
  retryCount = CLAWCARE_SYNC_RETRY_COUNT,
  retryDelayMin = CLAWCARE_SYNC_RETRY_DELAY_MIN,
}) => [
  'ClawCare automation event: follow-up-sync.',
  'Use the installed `clawcare-protocol` skill.',
  'Use the host agent\'s local execution capability to run the local Node script below exactly once.',
  'Read the JSON stdout.',
  'If the result status is "ok" and `hostWritebackSpec.required` is true, immediately mirror `hostMemorySpec` into the host-managed long-term memory store.',
  `Before the next build_plan.mjs call, retrieve recent ClawCare history from that host-managed store and pass it back with ${HOST_HISTORY_INPUT_FLAGS.join(' or ')}.`,
  `When the work completes successfully and no direct user reply is required, respond with ${CLAWCARE_NO_REPLY}.`,
  '',
  '```json',
  stableStringify({
    script: path.join(skillRoot, 'scripts', 'sync_run.mjs'),
    args: [
      '--locator',
      locatorPath,
      '--session-id',
      sessionId,
      '--retry-count',
      String(retryCount),
      '--retry-delay-min',
      String(retryDelayMin),
    ],
    sessionId,
  }),
  '```',
].join('\n');

export const buildScheduledReminderMessage = ({
  skillRoot,
  locatorPath,
}) => buildReminderTurnMessage({
  skillRoot,
  locatorPath,
  reminderKind: 'scheduled',
  intentText: '请准备一版适合当前状态的轻量训练，用于定时提醒消息。不要自动打开页面。',
});

export const buildProactiveReminderMessage = ({
  skillRoot,
  locatorPath,
}) => buildReminderTurnMessage({
  skillRoot,
  locatorPath,
  reminderKind: 'proactive',
  intentText: '请按近期训练和健康信号判断是否值得提醒用户做一组轻量活动训练；只有在确实值得提醒时才发送可见消息，不要自动打开页面。',
});

const resolveSchedulerBackendForOptions = (options = {}) => (
  options.schedulerBackend
  ?? options.workspacePaths?.hostLocator?.schedulerBackend
  ?? 'openclaw_cron'
);

const resolveMemorySyncBackend = (options = {}) => (
  options.memoryBackend
  ?? options.workspacePaths?.hostLocator?.memoryBackend
  ?? 'openclaw_memory'
);

const buildDeferredSchedulerResult = (spec, options = {}, action = 'deferred-create') => ({
  action,
  deferred: true,
  backend: resolveSchedulerBackendForOptions(options),
  command: null,
  hostSchedulerSpec: compactObject({
    name: spec.name,
    desiredState: spec.desiredState,
    schedule: spec.schedule,
    session: spec.session,
    systemEvent: spec.systemEvent,
    message: spec.message,
    announce: spec.announce,
    channel: spec.channel,
    to: spec.to,
    wake: spec.wake,
    deleteAfterRun: spec.deleteAfterRun,
  }),
});

const resolveOpenClawCommand = (openclawBin) => (
  openclawBin
  ?? process.env.OPENCLAW_BIN
  ?? 'openclaw'
);

export const runOpenClawCommand = async (args, options = {}) => {
  const command = resolveOpenClawCommand(options.openclawBin);
  const cwd = options.cwd ?? process.cwd();
  const env = { ...process.env, ...options.env };

  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) {
        resolve({
          command,
          args,
          stdout,
          stderr,
        });
        return;
      }
      reject(new Error(`openclaw_command_failed:${command} ${args.join(' ')}:${stderr || stdout || code}`));
    });
  });
};

const parseCronListPayload = (stdout) => {
  const parsed = JSON.parse(stdout);
  if (Array.isArray(parsed)) {
    return parsed;
  }
  if (isRecord(parsed) && Array.isArray(parsed.jobs)) {
    return parsed.jobs;
  }
  if (isRecord(parsed) && Array.isArray(parsed.items)) {
    return parsed.items;
  }
  return [];
};

export const listCronJobs = async (options = {}) => {
  if (resolveSchedulerBackendForOptions(options) !== 'openclaw_cron') {
    return [];
  }
  try {
    const result = await runOpenClawCommand(['cron', 'list', '--json'], options);
    return parseCronListPayload(result.stdout);
  } catch {
    return [];
  }
};

const getCronJobId = (job) => (
  job?.id
  ?? job?.jobId
  ?? job?.job_id
  ?? null
);

const getCronJobName = (job) => (
  job?.name
  ?? job?.jobName
  ?? job?.job_name
  ?? null
);

const collectStringLeaves = (value, bucket = []) => {
  if (typeof value === 'string') {
    bucket.push(value);
    return bucket;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectStringLeaves(entry, bucket);
    }
    return bucket;
  }
  if (isRecord(value)) {
    for (const entry of Object.values(value)) {
      collectStringLeaves(entry, bucket);
    }
  }
  return bucket;
};

const buildCronJobSearchText = (job) => collectStringLeaves(job)
  .join('\n')
  .replace(/\\\\/g, '/')
  .replace(/\\/g, '/')
  .toLowerCase();

const readAutomationState = async (workspacePaths) => {
  const parsed = await parseJsonFileIfExists(workspacePaths.automationStatePath);
  return isRecord(parsed) ? parsed : null;
};

const isOwnedGlobalCronJob = (job, workspacePaths) => {
  const jobName = getCronJobName(job);
  if (!jobName || !CLAWCARE_GLOBAL_JOB_NAMES.has(jobName)) {
    return false;
  }
  return buildCronJobSearchText(job).includes(normalizeComparablePath(workspacePaths.configPath));
};

const isOwnedScopedCronJob = (job, workspacePaths, automationState = null) => {
  const jobName = getCronJobName(job);
  if (!jobName) {
    return false;
  }
  const scopedNames = getScopedAutomationJobNames(workspacePaths);
  if (Object.values(scopedNames).includes(jobName)) {
    return true;
  }
  const searchText = buildCronJobSearchText(job);
  if (searchText.includes(scopedNames.scopeToken.toLowerCase())) {
    return true;
  }
  if (
    isRecord(automationState)
    && typeof automationState.configPath === 'string'
    && normalizeComparablePath(automationState.configPath) === normalizeComparablePath(workspacePaths.configPath)
    && isRecord(automationState.jobNames)
  ) {
    return Object.values(automationState.jobNames).includes(jobName);
  }
  return false;
};

const findCronJobByNameInJobs = (jobs, name) => (
  jobs.find((job) => getCronJobName(job) === name) ?? null
);

export const findCronJobByName = async (name, options = {}) => {
  const jobs = await listCronJobs(options);
  return jobs.find((job) => getCronJobName(job) === name) ?? null;
};

const cronSpecToArgs = (spec, existingJobId = null) => {
  const base = existingJobId
    ? ['cron', 'edit', existingJobId]
    : ['cron', 'add', '--name', spec.name];

  if (spec.schedule?.at) {
    base.push('--at', spec.schedule.at);
  }
  if (spec.schedule?.cron) {
    base.push('--cron', spec.schedule.cron);
  }
  if (spec.schedule?.tz) {
    base.push('--tz', spec.schedule.tz);
  }
  if (spec.session) {
    base.push('--session', spec.session);
  }
  if (spec.systemEvent) {
    base.push('--system-event', spec.systemEvent);
  }
  if (spec.message) {
    base.push('--message', spec.message);
  }
  if (spec.announce) {
    base.push('--announce');
  }
  if (spec.channel) {
    base.push('--channel', spec.channel);
  }
  if (spec.to) {
    base.push('--to', spec.to);
  }
  if (spec.wake) {
    base.push('--wake', spec.wake);
  }
  if (spec.deleteAfterRun) {
    base.push('--delete-after-run');
  }
  return base;
};

const buildCommandPreview = (args, options = {}) => {
  const command = resolveOpenClawCommand(options.openclawBin);
  return [command, ...args].join(' ');
};

export const reconcileNamedCronJob = async (spec, options = {}) => {
  if (resolveSchedulerBackendForOptions(options) !== 'openclaw_cron') {
    return buildDeferredSchedulerResult(
      spec,
      options,
      spec.existingJob ? 'deferred-update' : 'deferred-create',
    );
  }
  const existing = spec.existingJob ?? await findCronJobByName(spec.name, options);
  const args = cronSpecToArgs(spec, existing ? getCronJobId(existing) : null);
  const commandPreview = buildCommandPreview(args, options);

  try {
    const result = await runOpenClawCommand(args, options);
    return {
      action: existing ? 'updated' : 'created',
      deferred: false,
      command: [result.command, ...result.args].join(' '),
      stdout: result.stdout,
      stderr: result.stderr,
      hostSchedulerSpec: null,
    };
  } catch (error) {
    return {
      action: existing ? 'deferred-update' : 'deferred-create',
      deferred: true,
      command: commandPreview,
      error: error instanceof Error ? error.message : String(error),
      hostSchedulerSpec: buildDeferredSchedulerResult(spec, options, existing ? 'deferred-update' : 'deferred-create').hostSchedulerSpec,
    };
  }
};

export const removeNamedCronJob = async (name, options = {}) => {
  if (resolveSchedulerBackendForOptions(options) !== 'openclaw_cron') {
    return buildDeferredSchedulerResult({
      name,
      schedule: null,
      desiredState: 'disabled',
    }, options, 'deferred-remove');
  }
  const existing = options.existingJob ?? await findCronJobByName(name, options);
  if (!existing) {
    return {
      action: 'noop',
      deferred: false,
      command: null,
      hostSchedulerSpec: null,
    };
  }

  const jobId = getCronJobId(existing);
  const args = ['cron', 'remove', jobId];
  const commandPreview = buildCommandPreview(args, options);
  try {
    await runOpenClawCommand(args, options);
    return {
      action: 'removed',
      deferred: false,
      command: commandPreview,
      hostSchedulerSpec: null,
    };
  } catch (error) {
    return {
      action: 'deferred-remove',
      deferred: true,
      command: commandPreview,
      error: error instanceof Error ? error.message : String(error),
      hostSchedulerSpec: buildDeferredSchedulerResult({
        name,
        schedule: null,
        desiredState: 'disabled',
      }, options, 'deferred-remove').hostSchedulerSpec,
    };
  }
};

const removeOwnedGlobalCronJob = async (name, jobs, workspacePaths, options = {}) => {
  const existing = findCronJobByNameInJobs(jobs, name);
  if (!existing || !isOwnedGlobalCronJob(existing, workspacePaths)) {
    return {
      action: 'noop',
      deferred: false,
      command: null,
      hostSchedulerSpec: null,
    };
  }
  return await removeNamedCronJob(name, {
    ...options,
    existingJob: existing,
  });
};

export const reconcileAutomationJobs = async ({
  config,
  workspacePaths,
  skillRoot,
  openclawBin,
}) => {
  const options = {
    openclawBin,
    cwd: workspacePaths.workspaceDir,
    schedulerBackend: workspacePaths.hostLocator.schedulerBackend,
    workspacePaths,
  };
  const tz = detectTimeZone();
  const automationState = await readAutomationState(workspacePaths);
  const jobNames = getScopedAutomationJobNames(workspacePaths);
  const jobs = await listCronJobs(options);
  const state = {
    dailyPlan: null,
    scheduledReminder: null,
    proactiveReminder: null,
    legacyWorkdayReminder: null,
  };
  const existingDailyPlan = jobs.find((job) => (
    getCronJobName(job) === jobNames.dailyPlan
    && isOwnedScopedCronJob(job, workspacePaths, automationState)
  )) ?? null;
  const existingScheduledReminder = jobs.find((job) => (
    getCronJobName(job) === jobNames.scheduledReminder
    && isOwnedScopedCronJob(job, workspacePaths, automationState)
  )) ?? null;
  const existingProactiveReminder = jobs.find((job) => (
    getCronJobName(job) === jobNames.proactiveReminder
    && isOwnedScopedCronJob(job, workspacePaths, automationState)
  )) ?? null;

  if (config.automation.dailyPlan.enabled) {
    state.dailyPlan = await reconcileNamedCronJob({
      name: jobNames.dailyPlan,
      schedule: {
        cron: buildCronExpressionForLocalTime(config.automation.dailyPlan.scheduleLocalTime),
        tz,
      },
      desiredState: 'enabled',
      session: 'main',
      systemEvent: buildDailyPlanSystemEvent({
        skillRoot,
        locatorPath: workspacePaths.locatorPath,
        workspaceScope: jobNames.scopeToken,
      }),
      wake: 'now',
      existingJob: existingDailyPlan,
    }, options);
  } else {
    state.dailyPlan = await removeNamedCronJob(jobNames.dailyPlan, {
      ...options,
      existingJob: existingDailyPlan,
    });
  }

  if (config.automation.scheduledReminder.enabled) {
    state.scheduledReminder = await reconcileNamedCronJob({
      name: jobNames.scheduledReminder,
      schedule: {
        cron: buildCronExpressionForLocalTime(
          config.automation.scheduledReminder.scheduleLocalTime,
          config.automation.scheduledReminder.weekdays,
        ),
        tz,
      },
      desiredState: 'enabled',
      session: 'isolated',
      message: buildScheduledReminderMessage({
        skillRoot,
        locatorPath: workspacePaths.locatorPath,
      }),
      announce: true,
      existingJob: existingScheduledReminder,
    }, options);
  } else {
    state.scheduledReminder = await removeNamedCronJob(jobNames.scheduledReminder, {
      ...options,
      existingJob: existingScheduledReminder,
    });
  }

  if (config.automation.proactiveReminder.enabled && config.consent.proactiveReminderExplained) {
    state.proactiveReminder = await reconcileNamedCronJob({
      name: jobNames.proactiveReminder,
      schedule: {
        cron: buildCronExpressionForLocalTime(
          config.automation.proactiveReminder.scheduleLocalTime,
          config.automation.proactiveReminder.weekdays,
        ),
        tz,
      },
      desiredState: 'enabled',
      session: 'isolated',
      message: buildProactiveReminderMessage({
        skillRoot,
        locatorPath: workspacePaths.locatorPath,
      }),
      announce: true,
      existingJob: existingProactiveReminder,
    }, options);
  } else {
    state.proactiveReminder = await removeNamedCronJob(jobNames.proactiveReminder, {
      ...options,
      existingJob: existingProactiveReminder,
    });
  }

  await removeOwnedGlobalCronJob(CLAWCARE_JOB_NAMES.dailyPlan, jobs, workspacePaths, options);
  await removeOwnedGlobalCronJob(CLAWCARE_JOB_NAMES.scheduledReminder, jobs, workspacePaths, options);
  await removeOwnedGlobalCronJob(CLAWCARE_JOB_NAMES.proactiveReminder, jobs, workspacePaths, options);
  state.legacyWorkdayReminder = await removeOwnedGlobalCronJob(
    CLAWCARE_JOB_NAMES.legacyWorkdayReminder,
    jobs,
    workspacePaths,
    options,
  );

  await writeJsonFile(workspacePaths.automationStatePath, {
    updatedAt: new Date().toISOString(),
    timeZone: tz,
    configPath: workspacePaths.configPath,
    workspaceScope: jobNames.scopeToken,
    jobNames: {
      dailyPlan: jobNames.dailyPlan,
      scheduledReminder: jobNames.scheduledReminder,
      proactiveReminder: jobNames.proactiveReminder,
    },
    state,
  });

  return state;
};

export const scheduleFollowUpSyncJob = async ({
  config,
  workspacePaths,
  skillRoot,
  sessionId,
  delayMin,
  retryCount = CLAWCARE_SYNC_RETRY_COUNT,
  retryDelayMin = CLAWCARE_SYNC_RETRY_DELAY_MIN,
  openclawBin,
}) => {
  const options = {
    openclawBin,
    cwd: workspacePaths.workspaceDir,
    schedulerBackend: workspacePaths.hostLocator.schedulerBackend,
    workspacePaths,
  };
  return await reconcileNamedCronJob({
    name: `clawcare-followup-sync-${sanitizeToken(sessionId).slice(0, 36)}`,
    schedule: {
      at: `${Math.max(1, delayMin ?? config.automation.postRunSync.followUpDelayMin ?? CLAWCARE_FOLLOW_UP_DELAY_MIN)}m`,
    },
    desiredState: 'enabled',
    session: 'main',
    systemEvent: buildFollowUpSyncSystemEvent({
      skillRoot,
      locatorPath: workspacePaths.locatorPath,
      sessionId,
      retryCount,
      retryDelayMin,
    }),
    wake: 'now',
    deleteAfterRun: true,
  }, options);
};

export const indexOpenClawMemory = async ({ openclawBin, cwd }) => {
  try {
    const result = await runOpenClawCommand(['memory', 'index', '--force'], {
      openclawBin,
      cwd,
    });
    return {
      indexed: true,
      backend: 'openclaw_memory',
      command: [result.command, ...result.args].join(' '),
      stdout: result.stdout,
      hostMemorySpec: null,
    };
  } catch (error) {
    return {
      indexed: false,
      backend: 'openclaw_memory',
      command: `${resolveOpenClawCommand(openclawBin)} memory index --force`,
      error: error instanceof Error ? error.message : String(error),
      hostMemorySpec: null,
    };
  }
};

export const syncMemoryIndex = async ({ workspacePaths, openclawBin, cwd }) => {
  const backend = resolveMemorySyncBackend({ workspacePaths });
  if (backend !== 'openclaw_memory') {
    return {
      indexed: false,
      backend,
      command: null,
      reason: backend === 'host_native' ? 'host_managed' : 'local_file_only',
      hostMemorySpec: null,
    };
  }
  return await indexOpenClawMemory({ openclawBin, cwd });
};

export const buildPostRunSyncSpec = ({
  skillRoot,
  locatorPath,
  sessionId,
  runId,
  followUpSync,
}) => ({
  trigger: {
    event: 'run_completed',
    acceptedIdentifiers: ['sessionId', 'runId'],
  },
  timing: 'immediate',
  readStdoutAs: 'json',
  action: {
    kind: 'local_script',
    script: path.join(skillRoot, 'scripts', 'sync_run.mjs'),
    preferredIdentifier: sessionId ? 'sessionId' : runId ? 'runId' : undefined,
    argsBySessionId: [
      '--locator',
      locatorPath,
      '--session-id',
      sessionId ?? '<sessionId>',
    ],
    argsByRunId: [
      '--locator',
      locatorPath,
      '--run-id',
      runId ?? '<runId>',
    ],
  },
  fallback: followUpSync
    ? compactObject({
      kind: 'scheduled_retry',
      deferred: followUpSync.deferred,
      hostSchedulerSpec: followUpSync.hostSchedulerSpec,
    })
    : null,
});

const buildNextPlanInputSpec = () => ({
  flags: HOST_HISTORY_INPUT_FLAGS,
  acceptedPayload: 'items[]',
  requiredFields: HOST_HISTORY_REQUIRED_FIELDS,
  mergePolicy: 'prefer_local_runs_by_run_id',
});

const buildHostMemorySpec = ({
  workspacePaths,
  note,
  runRecordPath,
  memoryPath,
  recentAnalysisPath,
}) => {
  if (workspacePaths.hostLocator.memoryBackend !== 'host_native') {
    return null;
  }

  return {
    kind: 'memory',
    action: 'mirror_local_summary',
    backend: workspacePaths.hostLocator.memoryBackend,
    status: 'pending_host_write',
    tags: ['clawcare', 'training_summary', workspacePaths.hostLocator.hostKind],
    summary: note.summary,
    nextSuggestion: note.next_suggestion,
    entryTitle: `ClawCare ${note.protocol ?? 'training'} ${note.run_id}`,
    content: [
      `ClawCare sync`,
      `session: ${note.session_id}`,
      `run: ${note.run_id}`,
      `protocol: ${note.protocol}`,
      `summary: ${note.summary}`,
      `next: ${note.next_suggestion}`,
    ].join('\n'),
    localArtifacts: compactObject({
      runRecordPath,
      memoryPath,
      recentAnalysisPath,
    }),
  };
};

export const buildHostWritebackSpec = ({
  workspacePaths,
  hostMemorySpec,
  runRecordPath,
  memoryPath,
  recentAnalysisPath,
}) => ({
  kind: 'host_writeback',
  required: workspacePaths.hostLocator.memoryBackend === 'host_native',
  timing: 'immediate_after_local_sync',
  purpose: ['long_term_memory', 'future_personalization'],
  source: hostMemorySpec ? 'hostMemorySpec' : 'localArtifacts',
  hostDecidesStorage: true,
  readStdoutAs: 'json',
  nextPlanInput: buildNextPlanInputSpec(),
  instructions: hostMemorySpec
    ? `Read JSON stdout, write ${hostMemorySpec.entryTitle} into host-managed long-term memory immediately, and reuse recent ClawCare history through ${HOST_HISTORY_INPUT_FLAGS.join(' or ')} before the next build_plan.mjs call.`
    : 'Keep the local artifacts as the source of truth when no host-native memory exists.',
  localArtifacts: compactObject({
    runRecordPath,
    memoryPath,
    recentAnalysisPath,
  }),
});

export const syncRunToWorkspace = async (workspacePaths, bundle, options = {}) => {
  const recordWrite = await writeRunRecord(workspacePaths, {
    apiBase: bundle.apiBase,
    run: bundle.run,
    session: bundle.session,
    reminder: bundle.reminder,
    note: bundle.note,
    hook: bundle.hook,
    capturedAt: new Date().toISOString(),
  });
  const memoryWrite = await appendMemoryFile(workspacePaths, bundle.note, recordWrite.record);
  const recentAnalysisPath = await writeRecentAnalysis(workspacePaths, bundle.note);
  const memoryIndex = options.skipMemoryIndex
    ? { indexed: false, command: null, backend: workspacePaths.hostLocator.memoryBackend, hostMemorySpec: null }
    : await syncMemoryIndex({
      workspacePaths,
      openclawBin: options.openclawBin,
      cwd: workspacePaths.workspaceDir,
    });
  const hostMemorySpec = buildHostMemorySpec({
    workspacePaths,
    note: bundle.note,
    runRecordPath: recordWrite.filePath,
    memoryPath: memoryWrite.memoryPath,
    recentAnalysisPath,
  });
  const hostWritebackSpec = buildHostWritebackSpec({
    workspacePaths,
    hostMemorySpec,
    runRecordPath: recordWrite.filePath,
    memoryPath: memoryWrite.memoryPath,
    recentAnalysisPath,
  });

  return {
    runRecordPath: recordWrite.filePath,
    runRecordChanged: recordWrite.changed,
    memoryPath: memoryWrite.memoryPath,
    memoryAppended: memoryWrite.appended,
    recentAnalysisPath,
    memoryIndex,
    hostMemorySpec,
    hostWritebackSpec,
    localArtifacts: compactObject({
      runRecordPath: recordWrite.filePath,
      memoryPath: memoryWrite.memoryPath,
      recentAnalysisPath,
    }),
  };
};

const ALLOWED_PATCH_KEYS = new Set([
  'automation',
  'consent',
  'openclawContext',
  'personalizationSignals',
  'workState',
]);

const validatePatch = (patch, prefix = '') => {
  if (!isRecord(patch)) {
    throw new Error('invalid_patch');
  }

  for (const [key, value] of Object.entries(patch)) {
    const nextPrefix = prefix ? `${prefix}.${key}` : key;
    if (!prefix && !ALLOWED_PATCH_KEYS.has(key)) {
      throw new Error(`patch_key_not_allowed:${key}`);
    }
    if (prefix === 'automation' && ![
      'dailyPlan',
      'postRunSync',
      'scheduledReminder',
      'proactiveReminder',
      'workdayReminder',
      'sedentaryBreak',
    ].includes(key)) {
      throw new Error(`patch_key_not_allowed:${nextPrefix}`);
    }
    if (prefix === 'consent' && ![
      'disclosureShown',
      'proactiveReminderExplained',
      'workdayReminderExplained',
      'sedentaryTrackingExplained',
    ].includes(key)) {
      throw new Error(`patch_key_not_allowed:${nextPrefix}`);
    }
    if (prefix === 'personalizationSignals' && !['preferences', 'questionnaire', 'health', 'weather'].includes(key)) {
      throw new Error(`patch_key_not_allowed:${nextPrefix}`);
    }
    if (prefix === 'workState' && !['workModeEnabled', 'reminderEnabled', 'continuousActiveMinutes', 'lastBreakAt'].includes(key)) {
      throw new Error(`patch_key_not_allowed:${nextPrefix}`);
    }
    if (isRecord(value)) {
      validatePatch(value, nextPrefix);
    }
  }
};

export const applySettingsPatch = async ({
  patch,
  workspacePaths,
  openclawBin,
  skillRoot,
}) => {
  validatePatch(patch);
  const effectiveWorkspacePaths = resolveWorkspacePaths(workspacePaths ?? {});
  const loaded = await readConfig({
    locatorPath: effectiveWorkspacePaths.locatorPath,
    workspaceDir: effectiveWorkspacePaths.workspaceDir,
    configPath: effectiveWorkspacePaths.configPath,
  });
  const merged = deepMerge(loaded.config, patch);
  const normalized = normalizeConfig(merged, loaded.workspacePaths);
  await writeConfig(loaded.workspacePaths.configPath, normalized);
  const automation = await reconcileAutomationJobs({
    config: normalized,
    workspacePaths: loaded.workspacePaths,
    skillRoot,
    openclawBin,
  });

  return {
    config: normalized,
    automation,
  };
};

export const parsePatchInput = async (args) => {
  const patchFile = parseFlagValue(args, '--patch-file');
  const patchJson = parseFlagValue(args, '--patch-json');
  if (patchFile) {
    const parsed = await parseJsonFileIfExists(path.resolve(patchFile));
    if (!isRecord(parsed)) {
      throw new Error(`invalid_patch_file:${patchFile}`);
    }
    return parsed;
  }
  if (patchJson) {
    const parsed = JSON.parse(patchJson);
    if (!isRecord(parsed)) {
      throw new Error('invalid_patch_json');
    }
    return parsed;
  }
  throw new Error('missing_patch_input');
};
