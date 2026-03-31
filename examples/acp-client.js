// examples/acp-client.js
// Framework-agnostic ACP Cloud Runtime client.
// Use this file in any frontend — React, Vue, Angular, vanilla JS.

// ── SSE Event Source ─────────────────────────────────────────────────
// Wraps fetch-based SSE (not native EventSource) to support auth headers.
// Usage:
//   const sse = new AcpEventSource(url, { Authorization: 'Bearer ...' });
//   sse.addEventListener('agent_message_chunk', e => console.log(e.detail));
//   sse.close();

export class AcpEventSource extends EventTarget {
  #controller = null;
  #connected = false;

  constructor(url, headers = {}) {
    super();
    this.#connect(url, headers);
  }

  get connected() { return this.#connected; }

  close() {
    this.#controller?.abort();
    this.#connected = false;
  }

  async #connect(url, headers) {
    this.#controller = new AbortController();
    try {
      const res = await fetch(url, {
        headers: { Accept: 'text/event-stream', ...headers },
        signal: this.#controller.signal,
      });
      if (!res.ok) {
        this.dispatchEvent(new CustomEvent('error', {
          detail: new Error(`SSE connect failed: ${res.status}`),
        }));
        return;
      }
      this.#connected = true;
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '', eventType = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const line of lines) {
          if (line.startsWith('event: ')) {
            eventType = line.slice(7).trim();
          } else if (line.startsWith('data: ') && eventType) {
            try {
              const detail = JSON.parse(line.slice(6));
              this.dispatchEvent(new CustomEvent(eventType, { detail }));
            } catch { /* ignore malformed JSON */ }
            eventType = '';
          }
        }
      }
    } catch (e) {
      if (e.name !== 'AbortError') {
        this.dispatchEvent(new CustomEvent('error', { detail: e }));
      }
    } finally {
      this.#connected = false;
    }
  }
}

// ── REST Client ──────────────────────────────────────────────────────
// Usage:
//   const client = new AcpClient('http://localhost:3000', 'my-api-key');
//   const { agents } = await client.listAgents();
//   const session = await client.createSession('pi', '/workspace');
//   const sse = client.subscribe(session.id);

export class AcpClient {
  #baseUrl;
  #apiKey;

  constructor(baseUrl, apiKey) {
    this.#baseUrl = baseUrl.replace(/\/$/, '');
    this.#apiKey = apiKey || null;
  }

  /** Update the API key at runtime (e.g. user changes it in UI). */
  set apiKey(key) { this.#apiKey = key || null; }

  // ── Internal helpers ──

  #headers(extra = {}) {
    const h = { ...extra };
    if (this.#apiKey) h['Authorization'] = `Bearer ${this.#apiKey}`;
    return h;
  }

  async #json(res) {
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
    return body;
  }

  async #get(path) {
    return this.#json(await fetch(`${this.#baseUrl}${path}`, {
      headers: this.#headers(),
    }));
  }

  async #post(path, body) {
    return this.#json(await fetch(`${this.#baseUrl}${path}`, {
      method: 'POST',
      headers: this.#headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(body),
    }));
  }

  async #del(path) {
    return this.#json(await fetch(`${this.#baseUrl}${path}`, {
      method: 'DELETE',
      headers: this.#headers(),
    }));
  }

  // ── REST API ──

  /** GET /config → { workspace: string } */
  async getConfig() { return this.#get('/config'); }

  /** GET /agents → { agents: string[] } */
  async listAgents() { return this.#get('/agents'); }

  /**
   * POST /sessions → SessionInfo
   * @param {string} agent - Agent ID (e.g. 'pi', 'claude')
   * @param {string} cwd - Working directory for the agent
   * @param {string} [permissionMode] - 'approve-all'|'approve-reads'|'deny-all'|'delegate'
   */
  async createSession(agent, cwd, permissionMode) {
    const body = { agent, cwd };
    if (permissionMode) body.permissionMode = permissionMode;
    return this.#post('/sessions', body);
  }

  /** GET /sessions → SessionInfo[] */
  async listSessions() { return this.#get('/sessions'); }

  /** GET /sessions/:id → SessionInfo */
  async getSession(id) { return this.#get(`/sessions/${id}`); }

  /** DELETE /sessions/:id */
  async closeSession(id) { return this.#del(`/sessions/${id}`); }

  /**
   * POST /sessions/:id/prompt → RunInfo
   * The response returns immediately; results stream via SSE.
   */
  async prompt(sessionId, text) {
    return this.#post(`/sessions/${sessionId}/prompt`, { text });
  }

  /** POST /sessions/:id/cancel */
  async cancelRun(sessionId) {
    return this.#post(`/sessions/${sessionId}/cancel`, {});
  }

  /**
   * POST /sessions/:id/permissions/:reqId/respond
   * @param {string} optionId - One of the optionIds from the permission_request event
   */
  async respondToPermission(sessionId, reqId, optionId) {
    return this.#post(`/sessions/${sessionId}/permissions/${reqId}/respond`, { optionId });
  }

  // ── SSE ──

  /**
   * Subscribe to a session's event stream.
   * Returns an AcpEventSource (extends EventTarget).
   *
   * Events: session_status_changed, run_started, agent_message_chunk,
   *         agent_thought_chunk, tool_call, tool_call_update,
   *         run_completed, run_error, permission_request, permission_timeout
   *
   * Each event's `detail` contains the parsed JSON payload.
   */
  subscribe(sessionId) {
    return new AcpEventSource(
      `${this.#baseUrl}/sessions/${sessionId}/events`,
      this.#headers(),
    );
  }
}
