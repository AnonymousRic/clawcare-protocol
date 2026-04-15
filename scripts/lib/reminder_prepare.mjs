import { CLAWCARE_DEFAULT_BASE_URL } from './runtime.mjs';

const stripTrailingSlash = (value) => String(value ?? '').replace(/\/+$/, '');

const summarizeText = (text, maxLength = 56) => {
  const normalized = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 3))}...`;
};

const toPreparedSession = (reminder = {}) => ({
  session_id: reminder.session_id,
  protocol_family: reminder.protocol_family,
  launch_url: reminder.launch_url,
});

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
  const baseUrl = stripTrailingSlash(payload.baseUrl ?? CLAWCARE_DEFAULT_BASE_URL);
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
    ? summarizeText(payload.memorySignals[0])
    : '';
  const title = reminderKind === 'proactive'
    ? '\u73b0\u5728\u9002\u5408\u5b89\u6392\u4e00\u7ec4\u8f7b\u91cf\u6d3b\u52a8'
    : reminderKind === 'daily_plan'
      ? '\u4eca\u65e5\u8bad\u7ec3\u5df2\u51c6\u5907\u597d'
      : '\u5230\u65f6\u95f4\u6d3b\u52a8\u4e00\u4e0b\u4e86';
  const summary = primarySignal
    ? `\u4eca\u5929\u5148\u4ece\u4fdd\u5b88\u3001\u8f7b\u91cf\u7684\u6d3b\u52a8\u5f00\u59cb\uff0c\u91cd\u70b9\u7559\u610f\uff1a${primarySignal}`
    : '\u4eca\u5929\u5148\u4ece\u4fdd\u5b88\u3001\u8f7b\u91cf\u7684\u6d3b\u52a8\u5f00\u59cb\uff0c\u63a7\u5236\u5e45\u5ea6\u548c\u8282\u594f\u3002';
  const body = reminderKind === 'proactive' && proactiveDecision?.reasonText
    ? `${proactiveDecision.reasonText}\uff0c\u5148\u505a\u4e00\u7ec4\u8f7b\u91cf\u6d3b\u52a8\u66f4\u7a33\u59a5\u3002`
    : '\u5148\u505a 3 \u5230 6 \u5206\u949f\u7684\u8f7b\u91cf\u6d3b\u52a8\uff0c\u518d\u6839\u636e\u72b6\u6001\u51b3\u5b9a\u662f\u5426\u7ee7\u7eed\u3002';

  const reminder = {
    reminder_id: reminderId,
    title,
    summary,
    body,
    created_at: new Date().toISOString(),
    session_id: `prepared-${reminderId}`,
    entry_source: 'openclaw',
    protocol_family: family,
    protocol_title: family === 'neck_wake'
      ? '\u9888\u80a9\u5524\u9192'
      : family === 'stress_reset'
        ? '\u8212\u538b\u653e\u677e'
        : '\u4e45\u5750\u6fc0\u6d3b',
    launch_url: launchUrl,
    return_to: payload?.return_to,
    personalization_basis: Array.isArray(payload?.memorySignals) ? payload.memorySignals.slice(0, 3) : [],
    openclaw_context_snapshot: payload?.openclawContext,
    user_intent: payload?.userIntent,
    personalization_signals: payload?.personalizationSignals,
    decision_trace: {
      topDrivers: primarySignal ? [primarySignal] : ['\u5148\u4ece\u4f4e\u5f3a\u5ea6\u8f7b\u91cf\u6d3b\u52a8\u5f00\u59cb\u3002'],
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
        ? '\u9888\u80a9\u5524\u9192'
        : family === 'stress_reset'
          ? '\u8212\u538b\u653e\u677e'
          : '\u4e45\u5750\u6fc0\u6d3b',
      launch_url: launchUrl,
      return_to: payload?.return_to,
      created_at: new Date().toISOString(),
    },
  };

  return {
    apiBase: baseCandidates[0] ?? stripTrailingSlash(payload.baseUrl ?? CLAWCARE_DEFAULT_BASE_URL),
    fallbackUsed: true,
    reminder,
    session: toPreparedSession(reminder),
    paths: {},
  };
};

const requestJsonWithCandidates = async (pathname, options, baseCandidates, fetchImpl = fetch) => {
  let lastError = null;
  for (const candidate of baseCandidates) {
    try {
      const apiBase = stripTrailingSlash(candidate);
      const response = await fetchImpl(`${apiBase}${pathname}`, options);
      const raw = await response.text();
      const data = raw ? JSON.parse(raw) : {};
      if (!response.ok) {
        const message = typeof data?.error === 'string' ? data.error : response.statusText || 'request_failed';
        throw new Error(message);
      }
      return { apiBase, data };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error('request_failed');
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
    session: toPreparedSession(response.data.reminder),
    paths: response.data.paths,
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
