import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const CLAWCARE_DEFAULT_BASE_URL = 'https://clawcare-protocol.vercel.app';
export const CLAWCARE_DEFAULT_RETURN_TO = 'openclaw://clawcare';
export const CLAWCARE_NO_REPLY = 'NO_REPLY';
export const CLAWCARE_ANNOUNCE_SKIP = 'ANNOUNCE_SKIP';
export const CLAWCARE_FOLLOW_UP_DELAY_MIN = 20;
export const CLAWCARE_SYNC_RETRY_DELAY_MIN = 10;
export const CLAWCARE_SYNC_RETRY_COUNT = 1;
const DEFAULT_WEEKDAYS = [1, 2, 3, 4, 5];
export const CLAWCARE_JOB_NAMES = {
  dailyPlan: 'clawcare-daily-plan',
  scheduledReminder: 'clawcare-scheduled-reminder',
  proactiveReminder: 'clawcare-proactive-reminder',
  legacyWorkdayReminder: 'clawcare-workday-reminder',
};
const CLAWCARE_GLOBAL_JOB_NAMES = new Set(Object.values(CLAWCARE_JOB_NAMES));

const DEFAULT_CONFIG = {
  baseUrl: CLAWCARE_DEFAULT_BASE_URL,
  returnTo: CLAWCARE_DEFAULT_RETURN_TO,
  automation: {
    dailyPlan: {
      enabled: false,
      scheduleLocalTime: '09:00',
      mode: 'silent_prepare',
      autoOpen: false,
    },
    postRunSync: {
      enabled: true,
      followUpDelayMin: CLAWCARE_FOLLOW_UP_DELAY_MIN,
    },
    scheduledReminder: {
      enabled: false,
      scheduleLocalTime: '11:00',
      weekdays: DEFAULT_WEEKDAYS,
    },
    proactiveReminder: {
      enabled: false,
      scheduleLocalTime: '15:00',
      weekdays: DEFAULT_WEEKDAYS,
    },
  },
  consent: {
    disclosureShown: false,
    proactiveReminderExplained: false,
  },
  openclawContext: {
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
const VALID_REMINDER_KINDS = new Set(['direct', 'scheduled', 'proactive', 'daily_plan']);

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
const normalizeComparablePath = (value) => path.resolve(String(value ?? ''))
  .replace(/\\/g, '/')
  .toLowerCase();
const trimToUndefined = (value) => {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
};

const summarizeText = (text, maxLength = 220) => {
  const normalized = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 3)}...`;
};

const normalizeReminderKind = (value) => (
  VALID_REMINDER_KINDS.has(String(value ?? '').trim())
    ? String(value).trim()
    : 'direct'
);

const isOpenClawUri = (value) => (
  typeof value === 'string'
  && value.trim().toLowerCase().startsWith('openclaw://')
);

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
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? trimmed : undefined;
  }
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
    : DEFAULT_WEEKDAYS;
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
  'ClawCare 已准备好：启动训练会自动结合本地训练记录、recent_analysis 和最近记忆生成个性化方案，训练后会自动回写记录。安装后不会默认创建定时任务；你主动设置的提醒会直接生效，OpenClaw 自主提醒默认关闭，而且不会读取屏幕、输入内容或相机画面。'
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
  return false;
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

export const getWorkspaceScopeToken = (workspacePaths) => createHash('sha1')
  .update(normalizeComparablePath(workspacePaths.configPath))
  .digest('hex')
  .slice(0, 10);

export const getScopedAutomationJobNames = (workspacePaths) => {
  const scopeToken = getWorkspaceScopeToken(workspacePaths);
  return {
    scopeToken,
    dailyPlan: `${CLAWCARE_JOB_NAMES.dailyPlan}-${scopeToken}`,
    scheduledReminder: `${CLAWCARE_JOB_NAMES.scheduledReminder}-${scopeToken}`,
    proactiveReminder: `${CLAWCARE_JOB_NAMES.proactiveReminder}-${scopeToken}`,
    legacyWorkdayReminder: CLAWCARE_JOB_NAMES.legacyWorkdayReminder,
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

export const collectPlanContext = async (
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
    reasonText: '最近已经有训练或活动安排',
  };
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

export const requestReminderPreparation = async (
  payload,
  baseCandidates,
  fetchImpl = fetch,
) => {
  const response = await requestJsonWithCandidates(
    '/api/reminders/prepare',
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
    paths: response.data.paths,
  };
};

export const requestPreparedReminderLaunch = async ({
  reminderId,
  family,
  baseCandidates,
  fetchImpl = fetch,
}) => {
  const normalizedReminderId = String(reminderId ?? '').trim();
  if (!normalizedReminderId) {
    throw new Error('missing_reminder_id');
  }

  const query = new URLSearchParams({ format: 'json' });
  if (typeof family === 'string' && family.trim()) {
    query.set('family', family.trim());
  }

  const response = await requestJsonWithCandidates(
    `/api/reminders/${encodeURIComponent(normalizedReminderId)}/launch?${query.toString()}`,
    {
      method: 'GET',
    },
    baseCandidates,
    fetchImpl,
  );

  return {
    apiBase: response.apiBase,
    reminderId: response.data.reminderId ?? normalizedReminderId,
    session: response.data.session,
    filePath: response.data.filePath,
  };
};

const resolveFallbackFamily = (payload = {}) => {
  const preferredFamily = payload?.openclawContext?.preferredFamilies?.[0]
    ?? payload?.personalizationSignals?.preferences?.preferredFamilies?.[0];
  if (preferredFamily === 'neck_wake' || preferredFamily === 'sedentary_activate' || preferredFamily === 'stress_reset') {
    return preferredFamily;
  }

  const focus = payload?.personalizationSignals?.preferences?.focus
    ?? payload?.personalizationSignals?.questionnaire?.focus;
  if (focus === 'neck_relief') return 'neck_wake';
  if (focus === 'stress_relief') return 'stress_reset';
  return 'sedentary_activate';
};

const buildFallbackEntryUrl = (payload = {}, intentText) => {
  const baseUrl = stripTrailingSlash(String(payload.baseUrl ?? CLAWCARE_DEFAULT_BASE_URL));
  const url = new URL(`${baseUrl}/`);
  url.searchParams.set('mode', 'protocol');
  url.searchParams.set('entry', 'openclaw');
  if (typeof payload.return_to === 'string' && payload.return_to.trim()) {
    url.searchParams.set('return_to', payload.return_to.trim());
  }
  if (typeof intentText === 'string' && intentText.trim()) {
    url.searchParams.set('intent', intentText.trim());
  }
  return url.toString();
};

const buildFallbackReminderPlan = ({
  payload,
  baseCandidates,
  reminderKind,
  proactiveDecision,
}) => {
  const family = resolveFallbackFamily(payload);
  const reminderId = `reminder-fallback-${Date.now()}`;
  const launchUrl = buildFallbackEntryUrl(payload, payload?.userIntent?.rawText);
  const primarySignal = Array.isArray(payload?.memorySignals) && payload.memorySignals.length > 0
    ? summarizeText(payload.memorySignals[0], 56)
    : '';
  const title = reminderKind === 'proactive'
    ? '现在适合安排一组轻量活动'
    : reminderKind === 'daily_plan'
      ? '今日训练已准备好'
      : '到时间活动一下了';
  const summary = primarySignal
    ? `今天先从保守、轻量的活动开始，重点留意：${primarySignal}`
    : '今天先从保守、轻量的活动开始，控制幅度和节奏。';
  const body = reminderKind === 'proactive' && proactiveDecision?.reasonText
    ? `${proactiveDecision.reasonText}，先做一组轻量活动更稳妥。`
    : '先做 3 到 6 分钟的轻量活动，再根据状态决定是否继续。';

  return {
    apiBase: baseCandidates[0] ?? stripTrailingSlash(String(payload.baseUrl ?? CLAWCARE_DEFAULT_BASE_URL)),
    fallbackUsed: true,
    reminder: {
      reminder_id: reminderId,
      title,
      summary,
      body,
      created_at: new Date().toISOString(),
      session_id: `prepared-${reminderId}`,
      entry_source: 'openclaw',
      protocol_family: family,
      protocol_title: family === 'neck_wake'
        ? '颈肩唤醒'
        : family === 'stress_reset'
          ? '舒压放松'
          : '久坐激活',
      launch_url: launchUrl,
      return_to: payload?.return_to,
      personalization_basis: Array.isArray(payload?.memorySignals) ? payload.memorySignals.slice(0, 3) : [],
      openclaw_context_snapshot: payload?.openclawContext,
      user_intent: payload?.userIntent,
      personalization_signals: payload?.personalizationSignals,
      decision_trace: {
        topDrivers: primarySignal ? [primarySignal] : ['先从低强度轻量活动开始。'],
        familyScores: {
          neck_wake: family === 'neck_wake' ? 1 : 0,
          sedentary_activate: family === 'sedentary_activate' ? 1 : 0,
          stress_reset: family === 'stress_reset' ? 1 : 0,
        },
        trainingMode: 'conservative',
        appliedConstraints: [],
        sourceAvailability: {
          history: Boolean(payload?.personalizationSignals?.history),
          photo: false,
          questionnaire: Boolean(payload?.personalizationSignals?.questionnaire),
          preferences: Boolean(payload?.personalizationSignals?.preferences),
          health: Boolean(payload?.personalizationSignals?.health),
          weather: Boolean(payload?.personalizationSignals?.weather),
          workState: Boolean(payload?.personalizationSignals?.workState),
          userIntent: Boolean(payload?.userIntent?.rawText),
        },
      },
      warnings: [],
      conflicts: [],
      recommended_intensity: 'conservative',
      requested_intensity: payload?.userIntent?.requestedIntensity,
      can_proceed_with_requested_plan: true,
      alternate_protocols: [],
      launch_context: {
        version: 1,
        source: 'openclaw_skill',
        session_id: `prepared-${reminderId}`,
        entry_source: 'openclaw',
        protocol_family: family,
        protocol_title: family === 'neck_wake'
          ? '颈肩唤醒'
          : family === 'stress_reset'
            ? '舒压放松'
            : '久坐激活',
        launch_url: launchUrl,
        return_to: payload?.return_to,
        created_at: new Date().toISOString(),
      },
    },
    paths: {},
  };
};

export const requestReminderPreparationWithFallback = async ({
  payload,
  baseCandidates,
  reminderKind,
  proactiveDecision,
  fetchImpl = fetch,
}) => {
  try {
    return await requestReminderPreparation(payload, baseCandidates, fetchImpl);
  } catch {
    return buildFallbackReminderPlan({
      payload,
      baseCandidates,
      reminderKind,
      proactiveDecision,
    });
  }
};

export const cacheDailyPlan = async (workspacePaths, reminderPlan) => {
  await writeJsonFile(workspacePaths.dailyPlanCachePath, {
    requestedAt: new Date().toISOString(),
    apiBase: reminderPlan.apiBase,
    reminder: reminderPlan.reminder,
    session: reminderPlan.session,
    fallbackUsed: reminderPlan.fallbackUsed ?? false,
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
  workspaceScope,
}) => buildCronSystemEvent('daily-plan', {
  workspaceScope,
  script: path.join(skillRoot, 'scripts', 'build_plan.mjs'),
  args: [
    '--config',
    configPath,
    '--intent',
    '请静默准备今天的 ClawCare 训练，并结合本地记忆、recent_analysis 和最近训练记录生成个性化方案，不要主动打开页面。',
    '--reminder-kind',
    'daily_plan',
    '--no-open',
  ],
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

const buildReminderTurnMessage = ({
  skillRoot,
  configPath,
  workspaceScope,
  reminderKind,
  intentText,
}) => [
  `ClawCare reminder run: ${reminderKind}.`,
  'Use the installed `clawcare-protocol` skill.',
  'Use the `exec` tool to run the local Node script below exactly once.',
  'Read the JSON stdout.',
  `If the result contains "announceToken", reply with ${CLAWCARE_ANNOUNCE_SKIP} exactly.`,
  'Otherwise reply with the field "messageText" only.',
  'Do not open the page, do not output JSON, and do not add extra explanation.',
  '',
  '```json',
  stableStringify({
    workspaceScope,
    script: path.join(skillRoot, 'scripts', 'build_plan.mjs'),
    args: [
      '--config',
      configPath,
      '--intent',
      intentText,
      '--reminder-kind',
      reminderKind,
      '--no-open',
    ],
  }),
  '```',
].join('\n');

export const buildScheduledReminderMessage = ({
  skillRoot,
  configPath,
  workspaceScope,
}) => buildReminderTurnMessage({
  skillRoot,
  configPath,
  workspaceScope,
  reminderKind: 'scheduled',
  intentText: '请准备一版适合当前状态的轻量颈肩活动训练，用于定时提醒消息。不要自动打开页面。',
});

export const buildProactiveReminderMessage = ({
  skillRoot,
  configPath,
  workspaceScope,
}) => buildReminderTurnMessage({
  skillRoot,
  configPath,
  workspaceScope,
  reminderKind: 'proactive',
  intentText: '请按近期训练和健康信号判断是否值得提醒用户做一组轻量活动训练；只有在确实值得提醒时才发送可见消息，不要自动打开页面。',
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
  const existing = options.existingJob ?? await findCronJobByName(name, options);
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

const removeOwnedGlobalCronJob = async (name, jobs, workspacePaths, options = {}) => {
  const existing = findCronJobByNameInJobs(jobs, name);
  if (!existing || !isOwnedGlobalCronJob(existing, workspacePaths)) {
    return {
      action: 'noop',
      deferred: false,
      command: null,
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
      session: 'main',
      systemEvent: buildDailyPlanSystemEvent({
        skillRoot,
        configPath: workspacePaths.configPath,
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
      session: 'isolated',
      message: buildScheduledReminderMessage({
        skillRoot,
        configPath: workspacePaths.configPath,
        workspaceScope: jobNames.scopeToken,
      }),
      announce: true,
      channel: 'last',
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
      session: 'isolated',
      message: buildProactiveReminderMessage({
        skillRoot,
        configPath: workspacePaths.configPath,
        workspaceScope: jobNames.scopeToken,
      }),
      announce: true,
      channel: 'last',
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

const buildOpenClawAgentUrl = (message) => {
  const url = new URL('openclaw://agent');
  url.searchParams.set('message', message);
  return url.toString();
};

const resolveReminderHostMode = ({
  bootstrap,
  reminderPlan,
  reminderKind,
}) => {
  const normalizedKind = normalizeReminderKind(reminderKind);
  if (normalizedKind === 'direct') {
    return 'direct_session';
  }

  const returnTo = reminderPlan?.reminder?.return_to
    ?? reminderPlan?.session?.return_to
    ?? bootstrap?.config?.returnTo;

  return isOpenClawUri(returnTo)
    ? 'full_activation_host'
    : 'limited_host';
};

const buildPreparedReminderActivationMessage = ({
  reminderId,
  family,
}) => {
  const familySuffix = typeof family === 'string' && family.trim()
    ? ` (${family.trim()})`
    : '';
  return `Use ClawCare Protocol to activate prepared reminder ${reminderId}${familySuffix}. Arm follow-up sync, then open the training page.`;
};

const buildFallbackReminderActivationMessage = ({
  reminder,
}) => {
  const family = typeof reminder?.protocol_family === 'string' && reminder.protocol_family.trim()
    ? reminder.protocol_family.trim()
    : '';
  const summary = summarizeText(
    reminder?.summary
      ?? reminder?.body
      ?? reminder?.title
      ?? '',
    88,
  );
  const parts = [
    'Use ClawCare Protocol to start the reminder-triggered training now.',
  ];
  if (family) {
    parts.push(`Prefer family ${family}.`);
  }
  if (summary) {
    parts.push(`Use this cue: ${summary}.`);
  }
  parts.push('Create the real session, arm follow-up sync, then open the training page.');
  return parts.join(' ');
};

const resolveBuildPlanLaunchTargets = ({
  bootstrap,
  reminderPlan,
  reminderKind,
  followUpSync,
}) => {
  const reminder = isRecord(reminderPlan?.reminder) ? reminderPlan.reminder : {};
  const session = isRecord(reminderPlan?.session) ? reminderPlan.session : {};
  const normalizedKind = normalizeReminderKind(reminderKind);
  const browserLaunchUrl = session.launch_url ?? reminder.launch_url ?? '';
  const hostMode = resolveReminderHostMode({
    bootstrap,
    reminderPlan,
    reminderKind: normalizedKind,
  });

  if (normalizedKind === 'direct' || session.session_id) {
    return {
      launchUrl: browserLaunchUrl,
      activationUrl: browserLaunchUrl,
      browserLaunchUrl,
      activationMode: 'session_launch',
      followUpArmed: Boolean(followUpSync),
      hostMode,
    };
  }

  if (hostMode !== 'full_activation_host') {
    return {
      launchUrl: browserLaunchUrl,
      activationUrl: browserLaunchUrl,
      browserLaunchUrl,
      activationMode: 'browser_only',
      followUpArmed: false,
      hostMode,
    };
  }

  if (!reminderPlan?.fallbackUsed && typeof reminder.reminder_id === 'string' && reminder.reminder_id.trim()) {
    const activationUrl = buildOpenClawAgentUrl(buildPreparedReminderActivationMessage({
      reminderId: reminder.reminder_id.trim(),
      family: reminder.protocol_family,
    }));
    return {
      launchUrl: activationUrl,
      activationUrl,
      browserLaunchUrl,
      activationMode: 'openclaw_callback',
      followUpArmed: false,
      hostMode,
    };
  }

  const activationUrl = buildOpenClawAgentUrl(buildFallbackReminderActivationMessage({
    reminder,
  }));
  return {
    launchUrl: activationUrl,
    activationUrl,
    browserLaunchUrl,
    activationMode: 'openclaw_direct_start',
    followUpArmed: false,
    hostMode,
  };
};

const buildReminderMessageText = ({
  reminderPlan,
  reminderKind = 'direct',
  proactiveDecision,
  launchTargets,
}) => {
  const reminder = isRecord(reminderPlan?.reminder) ? reminderPlan.reminder : {};
  const launchUrl = launchTargets?.launchUrl
    ?? reminderPlan?.session?.launch_url
    ?? reminder.launch_url
    ?? '';
  const summary = summarizeText(
    reminder.summary
      ?? reminder.body
      ?? reminder.title
      ?? '已为你准备一组适合当前状态的训练。',
    120,
  );
  const warning = summarizeText(
    Array.isArray(reminder.warnings) && reminder.warnings.length > 0
      ? reminder.warnings[0]
      : Array.isArray(reminder.conflicts) && reminder.conflicts.length > 0
        ? reminder.conflicts[0]
        : '',
    48,
  );
  const opening = reminderKind === 'scheduled'
    ? '到时间活动一下了。'
    : reminderKind === 'proactive'
      ? proactiveDecision?.reasonText
        ? `${proactiveDecision.reasonText}，可以安排一组轻量活动。`
        : '现在适合安排一组轻量活动。'
      : reminder.title?.trim() || '已为你准备好今天的训练。';

  const lines = [
    opening,
    `这次更适合你当前状态：${summary}`,
  ];
  if (warning) {
    lines.push(`开始前注意：${warning}`);
  }
  if (launchUrl) {
    lines.push(`打开训练：${launchUrl}`);
  }
  return lines.join('\n');
};

export const buildSkippedBuildPlanResult = ({
  bootstrap,
  reminderKind,
  proactiveDecision,
}) => ({
  status: 'skipped',
  reminderKind: normalizeReminderKind(reminderKind),
  configPath: bootstrap.workspacePaths.configPath,
  bootstrapDisclosure: bootstrap.bootstrapDisclosure,
  disclosurePending: bootstrap.disclosurePending,
  announceToken: CLAWCARE_ANNOUNCE_SKIP,
  shouldAnnounce: false,
  reasonCode: proactiveDecision?.reasonCode ?? 'skip',
  reasonText: proactiveDecision?.reasonText ?? '当前不需要发送提醒',
});

const deriveDisplayReminderCopyV2 = ({
  reminderPlan,
  reminderKind,
}) => {
  const reminder = isRecord(reminderPlan?.reminder) ? reminderPlan.reminder : {};
  if (!reminderPlan?.fallbackUsed) {
    return {
      title: reminder.title,
      summary: reminder.summary,
      body: reminder.body,
    };
  }

  const title = reminderKind === 'daily_plan'
    ? '\u4eca\u65e5\u8bad\u7ec3\u5df2\u51c6\u5907\u597d'
    : reminderKind === 'proactive'
      ? '\u73b0\u5728\u9002\u5408\u5b89\u6392\u4e00\u7ec4\u8f7b\u91cf\u6d3b\u52a8'
      : '\u5230\u65f6\u95f4\u6d3b\u52a8\u4e00\u4e0b\u4e86';
  const summary = typeof reminder.summary === 'string' && reminder.summary.trim()
    ? reminder.summary
    : '\u5148\u4ece\u4fdd\u5b88\u3001\u8f7b\u91cf\u7684\u6d3b\u52a8\u5f00\u59cb\uff0c\u63a7\u5236\u5e45\u5ea6\u548c\u8282\u594f\u3002';
  const body = typeof reminder.body === 'string' && reminder.body.trim()
    ? reminder.body
    : '\u5148\u505a 3 \u5230 6 \u5206\u949f\u7684\u8f7b\u91cf\u6d3b\u52a8\uff0c\u518d\u6839\u636e\u72b6\u6001\u51b3\u5b9a\u662f\u5426\u7ee7\u7eed\u3002';
  return { title, summary, body };
};

const buildReminderMessageTextV2 = ({
  reminderPlan,
  reminderKind = 'direct',
  proactiveDecision,
  launchTargets,
}) => {
  const reminder = isRecord(reminderPlan?.reminder) ? reminderPlan.reminder : {};
  const displayCopy = deriveDisplayReminderCopyV2({
    reminderPlan,
    reminderKind,
  });
  const launchUrl = launchTargets?.launchUrl
    ?? reminderPlan?.session?.launch_url
    ?? reminder.launch_url
    ?? '';
  const summary = summarizeText(
    displayCopy.summary
      ?? displayCopy.body
      ?? displayCopy.title
      ?? '\u5df2\u4e3a\u4f60\u51c6\u5907\u4e00\u7ec4\u9002\u5408\u5f53\u524d\u72b6\u6001\u7684\u8bad\u7ec3\u3002',
    120,
  );
  const warning = summarizeText(
    Array.isArray(reminder.warnings) && reminder.warnings.length > 0
      ? reminder.warnings[0]
      : Array.isArray(reminder.conflicts) && reminder.conflicts.length > 0
        ? reminder.conflicts[0]
        : '',
    48,
  );
  const opening = reminderKind === 'scheduled'
    ? '\u5230\u65f6\u95f4\u6d3b\u52a8\u4e00\u4e0b\u4e86\u3002'
    : reminderKind === 'proactive'
      ? proactiveDecision?.shouldAnnounce
        ? '\u73b0\u5728\u53ef\u4ee5\u5b89\u6392\u4e00\u7ec4\u8f7b\u91cf\u6d3b\u52a8\u3002'
        : '\u73b0\u5728\u9002\u5408\u5148\u4fdd\u6301\u8f7b\u91cf\u6d3b\u52a8\u3002'
      : displayCopy.title?.trim() || '\u5df2\u4e3a\u4f60\u51c6\u5907\u597d\u4eca\u5929\u7684\u8bad\u7ec3\u3002';

  const lines = [
    opening,
    `\u8fd9\u6b21\u66f4\u9002\u5408\u4f60\u5f53\u524d\u72b6\u6001\uff1a${summary}`,
  ];
  if (warning) {
    lines.push(`\u5f00\u59cb\u524d\u6ce8\u610f\uff1a${warning}`);
  }
  if (launchUrl) {
    lines.push(`\u6253\u5f00\u8bad\u7ec3\uff1a${launchUrl}`);
  }
  return lines.join('\n');
};

export const buildBuildPlanResult = ({
  bootstrap,
  reminderPlan,
  cachePath,
  followUpSync,
  opened,
  reminderKind = 'direct',
  proactiveDecision,
}) => {
  const displayCopy = deriveDisplayReminderCopyV2({
    reminderPlan,
    reminderKind,
  });
  const launchTargets = resolveBuildPlanLaunchTargets({
    bootstrap,
    reminderPlan,
    reminderKind,
    followUpSync,
  });

  return {
    status: 'ok',
    apiBase: reminderPlan.apiBase,
    configPath: bootstrap.workspacePaths.configPath,
    cachePath,
    sessionId: reminderPlan.session?.session_id,
    protocolFamily: reminderPlan.session?.protocol_family ?? reminderPlan.reminder.protocol_family,
    launchUrl: launchTargets.launchUrl,
    activationUrl: launchTargets.activationUrl,
    browserLaunchUrl: launchTargets.browserLaunchUrl,
    activationMode: launchTargets.activationMode,
    followUpArmed: launchTargets.followUpArmed,
    reminderId: reminderPlan.reminder.reminder_id,
    title: displayCopy.title,
    summary: displayCopy.summary,
    body: displayCopy.body,
    protocolTitle: reminderPlan.reminder.protocol_title,
    recommendedIntensity: reminderPlan.reminder.recommended_intensity,
    requestedIntensity: reminderPlan.reminder.requested_intensity,
    warnings: reminderPlan.reminder.warnings ?? [],
    conflicts: reminderPlan.reminder.conflicts ?? [],
    bootstrapDisclosure: bootstrap.bootstrapDisclosure,
    disclosurePending: bootstrap.disclosurePending,
    opened,
    followUpSync,
    fallbackUsed: reminderPlan.fallbackUsed ?? false,
    reminderKind: normalizeReminderKind(reminderKind),
    shouldAnnounce: true,
    messageText: buildReminderMessageTextV2({
      reminderPlan,
      reminderKind,
      proactiveDecision,
      launchTargets,
    }),
  };
};
