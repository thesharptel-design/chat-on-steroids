/**
 * Passive, bounded page-response projection.
 *
 * Never reads request headers, cookies, credentials or request bodies. Besides
 * quota metadata, it observes the two opaque identifiers ChatGPT itself puts in the live
 * conversation event stream: `conversation_id` and `metadata.request_id`. The latter can
 * reach the stream tens of seconds before React publishes it, which is the difference between
 * an exact Core caller and CALLER_IDENTITY_REQUIRED. Only that pair crosses worlds.
 */
(() => {
  'use strict';
  if (window.__cosUsageObserver) return;
  window.__cosUsageObserver = true;
  const post = window.postMessage.bind(window);
  let latest = null;
  let latestServerTranscript = null;
  let requestOrder = 0, latestOrder = 0;
  const CONVERSATION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const REQUEST = /^wfr_[a-zA-Z0-9_-]{1,96}$/;
  const CONVERSATION_FIELD = /(?:^|[,{\s])\"conversation_id\"\s*:\s*\"([0-9a-f-]{36})\"/gi;
  // Passive evidence only: no polling, and no full response survives a scan. Retain a
  // small replay window for document_start -> content-script readiness and deduplicate
  // repeated provider observations across responses as well as inside one stream.
  const origins = new Map();
  const originReaders = new Set();
  const ORIGIN_LISTEN_MS = 15 * 60_000;
  function publishOrigin(conversationId, requestIds, observedAt) {
    const fresh = requestIds.filter(id => !origins.has(`${conversationId}:${id}`));
    if (!fresh.length) return;
    for (const requestId of fresh) {
      if (origins.size >= 64) origins.delete(origins.keys().next().value);
      origins.set(`${conversationId}:${requestId}`, { conversationId, requestId, observedAt });
    }
    post({ type: 'cos-request-origin', conversationId, requestIds: fresh, observedAt }, location.origin);
  }
  const project = (data, observedAt, order) => {
    if (!data || typeof data !== 'object') return;
    const rows = [];
    const label = (value) => typeof value === 'string' && /^[a-zA-Z0-9_. /-]{1,100}$/.test(value) ? value : null;
    const finite = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
    const add = (value) => { if (rows.length < 80) rows.push(value); };
    const metadata = data.conversation_detail_metadata || data;
    const recognized = Array.isArray(metadata.model_limits) || Array.isArray(metadata.limits_progress) || !!data.rate_limit || Array.isArray(data.additional_rate_limits);
    if (!recognized || order < latestOrder) return;
    for (const row of (Array.isArray(metadata.model_limits) ? metadata.model_limits : []).slice(0, 40)) {
      const model = label(row?.model_slug);
      const reset = typeof row?.resets_after === 'string' ? Date.parse(row.resets_after) : NaN;
      // A reset timestamp alone is not a remaining-message count.
      const remaining = finite(row?.remaining), resetAt = Number.isFinite(reset) && reset > 0 ? reset : null;
      if (model && (remaining !== null || resetAt !== null)) add({ model, scope: 'model', remaining, remainingPercent: null, resetAt, windowSeconds: null });
    }
    for (const row of (Array.isArray(metadata.limits_progress) ? metadata.limits_progress : []).slice(0, 40)) {
      const model = label(row?.model_slug), feature = label(row?.feature_name), remaining = finite(row?.remaining);
      const reset = typeof row?.reset_after === 'string' ? Date.parse(row.reset_after) : NaN;
      if ((model || feature) && remaining !== null) add({ model: model || feature, scope: model ? 'model' : 'feature', remaining, remainingPercent: null, resetAt: Number.isFinite(reset) && reset > 0 ? reset : null, windowSeconds: null });
    }
    const rates = [{ ...data, label: 'Shared usage' }, ...(Array.isArray(data.additional_rate_limits) ? data.additional_rate_limits.slice(0, 40) : [])];
    for (const rate of rates) {
      const model = label(rate?.model_slug), name = model || label(rate?.limit_name) || label(rate?.label);
      for (const window of [rate?.rate_limit?.primary_window, rate?.rate_limit?.secondary_window]) {
        const used = finite(window?.used_percent);
        if (!name || used === null || used > 100) continue;
        const reset = finite(window?.reset_at);
        add({ model: name, scope: model ? 'model' : 'shared', remaining: null, remainingPercent: 100 - used, resetAt: reset === null || reset === 0 ? null : reset * 1000, windowSeconds: finite(window?.limit_window_seconds) || null });
      }
    }
    latestOrder = order;
    latest = { type: 'cos-usage', rows, observedAt }; post(latest, location.origin);
  };
  async function inspect(response, observedAt, order) {
    let url;
    try { url = new URL(response.url); } catch { return; }
    if (url.origin !== location.origin || !/^\/backend-api\/(?:wham\/usage|conversation\/init|conversation\/prepare|models)(?:\?|$)/.test(url.pathname)) return;
    if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) return;
    const copy = response.clone(), reader = copy.body?.getReader();
    if (!reader) return;
    const timer = setTimeout(() => void reader.cancel().catch(() => {}), 10000);
    let bytes = 0, text = ''; const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        bytes += value.byteLength; if (bytes > 512 * 1024) return;
        text += decoder.decode(value, { stream: true });
      }
      project(JSON.parse(text + decoder.decode()), observedAt, order);
    } catch { /* Unsupported metadata is unavailable, never guessed. */ }
    finally { clearTimeout(timer); void reader.cancel().catch(() => {}); }
  }
  const SERVER_TRANSCRIPT_PATH = /^\/backend-api\/(?:f\/)?conversation\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i;
  const SERVER_TRANSCRIPT_BYTES = 8 * 1024 * 1024;
  const SERVER_TRANSCRIPT_MESSAGES = 96;
  const SERVER_TRANSCRIPT_LINEAGE = 512;
  const SERVER_TRANSCRIPT_TEXT = 256_000;
  const SERVER_TRANSCRIPT_TOTAL_TEXT = 1024 * 1024;

  function serverAuthoredTime(message) {
    const raw = Number(message?.create_time);
    if (!Number.isFinite(raw) || raw <= 0) return null;
    return Math.round(raw < 10_000_000_000 ? raw * 1000 : raw);
  }
  function serverText(message) {
    const content = message?.content;
    if (!content || typeof content !== 'object') return '';
    let parts = [];
    if (content.content_type === 'text' && Array.isArray(content.parts)) parts = content.parts;
    else if (content.content_type === 'multimodal_text' && Array.isArray(content.parts)) parts = content.parts;
    else return '';
    let value = '';
    for (const part of parts) {
      if (typeof part !== 'string') continue;
      if (value) value += '\n';
      value += part;
      if (value.length >= SERVER_TRANSCRIPT_TEXT) break;
    }
    return value.slice(0, SERVER_TRANSCRIPT_TEXT);
  }
  function publicServerMessage(message) {
    if (!message || typeof message !== 'object') return null;
    const id = typeof message.id === 'string' && /^[a-zA-Z0-9:_-]{1,200}$/.test(message.id) ? message.id : null;
    const role = message.author?.role;
    if (!id || (role !== 'user' && role !== 'assistant')) return null;
    const metadata = message.metadata && typeof message.metadata === 'object' ? message.metadata : null;
    if (metadata?.is_visually_hidden_from_conversation === true || metadata?.is_visually_hidden === true) return null;
    if (role === 'assistant') {
      if (message.channel === 'analysis' || metadata?.channel === 'analysis') return null;
      // Cross-device sync needs the settled public answer, not private/interim narration.
      if (message.end_turn !== true || (message.status && message.status !== 'finished_successfully')) return null;
    }
    const text = serverText(message);
    if (!text) return null;
    const createTime = serverAuthoredTime(message);
    return {
      role,
      messageId: id,
      ...(role === 'assistant' ? { providerMessageId: id, final: true } : {}),
      text,
      ...(createTime ? { createTime } : {})
    };
  }
  function projectServerTranscript(data, conversationId, observedAt) {
    if (!data || typeof data !== 'object' || !CONVERSATION.test(conversationId)) return;
    const claimed = typeof data.conversation_id === 'string' ? data.conversation_id :
      typeof data.id === 'string' ? data.id : null;
    if (claimed && claimed !== conversationId) return;
    const raw = data.mapping;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
    const entries = Object.entries(raw);
    if (entries.length === 0 || entries.length > 10000) return;
    const nodes = new Map();
    for (const [key, value] of entries) {
      if (!value || typeof value !== 'object') continue;
      const id = typeof value.id === 'string' ? value.id : key;
      if (typeof id !== 'string' || id.length > 200) continue;
      const parent = typeof value.parent === 'string' && value.parent.length <= 200 ? value.parent : null;
      const children = Array.isArray(value.children)
        ? value.children.filter(child => typeof child === 'string' && child.length <= 200).slice(0, 64)
        : [];
      nodes.set(id, { id, parent, children, message: value.message });
    }
    if (nodes.size === 0) return;
    const leaves = [...nodes.values()].filter(node => !node.children.some(child => nodes.has(child)));
    if (leaves.length === 0) return;
    const currentNode = typeof data.current_node === 'string' && nodes.has(data.current_node) ? data.current_node : null;
    let best = null;
    for (const leaf of leaves.slice(0, 2000)) {
      const chain = [];
      const seen = new Set();
      let at = leaf;
      while (at && !seen.has(at.id) && chain.length < 5000) {
        seen.add(at.id); chain.push(at);
        at = at.parent ? nodes.get(at.parent) : null;
      }
      chain.reverse();
      const publicRows = [];
      let latestAt = 0;
      for (const node of chain) {
        const projected = publicServerMessage(node.message);
        if (!projected) continue;
        publicRows.push(projected);
        latestAt = Math.max(latestAt, projected.createTime || 0);
      }
      if (!publicRows.length) continue;
      const preferred = currentNode === leaf.id ? 1 : 0;
      if (!best || latestAt > best.latestAt || (latestAt === best.latestAt && preferred > best.preferred))
        best = { leafId: leaf.id, rows: publicRows, latestAt, preferred };
    }
    if (!best) return;
    const userLineage = best.rows.filter(row => row.role === 'user').map(row => row.messageId).slice(-SERVER_TRANSCRIPT_LINEAGE);
    const messages = [];
    let textBudget = SERVER_TRANSCRIPT_TOTAL_TEXT;
    for (let index = best.rows.length - 1; index >= 0 && messages.length < SERVER_TRANSCRIPT_MESSAGES && textBudget > 0; index--) {
      const row = best.rows[index];
      const text = row.text.length <= textBudget ? row.text : row.text.slice(0, textBudget);
      if (!text) break;
      messages.push({ ...row, text });
      textBudget -= text.length;
    }
    messages.reverse();
    if (!messages.length || !userLineage.length) return;
    latestServerTranscript = {
      type: 'cos-server-transcript', conversationId, observedAt,
      leafId: best.leafId, userLineage, messages
    };
    post(latestServerTranscript, location.origin);
  }
  async function inspectServerTranscript(response, observedAt) {
    let url;
    try { url = new URL(response.url); } catch { return; }
    if (url.origin !== location.origin) return;
    const match = url.pathname.match(SERVER_TRANSCRIPT_PATH);
    if (!match || !response.ok || !response.headers.get('content-type')?.includes('application/json')) return;
    const copy = response.clone(), reader = copy.body?.getReader();
    if (!reader) return;
    const timer = setTimeout(() => void reader.cancel().catch(() => {}), 15000);
    let bytes = 0, text = ''; const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        bytes += value.byteLength; if (bytes > SERVER_TRANSCRIPT_BYTES) return;
        text += decoder.decode(value, { stream: true });
      }
      projectServerTranscript(JSON.parse(text + decoder.decode()), match[1], observedAt);
    } catch { /* Server transcript projection is opportunistic; the page remains authoritative. */ }
    finally { clearTimeout(timer); void reader.cancel().catch(() => {}); }
  }

  /**
   * Reads bounded complete SSE events from a clone without changing the page's response.
   * Only a conversation id and server request metadata from the same event are projected.
   */
  function readOrigin(frame) {
      if (!frame || frame.length > 512 * 1024) return;
      const conversations = new Set();
      CONVERSATION_FIELD.lastIndex = 0;
      for (let match; (match = CONVERSATION_FIELD.exec(frame));) {
        if (CONVERSATION.test(match[1])) conversations.add(match[1]);
      }
      // One complete server event must carry both sides of the join. Retaining an id from a
      // prior frame would turn response order into authority; a contradictory frame abstains.
      if (conversations.size !== 1) return;
      const conversationId = conversations.values().next().value;
      // Only server metadata in a complete JSON event owns a request id. A key in
      // quoted model text, tool arguments or an unrelated nested object is not proof.
      let event;
      try {
        const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:'))
          .map(line => line.slice(5).trimStart()).join('\n');
        event = JSON.parse(data);
      } catch { return; }
      if (event?.conversation_id !== conversationId) return;
      const requestIds = new Set([event.metadata?.request_id, event.message?.metadata?.request_id]
        .filter(id => typeof id === 'string' && REQUEST.test(id)));
      return requestIds.size ? { conversationId, requestIds: [...requestIds] } : null;
  }
  async function inspectRequestOrigins(response, observedAt) {
    let url;
    try { url = new URL(response.url); } catch { return; }
    if (url.origin !== location.origin || !/^\/backend-api\/(?:f\/)?conversation$/.test(url.pathname)) return;
    if (!response.ok || !response.headers.get('content-type')?.includes('text/event-stream')) return;
    if (originReaders.size >= 2) return;
    const copy = response.clone(), reader = copy.body?.getReader();
    if (!reader) return;
    originReaders.add(reader);
    const timer = setTimeout(() => void reader.cancel().catch(() => {}), ORIGIN_LISTEN_MS);
    const decoder = new TextDecoder(), emitted = new Set();
    let bytes = 0, buffer = '';
    const scan = (frame) => {
      const origin = readOrigin(frame);
      if (!origin) return;
      const fresh = origin.requestIds.filter((id) => !emitted.has(id)).slice(0, 16 - emitted.size);
      if (fresh.length === 0) return;
      for (const id of fresh) emitted.add(id);
      publishOrigin(origin.conversationId, fresh, observedAt);
    };
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 4 * 1024 * 1024) return;
        buffer += decoder.decode(value, { stream: true });
        for (;;) {
          const lf = buffer.indexOf('\n\n');
          const crlf = buffer.indexOf('\r\n\r\n');
          const split = lf < 0 ? crlf : crlf < 0 ? lf : Math.min(lf, crlf);
          if (split < 0) break;
          const width = buffer.startsWith('\r\n\r\n', split) ? 4 : 2;
          scan(buffer.slice(0, split));
          if (emitted.size >= 16) return;
          buffer = buffer.slice(split + width);
        }
        if (buffer.length > 512 * 1024) return;
      }
      buffer += decoder.decode();
      scan(buffer);
    } catch { /* A missing stream observation leaves the existing Fiber path in charge. */ }
    finally { clearTimeout(timer); originReaders.delete(reader); void reader.cancel().catch(() => {}); }
  }
  let observedFetch = null;
  let observedWebSocket = null;
  const observedSockets = new WeakSet();
  function inspectSocketMessage(event) {
    // Pro hands its HTTP stream to the native conversation-turn-stream socket.
    // Observe only complete server envelopes; never subscribe, send or join deltas.
    if (typeof event.data !== 'string' || event.data.length > 2 * 1024 * 1024 || !event.data.includes('wfr_')) return;
    let rows;
    try { rows = JSON.parse(event.data); } catch { return; }
    if (!Array.isArray(rows) || rows.length > 32) return;
    for (const row of rows) {
      const payload = row?.payload?.payload;
      if (row?.type !== 'message' || row.payload?.type !== 'conversation-turn-stream' ||
          payload?.type !== 'stream-item' || typeof payload.conversation_id !== 'string' || !CONVERSATION.test(payload.conversation_id) ||
          typeof payload.encoded_item !== 'string' || payload.encoded_item.length > 512 * 1024) continue;
      const frames = payload.encoded_item.split(/\r?\n\r?\n/);
      if (frames.length > 16) continue;
      for (const frame of frames) {
        const origin = readOrigin(frame);
        if (origin?.conversationId === payload.conversation_id)
          publishOrigin(origin.conversationId, origin.requestIds, Date.now());
      }
    }
  }
  function installSocketObserver() {
    if (typeof window.WebSocket !== 'function' || window.WebSocket === observedWebSocket) return;
    observedWebSocket = new Proxy(window.WebSocket, {
      construct(target, args, newTarget) {
        const socket = Reflect.construct(target, args, newTarget);
        try {
          const url = new URL(socket.url);
          if (url.protocol === 'wss:' && (url.hostname === 'chatgpt.com' || url.hostname.endsWith('.chatgpt.com')) &&
              !observedSockets.has(socket)) {
            observedSockets.add(socket);
            socket.addEventListener('message', inspectSocketMessage);
          }
        } catch { /* Foreign/unsupported transport remains untouched. */ }
        return socket;
      }
    });
    window.WebSocket = observedWebSocket;
  }
  const inspectedResponses = new WeakSet();
  const installFetchObserver = () => {
    if (window.fetch === observedFetch || typeof window.fetch !== 'function') return;
    // A page wrapper may still call our earlier wrapper. Capture its downstream
    // function per installation; changing a shared pointer would create a cycle.
    const downstreamFetch = window.fetch;
    observedFetch = function (...args) {
      // Request order fences late responses, not accounts. No account identity is inferred.
      const observedAt = Date.now(), order = ++requestOrder;
      const result = downstreamFetch.apply(this, args);
      void result.then((response) => {
        if (inspectedResponses.has(response)) return;
        inspectedResponses.add(response);
        void inspect(response, observedAt, order).catch(() => {});
        let method = 'GET';
        try {
          const explicit = args[1] && typeof args[1].method === 'string' ? args[1].method : null;
          const inherited = args[0] && typeof args[0] === 'object' && typeof args[0].method === 'string' ? args[0].method : null;
          method = String(explicit || inherited || 'GET').toUpperCase();
        } catch { return; }
        if (method === 'POST') void inspectRequestOrigins(response, observedAt).catch(() => {});
        else if (method === 'GET') void inspectServerTranscript(response, observedAt).catch(() => {});
      }).catch(() => {});
      return result;
    };
    // ChatGPT installs its own fetch instrumentation after document_start. Keep that owner in
    // the chain and reattach once at the page-ready boundary; otherwise our flag remains set
    // while the live response observer has silently been replaced.
    window.fetch = observedFetch;
  };
  installFetchObserver();
  installSocketObserver();
  if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', installFetchObserver, { once: true });
    window.addEventListener('DOMContentLoaded', installSocketObserver, { once: true });
  }
  window.addEventListener('message', (event) => {
    if (event.source !== window || event.origin !== location.origin || event.data?.type !== 'cos-usage-request') return;
    if (latest) post(latest, location.origin);
    if (latestServerTranscript) post(latestServerTranscript, location.origin);
    // Newest first: old evidence must not fill content's 16-ID pending capacity
    // before the current workflow can enter it during document startup.
    for (const { conversationId, requestId, observedAt } of [...origins.values()].slice(-16).reverse())
      post({ type: 'cos-request-origin', conversationId, requestIds: [requestId], observedAt }, location.origin);
  });
  window.addEventListener('pagehide', () => {
    for (const reader of originReaders) void reader.cancel().catch(() => {});
    origins.clear();
  });
})();
