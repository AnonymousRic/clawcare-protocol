import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
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
const RUNTIME_SKILL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLAWCARE_LOCATOR_VERSION = 1;
const HOST_KIND_VALUES = new Set(['openclaw', 'hermes', 'generic_agent']);

export const CLAWCARE_JOB_NAMES = {
  dailyPlan: 'clawcare-daily-plan',
  scheduledReminder: 'clawcare-scheduled-reminder',
  proactiveReminder: 'clawcare-proactive-reminder',
  legacyWorkdayReminder: 'clawcare-workday-reminder',
};

export const CLAWCARE_GLOBAL_JOB_NAMES = new Set(Object.values(CLAWCARE_JOB_NAMES));
export const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
export const ISO_DATE_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T/;
export const TIME_PATTERN = /^\d{2}:\d{2}$/;
export const VALID_PACE = new Set(['gentle', 'steady', 'brisk']);
export const VALID_FOCUS = new Set(['neck_relief', 'posture_reset', 'stress_relief', 'mobility']);
export const VALID_FAMILIES = new Set(['neck_wake', 'sedentary_activate', 'stress_reset']);
export const VALID_REMINDER_KINDS = new Set(['direct', 'scheduled', 'proactive', 'daily_plan']);

export const DEFAULT_CONFIG = {
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

export const stripTrailingSlash = (value) => value.replace(/\/+$/, '');
export const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
export const deepClone = (value) => JSON.parse(JSON.stringify(value));
export const stableStringify = (value) => JSON.stringify(value, null, 2);
export const uniqueStrings = (values) => Array.from(new Set(
  values
    .map((value) => String(value ?? '').trim())
    .filter(Boolean),
));

export const deepMerge = (base, patch) => {
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

export const safeJsonParse = (raw) => {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

export const isMissingFileError = (error) => (
  error instanceof Error
  && 'code' in error
  && error.code === 'ENOENT'
);

export const sanitizeToken = (value) => String(value ?? '')
  .replace(/[^a-z0-9_-]+/gi, '_')
  .replace(/^_+|_+$/g, '')
  .toLowerCase();

export const normalizeComparablePath = (value) => path.resolve(String(value ?? ''))
  .replace(/\\/g, '/')
  .toLowerCase();

export const trimToUndefined = (value) => {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
};

export const summarizeText = (text, maxLength = 220) => {
  const normalized = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 3)}...`;
};

export const normalizeReminderKind = (value) => (
  VALID_REMINDER_KINDS.has(String(value ?? '').trim())
    ? String(value).trim()
    : 'direct'
);

export const isOpenClawUri = (value) => (
  typeof value === 'string'
  && value.trim().toLowerCase().startsWith('openclaw://')
);

export const pathLooksLikeOpenClaw = (value) => (
  typeof value === 'string'
  && normalizeComparablePath(value).includes('/.openclaw/')
);

export const pathLooksLikeHermes = (value) => (
  typeof value === 'string'
  && normalizeComparablePath(value).includes('/.hermes/')
);

export const normalizeHostKind = (value, fallback = 'generic_agent') => {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (HOST_KIND_VALUES.has(normalized)) {
    return normalized;
  }
  return fallback;
};

export const parseBooleanValue = (value, fallback) => {
  if (value === undefined) {
    return fallback;
  }
  return /^(1|true|yes|on)$/i.test(String(value).trim());
};

export const supportsNativeMemoryByDefault = (hostKind) => (
  hostKind === 'openclaw' || hostKind === 'hermes'
);

export const supportsNativeSchedulerByDefault = (hostKind) => (
  hostKind === 'openclaw' || hostKind === 'hermes'
);

export const supportsCallbackActivationByDefault = (hostKind) => (
  hostKind === 'openclaw'
);

export const detectHostKind = (overrides = {}) => {
  const explicit = normalizeHostKind(
    overrides.hostKind
      ?? overrides.hostCapabilities?.hostKind
      ?? process.env.CLAWCARE_HOST,
    '',
  );
  if (explicit) {
    return explicit;
  }

  if (
    process.env.OPENCLAW_WORKSPACE_DIR
    || process.env.OPENCLAW_CLAWCARE_CONFIG_PATH
    || pathLooksLikeOpenClaw(overrides.configPath)
    || pathLooksLikeOpenClaw(overrides.workspaceDir)
    || pathLooksLikeOpenClaw(overrides.storageRoot)
  ) {
    return 'openclaw';
  }

  if (
    process.env.HERMES_HOME
    || process.env.HERMES_SKILLS_DIR
    || pathLooksLikeHermes(overrides.configPath)
    || pathLooksLikeHermes(overrides.workspaceDir)
    || pathLooksLikeHermes(overrides.storageRoot)
    || pathLooksLikeHermes(RUNTIME_SKILL_ROOT)
  ) {
    return 'hermes';
  }

  return 'openclaw';
};

export const buildResolvedHostCapabilities = (hostKind, overrides = {}) => ({
  persistent_files: true,
  native_memory: parseBooleanValue(
    overrides.nativeMemory,
    supportsNativeMemoryByDefault(hostKind),
  ),
  native_scheduler: parseBooleanValue(
    overrides.nativeScheduler,
    supportsNativeSchedulerByDefault(hostKind),
  ),
  callback_activation: parseBooleanValue(
    overrides.callbackActivation,
    supportsCallbackActivationByDefault(hostKind),
  ),
  local_browser_launch: parseBooleanValue(
    overrides.localBrowserLaunch,
    false,
  ),
});

export const resolveMemoryBackend = (hostKind, capabilities) => {
  if (hostKind === 'openclaw') {
    return 'openclaw_memory';
  }
  return capabilities.native_memory ? 'host_native' : 'local_file';
};

export const resolveSchedulerBackend = (hostKind, capabilities) => {
  if (hostKind === 'openclaw') {
    return 'openclaw_cron';
  }
  return capabilities.native_scheduler ? 'host_native' : 'deferred';
};

export const resolveCallbackBackend = (hostKind, capabilities) => (
  hostKind === 'openclaw' && capabilities.callback_activation
    ? 'openclaw_uri'
    : 'browser_only'
);

export const resolveBrowserLaunchMode = (capabilities) => (
  capabilities.local_browser_launch ? 'local_browser' : 'return_link'
);

export const getDefaultStorageRoot = (hostKind) => {
  if (hostKind === 'openclaw') {
    return path.join(os.homedir(), '.openclaw', 'workspace', 'clawcare');
  }
  return path.join(RUNTIME_SKILL_ROOT, '.agent-state', hostKind);
};

export const getDefaultReturnToForHost = (hostLocator) => (
  hostLocator?.callbackBackend === 'openclaw_uri'
    ? CLAWCARE_DEFAULT_RETURN_TO
    : ''
);

const buildLocatorCandidates = (overrides = {}, hostKind = detectHostKind(overrides)) => {
  const candidates = [
    overrides.locatorPath,
    overrides.configPath ? path.join(path.dirname(path.resolve(overrides.configPath)), 'locator.json') : undefined,
    overrides.storageRoot ? path.join(path.resolve(overrides.storageRoot), 'locator.json') : undefined,
    overrides.workspaceDir ? path.join(path.resolve(overrides.workspaceDir), 'clawcare', 'locator.json') : undefined,
    overrides.workspaceDir ? path.join(path.resolve(overrides.workspaceDir), 'locator.json') : undefined,
    process.env.CLAWCARE_STORAGE_ROOT ? path.join(path.resolve(process.env.CLAWCARE_STORAGE_ROOT), 'locator.json') : undefined,
    process.env.OPENCLAW_CLAWCARE_CONFIG_PATH
      ? path.join(path.dirname(path.resolve(process.env.OPENCLAW_CLAWCARE_CONFIG_PATH)), 'locator.json')
      : undefined,
    process.env.OPENCLAW_WORKSPACE_DIR
      ? path.join(path.resolve(process.env.OPENCLAW_WORKSPACE_DIR), 'clawcare', 'locator.json')
      : undefined,
    hostKind === 'openclaw'
      ? path.join(os.homedir(), '.openclaw', 'workspace', 'clawcare', 'locator.json')
      : undefined,
    path.join(getDefaultStorageRoot(hostKind), 'locator.json'),
  ].filter(Boolean);

  return Array.from(new Set(candidates.map((entry) => path.resolve(entry))));
};

const readLocatorFileSync = (locatorPath) => {
  try {
    const raw = fsSync.readFileSync(locatorPath, 'utf8');
    const parsed = safeJsonParse(raw);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

export const readExistingHostLocatorSync = (overrides = {}, hostKind = detectHostKind(overrides)) => {
  const candidates = buildLocatorCandidates(overrides, hostKind);
  for (const locatorPath of candidates) {
    const locator = readLocatorFileSync(locatorPath);
    if (locator) {
      return {
        locator,
        locatorPath,
      };
    }
  }
  return null;
};

export const normalizeHostLocator = (
  rawLocator = {},
  {
    hostKind,
    storageRoot,
    workspaceDir,
    locatorPath,
    configPath,
    capabilities,
  },
) => {
  const normalizedHostKind = normalizeHostKind(rawLocator.hostKind ?? hostKind, hostKind);
  const resolvedCapabilities = {
    ...buildResolvedHostCapabilities(normalizedHostKind, {}),
    ...(isRecord(rawLocator.capabilities) ? rawLocator.capabilities : {}),
    ...capabilities,
  };

  return {
    version: Number.parseInt(String(rawLocator.version ?? CLAWCARE_LOCATOR_VERSION), 10) || CLAWCARE_LOCATOR_VERSION,
    hostKind: normalizedHostKind,
    capabilities: resolvedCapabilities,
    storageRoot,
    workspaceDir,
    configPath,
    locatorPath,
    memoryBackend: rawLocator.memoryBackend ?? resolveMemoryBackend(normalizedHostKind, resolvedCapabilities),
    schedulerBackend: rawLocator.schedulerBackend ?? resolveSchedulerBackend(normalizedHostKind, resolvedCapabilities),
    callbackBackend: rawLocator.callbackBackend ?? resolveCallbackBackend(normalizedHostKind, resolvedCapabilities),
    browserLaunch: rawLocator.browserLaunch ?? resolveBrowserLaunchMode(resolvedCapabilities),
  };
};

export const buildHostProfile = (hostLocator = {}) => ({
  version: hostLocator.version ?? CLAWCARE_LOCATOR_VERSION,
  hostKind: hostLocator.hostKind ?? 'generic_agent',
  capabilities: { ...(hostLocator.capabilities ?? {}) },
  storageRoot: hostLocator.storageRoot ?? '',
  memoryBackend: hostLocator.memoryBackend ?? 'local_file',
  schedulerBackend: hostLocator.schedulerBackend ?? 'deferred',
  callbackBackend: hostLocator.callbackBackend ?? 'browser_only',
  browserLaunch: hostLocator.browserLaunch ?? 'return_link',
});

export const parseMaybeInt = (value, fallback) => {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export const ensureDirectory = async (dirPath) => {
  await fs.mkdir(dirPath, { recursive: true });
  return dirPath;
};

export const readFileIfExists = async (filePath) => {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if (isMissingFileError(error)) {
      return '';
    }
    throw error;
  }
};

export const parseJsonFileIfExists = async (filePath) => {
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

export const writeJsonFile = async (filePath, value) => {
  await ensureDirectory(path.dirname(filePath));
  await fs.writeFile(filePath, `${stableStringify(value)}\n`, 'utf8');
  return filePath;
};

export const compactObject = (value) => {
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

export const buildSedentaryLevel = (workState) => {
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

export const parseHostCapabilityFlags = (args = []) => ({
  hostKind: normalizeHostKind(
    parseFlagValue(args, '--host-kind'),
    detectHostKind(),
  ),
  canOpenLocalBrowser: parseBooleanValue(
    parseFlagValue(args, '--host-can-open-local-browser'),
    false,
  ),
  canHandleOpenClawCallback: parseBooleanValue(
    parseFlagValue(args, '--host-can-handle-openclaw-callback'),
    false,
  ),
  supportsNativeMemory: parseBooleanValue(
    parseFlagValue(args, '--host-has-native-memory'),
    supportsNativeMemoryByDefault(
      normalizeHostKind(parseFlagValue(args, '--host-kind'), detectHostKind()),
    ),
  ),
  supportsNativeScheduler: parseBooleanValue(
    parseFlagValue(args, '--host-has-native-scheduler'),
    supportsNativeSchedulerByDefault(
      normalizeHostKind(parseFlagValue(args, '--host-kind'), detectHostKind()),
    ),
  ),
});

export const resolveSkillRoot = (importMetaUrl) => (
  path.resolve(path.dirname(fileURLToPath(importMetaUrl)), '..')
);

export const resolveWorkspacePaths = (overrides = {}) => {
  const detectedHostKind = detectHostKind(overrides);
  const existingLocatorState = readExistingHostLocatorSync(overrides, detectedHostKind);
  const hostKind = normalizeHostKind(existingLocatorState?.locator?.hostKind, detectedHostKind);
  const configPathOverride = overrides.configPath
    ? path.resolve(overrides.configPath)
    : undefined;
  const explicitStorageRoot = overrides.storageRoot
    ? path.resolve(overrides.storageRoot)
    : undefined;
  const resolvedStorageRoot = explicitStorageRoot
    ?? (configPathOverride ? path.dirname(configPathOverride) : undefined)
    ?? (typeof existingLocatorState?.locator?.storageRoot === 'string'
      ? path.resolve(existingLocatorState.locator.storageRoot)
      : undefined)
    ?? (hostKind === 'openclaw'
      ? path.join(
        path.resolve(
          overrides.workspaceDir
            ?? process.env.OPENCLAW_WORKSPACE_DIR
            ?? path.join(os.homedir(), '.openclaw', 'workspace'),
        ),
        'clawcare',
      )
      : path.resolve(
        overrides.workspaceDir
          ?? getDefaultStorageRoot(hostKind),
      ));
  const workspaceDir = path.resolve(
    overrides.workspaceDir
      ?? (hostKind === 'openclaw'
        ? path.dirname(resolvedStorageRoot)
        : resolvedStorageRoot),
  );
  const clawcareDir = resolvedStorageRoot;
  const configPath = configPathOverride
    ?? path.resolve(
      (hostKind === 'openclaw' ? process.env.OPENCLAW_CLAWCARE_CONFIG_PATH : undefined)
        ?? path.join(clawcareDir, 'config.json'),
    );
  const cacheDir = path.resolve(overrides.cacheDir ?? path.join(clawcareDir, 'cache'));
  const runsDir = path.resolve(overrides.runsDir ?? path.join(clawcareDir, 'runs'));
  const memoryDir = path.resolve(
    overrides.memoryDir
      ?? (hostKind === 'openclaw' ? process.env.OPENCLAW_MEMORY_DIR : undefined)
      ?? path.join(workspaceDir, 'memory'),
  );
  const recentAnalysisPath = path.resolve(
    overrides.recentAnalysisPath
      ?? path.join(clawcareDir, 'recent_analysis.md'),
  );
  const locatorPath = path.resolve(
    overrides.locatorPath
      ?? existingLocatorState?.locatorPath
      ?? path.join(clawcareDir, 'locator.json'),
  );
  const capabilities = buildResolvedHostCapabilities(hostKind, {
    nativeMemory: overrides.hostCapabilities?.supportsNativeMemory,
    nativeScheduler: overrides.hostCapabilities?.supportsNativeScheduler,
    callbackActivation: overrides.hostCapabilities?.canHandleOpenClawCallback,
    localBrowserLaunch: overrides.hostCapabilities?.canOpenLocalBrowser,
  });
  const hostLocator = normalizeHostLocator(existingLocatorState?.locator ?? {}, {
    hostKind,
    storageRoot: clawcareDir,
    workspaceDir,
    locatorPath,
    configPath,
    capabilities,
  });

  return {
    workspaceDir,
    storageRoot: clawcareDir,
    clawcareDir,
    configPath,
    cacheDir,
    preparedRemindersDir: path.join(cacheDir, 'prepared_reminders'),
    runsDir,
    memoryDir,
    recentAnalysisPath,
    dailyPlanCachePath: path.join(cacheDir, 'daily_plan.json'),
    automationStatePath: path.join(cacheDir, 'automation_state.json'),
    locatorPath,
    hostLocator,
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
  };
};
