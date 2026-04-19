import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';

import {
  CLAWCARE_ANNOUNCE_SKIP,
  CLAWCARE_DEFAULT_BASE_URL,
  CLAWCARE_DEFAULT_RETURN_TO,
  compactObject,
  ensureDirectory,
  isRecord,
  normalizeReminderKind,
  parseJsonFileIfExists,
  readFileIfExists,
  sanitizeToken,
  stableStringify,
  stripTrailingSlash,
  summarizeText,
  trimToUndefined,
  uniqueStrings,
} from './core.mjs';
import { formatMemoryMarkdown } from './state-store.mjs';

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

const PREPARED_REMINDER_REF_KIND = 'clawcare_prepared_reminder_ref';

const buildPreparedReminderRef = (payload, reminderKind) => {
  const seed = stableStringify(compactObject({
    reminderKind: normalizeReminderKind(reminderKind),
    userIntent: payload?.userIntent?.rawText,
    openclawContext: payload?.openclawContext,
    memorySignals: Array.isArray(payload?.memorySignals) ? payload.memorySignals.slice(0, 3) : [],
    createdAt: new Date().toISOString(),
  }));
  const digest = createHash('sha1').update(seed).digest('hex').slice(0, 10);
  return `prepared-${Date.now().toString(36)}-${digest}`;
};

const buildPreparedReminderRefPath = (workspacePaths, activationRef) => (
  path.join(workspacePaths.preparedRemindersDir, `${sanitizeToken(activationRef)}.json`)
);

const writePreparedReminderRef = async ({
  workspacePaths,
  activationRef,
  record,
}) => {
  const filePath = buildPreparedReminderRefPath(workspacePaths, activationRef);
  await ensureDirectory(path.dirname(filePath));
  await fs.writeFile(filePath, `${stableStringify({
    kind: PREPARED_REMINDER_REF_KIND,
    activationRef,
    ...record,
  })}\n`, 'utf8');
  return filePath;
};

export const readPreparedReminderRef = async ({
  workspacePaths,
  activationRef,
}) => {
  const normalizedRef = String(activationRef ?? '').trim();
  if (!normalizedRef) {
    throw new Error('missing_activation_ref');
  }
  const filePath = buildPreparedReminderRefPath(workspacePaths, normalizedRef);
  const record = await parseJsonFileIfExists(filePath);
  if (!isRecord(record) || record.kind !== PREPARED_REMINDER_REF_KIND) {
    throw new Error(`missing_prepared_reminder_ref:${normalizedRef}`);
  }
  return {
    activationRef: normalizedRef,
    filePath,
    record,
  };
};

const getProactiveReasonText = (proactiveDecision) => {
  switch (proactiveDecision?.reasonCode) {
    case 'no_recent_runs':
      return '最近还没有训练记录';
    case 'inactive_for_days':
      return '这几天还没有安排训练';
    case 'recent_caution_signals':
      return '最近训练里有需要留意的信号';
    case 'recently_active':
      return '最近已经安排过训练或活动';
    default:
      return trimToUndefined(proactiveDecision?.reasonText) ?? '当前不需要发送提醒';
  }
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

const buildFallbackReminderCopy = ({
  reminderKind,
  proactiveDecision,
  primarySignal,
}) => {
  const title = reminderKind === 'proactive'
    ? '现在适合安排一组轻量活动'
    : reminderKind === 'daily_plan'
      ? '今日训练已准备好'
      : '到时间活动一下了';
  const summary = primarySignal
    ? `今天先从轻量、保守的活动开始，重点留意：${primarySignal}`
    : '今天先从轻量、保守的活动开始，控制幅度和节奏。';
  const body = reminderKind === 'proactive' && proactiveDecision
    ? `${getProactiveReasonText(proactiveDecision)}，先做一组轻量活动会更稳妥。`
    : '先做 3 到 6 分钟的轻量活动，再根据状态决定是否继续。';
  return { title, summary, body };
};

const buildLocalFallbackReminderPlan = async ({
  payload,
  baseCandidates,
  reminderKind,
  proactiveDecision,
  workspacePaths,
}) => {
  const family = resolveFallbackFamily(payload);
  const activationRef = buildPreparedReminderRef(payload, reminderKind);
  const browserLaunchUrl = buildFallbackEntryUrl(payload, payload?.userIntent?.rawText);
  const primarySignal = Array.isArray(payload?.memorySignals) && payload.memorySignals.length > 0
    ? summarizeText(payload.memorySignals[0], 56)
    : '';
  const copy = buildFallbackReminderCopy({
    reminderKind,
    proactiveDecision,
    primarySignal,
  });
  const createdAt = new Date().toISOString();
  const preparedReminderRefPath = workspacePaths
    ? await writePreparedReminderRef({
      workspacePaths,
      activationRef,
      record: {
        createdAt,
        reminderKind: normalizeReminderKind(reminderKind),
        fallbackUsed: true,
        preferredFamily: family,
        browserLaunchUrl,
        payload,
      },
    })
    : undefined;

  return {
    apiBase: baseCandidates[0] ?? stripTrailingSlash(String(payload.baseUrl ?? CLAWCARE_DEFAULT_BASE_URL)),
    fallbackUsed: true,
    localPreparedRef: activationRef,
    reminder: {
      reminder_id: `fallback-${activationRef}`,
      title: copy.title,
      summary: copy.summary,
      body: copy.body,
      created_at: createdAt,
      entry_source: 'openclaw',
      protocol_family: family,
      protocol_title: family === 'neck_wake'
        ? '颈肩唤醒'
        : family === 'stress_reset'
          ? '舒压放松'
          : '久坐激活',
      launch_url: browserLaunchUrl,
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
      },
      warnings: [],
      conflicts: [],
      recommended_intensity: 'conservative',
      requested_intensity: payload?.userIntent?.requestedIntensity,
      can_proceed_with_requested_plan: true,
      alternate_protocols: [],
    },
    paths: compactObject({
      preparedReminderRefPath,
    }),
  };
};

export const requestReminderPreparationWithFallback = async ({
  payload,
  baseCandidates,
  reminderKind,
  proactiveDecision,
  workspacePaths,
  fetchImpl = fetch,
}) => {
  try {
    return await requestReminderPreparation(payload, baseCandidates, fetchImpl);
  } catch {
    return await buildLocalFallbackReminderPlan({
      payload,
      baseCandidates,
      reminderKind,
      proactiveDecision,
      workspacePaths,
    });
  }
};

export const cacheDailyPlan = async (workspacePaths, reminderPlan) => {
  await ensureDirectory(path.dirname(workspacePaths.dailyPlanCachePath));
  await fs.writeFile(
    workspacePaths.dailyPlanCachePath,
    `${stableStringify({
      requestedAt: new Date().toISOString(),
      apiBase: reminderPlan.apiBase,
      reminder: reminderPlan.reminder,
      session: reminderPlan.session,
      fallbackUsed: reminderPlan.fallbackUsed ?? false,
      paths: reminderPlan.paths,
    })}\n`,
    'utf8',
  );
  return workspacePaths.dailyPlanCachePath;
};

export const openUrl = async (url) => {
  const testOpenMarkerPath = trimToUndefined(process.env.CLAWCARE_TEST_OPEN_MARKER);
  if (testOpenMarkerPath) {
    const resolvedMarkerPath = path.resolve(testOpenMarkerPath);
    await ensureDirectory(path.dirname(resolvedMarkerPath));
    await fs.appendFile(resolvedMarkerPath, `${url}\n`, 'utf8');
    return;
  }

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

const buildOpenClawAgentUrl = (message) => {
  const url = new URL('openclaw://agent');
  url.searchParams.set('message', message);
  return url.toString();
};

const buildReminderActivationMessage = ({
  reminderId,
  activationRef,
  family,
}) => {
  const familySuffix = typeof family === 'string' && family.trim()
    ? ` (${family.trim()})`
    : '';
  if (typeof reminderId === 'string' && reminderId.trim()) {
    return `Use ClawCare Protocol to activate prepared reminder reminderId=${reminderId.trim()}${familySuffix}. Run launch_prepared_reminder.mjs, apply the skill's immediate sync policy, then open or return the training page.`;
  }
  if (typeof activationRef === 'string' && activationRef.trim()) {
    return `Use ClawCare Protocol to activate local prepared reminder activationRef=${activationRef.trim()}${familySuffix}. Run launch_prepared_reminder.mjs, apply the skill's immediate sync policy, then open or return the training page.`;
  }
  return '';
};

const resolveBuildPlanLaunchTargets = ({
  reminderPlan,
  reminderKind,
  followUpSync,
  hostCapabilities,
}) => {
  const reminder = isRecord(reminderPlan?.reminder) ? reminderPlan.reminder : {};
  const session = isRecord(reminderPlan?.session) ? reminderPlan.session : {};
  const normalizedKind = normalizeReminderKind(reminderKind);
  const browserLaunchUrl = session.launch_url ?? reminder.launch_url ?? '';

  if (normalizedKind === 'direct' || session.session_id) {
    return {
      launchUrl: browserLaunchUrl,
      activationUrl: browserLaunchUrl,
      browserLaunchUrl,
      activationMode: 'session_launch',
      followUpArmed: Boolean(followUpSync),
      activationSpec: compactObject({
        kind: 'web',
        url: browserLaunchUrl,
      }),
    };
  }

  if (hostCapabilities?.canHandleOpenClawCallback) {
    const activationMessage = buildReminderActivationMessage({
      reminderId: !reminderPlan?.fallbackUsed ? reminder.reminder_id : undefined,
      activationRef: reminderPlan?.fallbackUsed ? reminderPlan.localPreparedRef : undefined,
      family: reminder.protocol_family,
    });
    const activationUrl = activationMessage ? buildOpenClawAgentUrl(activationMessage) : browserLaunchUrl;
    return {
      launchUrl: activationUrl,
      activationUrl,
      browserLaunchUrl,
      activationMode: activationMessage ? 'openclaw_callback' : 'browser_only',
      followUpArmed: false,
      activationSpec: compactObject({
        kind: activationMessage ? 'deeplink' : 'web',
        url: activationUrl,
        fallbackUrl: activationMessage ? browserLaunchUrl : undefined,
      }),
    };
  }

  return {
    launchUrl: browserLaunchUrl,
    activationUrl: browserLaunchUrl,
    browserLaunchUrl,
    activationMode: 'browser_only',
    followUpArmed: false,
    activationSpec: compactObject({
      kind: 'message',
      url: browserLaunchUrl,
      messageText: '将训练入口作为可点击消息或卡片返回给用户，用户确认后再进入网页训练。',
    }),
  };
};

const deriveDisplayReminderCopy = ({
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
    ? '今日训练已准备好'
    : reminderKind === 'proactive'
      ? '现在适合安排一组轻量活动'
      : '到时间活动一下了';
  const summary = typeof reminder.summary === 'string' && reminder.summary.trim()
    ? reminder.summary
    : '先从保守、轻量的活动开始，控制幅度和节奏。';
  const body = typeof reminder.body === 'string' && reminder.body.trim()
    ? reminder.body
    : '先做 3 到 6 分钟的轻量活动，再根据状态决定是否继续。';
  return { title, summary, body };
};

const buildReminderMessageText = ({
  reminderPlan,
  reminderKind = 'direct',
  proactiveDecision,
  launchTargets,
}) => {
  const reminder = isRecord(reminderPlan?.reminder) ? reminderPlan.reminder : {};
  const displayCopy = deriveDisplayReminderCopy({
    reminderPlan,
    reminderKind,
  });
  const launchUrl = launchTargets?.browserLaunchUrl
    ?? reminderPlan?.session?.launch_url
    ?? reminder.launch_url
    ?? '';
  const summary = summarizeText(
    displayCopy.summary
      ?? displayCopy.body
      ?? displayCopy.title
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
      ? proactiveDecision?.shouldAnnounce
        ? '现在可以安排一组轻量活动。'
        : '现在适合先保持轻量活动。'
      : displayCopy.title?.trim() || '已为你准备好今天的训练。';

  const lines = [
    opening,
    `这次更适合你当前状态：${summary}`,
  ];
  if (warning) {
    lines.push(`开始前注意：${warning}`);
  }
  if (launchTargets?.activationSpec?.kind === 'deeplink' && launchTargets?.activationUrl) {
    lines.push(`从智能体进入：${launchTargets.activationUrl}`);
    if (
      launchTargets?.browserLaunchUrl
      && launchTargets.browserLaunchUrl !== launchTargets.activationUrl
    ) {
      lines.push(`网页入口：${launchTargets.browserLaunchUrl}`);
    }
  } else if (launchUrl) {
    lines.push(`打开训练：${launchUrl}`);
  }
  return lines.join('\n');
};

const parseFallbackDelayMin = (followUpSync) => {
  const atValue = followUpSync?.hostSchedulerSpec?.schedule?.at;
  if (typeof atValue === 'string') {
    const match = atValue.match(/(\d+)/);
    if (match) {
      return Number.parseInt(match[1], 10);
    }
  }
  return null;
};

const buildSyncPolicy = ({
  bootstrap,
  followUpSync,
}) => ({
  mode: 'event_first',
  fallbackScheduled: Boolean(followUpSync),
  fallbackDelayMin: parseFallbackDelayMin(followUpSync),
  requiresHostNativeWriteback: bootstrap.workspacePaths.hostLocator.memoryBackend === 'host_native',
});

const buildHostActionHints = ({
  bootstrap,
  followUpSync,
}) => {
  const hints = [
    '训练完成后，宿主应优先基于当前 session 或 run 上下文立即执行同步。',
  ];

  if (followUpSync) {
    hints.push('如果即时同步链路缺失，可在短窗口内执行一次补偿同步。');
  }
  if (bootstrap.workspacePaths.hostLocator.memoryBackend === 'host_native') {
    hints.push('宿主可自行选择最合适的 native memory 或记忆位置写入摘要。');
  } else {
    hints.push('如宿主不管理 native memory，本 skill 会继续维护本地兼容镜像文件。');
  }

  return hints;
};

export const buildSkippedBuildPlanResult = ({
  bootstrap,
  reminderKind,
  proactiveDecision,
}) => ({
  status: 'skipped',
  reminderKind: normalizeReminderKind(reminderKind),
  configPath: bootstrap.workspacePaths.configPath,
  locatorPath: bootstrap.workspacePaths.locatorPath,
  hostProfile: bootstrap.hostProfile,
  bootstrapDisclosure: bootstrap.bootstrapDisclosure,
  disclosurePending: bootstrap.disclosurePending,
  announceToken: CLAWCARE_ANNOUNCE_SKIP,
  shouldAnnounce: false,
  reasonCode: proactiveDecision?.reasonCode ?? 'skip',
  reasonText: getProactiveReasonText(proactiveDecision),
  syncPolicy: buildSyncPolicy({
    bootstrap,
    followUpSync: null,
  }),
  hostActionHints: buildHostActionHints({
    bootstrap,
    followUpSync: null,
  }),
  activationSpec: null,
  localArtifacts: null,
});

export const buildBuildPlanResult = ({
  bootstrap,
  reminderPlan,
  cachePath,
  followUpSync,
  opened,
  reminderKind = 'direct',
  proactiveDecision,
  hostCapabilities,
}) => {
  const displayCopy = deriveDisplayReminderCopy({
    reminderPlan,
    reminderKind,
  });
  const launchTargets = resolveBuildPlanLaunchTargets({
    reminderPlan,
    reminderKind,
    followUpSync,
    hostCapabilities,
  });

  return {
    status: 'ok',
    apiBase: reminderPlan.apiBase,
    configPath: bootstrap.workspacePaths.configPath,
    locatorPath: bootstrap.workspacePaths.locatorPath,
    hostProfile: bootstrap.hostProfile,
    cachePath,
    sessionId: reminderPlan.session?.session_id,
    protocolFamily: reminderPlan.session?.protocol_family ?? reminderPlan.reminder.protocol_family,
    launchUrl: launchTargets.launchUrl,
    activationUrl: launchTargets.activationUrl,
    browserLaunchUrl: launchTargets.browserLaunchUrl,
    activationMode: launchTargets.activationMode,
    activationSpec: launchTargets.activationSpec,
    followUpArmed: launchTargets.followUpArmed,
    syncPolicy: buildSyncPolicy({
      bootstrap,
      followUpSync,
    }),
    hostActionHints: buildHostActionHints({
      bootstrap,
      followUpSync,
    }),
    reminderId: reminderPlan.reminder.reminder_id,
    activationRef: reminderPlan.localPreparedRef,
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
    messageText: buildReminderMessageText({
      reminderPlan,
      reminderKind,
      proactiveDecision,
      launchTargets,
    }),
    localArtifacts: compactObject({
      cachePath,
      preparedReminderRefPath: reminderPlan.paths?.preparedReminderRefPath,
    }),
  };
};
