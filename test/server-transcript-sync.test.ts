import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const source = readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8');
const start = source.indexOf('async function readServerTranscriptProjection(');
const end = source.indexOf('async function performBrowserRepairs(', start);
if (start < 0 || end < 0) throw new Error('server transcript helper not found');
const helper = source.slice(start, end);
const CHAT = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

function response(data: unknown, status = 200) {
  const bytes = new TextEncoder().encode(JSON.stringify(data)); let read = false;
  return { ok: status >= 200 && status < 300, status, headers: { get: () => 'application/json' }, body: { getReader: () => ({
    read: async () => read ? { done: true } : (read = true, { done: false, value: bytes }), cancel: async () => {}
  }) } };
}
function fixture(data: unknown, pathname = `/c/${CHAT}`) {
  const fetch = vi.fn(async (_input: string, _init?: Record<string, unknown>) => response(data));
  const context = vm.createContext({ location: { origin: 'https://chatgpt.com', pathname }, fetch, AbortController, TextDecoder, TextEncoder,
    URL, Date, Map, Set, Object, Array, Number, String, RegExp, JSON, Math, setTimeout, clearTimeout });
  vm.runInContext(`${helper}\nglobalThis.readServer = readServerTranscriptProjection;`, context);
  return { fetch, read: context.readServer as (id: string) => Promise<any> };
}

describe('one-shot public server transcript projection', () => {
  it('returns only public user and settled final assistant messages', async () => {
    const u = 'user-one', analysis = 'analysis-one', interim = 'interim-one', a = 'assistant-final';
    const data = { conversation_id: CHAT, current_node: a, mapping: {
      [u]: { id: u, parent: null, children: [analysis], message: { id: u, author: { role: 'user' }, create_time: 100, content: { content_type: 'text', parts: ['mobile question'] } } },
      [analysis]: { id: analysis, parent: u, children: [interim], message: { id: analysis, author: { role: 'assistant' }, channel: 'analysis', create_time: 101, content: { content_type: 'text', parts: ['private reasoning'] } } },
      [interim]: { id: interim, parent: analysis, children: [a], message: { id: interim, author: { role: 'assistant' }, create_time: 102, end_turn: false, content: { content_type: 'text', parts: ['working'] } } },
      [a]: { id: a, parent: interim, children: [], message: { id: a, author: { role: 'assistant' }, create_time: 103, end_turn: true, status: 'finished_successfully', content: { content_type: 'text', parts: ['final answer'] }, metadata: { model_slug: 'gpt-5-6-thinking' } } }
    } };
    const f = fixture(data); const result = await f.read(CHAT);
    expect(result.ok).toBe(true);
    expect(result.projection.userLineage).toEqual([u]);
    expect(result.projection.messages.map((row: any) => [row.role, row.messageId, row.text])).toEqual([
      ['user', u, 'mobile question'], ['assistant', a, 'final answer']
    ]);
    expect(JSON.stringify(result)).not.toContain('private reasoning');
    expect(JSON.stringify(result)).not.toContain('working');
    expect(f.fetch).toHaveBeenCalledWith(`/backend-api/conversation/${CHAT}`, expect.objectContaining({ method: 'GET', credentials: 'same-origin', cache: 'no-store' }));
    expect(f.fetch.mock.calls[0]![1]).not.toHaveProperty('headers');
  });
  it('refuses a different current conversation before making an authenticated read', async () => {
    const f = fixture({}, '/c/bbbbbbbb-cccc-4ddd-8eee-ffffffffffff');
    await expect(f.read(CHAT)).resolves.toEqual({ ok: false, error: 'route_unavailable' });
    expect(f.fetch).not.toHaveBeenCalled();
  });
  it('tries the f/conversation route only when the normal read is unavailable', async () => {
    const data = { conversation_id: CHAT, current_node: 'u', mapping: { u: { id: 'u', parent: null, children: [], message: { id: 'u', author: { role: 'user' }, create_time: 1, content: { content_type: 'text', parts: ['q'] } } } } };
    const f = fixture(data); f.fetch.mockResolvedValueOnce(response({}, 404) as never).mockResolvedValueOnce(response(data) as never);
    expect((await f.read(CHAT)).ok).toBe(true);
    expect(f.fetch.mock.calls.map(call => call[0])).toEqual([`/backend-api/conversation/${CHAT}`, `/backend-api/f/conversation/${CHAT}`]);
  });
});


describe('content-side server transcript compatibility', () => {
  const content = readFileSync(new URL('../extension/content.js', import.meta.url), 'utf8');
  const mergeStart = content.indexOf('  function latestServerTranscriptAnchor()');
  const mergeEnd = content.indexOf('  /** The app is holding this exact revision.', mergeStart);
  if (mergeStart < 0 || mergeEnd < 0) throw new Error('server transcript merge helper not found');
  const mergeSource = content.slice(mergeStart, mergeEnd);
  function mergeFixture(anchor = 'local-anchor') {
    const emitted: any[] = [];
    const context = vm.createContext({ conversationId: CHAT, CLF_DOM: { conversationId: () => CHAT },
      userAnchorByMessage: new Map([[anchor, { seq: 10, time: 1, messageId: anchor }]]),
      serverTranscriptSeen: new Set(), pendingServerTranscript: null, emit: (row: any) => emitted.push(row),
      Set, Map, Number, String });
    vm.runInContext(`${mergeSource}\nglobalThis.compatible = serverTranscriptCompatible; globalThis.applyServer = applyServerTranscript;`, context);
    return { emitted, compatible: context.compatible as (data: any) => boolean, apply: context.applyServer as (data: any) => boolean };
  }
  it('accepts only a branch containing the newest durable local user anchor', () => {
    const f = mergeFixture();
    const good = { conversationId: CHAT, userLineage: ['older', 'local-anchor'], messages: [
      { role: 'assistant', messageId: 'answer', providerMessageId: 'answer', text: 'external final', model: 'gpt-5-6-thinking', createTime: 123 }
    ] };
    expect(f.compatible(good)).toBe(true);
    expect(f.apply(good)).toBe(true);
    expect(f.emitted).toEqual([expect.objectContaining({ kind: 'assistant_message', messageId: 'answer', text: 'external final', final: true })]);
    expect(f.compatible({ ...good, userLineage: ['sibling-anchor'] })).toBe(false);
  });
  it('treats an already-merged compatible branch as a successful no-op candidate', () => {
    const f = mergeFixture();
    const data = { conversationId: CHAT, userLineage: ['local-anchor'], messages: [
      { role: 'assistant', messageId: 'answer', providerMessageId: 'answer', text: 'same final', createTime: 123 }
    ] };
    expect(f.compatible(data)).toBe(true);
    expect(f.apply(data)).toBe(true);
    expect(f.compatible(data)).toBe(true);
    expect(f.apply(data)).toBe(false);
  });
});
