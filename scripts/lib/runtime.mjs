import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const CLAWCARE_DEFAULT_BASE_URL = 'https://clawcare-protocol.vercel.app';
export const CLAWCARE_DEFAULT_RETURN_TO = 'openclaw://clawcare';
export const CLAWCARE_NO_REPLY = 'NO_REPLY';
export const CLAWCARE_FOLLOW_UP_DELAY_MIN = 20;
export const CLAWCARE_SYNC_RETRY_DELAY_MIN = 10;
export const CLAWCARE_SYNC_RETRY_COUNT = 1;
export const CLAWCARE_JOB_NAMES = {
  dailyPlan: 'clawcare-daily-plan',
  workdayReminder: 'clawcare-workday-reminder',
};

const DEFAULT_CONFIG = {
  baseUrl: CLAWCARE_DEFAULT_BASE_URL,
  returnTo: CLAWCARE_DEFAULT_RETURN_TO,
  automation: {
    dailyPlan: {
      enabled: true,
      scheduleLocalTime: '09:00',
      mode: 'silent_prepare',
      autoOpen: false,
    },
    postRunSync: {
      enabled: true,
      followUpDelayMin: CLAWCARE_FOLLOW_UP_DELAY_MIN,
    },
    workdayReminder: {
      enabled: false,
      scheduleLocalTime: '15:00',
      weekdays: [1, 2, 3, 4, 5],
    },
  },
  consent: {
    disclosureShown: false,
    workdayReminderExplained: false,
  },
  openclawContext: {
    goalNote: '',
    preferredFamilies: [],
    avoidActionTypes: [],
    bodyLimits: [],
  },
  personalizationSignals: {
    preferences: {
      focus: 'neck_relief',
      pace: 'gentle',
      durationMin: 6,
      preferredFamilies: [],
    },
    questionnaire: {
      focus: 'neck_relief',
      pace: 'gentle',
      durationMin: 6,
    },
    health: {
      sleepHours: 7,
      stepBucket: 'mid',
      energyBucket: 'mid',
    },
    weather: {
      condition: '',
      severity: 'normal',
    },
  },
  workState: {
    workModeEnabled: false,
    reminderEnabled: false,
    continuousActiveMinutes: undefined,
    lastBreakAt: '',
  },
};

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATE_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T/;
const TIME_PATTERN = /^\d{2}:\d{2}$/;
const VALID_PACE = new Set(['gentle', 'steady', 'brisk']);
const VALID_FOCUS = new Set(['neck_relief', 'posture_reset', 'stress_relief', 'mobility']);
const VALID_FAMILIES = new Set(['neck_wake', 'sedentary_activate', 'stress_reset']);

const stripTrailingSlash = (value) => value.replace(/\/+$/, '');
const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const deepClone = (value) => JSON.parse(JSON.stringify(value));
const stableStringify = (value) => JSON.stringify(value, null, 2);
const uniqueStrings = (values) => Array.from(new Set(
  values
    .map((value) => String(value ?? '').trim())
    .filter(Boolean),
));

const deepMerge = (base, patch) => {
  if (!isRecord(base) || !isRecord(patch)) {
    return patch;
  }

  const merged = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (Array.isArray(value)) {
      merged[key] = [...value];
      continue;
    }
    if (isRecord(value) && isRecord(merged[key])) {
      merged[key] = deepMerge(merged[key], value);
      continue;
    }
    merged[key] = value;
  }
  return merged;
};

const safeJsonParse = (raw) => {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

const isMissingFileError = (error) => (
  error instanceof Error
  && 'code' in error
  && error.code === 'ENOENT'
);

const sanitizeToken = (value) => String(value ?? '')
  .replace(/[^a-z0-9_-]+/gi, '_')
  .replace(/^_+|_+$/g, '')
  .toLowerCase();

const summarizeText = (text, maxLength = 220) => {
  const normalized = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 3)}...`;
};

const parseMaybeInt = (value, fallback) => {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const ensureDirectory = async (dirPath) => {
  await fs.mkdir(dirPath, { recursive: true });
  return dirPath;
};

const readFileIfExists = async (filePath) => {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if (isMissingFileError(error)) {
      return '';
    }
    throw error;
  }
};

const parseJsonFileIfExists = async (filePath) => {
  const raw = await readFileIfExists(filePath);
  if (!raw.trim()) {
    return null;
  }
  const parsed = safeJsonParse(raw);
  if (parsed === null) {
    throw new Error(`invalid_json:${filePath}`);
  }
  return parsed;
};

const writeJsonFile = async (filePath, value) => {
  await ensureDirectory(path.dirname(filePath));
  await fs.writeFile(filePath, `${stableStringify(value)}\n`, 'utf8');
  return filePath;
};

const compactObject = (value) => {
  if (Array.isArray(value)) {
    return value
      .map((entry) => compactObject(entry))
      .filter((entry) => entry !== undefined);
  }
  if (!isRecord(value)) {
    return value;
  }

  const next = {};
  for (const [key, entry] of Object.entries(value)) {
    const compacted = compactObject(entry);
    if (compacted === undefined) {
      continue;
    }
    if (Array.isArray(compacted) && compacted.length === 0) {
      continue;
    }
    if (isRecord(compacted) && Object.keys(compacted).length === 0) {
      continue;
    }
    next[key] = compacted;
  }
  return next;
};

const buildSedentaryLevel = (workState) => {
  if (!workState.workModeEnabled || !workState.reminderEnabled) {
    return 'none';
  }
  if ((workState.continuousActiveMinutes ?? 0) >= 80) {
    return 'elevated';
  }
  if ((workState.continuousActiveMinutes ?? 0) >= 50) {
    return 'watch';
  }
  return 'none';
};

export const parseFlagValue = (args, flag) => {
  const index = args.indexOf(flag);
  if (index < 0) {
    return undefined;
  }
  return args[index + 1];
};

export const hasFlag = (args, flag) => args.includes(flag);

export const parseBooleanValue = (value, fallback) => {
  if (value === undefined) {
    return fallback;
  }
  return /^(1|true|yes|on)$/i.test(String(value).trim());
};

export const resolveSkillRoot = (importMetaUrl) => (
  path.resolve(path.dirname(fileURLToPath(importMetaUrl)), '..')
);

export const resolveWorkspacePaths = (overrides = {}) => {
  const configPathOverride = overrides.configPath
    ? path.resolve(overrides.configPath)
    : undefined;
  const derivedWorkspaceDir = !overrides.workspaceDir && configPathOverride
    ? path.resolve(path.dirname(configPathOverride), '..')
    : undefined;
  const workspaceDir = path.resolve(
    overrides.workspaceDir
      ?? derivedWorkspaceDir
      ?? process.env.OPENCLAW_WORKSPACE_DIR
      ?? path.join(os.homedir(), '.openclaw', 'workspace'),
  );
  const clawcareDir = path.join(workspaceDir, 'clawcare');
  const configPath = configPathOverride
    ?? path.resolve(
      process.env.OPENCLAW_CLAWCARE_CONFIG_PATH
        ?? path.join(clawcareDir, 'config.json'),
    );
  const cacheDir = path.resolve(overrides.cacheDir ?? path.join(clawcareDir, 'cache'));
  const runsDir = path.resolve(overrides.runsDir ?? path.join(clawcareDir, 'runs'));
  const memoryDir = path.resolve(
    overrides.memoryDir
      ?? process.env.OPENCLAW_MEMORY_DIR
      ?? path.join(workspaceDir, 'memory'),
  );
  const recentAnalysisPath = path.resolve(
    overrides.recentAnalysisPath
      ?? path.join(clawcareDir, 'recent_analysis.md'),
  );

  return {
    workspaceDir,
    clawcareDir,
    configPath,
    cacheDir,
    runsDir,
    memoryDir,
    recentAnalysisPath,
    dailyPlanCachePath: path.join(cacheDir, 'daily_plan.json'),
    automationStatePath: path.join(cacheDir, 'automation_state.json'),
  };
};

const normalizeScheduleLocalTime = (value, fallback) => (
  typeof value === 'string' && TIME_PATTERN.test(value.trim())
    ? value.trim()
    : fallback
);

const normalizeWeekdays = (value) => {
  const source = Array.isArray(value)
    ? value
    : DEFAULT_CONFIG.automation.workdayReminder.weekdays;
  return Array.from(new Set(
    source
      .map((entry) => Number.parseInt(String(entry), 10))
      .filter((entry) => Number.isFinite(entry) && entry >= 0 && entry <= 6),
  )).sort((left, right) => left - right);
};

const normalizeOpenclawContext = (value) => {
  const source = isRecord(value) ? value : {};
  return {
    goalNote: typeof source.goalNote === 'string' ? source.goalNote.trim() : '',
    preferredFamilies: uniqueStrings(Array.isArray(source.preferredFamilies) ? source.preferredFamilies : [])
      .filter((entry) => VALID_FAMILIES.has(entry)),
    avoidActionTypes: uniqueStrings(Array.isArray(source.avoidActionTypes) ? source.avoidActionTypes : []),
    bodyLimits: uniqueStrings(Array.isArray(source.bodyLimits) ? source.bodyLimits : []),
  };
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
  return {
    preferences: normalizePreferences(source.preferences),
    questionnaire: normalizeQuestionnaire(source.questionnaire),
    health: isRecord(source.health)
      ? { ...DEFAULT_CONFIG.personalizationSignals.health, ...source.health }
      : deepClone(DEFAULT_CONFIG.personalizationSignals.health),
    weather: isRecord(source.weather)
      ? { ...DEFAULT_CONFIG.personalizationSignals.weather, ...source.weather }
      : deepClone(DEFAULT_CONFIG.personalizationSignals.weather),
  };
};

export const normalizeConfig = (rawConfig = {}, workspacePaths = resolveWorkspacePaths()) => {
  const source = isRecord(rawConfig) ? rawConfig : {};
  const automation = isRecord(source.automation) ? source.automation : {};
  const legacyReminder = isRecord(automation.sedentaryBreak) ? automation.sedentaryBreak : {};
  const workdayReminder = isRecord(automation.workdayReminder)
    ? automation.workdayReminder
    : legacyReminder;
  const postRunSync = isRecord(automation.postRunSync) ? automation.postRunSync : {};
  const consent = isRecord(source.consent) ? source.consent : {};
  const workState = isRecord(source.workState) ? source.workState : {};

  return {
    baseUrl: typeof source.baseUrl === 'string' && source.baseUrl.trim()
      ? stripTrailingSlash(source.baseUrl.trim())
      : CLAWCARE_DEFAULT_BASE_URL,
    returnTo: typeof source.returnTo === 'string' && source.returnTo.trim()
      ? source.returnTo.trim()
      : CLAWCARE_DEFAULT_RETURN_TO,
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
        mode: automation.dailyPlan?.mode === 'notify' ? 'notify' : 'silent_prepare',
        autoOpen: parseBooleanValue(
          automation.dailyPlan?.autoOpen,
          DEFAULT_CONFIG.automation.dailyPlan.autoOpen,
        ),
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
      workdayReminder: {
        enabled: parseBooleanValue(
          workdayReminder.enabled,
          DEFAULT_CONFIG.automation.workdayReminder.enabled,
        ),
        scheduleLocalTime: normalizeScheduleLocalTime(
          workdayReminder.scheduleLocalTime,
          DEFAULT_CONFIG.automation.workdayReminder.scheduleLocalTime,
        ),
        weekdays: normalizeWeekdays(workdayReminder.weekdays),
      },
    },
    consent: {
      disclosureShown: parseBooleanValue(
        consent.disclosureShown,
        DEFAULT_CONFIG.consent.disclosureShown,
      ),
      workdayReminderExplained: parseBooleanValue(
        consent.workdayReminderExplained ?? consent.sedentaryTrackingExplained,
        DEFAULT_CONFIG.consent.workdayReminderExplained,
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
    },
  };
};

export const readConfig = async (overrides = {}) => {
  const workspacePaths = resolveWorkspacePaths(overrides);
  const rawConfig = await parseJsonFileIfExists(workspacePaths.configPath);
  const config = normalizeConfig(rawConfig ?? {}, workspacePaths);
  return {
    workspacePaths,
    rawConfig: rawConfig ?? {},
    fileExists: rawConfig !== null,
    config,
  };
};

export const writeConfig = async (configPath, config) => {
  await writeJsonFile(configPath, config);
  return configPath;
};

const buildBootstrapDisclosure = () => (
  'ClawCare \u5df2\u6309\u9ed8\u8ba4\u95ed\u73af\u51c6\u5907\u5b8c\u6210\uff1a\u542f\u52a8\u8bad\u7ec3\u65f6\u4f1a\u81ea\u52a8\u7ed3\u5408\u672c\u5730\u8bad\u7ec3\u5386\u53f2\u3001recent_analysis \u548c\u6700\u8fd1\u7684\u8bb0\u5fc6\u6458\u8981\u751f\u6210\u4e2a\u6027\u5316\u65b9\u6848\uff1b\u8bad\u7ec3\u540e\u4f1a\u81ea\u52a8\u5b89\u6392\u56de\u6d41\u5199\u5165\u8bad\u7ec3\u8bb0\u5f55\u3001recent_analysis \u548c\u5f53\u5929\u8bb0\u5fc6\u3002\u4e3b\u52a8\u63d0\u9192\u9ed8\u8ba4\u5173\u95ed\uff0c\u53ea\u6709\u4f60\u660e\u786e\u8981\u6c42\u540e\u624d\u4f1a\u5f00\u542f\uff0c\u800c\u4e14\u4e0d\u4f1a\u8bfb\u53d6\u5c4f\u5e55\u3001\u8f93\u5165\u5185\u5bb9\u6216\u6444\u50cf\u5934\u753b\u9762\u3002'
);

export const ensureBootstrap = async (options = {}) => {
  const loaded = await readConfig(options);
  const effectiveConfig = deepClone(loaded.config);
  const disclosurePending = !effectiveConfig.consent.disclosureShown;

  await Promise.all([
    ensureDirectory(loaded.workspacePaths.clawcareDir),
    ensureDirectory(loaded.workspacePaths.cacheDir),
    ensureDirectory(loaded.workspacePaths.runsDir),
    ensureDirectory(loaded.workspacePaths.memoryDir),
  ]);

  if (options.markDisclosureShown !== false) {
    effectiveConfig.consent.disclosureShown = true;
  }

  const normalizedRaw = normalizeConfig(loaded.rawConfig, loaded.workspacePaths);
  const shouldWrite = !loaded.fileExists || stableStringify(normalizedRaw) !== stableStringify(effectiveConfig);
  if (shouldWrite) {
    await writeConfig(loaded.workspacePaths.configPath, effectiveConfig);
  }

  return {
    ...loaded,
    config: effectiveConfig,
    wroteConfig: shouldWrite,
    disclosurePending,
    bootstrapDisclosure: disclosurePending ? buildBootstrapDisclosure() : undefined,
  };
};

export const buildDailyPlanShouldOpen = (config, flags = {}) => {
  if (!config.automation.dailyPlan.enabled) {
    return false;
  }
  if (flags.forceNoOpen) {
    return false;
  }
  if (flags.forceOpen) {
    return true;
  }
  return config.automation.dailyPlan.mode === 'notify' && Boolean(config.automation.dailyPlan.autoOpen);
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
  const latestTimestamp = Date.parse(recentRuns[0].capturedAt ?? '');
  return compactObject({
    daysSinceLastRun: Number.isFinite(latestTimestamp)
      ? Math.max(0, Math.floor((Date.now() - latestTimestamp) / (24 * 60 * 60 * 1000)))
      : undefined,
    recentCompletionAvg: completionValues.length
      ? Number((completionValues.reduce((sum, value) => sum + value, 0) / completionValues.length).toFixed(2))
      : undefined,
    recentFatigueAvg: fatigueValues.length
      ? Number((fatigueValues.reduce((sum, value) => sum + value, 0) / fatigueValues.length).toFixed(2))
      : undefined,
    recentRerouteCount: recentRuns.filter((run) => run.rerouted).length,
    recentPositiveCount: recentRuns.filter((run) => (run.completion ?? 0) >= 0.85).length,
  });
};

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
    .find((line) => /^-\s*(\u603b\u7ed3|\u4e0b\u6b21\u5efa\u8bae|\u6700\u8fd1\u4e00\u6b21\u8bad\u7ec3)/.test(line));
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

export const buildPlanPayload = async (
  config,
  workspacePaths,
  options = {},
) => {
  const recentAnalysis = await collectRecentAnalysisSignals(workspacePaths.recentAnalysisPath);
  const records = await listRunRecords(workspacePaths.runsDir);
  const recentRuns = buildRecentRunSignalsFromRecords(records);
  const history = deriveHistorySignals(recentRuns);
  const memorySignals = uniqueStrings([
    ...recentAnalysis.memorySignals,
    recentAnalysis.summary,
    ...(await collectMemorySignals(workspacePaths.memoryDir)),
  ]).slice(0, 6);
  const nowSignals = computeNowSignals(options.now instanceof Date ? options.now : new Date());
  const workState = compactObject({
    workModeEnabled: config.workState.workModeEnabled,
    sedentaryReminderEnabled: config.workState.reminderEnabled && config.consent.workdayReminderExplained,
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

  return compactObject({
    baseUrl: options.baseUrl ?? config.baseUrl,
    return_to: options.returnTo ?? config.returnTo,
    openclawContext: config.openclawContext,
    userIntent,
    personalizationSignals,
    recentRuns,
    memorySignals,
    selfReport: recentAnalysis.selfReport,
  });
};

export const getApiBaseCandidates = (...values) => uniqueStrings(
  values.flatMap((value) => String(value ?? '')
    .split(/[,\s]+/)
    .map((entry) => stripTrailingSlash(entry))
    .filter(Boolean)),
);

const requestJsonWithCandidates = async (
  apiPath,
  init,
  baseCandidates,
  fetchImpl = fetch,
) => {
  const errors = [];
  for (const base of baseCandidates) {
    try {
      const response = await fetchImpl(`${stripTrailingSlash(base)}${apiPath}`, init);
      if (!response.ok) {
        errors.push(`${base}${apiPath}:${response.status}:${await response.text()}`);
        continue;
      }
      return {
        apiBase: stripTrailingSlash(base),
        data: await response.json(),
      };
    } catch (error) {
      errors.push(`${base}${apiPath}:${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`api_request_failed:${errors.join(' | ')}`);
};

export const requestReminderPlan = async (
  payload,
  baseCandidates,
  fetchImpl = fetch,
) => {
  const response = await requestJsonWithCandidates(
    '/api/reminders',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    },
    baseCandidates,
    fetchImpl,
  );
  return {
    apiBase: response.apiBase,
    reminder: response.data.reminder,
    session: response.data.session,
    paths: response.data.paths,
  };
};

export const cacheDailyPlan = async (workspacePaths, reminderPlan) => {
  await writeJsonFile(workspacePaths.dailyPlanCachePath, {
    requestedAt: new Date().toISOString(),
    apiBase: reminderPlan.apiBase,
    reminder: reminderPlan.reminder,
    session: reminderPlan.session,
    paths: reminderPlan.paths,
  });
  return workspacePaths.dailyPlanCachePath;
};

export const openUrl = async (url) => {
  const command = process.platform === 'win32'
    ? { file: 'cmd', args: ['/c', 'start', '', url] }
    : process.platform === 'darwin'
      ? { file: 'open', args: [url] }
      : { file: 'xdg-open', args: [url] };

  await new Promise((resolve, reject) => {
    const child = spawn(command.file, command.args, {
      stdio: 'ignore',
      detached: true,
    });
    child.once('error', reject);
    child.unref();
    resolve();
  });
};

export const formatMemoryMarkdown = (note, runRecord) => {
  const marker = `<!-- clawcare:run:${note.run_id} -->`;
  const lines = [
    marker,
    '## ClawCare \u8bad\u7ec3\u8bb0\u5f55',
    '',
    `- \u4f1a\u8bdd ID: ${note.session_id}`,
    `- \u8fd0\u884c ID: ${note.run_id}`,
    `- \u534f\u8bae\u540d\u79f0: ${note.protocol}`,
    `- \u540c\u6b65\u65f6\u95f4: ${note.sync_generated_at}`,
    `- \u5b8c\u6210\u5ea6: ${Number(note.completion ?? 0).toFixed(2)}`,
    `- \u7a33\u5b9a\u5ea6: ${Number(note.stability ?? 0).toFixed(2)}`,
    `- \u5bf9\u79f0\u6027: ${Number(note.symmetry ?? 0).toFixed(2)}`,
    `- \u75b2\u52b3: ${Number(note.fatigue ?? 0).toFixed(2)}`,
    `- \u63a8\u8350\u5f3a\u5ea6: ${note.recommended_intensity ?? 'steady'}`,
    `- \u603b\u7ed3: ${note.summary}`,
    `- \u4e0b\u6b21\u5efa\u8bae: ${note.next_suggestion}`,
  ];

  if (Array.isArray(note.warnings) && note.warnings.length) {
    lines.push('', '### \u9884\u8b66');
    for (const warning of note.warnings) {
      lines.push(`- ${warning}`);
    }
  }

  if (Array.isArray(note.conflicts) && note.conflicts.length) {
    lines.push('', '### \u51b2\u7a81');
    for (const conflict of note.conflicts) {
      lines.push(`- ${conflict}`);
    }
  }

  if (runRecord?.run?.summary && runRecord.run.summary !== note.summary) {
    lines.push('', `- \u8bad\u7ec3\u7aef\u6458\u8981: ${runRecord.run.summary}`);
  }

  return `${lines.join('\n')}\n`;
};

export const writeRecentAnalysis = async (workspacePaths, note) => {
  const payload = {
    summary: `\u6700\u8fd1\u4e00\u6b21 ClawCare \u8bad\u7ec3\u5df2\u540c\u6b65\uff1a${note.summary}`,
    memorySignals: uniqueStrings([
      `\u6700\u8fd1\u4e00\u6b21 ClawCare \u8bad\u7ec3\uff1a${note.summary}`,
      `\u4e0b\u4e00\u6b21\u5efa\u8bae\uff1a${note.next_suggestion}`,
      ...(Array.isArray(note.warnings) ? note.warnings.map((warning) => `\u6ce8\u610f\uff1a${warning}`) : []),
      ...(Array.isArray(note.conflicts) ? note.conflicts.map((conflict) => `\u51b2\u7a81\uff1a${conflict}`) : []),
    ]).slice(0, 8),
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
    '# \u6700\u8fd1\u5065\u5eb7\u5206\u6790',
    '',
    `- \u66f4\u65b0\u65f6\u95f4: ${note.sync_generated_at}`,
    `- \u6700\u8fd1\u4e00\u6b21\u8bad\u7ec3: ${note.protocol}`,
    `- \u603b\u7ed3: ${note.summary}`,
    `- \u4e0b\u6b21\u5efa\u8bae: ${note.next_suggestion}`,
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

const parseHistoryItems = (data) => {
  if (Array.isArray(data?.items)) {
    return data.items;
  }
  if (Array.isArray(data)) {
    return data;
  }
  return [];
};

export const fetchSyncBundle = async (
  baseCandidates,
  options = {},
) => {
  if (options.runId) {
    const runId = encodeURIComponent(options.runId);
    const sync = await requestJsonWithCandidates(
      `/api/runs/${runId}/sync`,
      undefined,
      baseCandidates,
      options.fetchImpl ?? fetch,
    );
    let run;
    try {
      const runResponse = await requestJsonWithCandidates(
        `/api/runs/${runId}`,
        undefined,
        [sync.apiBase],
        options.fetchImpl ?? fetch,
      );
      run = runResponse.data.run;
    } catch {
      run = undefined;
    }

    return {
      apiBase: sync.apiBase,
      run,
      session: undefined,
      reminder: undefined,
      note: sync.data.note,
      markdown: typeof sync.data.markdown === 'string'
        ? sync.data.markdown
        : formatMemoryMarkdown(sync.data.note, { run }),
      hook: sync.data.hook,
    };
  }

  if (options.sessionId) {
    const history = await requestJsonWithCandidates(
      '/api/openclaw/history?limit=15',
      undefined,
      baseCandidates,
      options.fetchImpl ?? fetch,
    );
    const match = parseHistoryItems(history.data).find((item) => (
      item?.session?.session_id === options.sessionId
      || item?.run?.session_id === options.sessionId
      || item?.note?.session_id === options.sessionId
    ));
    if (!match) {
      return null;
    }
    return {
      apiBase: history.apiBase,
      run: match.run,
      session: match.session,
      reminder: match.reminder,
      note: match.note,
      markdown: typeof match.markdown === 'string'
        ? match.markdown
        : formatMemoryMarkdown(match.note, match),
      hook: match.hook,
    };
  }

  const latest = await requestJsonWithCandidates(
    '/api/openclaw/sync/latest',
    undefined,
    baseCandidates,
    options.fetchImpl ?? fetch,
  );
  return {
    apiBase: latest.apiBase,
    run: latest.data.run,
    session: latest.data.session,
    reminder: latest.data.reminder,
    note: latest.data.note,
    markdown: typeof latest.data.markdown === 'string'
      ? latest.data.markdown
      : formatMemoryMarkdown(latest.data.note, latest.data),
    hook: latest.data.hook,
  };
};

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
    ? { indexed: false, command: null }
    : await indexOpenClawMemory({
      openclawBin: options.openclawBin,
      cwd: workspacePaths.workspaceDir,
    });

  return {
    runRecordPath: recordWrite.filePath,
    runRecordChanged: recordWrite.changed,
    memoryPath: memoryWrite.memoryPath,
    memoryAppended: memoryWrite.appended,
    recentAnalysisPath,
    memoryIndex,
  };
};

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

const buildCronSystemEvent = (action, payload) => [
  `ClawCare automation event: ${action}.`,
  'Use the installed `clawcare-protocol` skill.',
  'Use the `exec` tool to run the local Node script described below exactly once.',
  'Only touch files under `~/.openclaw/workspace/clawcare/` and the current daily memory file.',
  `When the work completes successfully and no direct user reply is required, respond with ${CLAWCARE_NO_REPLY}.`,
  '',
  '```json',
  stableStringify(payload),
  '```',
].join('\n');

export const buildDailyPlanSystemEvent = ({
  skillRoot,
  configPath,
  mode,
}) => buildCronSystemEvent('daily-plan', {
  script: path.join(skillRoot, 'scripts', 'build_plan.mjs'),
  args: [
    '--config',
    configPath,
    '--intent',
    mode === 'notify'
      ? '\u8bf7\u51c6\u5907\u4eca\u5929\u7684 ClawCare \u8bad\u7ec3\uff0c\u5e76\u81ea\u52a8\u7ed3\u5408\u672c\u5730\u8bb0\u5fc6\u3001recent_analysis \u548c\u6700\u8fd1\u8bad\u7ec3\u8bb0\u5f55\u751f\u6210\u4e2a\u6027\u5316\u65b9\u6848\uff1b\u5728\u5408\u9002\u65f6\u63d0\u9192\u6211\u5f00\u59cb\u3002'
      : '\u8bf7\u9759\u9ed8\u51c6\u5907\u4eca\u5929\u7684 ClawCare \u8bad\u7ec3\uff0c\u5e76\u81ea\u52a8\u7ed3\u5408\u672c\u5730\u8bb0\u5fc6\u3001recent_analysis \u548c\u6700\u8fd1\u8bad\u7ec3\u8bb0\u5f55\u751f\u6210\u4e2a\u6027\u5316\u65b9\u6848\uff1b\u4e0d\u8981\u4e3b\u52a8\u6253\u5f00\u9875\u9762\u3002',
    mode === 'notify' ? '--open' : '--no-open',
  ],
  mode,
});

export const buildFollowUpSyncSystemEvent = ({
  skillRoot,
  configPath,
  sessionId,
  retryCount = CLAWCARE_SYNC_RETRY_COUNT,
  retryDelayMin = CLAWCARE_SYNC_RETRY_DELAY_MIN,
}) => buildCronSystemEvent('follow-up-sync', {
  script: path.join(skillRoot, 'scripts', 'sync_run.mjs'),
  args: [
    '--config',
    configPath,
    '--session-id',
    sessionId,
    '--retry-count',
    String(retryCount),
    '--retry-delay-min',
    String(retryDelayMin),
  ],
  sessionId,
});

export const buildWorkdayReminderSystemEvent = ({
  skillRoot,
  configPath,
}) => buildCronSystemEvent('workday-reminder', {
  script: path.join(skillRoot, 'scripts', 'build_plan.mjs'),
  args: [
    '--config',
    configPath,
    '--intent',
    '\u8bf7\u6309\u5de5\u4f5c\u65e5\u8212\u5c55\u63d0\u9192\u51c6\u5907\u4e00\u7248\u504f\u8f7b\u7684\u9888\u80a9\u653e\u677e\u8bad\u7ec3\uff0c\u5e76\u81ea\u52a8\u7ed3\u5408\u672c\u5730\u8bb0\u5fc6\u3001recent_analysis \u548c\u6700\u8fd1\u8bad\u7ec3\u8bb0\u5f55\u751f\u6210\u4e2a\u6027\u5316\u65b9\u6848\u3002\u6ce8\u610f\u8fd9\u53ea\u662f\u65f6\u95f4\u578b\u63d0\u9192\uff0c\u4e0d\u4ee3\u8868\u4efb\u4f55\u884c\u4e3a\u76d1\u6d4b\u3002',
    '--no-open',
  ],
  reminderType: 'time_boxed_workday',
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
  const parsed = safeJsonParse(stdout);
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

export const findCronJobByName = async (name, options = {}) => {
  const jobs = await listCronJobs(options);
  return jobs.find((job) => getCronJobName(job) === name) ?? null;
};

const cronSpecToArgs = (spec, existingJobId = null) => {
  const base = existingJobId
    ? ['cron', 'edit', existingJobId]
    : ['cron', 'add', '--name', spec.name];

  if (spec.schedule.at) {
    base.push('--at', spec.schedule.at);
  }
  if (spec.schedule.cron) {
    base.push('--cron', spec.schedule.cron);
  }
  if (spec.schedule.tz) {
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
  const existing = await findCronJobByName(spec.name, options);
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
    };
  } catch (error) {
    return {
      action: existing ? 'deferred-update' : 'deferred-create',
      deferred: true,
      command: commandPreview,
      error: error instanceof Error ? error.message : String(error),
    };
  }
};

export const removeNamedCronJob = async (name, options = {}) => {
  const existing = await findCronJobByName(name, options);
  if (!existing) {
    return {
      action: 'noop',
      deferred: false,
      command: null,
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
    };
  } catch (error) {
    return {
      action: 'deferred-remove',
      deferred: true,
      command: commandPreview,
      error: error instanceof Error ? error.message : String(error),
    };
  }
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
  };
  const tz = detectTimeZone();
  const state = {
    dailyPlan: null,
    workdayReminder: null,
  };

  if (config.automation.dailyPlan.enabled) {
    state.dailyPlan = await reconcileNamedCronJob({
      name: CLAWCARE_JOB_NAMES.dailyPlan,
      schedule: {
        cron: buildCronExpressionForLocalTime(config.automation.dailyPlan.scheduleLocalTime),
        tz,
      },
      session: 'main',
      systemEvent: buildDailyPlanSystemEvent({
        skillRoot,
        configPath: workspacePaths.configPath,
        mode: config.automation.dailyPlan.mode,
      }),
      wake: 'now',
    }, options);
  } else {
    state.dailyPlan = await removeNamedCronJob(CLAWCARE_JOB_NAMES.dailyPlan, options);
  }

  if (config.automation.workdayReminder.enabled && config.consent.workdayReminderExplained) {
    state.workdayReminder = await reconcileNamedCronJob({
      name: CLAWCARE_JOB_NAMES.workdayReminder,
      schedule: {
        cron: buildCronExpressionForLocalTime(
          config.automation.workdayReminder.scheduleLocalTime,
          config.automation.workdayReminder.weekdays,
        ),
        tz,
      },
      session: 'main',
      systemEvent: buildWorkdayReminderSystemEvent({
        skillRoot,
        configPath: workspacePaths.configPath,
      }),
      wake: 'now',
    }, options);
  } else {
    state.workdayReminder = await removeNamedCronJob(CLAWCARE_JOB_NAMES.workdayReminder, options);
  }

  await writeJsonFile(workspacePaths.automationStatePath, {
    updatedAt: new Date().toISOString(),
    timeZone: tz,
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
  };
  return await reconcileNamedCronJob({
    name: `clawcare-followup-sync-${sanitizeToken(sessionId).slice(0, 36)}`,
    schedule: {
      at: `${Math.max(1, delayMin ?? config.automation.postRunSync.followUpDelayMin)}m`,
    },
    session: 'main',
    systemEvent: buildFollowUpSyncSystemEvent({
      skillRoot,
      configPath: workspacePaths.configPath,
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
      command: [result.command, ...result.args].join(' '),
      stdout: result.stdout,
    };
  } catch (error) {
    return {
      indexed: false,
      command: `${resolveOpenClawCommand(openclawBin)} memory index --force`,
      error: error instanceof Error ? error.message : String(error),
    };
  }
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
    if (prefix === 'automation' && !['dailyPlan', 'postRunSync', 'workdayReminder'].includes(key)) {
      throw new Error(`patch_key_not_allowed:${nextPrefix}`);
    }
    if (prefix === 'consent' && !['disclosureShown', 'workdayReminderExplained'].includes(key)) {
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
    workspaceDir: effectiveWorkspacePaths.workspaceDir,
    configPath: effectiveWorkspacePaths.configPath,
    cacheDir: effectiveWorkspacePaths.cacheDir,
    runsDir: effectiveWorkspacePaths.runsDir,
    memoryDir: effectiveWorkspacePaths.memoryDir,
    recentAnalysisPath: effectiveWorkspacePaths.recentAnalysisPath,
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
    const parsed = safeJsonParse(patchJson);
    if (!isRecord(parsed)) {
      throw new Error('invalid_patch_json');
    }
    return parsed;
  }
  throw new Error('missing_patch_input');
};

export const buildBuildPlanResult = ({
  bootstrap,
  reminderPlan,
  cachePath,
  followUpSync,
  opened,
}) => ({
  status: 'ok',
  apiBase: reminderPlan.apiBase,
  configPath: bootstrap.workspacePaths.configPath,
  cachePath,
  sessionId: reminderPlan.session.session_id,
  protocolFamily: reminderPlan.session.protocol_family,
  launchUrl: reminderPlan.session.launch_url,
  reminderId: reminderPlan.reminder.reminder_id,
  recommendedIntensity: reminderPlan.reminder.recommended_intensity,
  requestedIntensity: reminderPlan.reminder.requested_intensity,
  warnings: reminderPlan.reminder.warnings ?? [],
  conflicts: reminderPlan.reminder.conflicts ?? [],
  bootstrapDisclosure: bootstrap.bootstrapDisclosure,
  disclosurePending: bootstrap.disclosurePending,
  opened,
  followUpSync,
});
