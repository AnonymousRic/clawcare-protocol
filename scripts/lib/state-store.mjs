import fs from 'node:fs/promises';
import path from 'node:path';

import {
  CLAWCARE_DEFAULT_BASE_URL,
  DEFAULT_CONFIG,
  ISO_DATE_PATTERN,
  ISO_DATE_TIME_PATTERN,
  TIME_PATTERN,
  VALID_FAMILIES,
  VALID_FOCUS,
  VALID_PACE,
  buildSedentaryLevel,
  buildHostProfile,
  compactObject,
  deepClone,
  deepMerge,
  ensureDirectory,
  isMissingFileError,
  isRecord,
  parseBooleanValue,
  parseJsonFileIfExists,
  parseMaybeInt,
  readFileIfExists,
  resolveWorkspacePaths,
  safeJsonParse,
  stableStringify,
  stripTrailingSlash,
  summarizeText,
  trimToUndefined,
  uniqueStrings,
  VALID_REMINDER_KINDS,
  getDefaultReturnToForHost,
  normalizeHostLocator,
  writeJsonFile,
  sanitizeToken,
} from './core.mjs';

const normalizeScheduleLocalTime = (value, fallback) => (
  typeof value === 'string' && TIME_PATTERN.test(value.trim())
    ? value.trim()
    : fallback
);

const normalizeWeekdays = (value) => {
  const source = Array.isArray(value)
    ? value
    : DEFAULT_CONFIG.automation.scheduledReminder.weekdays;
  return Array.from(new Set(
    source
      .map((entry) => Number.parseInt(String(entry), 10))
      .filter((entry) => Number.isFinite(entry) && entry >= 0 && entry <= 6),
  )).sort((left, right) => left - right);
};

const normalizeOpenclawContext = (value) => {
  const source = isRecord(value) ? value : {};
  return compactObject({
    goalNote: trimToUndefined(source.goalNote),
    preferredFamilies: uniqueStrings(Array.isArray(source.preferredFamilies) ? source.preferredFamilies : [])
      .filter((entry) => VALID_FAMILIES.has(entry)),
    avoidActionTypes: uniqueStrings(Array.isArray(source.avoidActionTypes) ? source.avoidActionTypes : []),
    bodyLimits: uniqueStrings(Array.isArray(source.bodyLimits) ? source.bodyLimits : []),
  });
};

const normalizePreferences = (value) => {
  const source = isRecord(value) ? value : {};
  const durationMin = parseMaybeInt(
    source.durationMin,
    DEFAULT_CONFIG.personalizationSignals.preferences.durationMin,
  );
  return {
    focus: VALID_FOCUS.has(source.focus)
      ? source.focus
      : DEFAULT_CONFIG.personalizationSignals.preferences.focus,
    pace: VALID_PACE.has(source.pace)
      ? source.pace
      : DEFAULT_CONFIG.personalizationSignals.preferences.pace,
    durationMin: Math.max(3, Math.min(12, durationMin)),
    preferredFamilies: uniqueStrings(Array.isArray(source.preferredFamilies) ? source.preferredFamilies : [])
      .filter((entry) => VALID_FAMILIES.has(entry)),
  };
};

const normalizeQuestionnaire = (value) => {
  const source = isRecord(value) ? value : {};
  const durationMin = parseMaybeInt(
    source.durationMin,
    DEFAULT_CONFIG.personalizationSignals.questionnaire.durationMin,
  );
  return {
    focus: VALID_FOCUS.has(source.focus)
      ? source.focus
      : DEFAULT_CONFIG.personalizationSignals.questionnaire.focus,
    pace: VALID_PACE.has(source.pace)
      ? source.pace
      : DEFAULT_CONFIG.personalizationSignals.questionnaire.pace,
    durationMin: Math.max(3, Math.min(12, durationMin)),
  };
};

const normalizePersonalizationSignals = (value) => {
  const source = isRecord(value) ? value : {};
  const weatherSource = isRecord(source.weather) ? source.weather : {};
  return {
    preferences: normalizePreferences(source.preferences),
    questionnaire: normalizeQuestionnaire(source.questionnaire),
    health: isRecord(source.health)
      ? { ...DEFAULT_CONFIG.personalizationSignals.health, ...source.health }
      : deepClone(DEFAULT_CONFIG.personalizationSignals.health),
    weather: compactObject(
      isRecord(source.weather)
        ? {
          ...DEFAULT_CONFIG.personalizationSignals.weather,
          ...weatherSource,
          condition: trimToUndefined(weatherSource.condition),
        }
        : deepClone(DEFAULT_CONFIG.personalizationSignals.weather),
    ),
  };
};

export const normalizeConfig = (rawConfig = {}, workspacePaths = resolveWorkspacePaths()) => {
  const source = isRecord(rawConfig) ? rawConfig : {};
  const automation = isRecord(source.automation) ? source.automation : {};
  const legacyScheduledReminder = isRecord(automation.workdayReminder) ? automation.workdayReminder : {};
  const legacyProactiveReminder = isRecord(automation.sedentaryBreak) ? automation.sedentaryBreak : {};
  const scheduledReminder = isRecord(automation.scheduledReminder)
    ? deepMerge(automation.scheduledReminder, legacyScheduledReminder)
    : legacyScheduledReminder;
  const proactiveReminder = isRecord(automation.proactiveReminder)
    ? deepMerge(automation.proactiveReminder, legacyProactiveReminder)
    : legacyProactiveReminder;
  const postRunSync = isRecord(automation.postRunSync) ? automation.postRunSync : {};
  const consent = isRecord(source.consent) ? source.consent : {};
  const workState = isRecord(source.workState) ? source.workState : {};
  const legacyDailyNotify = automation.dailyPlan?.mode === 'notify'
    || parseBooleanValue(automation.dailyPlan?.autoOpen, false);
  const defaultReturnTo = getDefaultReturnToForHost(workspacePaths.hostLocator);

  return {
    baseUrl: typeof source.baseUrl === 'string' && source.baseUrl.trim()
      ? stripTrailingSlash(source.baseUrl.trim())
      : CLAWCARE_DEFAULT_BASE_URL,
    returnTo: typeof source.returnTo === 'string' && source.returnTo.trim()
      ? source.returnTo.trim()
      : defaultReturnTo,
    automation: {
      dailyPlan: {
        enabled: parseBooleanValue(
          automation.dailyPlan?.enabled,
          DEFAULT_CONFIG.automation.dailyPlan.enabled,
        ),
        scheduleLocalTime: normalizeScheduleLocalTime(
          automation.dailyPlan?.scheduleLocalTime,
          DEFAULT_CONFIG.automation.dailyPlan.scheduleLocalTime,
        ),
        mode: 'silent_prepare',
        autoOpen: false,
      },
      postRunSync: {
        enabled: parseBooleanValue(
          postRunSync.enabled,
          DEFAULT_CONFIG.automation.postRunSync.enabled,
        ),
        followUpDelayMin: Math.max(
          1,
          parseMaybeInt(
            postRunSync.followUpDelayMin,
            DEFAULT_CONFIG.automation.postRunSync.followUpDelayMin,
          ),
        ),
      },
      scheduledReminder: {
        enabled: parseBooleanValue(
          scheduledReminder.enabled ?? (legacyDailyNotify ? true : undefined),
          DEFAULT_CONFIG.automation.scheduledReminder.enabled,
        ),
        scheduleLocalTime: normalizeScheduleLocalTime(
          scheduledReminder.scheduleLocalTime ?? (legacyDailyNotify ? automation.dailyPlan?.scheduleLocalTime : undefined),
          DEFAULT_CONFIG.automation.scheduledReminder.scheduleLocalTime,
        ),
        weekdays: normalizeWeekdays(scheduledReminder.weekdays),
      },
      proactiveReminder: {
        enabled: parseBooleanValue(
          proactiveReminder.enabled,
          DEFAULT_CONFIG.automation.proactiveReminder.enabled,
        ),
        scheduleLocalTime: normalizeScheduleLocalTime(
          proactiveReminder.scheduleLocalTime,
          DEFAULT_CONFIG.automation.proactiveReminder.scheduleLocalTime,
        ),
        weekdays: normalizeWeekdays(proactiveReminder.weekdays),
      },
    },
    consent: {
      disclosureShown: parseBooleanValue(
        consent.disclosureShown,
        DEFAULT_CONFIG.consent.disclosureShown,
      ),
      proactiveReminderExplained: parseBooleanValue(
        Object.prototype.hasOwnProperty.call(consent, 'workdayReminderExplained')
          ? consent.workdayReminderExplained
          : Object.prototype.hasOwnProperty.call(consent, 'sedentaryTrackingExplained')
            ? consent.sedentaryTrackingExplained
            : consent.proactiveReminderExplained,
        DEFAULT_CONFIG.consent.proactiveReminderExplained,
      ),
    },
    openclawContext: normalizeOpenclawContext(source.openclawContext),
    personalizationSignals: normalizePersonalizationSignals(source.personalizationSignals),
    workState: {
      workModeEnabled: parseBooleanValue(
        workState.workModeEnabled,
        DEFAULT_CONFIG.workState.workModeEnabled,
      ),
      reminderEnabled: parseBooleanValue(
        workState.reminderEnabled ?? workState.sedentaryReminderEnabled,
        DEFAULT_CONFIG.workState.reminderEnabled,
      ),
      continuousActiveMinutes: Number.isFinite(workState.continuousActiveMinutes)
        ? Math.max(0, Math.floor(workState.continuousActiveMinutes))
        : undefined,
      lastBreakAt: typeof workState.lastBreakAt === 'string' && ISO_DATE_TIME_PATTERN.test(workState.lastBreakAt)
        ? workState.lastBreakAt.trim()
        : '',
    },
    paths: {
      workspaceDir: workspacePaths.workspaceDir,
      cacheDir: workspacePaths.cacheDir,
      runsDir: workspacePaths.runsDir,
      memoryDir: workspacePaths.memoryDir,
      recentAnalysisPath: workspacePaths.recentAnalysisPath,
      locatorPath: workspacePaths.locatorPath,
    },
  };
};

export const readConfig = async (overrides = {}) => {
  const workspacePaths = resolveWorkspacePaths(overrides);
  const rawLocator = await parseJsonFileIfExists(workspacePaths.locatorPath);
  const normalizedWorkspacePaths = {
    ...workspacePaths,
    hostLocator: normalizeHostLocator(rawLocator ?? workspacePaths.hostLocator, {
      hostKind: workspacePaths.hostLocator.hostKind,
      storageRoot: workspacePaths.storageRoot,
      workspaceDir: workspacePaths.workspaceDir,
      locatorPath: workspacePaths.locatorPath,
      configPath: workspacePaths.configPath,
      capabilities: workspacePaths.hostLocator.capabilities,
    }),
  };
  const rawConfig = await parseJsonFileIfExists(workspacePaths.configPath);
  const config = normalizeConfig(rawConfig ?? {}, normalizedWorkspacePaths);
  return {
    workspacePaths: normalizedWorkspacePaths,
    rawConfig: rawConfig ?? {},
    rawLocator: rawLocator ?? {},
    fileExists: rawConfig !== null,
    config,
  };
};

export const writeConfig = async (configPath, config) => {
  await writeJsonFile(configPath, config);
  return configPath;
};

const buildBootstrapDisclosureText = () => (
  '奇点行动已准备好：训练方案会结合本地训练记录、recent_analysis 和最近记忆生成个性化建议，完成后会回写稳定记录。安装后不会默认创建定时任务；你主动设置的提醒会直接生效。该 skill 不会读取屏幕、输入内容、摄像头画面或无关本地文件。'
);

export const ensureBootstrap = async (options = {}) => {
  const loaded = await readConfig({
    ...options,
    hostCapabilities: options.hostCapabilities,
  });
  const effectiveConfig = deepClone(loaded.config);
  const disclosurePending = !effectiveConfig.consent.disclosureShown;
  const effectiveLocator = normalizeHostLocator(loaded.rawLocator, {
    hostKind: loaded.workspacePaths.hostLocator.hostKind,
    storageRoot: loaded.workspacePaths.storageRoot,
    workspaceDir: loaded.workspacePaths.workspaceDir,
    locatorPath: loaded.workspacePaths.locatorPath,
    configPath: loaded.workspacePaths.configPath,
    capabilities: {
      ...loaded.workspacePaths.hostLocator.capabilities,
      native_memory: parseBooleanValue(
        options.hostCapabilities?.supportsNativeMemory,
        loaded.workspacePaths.hostLocator.capabilities.native_memory,
      ),
      native_scheduler: parseBooleanValue(
        options.hostCapabilities?.supportsNativeScheduler,
        loaded.workspacePaths.hostLocator.capabilities.native_scheduler,
      ),
      callback_activation: parseBooleanValue(
        options.hostCapabilities?.canHandleOpenClawCallback,
        loaded.workspacePaths.hostLocator.capabilities.callback_activation,
      ),
      local_browser_launch: parseBooleanValue(
        options.hostCapabilities?.canOpenLocalBrowser,
        loaded.workspacePaths.hostLocator.capabilities.local_browser_launch,
      ),
    },
  });
  const effectiveWorkspacePaths = {
    ...loaded.workspacePaths,
    hostLocator: effectiveLocator,
  };

  await Promise.all([
    ensureDirectory(effectiveWorkspacePaths.clawcareDir),
    ensureDirectory(effectiveWorkspacePaths.cacheDir),
    ensureDirectory(effectiveWorkspacePaths.preparedRemindersDir),
    ensureDirectory(effectiveWorkspacePaths.runsDir),
    ensureDirectory(effectiveWorkspacePaths.memoryDir),
  ]);

  if (options.markDisclosureShown !== false) {
    effectiveConfig.consent.disclosureShown = true;
  }

  const normalizedRaw = normalizeConfig(loaded.rawConfig, effectiveWorkspacePaths);
  const shouldWrite = !loaded.fileExists || stableStringify(normalizedRaw) !== stableStringify(effectiveConfig);
  const shouldWriteLocator = stableStringify(loaded.rawLocator) !== stableStringify(effectiveLocator);
  if (shouldWrite) {
    await writeConfig(effectiveWorkspacePaths.configPath, effectiveConfig);
  }
  if (shouldWriteLocator) {
    await writeJsonFile(effectiveWorkspacePaths.locatorPath, effectiveLocator);
  }

  return {
    ...loaded,
    workspacePaths: effectiveWorkspacePaths,
    config: effectiveConfig,
    wroteConfig: shouldWrite,
    wroteLocator: shouldWriteLocator,
    disclosurePending,
    bootstrapDisclosure: disclosurePending ? buildBootstrapDisclosureText() : undefined,
    hostProfile: buildHostProfile(effectiveLocator),
  };
};

export const buildDailyPlanShouldOpen = (_config, flags = {}) => {
  if (flags.forceNoOpen) {
    return false;
  }
  const reminderKind = VALID_REMINDER_KINDS.has(String(flags.reminderKind ?? '').trim())
    ? String(flags.reminderKind).trim()
    : 'direct';
  if (reminderKind !== 'direct') {
    return false;
  }
  if (!flags.forceOpen) {
    return false;
  }
  return Boolean(flags.hostCanOpenLocalBrowser);
};

const computeNowSignals = (now = new Date()) => {
  const hour = now.getHours();
  let daypart = 'midday';
  if (hour < 6) daypart = 'late_night';
  else if (hour < 11) daypart = 'morning';
  else if (hour < 15) daypart = 'midday';
  else if (hour < 19) daypart = 'afternoon';
  else daypart = 'evening';

  return {
    timestamp: now.toISOString(),
    daypart,
    weekdayType: now.getDay() === 0 || now.getDay() === 6 ? 'weekend' : 'weekday',
  };
};

const deriveHistorySignals = (recentRuns) => {
  if (!recentRuns.length) {
    return undefined;
  }

  const completionValues = recentRuns
    .map((run) => run.completion)
    .filter((value) => typeof value === 'number');
  const fatigueValues = recentRuns
    .map((run) => run.fatigue)
    .filter((value) => typeof value === 'number');
  const last = recentRuns[0];
  return compactObject({
    lastProtocolFamily: last.protocol_family,
    lastCompletion: last.completion,
    lastFatigue: last.fatigue,
    daysSinceLastRun: last.capturedAt
      ? Math.floor((Date.now() - new Date(last.capturedAt).getTime()) / 86_400_000)
      : undefined,
    completionAvg: completionValues.length
      ? Number((completionValues.reduce((sum, value) => sum + value, 0) / completionValues.length).toFixed(3))
      : undefined,
    fatigueAvg: fatigueValues.length
      ? Number((fatigueValues.reduce((sum, value) => sum + value, 0) / fatigueValues.length).toFixed(3))
      : undefined,
    recentRerouteCount: recentRuns.filter((run) => run.rerouted).length,
    recentPositiveCount: recentRuns.filter((run) => (run.completion ?? 0) >= 0.85).length,
  });
};

const parseMaybeNumber = (value) => {
  if (value === null || value === undefined || value === '') {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const normalizeHostHistoryPayload = (value) => {
  if (Array.isArray(value)) {
    return value;
  }
  if (isRecord(value) && Array.isArray(value.items)) {
    return value.items;
  }
  return [];
};

const readHostHistorySource = async (source, kind) => {
  if (typeof source !== 'string' || !source.trim()) {
    return [];
  }
  if (kind === 'json') {
    return normalizeHostHistoryPayload(safeJsonParse(source.trim()));
  }

  const raw = await readFileIfExists(path.resolve(source));
  if (!raw.trim()) {
    return [];
  }
  return normalizeHostHistoryPayload(safeJsonParse(raw));
};

const normalizeHostHistoryItem = (item) => {
  if (!isRecord(item)) {
    return null;
  }

  const runId = trimToUndefined(item.runId ?? item.run_id);
  const sessionId = trimToUndefined(item.sessionId ?? item.session_id);
  const protocol = trimToUndefined(item.protocol);
  const protocolFamily = trimToUndefined(item.protocolFamily ?? item.protocol_family);
  const summary = trimToUndefined(item.summary);
  const nextSuggestion = trimToUndefined(item.nextSuggestion ?? item.next_suggestion);
  const syncedAt = trimToUndefined(
    item.syncedAt
    ?? item.synced_at
    ?? item.capturedAt
    ?? item.captured_at
    ?? item.sync_generated_at,
  );
  const recommendedIntensity = trimToUndefined(
    item.recommendedIntensity ?? item.recommended_intensity,
  );
  const warnings = uniqueStrings(Array.isArray(item.warnings) ? item.warnings : []);
  const conflicts = uniqueStrings(Array.isArray(item.conflicts) ? item.conflicts : []);

  if (!runId && !sessionId && !summary && !nextSuggestion && !syncedAt) {
    return null;
  }

  return compactObject({
    runId,
    sessionId,
    protocol,
    protocolFamily,
    summary,
    nextSuggestion,
    recommendedIntensity,
    warnings,
    conflicts,
    syncedAt,
    completion: parseMaybeNumber(item.completion),
    fatigue: parseMaybeNumber(item.fatigue),
    rerouted: item.rerouted === true
      || (Array.isArray(item.reroutes) && item.reroutes.length > 0),
  });
};

const collectHostHistory = async (options = {}) => {
  const jsonItems = await readHostHistorySource(options.hostHistoryJson, 'json');
  const fileItems = await readHostHistorySource(options.hostHistoryFile, 'file');
  const normalizedItems = uniqueStrings(
    [...jsonItems, ...fileItems]
      .map((entry) => stableStringify(normalizeHostHistoryItem(entry)))
      .filter((entry) => entry !== undefined),
  )
    .map((entry) => safeJsonParse(entry))
    .filter((entry) => entry !== null);

  return normalizedItems.map((entry) => normalizeHostHistoryItem(entry)).filter(Boolean);
};

const buildRecentRunSignalsFromHostHistory = (items) => (
  items.map((item) => compactObject({
    runId: item.runId,
    sessionId: item.sessionId,
    protocol_id: item.protocol ?? 'clawcare-protocol',
    protocol_family: item.protocolFamily,
    completion: item.completion,
    fatigue: item.fatigue,
    rerouted: item.rerouted,
    summary: item.summary,
    capturedAt: item.syncedAt,
  }))
);

const mergeRecentRuns = (localRuns, hostRuns) => {
  const merged = [];
  const seen = new Set();
  for (const run of [...localRuns, ...hostRuns]) {
    const key = trimToUndefined(run.runId)
      ?? trimToUndefined(run.sessionId)
      ?? `${run.protocol_id ?? 'clawcare'}|${run.capturedAt ?? ''}|${run.summary ?? ''}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    merged.push(run);
  }
  return merged
    .sort((left, right) => String(right.capturedAt ?? '').localeCompare(String(left.capturedAt ?? '')))
    .slice(0, 5);
};

const buildHostHistoryMemorySignals = (items) => uniqueStrings(
  items.flatMap((item) => [
    item.summary,
    item.nextSuggestion ? `Next: ${item.nextSuggestion}` : undefined,
    ...(Array.isArray(item.warnings) ? item.warnings.map((warning) => `Warning: ${warning}`) : []),
    ...(Array.isArray(item.conflicts) ? item.conflicts.map((conflict) => `Conflict: ${conflict}`) : []),
  ]
    .filter(Boolean)
    .map((entry) => summarizeText(entry))),
).slice(0, 6);

const extractJsonFence = (markdown) => {
  const match = markdown.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (!match) {
    return null;
  }
  return safeJsonParse(match[1].trim());
};

export const collectRecentAnalysisSignals = async (recentAnalysisPath) => {
  const markdown = await readFileIfExists(recentAnalysisPath);
  if (!markdown.trim()) {
    return {
      summary: '',
      memorySignals: [],
      selfReport: undefined,
      raw: '',
      payload: null,
    };
  }

  const payload = extractJsonFence(markdown);
  const summaryLine = markdown
    .split(/\r?\n/)
    .find((line) => /^-\s*(总结|下次建议|最近一次训练)/.test(line));
  return {
    summary: summaryLine ? summaryLine.replace(/^- [^:\uFF1A]+[:\uFF1A]\s*/, '').trim() : '',
    memorySignals: Array.isArray(payload?.memorySignals)
      ? uniqueStrings(payload.memorySignals)
      : [],
    selfReport: isRecord(payload?.selfReport) ? payload.selfReport : undefined,
    raw: markdown,
    payload,
  };
};

export const listRunRecords = async (runsDir) => {
  try {
    const entries = await fs.readdir(runsDir, { withFileTypes: true });
    const records = [];

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) {
        continue;
      }
      const filePath = path.join(runsDir, entry.name);
      const parsed = await parseJsonFileIfExists(filePath);
      if (!isRecord(parsed)) {
        continue;
      }
      const note = isRecord(parsed.note) ? parsed.note : {};
      records.push({
        ...parsed,
        filePath,
        capturedAt: typeof parsed.capturedAt === 'string'
          ? parsed.capturedAt
          : typeof note.sync_generated_at === 'string'
            ? note.sync_generated_at
            : '',
      });
    }

    return records.sort((left, right) => String(right.capturedAt).localeCompare(String(left.capturedAt)));
  } catch (error) {
    if (isMissingFileError(error)) {
      return [];
    }
    throw error;
  }
};

export const buildRecentRunSignalsFromRecords = (records) => (
  records.slice(0, 5).map((record) => ({
    runId: record.note?.run_id,
    sessionId: record.note?.session_id,
    protocol_id: record.session?.protocol_id ?? record.note?.protocol ?? 'clawcare-protocol',
    protocol_family: record.session?.protocol_family ?? record.reminder?.protocol_family,
    completion: record.note?.completion,
    fatigue: record.note?.fatigue,
    rerouted: Array.isArray(record.run?.reroutes) ? record.run.reroutes.length > 0 : false,
    summary: record.note?.summary,
    capturedAt: record.capturedAt,
  }))
);

export const collectMemorySignals = async (memoryDir) => {
  try {
    const entries = await fs.readdir(memoryDir, { withFileTypes: true });
    const targets = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.md') && ISO_DATE_PATTERN.test(entry.name.slice(0, 10)))
      .map((entry) => entry.name)
      .sort()
      .reverse()
      .slice(0, 3);

    const signals = [];
    for (const name of targets) {
      const markdown = await readFileIfExists(path.join(memoryDir, name));
      const lines = markdown
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.startsWith('- '))
        .slice(0, 6);
      for (const line of lines) {
        signals.push(summarizeText(line.replace(/^- /, '')));
      }
    }
    return uniqueStrings(signals).slice(0, 6);
  } catch (error) {
    if (isMissingFileError(error)) {
      return [];
    }
    throw error;
  }
};

export const collectPlanContext = async (
  config,
  workspacePaths,
  options = {},
) => {
  const recentAnalysis = await collectRecentAnalysisSignals(workspacePaths.recentAnalysisPath);
  const records = await listRunRecords(workspacePaths.runsDir);
  const hostHistoryItems = await collectHostHistory(options);
  const recentRuns = mergeRecentRuns(
    buildRecentRunSignalsFromRecords(records),
    buildRecentRunSignalsFromHostHistory(hostHistoryItems),
  );
  const history = deriveHistorySignals(recentRuns);
  const memorySignals = uniqueStrings([
    ...recentAnalysis.memorySignals,
    recentAnalysis.summary,
    ...(await collectMemorySignals(workspacePaths.memoryDir)),
    ...buildHostHistoryMemorySignals(hostHistoryItems),
  ]).slice(0, 6);
  const nowSignals = computeNowSignals(options.now instanceof Date ? options.now : new Date());
  const workState = compactObject({
    workModeEnabled: config.workState.workModeEnabled,
    proactiveReminderEnabled: (
      config.workState.reminderEnabled
      && config.automation.proactiveReminder.enabled
      && config.consent.proactiveReminderExplained
    ),
    continuousActiveMinutes: config.workState.continuousActiveMinutes,
    lastBreakAt: config.workState.lastBreakAt || undefined,
    sedentaryLevel: buildSedentaryLevel(config.workState),
  });
  const personalizationSignals = compactObject({
    ...config.personalizationSignals,
    now: nowSignals,
    history,
    workState,
  });
  const userIntent = compactObject({
    rawText: options.intentText?.trim() || undefined,
  });

  return {
    payload: compactObject({
      baseUrl: options.baseUrl ?? config.baseUrl,
      return_to: options.returnTo ?? config.returnTo,
      openclawContext: config.openclawContext,
      userIntent,
      personalizationSignals,
      recentRuns,
      memorySignals,
      selfReport: recentAnalysis.selfReport,
    }),
    recentAnalysis,
    recentRuns,
    history,
    memorySignals,
    workState,
    nowSignals,
    records,
    hostHistoryItems,
  };
};

export const buildPlanPayload = async (
  config,
  workspacePaths,
  options = {},
) => (await collectPlanContext(config, workspacePaths, options)).payload;

export const evaluateProactiveReminder = (planContext) => {
  const daysSinceLastRun = Number.isFinite(planContext?.history?.daysSinceLastRun)
    ? planContext.history.daysSinceLastRun
    : undefined;
  const lastTraining = isRecord(planContext?.recentAnalysis?.payload?.lastTraining)
    ? planContext.recentAnalysis.payload.lastTraining
    : {};
  const warnings = Array.isArray(lastTraining.warnings) ? lastTraining.warnings : [];
  const conflicts = Array.isArray(lastTraining.conflicts) ? lastTraining.conflicts : [];

  if (!Array.isArray(planContext?.recentRuns) || planContext.recentRuns.length === 0) {
    return {
      shouldAnnounce: true,
      reasonCode: 'no_recent_runs',
      reasonText: '最近还没有训练记录',
    };
  }
  if ((daysSinceLastRun ?? 0) >= 3) {
    return {
      shouldAnnounce: true,
      reasonCode: 'inactive_for_days',
      reasonText: `已经 ${daysSinceLastRun} 天没有训练了`,
    };
  }
  if ((warnings.length > 0 || conflicts.length > 0) && (daysSinceLastRun ?? 0) >= 1) {
    return {
      shouldAnnounce: true,
      reasonCode: 'recent_caution_signals',
      reasonText: '最近训练里有需要留意的信号',
    };
  }
  return {
    shouldAnnounce: false,
    reasonCode: 'recently_active',
    reasonText: '最近已经安排过训练或活动',
  };
};

export const formatMemoryMarkdown = (note, runRecord) => {
  const marker = `<!-- clawcare:run:${note.run_id} -->`;
  const lines = [
    marker,
    '## 奇点行动 训练记录',
    '',
    `- 会话 ID: ${note.session_id}`,
    `- 运行 ID: ${note.run_id}`,
    `- 协议名称: ${note.protocol}`,
    `- 同步时间: ${note.sync_generated_at}`,
    `- 完成度: ${Number(note.completion ?? 0).toFixed(2)}`,
    `- 稳定度: ${Number(note.stability ?? 0).toFixed(2)}`,
    `- 对称性: ${Number(note.symmetry ?? 0).toFixed(2)}`,
    `- 疲劳: ${Number(note.fatigue ?? 0).toFixed(2)}`,
    `- 推荐强度: ${note.recommended_intensity ?? 'steady'}`,
    `- 总结: ${note.summary}`,
    `- 下次建议: ${note.next_suggestion}`,
  ];

  if (Array.isArray(note.warnings) && note.warnings.length) {
    lines.push('', '### 预警');
    for (const warning of note.warnings) {
      lines.push(`- ${warning}`);
    }
  }

  if (Array.isArray(note.conflicts) && note.conflicts.length) {
    lines.push('', '### 冲突');
    for (const conflict of note.conflicts) {
      lines.push(`- ${conflict}`);
    }
  }

  if (runRecord?.run?.summary && runRecord.run.summary !== note.summary) {
    lines.push('', `- 训练端摘要: ${runRecord.run.summary}`);
  }

  return `${lines.join('\n')}\n`;
};

export const writeRecentAnalysis = async (workspacePaths, note) => {
  const payload = {
    summary: `最近一次奇点行动训练已同步：${note.summary}`,
    memorySignals: uniqueStrings([
      `最近一次奇点行动训练：${note.summary}`,
      `下一次建议：${note.next_suggestion}`,
      ...(Array.isArray(note.warnings) ? note.warnings.map((warning) => `注意：${warning}`) : []),
      ...(Array.isArray(note.conflicts) ? note.conflicts.map((conflict) => `冲突：${conflict}`) : []),
    ]).slice(0, 8),
    selfReport: {
      focus: note.recommended_intensity === 'gentle' ? 'neck_relief' : undefined,
    },
    lastTraining: {
      sessionId: note.session_id,
      runId: note.run_id,
      protocol: note.protocol,
      completion: note.completion,
      stability: note.stability,
      symmetry: note.symmetry,
      fatigue: note.fatigue,
      recommendedIntensity: note.recommended_intensity,
      requestedIntensity: note.requested_intensity,
      canProceedWithRequestedPlan: note.can_proceed_with_requested_plan,
      warnings: note.warnings ?? [],
      conflicts: note.conflicts ?? [],
      nextSuggestion: note.next_suggestion,
      syncedAt: note.sync_generated_at,
    },
    lastRunId: note.run_id,
    lastSessionId: note.session_id,
    lastUpdatedAt: note.sync_generated_at,
  };
  const markdown = [
    '# 最近健康分析',
    '',
    `- 更新时间: ${note.sync_generated_at}`,
    `- 最近一次训练: ${note.protocol}`,
    `- 总结: ${note.summary}`,
    `- 下次建议: ${note.next_suggestion}`,
    '',
    '```json',
    stableStringify(payload),
    '```',
    '',
  ].join('\n');

  await ensureDirectory(path.dirname(workspacePaths.recentAnalysisPath));
  await fs.writeFile(workspacePaths.recentAnalysisPath, markdown, 'utf8');
  return workspacePaths.recentAnalysisPath;
};

export const appendMemoryFile = async (workspacePaths, note, runRecord) => {
  const dateToken = ISO_DATE_PATTERN.test(String(note.sync_generated_at).slice(0, 10))
    ? String(note.sync_generated_at).slice(0, 10)
    : new Date().toISOString().slice(0, 10);
  const memoryPath = path.join(workspacePaths.memoryDir, `${dateToken}.md`);
  const existing = await readFileIfExists(memoryPath);
  const marker = `<!-- clawcare:run:${note.run_id} -->`;
  if (existing.includes(marker)) {
    return {
      memoryPath,
      appended: false,
    };
  }

  const block = formatMemoryMarkdown(note, runRecord);
  const nextContent = existing.trim()
    ? `${existing.trimEnd()}\n\n${block}`
    : block;
  await ensureDirectory(path.dirname(memoryPath));
  await fs.writeFile(memoryPath, nextContent, 'utf8');
  return {
    memoryPath,
    appended: true,
  };
};

const normalizeRunRecord = (record) => ({
  kind: 'clawcare_run_record',
  capturedAt: record.capturedAt ?? new Date().toISOString(),
  apiBase: record.apiBase,
  run: record.run,
  session: record.session,
  reminder: record.reminder,
  note: record.note,
  hook: record.hook,
});

export const writeRunRecord = async (workspacePaths, record) => {
  const normalized = normalizeRunRecord(record);
  const runId = normalized.note?.run_id ?? normalized.run?.run_id;
  if (!runId) {
    throw new Error('missing_run_id');
  }
  const filePath = path.join(workspacePaths.runsDir, `${sanitizeToken(runId)}.json`);
  const previous = await parseJsonFileIfExists(filePath);
  const changed = stableStringify(previous) !== stableStringify(normalized);
  if (changed) {
    await writeJsonFile(filePath, normalized);
  }
  return {
    filePath,
    changed,
    record: normalized,
  };
};
