import { z } from 'zod';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import { listUsageSessions, readEvents } from './store.js';
import { readDurable, writeDurableSoon } from '../durable.js';
import { logInfo } from '../logger.js';
import { eventTokens } from '../../shared/session.js';
import { usageModelKey, type ModelUsage, type ProChatUsage, type UsageModelTokens, type UsageOverview } from '../../shared/usage.js';
import { getChatModels } from '../chat-models.js';
import { isAstraModel, isProModel } from '../../shared/chat-models.js';
import { getConfig } from '../config.js';
import type { ProChatAllowance } from '../../shared/types.js';
const row = z.object({ model: z.string().min(1).max(100), scope: z.enum(['model', 'feature', 'shared']), remaining: z.number().finite().nonnegative().nullable(), remainingPercent: z.number().min(0).max(100).nullable(), limit: z.number().finite().nonnegative().nullable().optional().default(null), used: z.number().finite().nonnegative().nullable().optional().default(null), resetAt: z.number().finite().positive().nullable(), windowSeconds: z.number().finite().positive().nullable() });
let limits: ModelUsage[] = [];
let accountPlan: string | null = null;
let latestObservedAt = 0;
let limitsLoaded = false;
const FRESH_MS = 10 * 60000;
export function observeUsage(raw: unknown, capturedAt: unknown = Date.now(), plan: unknown = null): void {
  const parsed = z.array(row).max(80).parse(raw);
  const now = Date.now();
  if (typeof capturedAt !== 'number' || !Number.isFinite(capturedAt) || capturedAt > now + 5000 || now - capturedAt > FRESH_MS || capturedAt < latestObservedAt) return;
  // A snapshot is one account observation. Never merge old counters from another
  // account/tab into the latest response; an explicit empty snapshot clears them.
  latestObservedAt = capturedAt;
  limits = parsed.map((entry) => ({ ...entry, observedAt: capturedAt }));
  accountPlan = typeof plan === 'string' && /^[a-zA-Z0-9_. /-]{1,100}$/.test(plan) ? plan : accountPlan;
  limitsLoaded = true;
  writeDurableSoon('usage-limits', { observedAt: capturedAt, rows: parsed, plan: accountPlan });
}
const persistedLimits = z.object({ observedAt: z.number().finite().positive(), rows: z.array(row).max(80), plan: z.string().max(100).nullable().optional() });
async function restoreUsageLimits(): Promise<void> {
  if (limitsLoaded) return;
  limitsLoaded = true;
  const saved = persistedLimits.safeParse(await readDurable('usage-limits'));
  if (!saved.success || saved.data.observedAt < latestObservedAt) return;
  latestObservedAt = saved.data.observedAt;
  limits = saved.data.rows.map(entry => ({ ...entry, observedAt: saved.data.observedAt }));
  accountPlan = saved.data.plan ?? null;
}
// One persisted derived cache owns both daily and model totals. Formula edits project
// this baseline; only changed canonical session revisions reread transcripts.
const CACHE_VERSION = 8;
const modelTokens = z.object({ model: z.string().min(1).max(100), reasoningEffort: z.string().max(100).nullable(), assumed: z.boolean(), tokens: z.number().finite().nonnegative() });
const proMessage = z.object({ time: z.number().finite().positive(), id: z.string().min(1).max(200), model: z.string().min(1).max(100), reasoningEffort: z.string().max(100).nullable() });
const cacheRow = z.object({ id: z.string().max(64), revision: z.string().max(200), days: z.array(z.tuple([z.string().regex(/^\d{4}-\d{2}-\d{2}$/), z.array(modelTokens)])).max(36600), proMessages: z.array(proMessage).max(20000) });
const cacheSchema = z.object({ version: z.literal(CACHE_VERSION), rows: z.array(cacheRow).max(100000) });
type TrackedProMessage = z.infer<typeof proMessage>;
const dayCache = new Map<string, { revision: string; days: Map<string, UsageModelTokens[]>; proMessages: TrackedProMessage[] }>();
let cacheLoaded = false;
let overviewFlight: Promise<UsageOverview> | null = null;
export function usageOverview(signal?: AbortSignal): Promise<UsageOverview> {
  return overviewFlight ??= computeOverview(signal).finally(() => { overviewFlight = null; });
}
function mergeModels(target: Map<string, UsageModelTokens>, rows: readonly UsageModelTokens[]): void {
  for (const row of rows) {
    const key = usageModelKey(row);
    const previous = target.get(key);
    target.set(key, { ...row, tokens: (previous?.tokens ?? 0) + row.tokens });
  }
}
type Attribution = Pick<UsageModelTokens, 'model' | 'reasoningEffort' | 'assumed'>;
const LEGACY: Attribution = { model: 'gpt-5.6', reasoningEffort: 'high', assumed: true };
function attribution(raw: { model?: string; reasoningEffort?: string }, previous: Attribution): Attribution {
  const model = raw.model?.trim();
  const effort = raw.reasoningEffort?.trim();
  if (model) return { model, reasoningEffort: effort || (!previous.assumed && model === previous.model ? previous.reasoningEffort : null), assumed: false };
  if (effort) return { ...previous, reasoningEffort: effort };
  return previous;
}
function resolvedProProfile(wanted: ProChatAllowance, plan: string | null): ProChatAllowance {
  if (wanted !== 'auto') return wanted;
  const normalized = (plan ?? '').trim().toLowerCase().replace(/[ _]+/g, '-');
  if (/pro-?200/.test(normalized)) return 'pro-200';
  if (/pro-?100|business-?premium/.test(normalized)) return 'shared-50-week';
  if (/business-?standard/.test(normalized)) return 'business-standard-15-month';
  return 'auto';
}
function proCap(profile: ProChatAllowance): number | null {
  return profile === 'pro-200' ? 200 : profile === 'shared-50-week' ? 50 : profile === 'business-standard-15-month' ? 15 : null;
}
function periodStart(profile: ProChatAllowance, resetAt: number | null): number | null {
  if (!resetAt) return null;
  if (profile === 'pro-200' || profile === 'shared-50-week') return resetAt - 7 * 24 * 60 * 60 * 1000;
  if (profile === 'business-standard-15-month') { const date = new Date(resetAt); date.setUTCMonth(date.getUTCMonth() - 1); return date.getTime(); }
  return null;
}
function solPro(model: string, effort: string | null): boolean {
  const normalized = model.trim().toLowerCase().replace(/[ .]/g, '-').replace(/--+/g, '-');
  return (effort === 'pro' || /-pro$/.test(normalized)) && /^(?:gpt-?)?5(?:-?6)(?:-sol)?(?:-pro)?$/.test(normalized);
}
function astraOptionUnavailable(): boolean | null {
  const option = getChatModels().models.find(model =>
    model.efforts.includes('pro') && (isAstraModel(model.id, 'pro') || model.aliases?.some(alias => isAstraModel(alias, 'pro'))));
  return option ? option.unavailableEfforts?.includes('pro') === true : null;
}
function proChatSummary(activeLimits: readonly ModelUsage[], tracked: readonly TrackedProMessage[]): ProChatUsage {
  const requested = getConfig().ui.proChatAllowance ?? 'auto';
  const profile = resolvedProProfile(requested, accountPlan);
  const astra = activeLimits.find(row => row.scope === 'model' && isAstraModel(row.model, 'pro'));
  const resetAt = astra?.resetAt ?? null;
  const start = periodStart(profile, resetAt);
  const matches = tracked.filter(message => {
    if (start !== null && message.time < start) return false;
    if (resetAt !== null && message.time >= resetAt) return false;
    return profile === 'pro-200' ? isAstraModel(message.model, message.reasoningEffort as never)
      : profile === 'shared-50-week' || profile === 'business-standard-15-month'
        ? isAstraModel(message.model, message.reasoningEffort as never) || solPro(message.model, message.reasoningEffort)
        : isProModel(message.model, message.reasoningEffort as never);
  });
  const unique = new Set(matches.map(message => message.id));
  const trackedMessages = unique.size;
  const configuredCap = proCap(profile);
  const cap = astra?.limit ?? configuredCap;
  const providerRemaining = astra?.remaining ?? null;
  const unavailable = astraOptionUnavailable();
  const providerExhausted = providerRemaining === 0 || (providerRemaining === null && unavailable === true && resetAt !== null && resetAt > Date.now());
  if (providerRemaining !== null || providerExhausted) {
    const remaining = providerRemaining ?? 0;
    return { profile, cap, used: astra?.used ?? (cap !== null ? Math.max(0, cap - remaining) : trackedMessages), remaining, resetAt, periodStart: start, exact: true, exhausted: remaining === 0, source: 'provider', trackedMessages, accountPlan };
  }
  const remaining = cap === null ? null : Math.max(0, cap - trackedMessages);
  return { profile, cap, used: trackedMessages, remaining, resetAt, periodStart: start, exact: false, exhausted: false, source: remaining === null ? 'unknown' : 'local', trackedMessages, accountPlan };
}
async function computeOverview(signal?: AbortSignal): Promise<UsageOverview> {
  signal?.throwIfAborted();
  await restoreUsageLimits();
  const started = performance.now();
  // One observed Pro choice raises the comparison ceiling for the whole account,
  // including ordinary models. Read existing catalog evidence without discovery.
  const contextTokenCap = getChatModels().models.some(model => isProModel(model.id) || model.efforts.includes('pro')) ? 400_000 : 256_000;
  let rebuilt = 0;
  if (!cacheLoaded) {
    const saved = cacheSchema.safeParse(await readDurable('usage-cache'));
    if (saved.success) for (const row of saved.data.rows) dayCache.set(row.id, { revision: row.revision, days: new Map(row.days), proMessages: row.proMessages });
    cacheLoaded = true;
  }
  const sessions = await listUsageSessions();
  let dirty = false;
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const days = new Map<string, Map<string, UsageModelTokens>>();
  const models = new Map<string, UsageModelTokens>();
  const trackedPro: TrackedProMessage[] = [];
  for (const session of sessions) {
    signal?.throwIfAborted();
    const revision = `${contextTokenCap}:${timezone}:${session.updatedAt}:${session.events}:${session.estimatedTokens}`;
    let cached = dayCache.get(session.id);
    if (cached?.revision !== revision) {
      // Startup and the Usage page share this one flight. Read only one changed
      // session at a time, giving interactive work a turn before each disk read.
      await yieldToEventLoop(undefined, { signal });
      rebuilt++;
      const perDay = new Map<string, Map<string, UsageModelTokens>>();
      let context = 0;
      let conversation: string | null = null;
      let selected = LEGACY;
      const calls: Array<{ day: string; attribution: Attribution }> = [];
      const countedCalls = new Set<string>();
      const proMessages: TrackedProMessage[] = [];
      let proRequestAlreadyCounted = false;
      const finishSegment = () => {
        // Cap each frontend before the baseline divisor and call aggregation.
        // Model switches divide attribution, never the frontend context.
        const billingContext = Math.min(context, contextTokenCap);
        for (const call of calls) {
          const totals = perDay.get(call.day) ?? new Map<string, UsageModelTokens>();
          mergeModels(totals, [{ ...call.attribution, tokens: billingContext / 2 }]);
          perDay.set(call.day, totals);
        }
        calls.length = 0; context = 0; selected = LEGACY;
      };
      const events = await readEvents(session.id);
      signal?.throwIfAborted();
      for (const event of events) {
        if (event.kind === 'session_start') { finishSegment(); conversation = event.conversationId; proRequestAlreadyCounted = false; }
        if (event.kind === 'user_message' && !event.messageId?.startsWith('input:')) {
          proRequestAlreadyCounted = false;
          if (event.messageId && event.model && isProModel(event.model, event.reasoningEffort)) {
            proMessages.push({ time: event.time, id: `user:${event.messageId}`, model: event.model, reasoningEffort: event.reasoningEffort ?? null });
            proRequestAlreadyCounted = true;
          }
        }
        if (event.kind === 'assistant_message' && event.final === true) {
          if (event.messageId && event.model && isProModel(event.model, event.reasoningEffort) && !proRequestAlreadyCounted) {
            proMessages.push({ time: event.time, id: event.providerMessageId ?? event.messageId, model: event.model, reasoningEffort: event.reasoningEffort ?? null });
          }
          proRequestAlreadyCounted = false;
        }
        if (event.kind === 'tool_call') {
          if (countedCalls.has(event.call.callId)) continue;
          countedCalls.add(event.call.callId);
          if (!event.call.conversationId || (conversation && conversation !== event.call.conversationId)) finishSegment();
          conversation = event.call.conversationId;
        }
        // Recorded selection belongs to this frontend history, never a mutable
        // global picker or a worker's requested-but-unconfirmed spawn setting.
        if (event.kind === 'user_message' && !event.messageId?.startsWith('input:')) selected = LEGACY;
        if (event.kind !== 'user_message' || !event.messageId?.startsWith('input:')) selected = attribution(event, selected);
        context += eventTokens(event);
        if (event.kind !== 'tool_call') continue;
        const date = new Date(event.time);
        const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
        calls.push({ day, attribution: attribution(event.call, selected) });
        if (!conversation) finishSegment();
      }
      finishSegment();
      dirty = true;
      cached = { revision, days: new Map([...perDay].map(([day, values]) => [day, [...values.values()]])), proMessages }; dayCache.set(session.id, cached);
    }
    trackedPro.push(...cached.proMessages);
    for (const [date, rows] of cached.days) {
      const totals = days.get(date) ?? new Map<string, UsageModelTokens>();
      mergeModels(totals, rows); days.set(date, totals); mergeModels(models, rows);
    }
  }
  const ids = new Set(sessions.map((session) => session.id));
  signal?.throwIfAborted();
  for (const id of dayCache.keys()) if (!ids.has(id)) { dayCache.delete(id); dirty = true; }
  if (dirty) writeDurableSoon('usage-cache', { version: CACHE_VERSION, rows: [...dayCache].map(([id, row]) => ({ id, revision: row.revision, days: [...row.days], proMessages: row.proMessages })) });
  logInfo(`usage overview sessions=${sessions.length} reused=${sessions.length - rebuilt} rebuilt=${rebuilt} elapsed_ms=${Math.round(performance.now() - started)}`);
  const now = Date.now();
  const activeLimits = limits.filter((entry) => {
    if (entry.resetAt !== null && entry.resetAt <= now) return false;
    if (now - entry.observedAt <= FRESH_MS) return true;
    // A future provider reset is a durable fence when the provider reported zero or no numeric
    // balance. Positive remaining counts go stale because use on another device can consume them.
    return entry.scope === 'model' && entry.resetAt !== null && (entry.remaining === 0 || entry.remaining === null);
  }).map((entry) => ({ ...entry }));
  return {
    contextTokenCap,
    limits: activeLimits,
    proChat: proChatSummary(activeLimits, trackedPro),
    days: [...days].sort(([a], [b]) => a.localeCompare(b)).map(([date, rows]) => ({ date, tokens: [...rows.values()].reduce((sum, row) => sum + row.tokens, 0), models: [...rows.values()] })),
    models: [...models.values()], tokens: [...models.values()].reduce((sum, row) => sum + row.tokens, 0), sessions: sessions.length
  };
}
