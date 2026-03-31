// examples/acp-components.js
// Lit web components for ACP Cloud Runtime Web UI.
// Depends on: lit (CDN), marked (global), hljs (global), ./acp-client.js

import { LitElement, html, css } from 'https://cdn.jsdelivr.net/npm/lit@3/+esm';
import { AcpClient } from './acp-client.js';

// ── Helpers ──────────────────────────────────────────────────────────

function renderMarkdown(text) {
  try {
    return marked.parse(text.trim());
  } catch {
    const d = document.createElement('div');
    d.textContent = text;
    return d.innerHTML;
  }
}

// ── <acp-system-notice> ──────────────────────────────────────────────
// Centered, muted text for system messages (session created, run ended, errors).

class AcpSystemNotice extends LitElement {
  static properties = {
    text: { type: String },
  };

  static styles = css`
    :host { display: block; text-align: center; padding: 4px 0; }
    span { font-size: 11px; color: #aaa; }
  `;

  render() {
    return html`<span>${this.text}</span>`;
  }
}
customElements.define('acp-system-notice', AcpSystemNotice);

// ── <acp-message> ────────────────────────────────────────────────────
// Chat bubble for user and agent messages.
// - User: right-aligned, escaped text.
// - Agent streaming: plain text with blinking cursor.
// - Agent finalized: markdown rendered via marked.js + hljs.

class AcpMessage extends LitElement {
  static properties = {
    text: { type: String },
    role: { type: String },          // 'user' | 'agent'
    streaming: { type: Boolean },
  };

  static styles = css`
    :host { display: block; }
    .row { display: flex; gap: 10px; align-items: flex-start; }
    .row.user { flex-direction: row-reverse; }
    .avatar {
      width: 28px; height: 28px; border-radius: 50%; flex-shrink: 0;
      display: flex; align-items: center; justify-content: center;
      font-size: 11px; font-weight: 600; color: #fff; margin-top: 2px;
    }
    .avatar.agent { background: linear-gradient(135deg, #6366f1, #8b5cf6); }
    .avatar.user { background: linear-gradient(135deg, #3b82f6, #06b6d4); }

    .bubble {
      padding: 10px 14px; border-radius: 14px; line-height: 1.6;
      word-break: break-word; font-size: 14px; max-width: 80%;
    }
    .agent .bubble {
      background: #fff; border: 1px solid #e5e5e5;
      border-top-left-radius: 4px; box-shadow: 0 1px 2px rgba(0,0,0,.04);
    }
    .user .bubble {
      background: linear-gradient(135deg, #6366f1, #818cf8);
      color: #fff; border-top-right-radius: 4px;
    }

    /* Streaming cursor */
    .streaming { white-space: pre-wrap; }
    .streaming::after {
      content: ''; display: inline-block; width: 2px; height: 1em;
      background: #6366f1; margin-left: 1px; vertical-align: text-bottom;
      animation: blink .8s step-end infinite;
    }
    @keyframes blink { 0%,100%{opacity:1}50%{opacity:0} }

    /* Markdown styles */
    .md p { margin: 0 0 8px; } .md p:last-child { margin: 0; }
    .md h1,.md h2,.md h3 { margin: 12px 0 6px; font-weight: 600; }
    .md h1 { font-size: 17px; } .md h2 { font-size: 16px; } .md h3 { font-size: 15px; }
    .md ul,.md ol { padding-left: 20px; margin: 4px 0; }
    .md li { margin: 2px 0; }
    .md code {
      background: #f3f4f6; padding: 1px 5px; border-radius: 4px;
      font-size: 13px; font-family: 'SF Mono','Fira Code',monospace;
    }
    .md pre {
      background: #f8f9fa; border: 1px solid #e5e7eb; border-radius: 8px;
      padding: 10px 12px; margin: 8px 0; overflow-x: auto;
    }
    .md pre code { background: none; padding: 0; font-size: 12.5px; line-height: 1.5; }
    .md strong { font-weight: 600; }
    .md a { color: #6366f1; text-decoration: underline; }
    .md blockquote { border-left: 3px solid #d1d5db; padding-left: 10px; color: #6b7280; margin: 6px 0; }
    .md table { border-collapse: collapse; margin: 8px 0; font-size: 13px; width: 100%; }
    .md th,.md td { border: 1px solid #e5e7eb; padding: 4px 8px; text-align: left; }
    .md th { background: #f9fafb; font-weight: 600; }
    .md hr { border: none; border-top: 1px solid #e5e7eb; margin: 10px 0; }
  `;

  render() {
    const r = this.role || 'agent';
    const initial = r === 'user' ? 'U' : 'A';
    const isStreaming = this.streaming && r === 'agent';
    return html`
      <div class="row ${r}">
        <div class="avatar ${r}">${initial}</div>
        <div class="bubble ${isStreaming ? 'streaming' : ''}"></div>
      </div>
    `;
  }

  updated() {
    const bubble = this.renderRoot.querySelector('.bubble');
    if (!bubble) return;
    if (this.role === 'agent' && !this.streaming && this.text) {
      bubble.classList.add('md');
      bubble.innerHTML = renderMarkdown(this.text);
      bubble.querySelectorAll('pre code').forEach(el => {
        if (!el.dataset.highlighted) hljs.highlightElement(el);
      });
    } else {
      bubble.classList.remove('md');
      bubble.textContent = this.text || '';
    }
  }
}
customElements.define('acp-message', AcpMessage);

// ── <acp-input> ──────────────────────────────────────────────────────
// Auto-growing textarea + send button.
// Dispatches 'send-prompt' event with { detail: string }.

class AcpInput extends LitElement {
  static properties = {
    disabled: { type: Boolean },
  };

  static styles = css`
    :host { display: block; padding: 12px 16px; background: #fff;
      border-top: 1px solid #e5e7eb; box-shadow: 0 -1px 3px rgba(0,0,0,.04); }
    .wrap { max-width: 760px; margin: 0 auto; display: flex; gap: 8px; align-items: flex-end; }
    textarea {
      flex: 1; padding: 10px 14px; border-radius: 12px; border: 1.5px solid #e5e7eb;
      background: #f9fafb; color: #1a1a1a; font-size: 14px; font-family: inherit;
      resize: none; line-height: 1.5; min-height: 40px; max-height: 140px;
      transition: border-color .15s;
    }
    textarea:focus { outline: none; border-color: #6366f1; background: #fff; }
    textarea:disabled { opacity: .4; }
    button {
      width: 40px; height: 40px; border-radius: 10px; border: none;
      background: #6366f1; color: white; font-size: 16px; cursor: pointer;
      display: flex; align-items: center; justify-content: center;
      flex-shrink: 0; transition: background .15s;
    }
    button:hover { background: #4f46e5; }
    button:disabled { opacity: .3; cursor: not-allowed; }
  `;

  render() {
    return html`
      <div class="wrap">
        <textarea
          rows="1"
          placeholder="Type a message..."
          ?disabled=${this.disabled}
          @input=${this._autoGrow}
          @keydown=${this._onKey}
        ></textarea>
        <button ?disabled=${this.disabled} @click=${this._send}>&#x2191;</button>
      </div>
    `;
  }

  _autoGrow(e) {
    const el = e.target;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 140) + 'px';
  }

  _onKey(e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this._send(); }
  }

  _send() {
    const ta = this.renderRoot.querySelector('textarea');
    const text = ta.value.trim();
    if (!text || this.disabled) return;
    this.dispatchEvent(new CustomEvent('send-prompt', { detail: text, bubbles: true, composed: true }));
    ta.value = '';
    ta.style.height = 'auto';
  }

  focus() {
    this.renderRoot.querySelector('textarea')?.focus();
  }
}
customElements.define('acp-input', AcpInput);

// ── <acp-thinking> ───────────────────────────────────────────────────
// Collapsible thinking/reasoning block.
// Collapsed by default. Shows "Thinking..." while streaming, "Thought" when done.

class AcpThinking extends LitElement {
  static properties = {
    text: { type: String },
    streaming: { type: Boolean },
    _open: { state: true },
  };

  constructor() { super(); this._open = false; }

  static styles = css`
    :host { display: block; max-width: 80%; }
    .toggle {
      display: inline-flex; align-items: center; gap: 4px;
      font-size: 12px; color: #b0b0b0; cursor: pointer; user-select: none; padding: 2px 0;
    }
    .toggle:hover { color: #888; }
    .arrow {
      display: inline-block; font-size: 10px; transition: transform .2s;
    }
    .arrow.open { transform: rotate(90deg); }
    .label.streaming {
      background: linear-gradient(90deg, #d1d5db, #e5e7eb, #d1d5db);
      background-size: 200% 100%;
      -webkit-background-clip: text; -webkit-text-fill-color: transparent;
      animation: shimmer 1.5s infinite;
    }
    @keyframes shimmer { 0%{background-position:200% 0}100%{background-position:-200% 0} }
    .content {
      padding: 8px 12px; border-radius: 8px; font-size: 12px;
      color: #9ca3af; background: #f9fafb; border: 1px solid #f3f4f6;
      font-style: italic; max-height: 200px; overflow-y: auto;
      line-height: 1.5; margin-top: 4px; white-space: pre-wrap;
    }
  `;

  render() {
    return html`
      <div class="toggle" @click=${() => this._open = !this._open}>
        <span class="arrow ${this._open ? 'open' : ''}">&#x25B6;</span>
        <span class="label ${this.streaming ? 'streaming' : ''}">
          ${this.streaming ? 'Thinking...' : 'Thought'}
        </span>
      </div>
      ${this._open ? html`<div class="content">${this.text}</div>` : ''}
    `;
  }
}
customElements.define('acp-thinking', AcpThinking);

// ── <acp-tool-call> ──────────────────────────────────────────────────
// Compact bar showing tool execution status.
// Status: 'in_progress' (amber), 'completed' (green), 'failed' (red).

class AcpToolCall extends LitElement {
  static properties = {
    title: { type: String },
    kind: { type: String },
    status: { type: String },
  };

  static styles = css`
    :host { display: block; max-width: 80%; }
    .bar {
      padding: 6px 10px; border-radius: 8px; font-size: 12px;
      color: #6b7280; background: #fff; border: 1px solid #e5e5e5;
      border-left: 3px solid #6366f1;
      display: flex; align-items: center; gap: 6px; transition: all .3s;
    }
    .bar.in_progress { border-left-color: #f59e0b; background: #fffbeb; }
    .bar.completed { border-left-color: #10b981; }
    .bar.failed { border-left-color: #ef4444; background: #fef2f2; }
    .icon { opacity: .5; }
    .name { font-weight: 500; color: #374151; }
    .kind { color: #9ca3af; }
    .badge {
      font-size: 10px; margin-left: auto; padding: 1px 6px;
      border-radius: 4px; background: #f3f4f6; color: #6b7280;
    }
    .in_progress .badge { background: #fef3c7; color: #92400e; }
    .completed .badge { background: #d1fae5; color: #065f46; }
    .failed .badge { background: #fee2e2; color: #991b1b; }
  `;

  render() {
    const s = this.status || 'pending';
    return html`
      <div class="bar ${s}">
        <span class="icon">&#x2699;</span>
        <span class="name">${this.title}</span>
        ${this.kind ? html`<span class="kind">${this.kind}</span>` : ''}
        <span class="badge">${s}</span>
      </div>
    `;
  }
}
customElements.define('acp-tool-call', AcpToolCall);

// ── <acp-permission> ─────────────────────────────────────────────────
// Interactive permission dialog. Shows tool info + approve/deny buttons.
// Dispatches 'permission-respond' with { detail: { requestId, optionId } }.

class AcpPermission extends LitElement {
  static properties = {
    requestId: { type: String, attribute: 'request-id' },
    toolCall: { type: Object },
    options: { type: Array },
    resolved: { type: Boolean },
    _chosen: { state: true },
  };

  constructor() { super(); this.options = []; this._chosen = null; }

  static styles = css`
    :host { display: block; max-width: 80%; }
    .card {
      padding: 12px 14px; border-radius: 10px; background: #fffbeb;
      border: 1px solid #fde68a; font-size: 13px;
    }
    .title { font-weight: 600; color: #92400e; margin-bottom: 6px; display: flex; align-items: center; gap: 6px; }
    .desc { color: #78716c; margin-bottom: 10px; font-size: 12px; }
    .actions { display: flex; gap: 6px; flex-wrap: wrap; }
    button {
      padding: 5px 12px; border-radius: 6px; border: 1px solid #e5e7eb;
      background: #fff; font-size: 12px; cursor: pointer; font-family: inherit;
      transition: all .15s;
    }
    button:hover:not(:disabled) { background: #f3f4f6; }
    button:disabled { opacity: .5; cursor: not-allowed; }
    button.allow { border-color: #86efac; color: #065f46; }
    button.allow:hover:not(:disabled) { background: #dcfce7; }
    button.reject { border-color: #fca5a5; color: #991b1b; }
    button.reject:hover:not(:disabled) { background: #fee2e2; }
    button.chosen { font-weight: 600; box-shadow: 0 0 0 2px #6366f1; }
    .resolved { color: #9ca3af; font-size: 11px; margin-top: 6px; }
  `;

  render() {
    const toolTitle = this.toolCall?.title || 'Unknown tool';
    return html`
      <div class="card">
        <div class="title">&#x1F512; Permission required: ${toolTitle}</div>
        ${this.toolCall?.description
          ? html`<div class="desc">${this.toolCall.description}</div>`
          : ''}
        <div class="actions">
          ${(this.options || []).map(opt => {
            const isAllow = opt.kind?.startsWith('allow');
            const cls = isAllow ? 'allow' : 'reject';
            const chosen = this._chosen === opt.optionId;
            return html`
              <button
                class="${cls} ${chosen ? 'chosen' : ''}"
                ?disabled=${this.resolved}
                @click=${() => this._respond(opt.optionId)}
              >${opt.name || opt.optionId}</button>
            `;
          })}
        </div>
        ${this.resolved ? html`<div class="resolved">Responded</div>` : ''}
      </div>
    `;
  }

  _respond(optionId) {
    this._chosen = optionId;
    this.dispatchEvent(new CustomEvent('permission-respond', {
      detail: { requestId: this.requestId, optionId },
      bubbles: true,
      composed: true,
    }));
  }
}
customElements.define('acp-permission', AcpPermission);

// ── <acp-header> ─────────────────────────────────────────────────────
// Top bar: status dot, title, API key input, agent select, action buttons.
// Dispatches: agent-change, api-key-change, new-session, cancel-run, close-session.

class AcpHeader extends LitElement {
  static properties = {
    agents: { type: Array },
    selectedAgent: { type: String, attribute: 'selected-agent' },
    status: { type: String },
    apiKey: { type: String, attribute: 'api-key' },
  };

  constructor() { super(); this.agents = []; }

  static styles = css`
    :host { display: block; }
    .bar {
      padding: 10px 16px; background: #fff; border-bottom: 1px solid #e5e7eb;
      display: flex; align-items: center; gap: 12px;
      box-shadow: 0 1px 3px rgba(0,0,0,.04); z-index: 10;
    }
    .logo { display: flex; align-items: center; gap: 8px; }
    .dot {
      width: 8px; height: 8px; border-radius: 50%; background: #9ca3af; flex-shrink: 0;
    }
    .dot.ready { background: #10b981; }
    .dot.busy { background: #f59e0b; animation: pulse 1.5s infinite; }
    .dot.terminated { background: #ef4444; }
    @keyframes pulse { 0%,100%{opacity:1}50%{opacity:.4} }
    h1 { font-size: 14px; font-weight: 600; color: #374151; white-space: nowrap; }
    .status { font-size: 11px; color: #9ca3af; }
    .controls { margin-left: auto; display: flex; gap: 6px; align-items: center; }
    select, button, input {
      font-size: 12px; padding: 5px 10px; border-radius: 6px;
      border: 1px solid #e5e7eb; background: #fff; color: #374151;
      cursor: pointer; font-family: inherit; transition: all .15s;
    }
    select:hover, button:hover { background: #f3f4f6; border-color: #d1d5db; }
    input { width: 130px; cursor: text; }
    .danger { color: #ef4444; }
    .danger:hover { background: #fef2f2; border-color: #fecaca; }
    .cancel { color: #f59e0b; }
    .cancel:hover { background: #fffbeb; border-color: #fde68a; }
  `;

  render() {
    return html`
      <div class="bar">
        <div class="logo">
          <div class="dot ${this.status || ''}"></div>
          <h1>ACP Cloud</h1>
        </div>
        <span class="status">${this.status || 'connecting'}</span>
        <div class="controls">
          <input
            type="password"
            placeholder="API Key"
            .value=${this.apiKey || ''}
            @change=${this._onApiKey}
          >
          <select @change=${this._onAgent}>
            ${(this.agents || []).map(a => html`
              <option value=${a} ?selected=${a === this.selectedAgent}>${a}</option>
            `)}
          </select>
          <button @click=${this._newSession}>+ New</button>
          ${this.status === 'busy' ? html`
            <button class="cancel" @click=${this._cancel}>Cancel</button>
          ` : ''}
          <button class="danger" @click=${this._close}>Close</button>
        </div>
      </div>
    `;
  }

  _onApiKey(e) {
    this.dispatchEvent(new CustomEvent('api-key-change', {
      detail: e.target.value.trim(), bubbles: true, composed: true,
    }));
  }
  _onAgent(e) {
    this.dispatchEvent(new CustomEvent('agent-change', {
      detail: e.target.value, bubbles: true, composed: true,
    }));
  }
  _newSession() {
    this.dispatchEvent(new CustomEvent('new-session', { bubbles: true, composed: true }));
  }
  _cancel() {
    this.dispatchEvent(new CustomEvent('cancel-run', { bubbles: true, composed: true }));
  }
  _close() {
    this.dispatchEvent(new CustomEvent('close-session', { bubbles: true, composed: true }));
  }
}
customElements.define('acp-header', AcpHeader);

// ── <acp-sidebar> ────────────────────────────────────────────────────
// Left panel: list of sessions. Click to switch.
// Dispatches 'session-select' with { detail: sessionId }.

class AcpSidebar extends LitElement {
  static properties = {
    sessions: { type: Array },
    activeId: { type: String, attribute: 'active-id' },
  };

  constructor() { super(); this.sessions = []; }

  static styles = css`
    :host { display: block; width: 200px; background: #fff; border-right: 1px solid #e5e7eb;
      overflow-y: auto; flex-shrink: 0; }
    .title {
      padding: 12px 14px 8px; font-size: 11px; font-weight: 600;
      color: #9ca3af; text-transform: uppercase; letter-spacing: .5px;
    }
    .item {
      padding: 8px 14px; cursor: pointer; font-size: 13px;
      display: flex; align-items: center; gap: 8px; transition: background .15s;
    }
    .item:hover { background: #f9fafb; }
    .item.active { background: #eef2ff; color: #4f46e5; font-weight: 500; }
    .agent { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .badge {
      font-size: 9px; padding: 1px 5px; border-radius: 3px;
      background: #f3f4f6; color: #9ca3af;
    }
    .badge.ready { background: #d1fae5; color: #065f46; }
    .badge.busy { background: #fef3c7; color: #92400e; }
    .badge.terminated { background: #fee2e2; color: #991b1b; }
    .empty { padding: 14px; font-size: 12px; color: #ccc; text-align: center; }
  `;

  render() {
    return html`
      <div class="title">Sessions</div>
      ${this.sessions.length === 0
        ? html`<div class="empty">No sessions</div>`
        : this.sessions.map(s => html`
            <div
              class="item ${s.id === this.activeId ? 'active' : ''}"
              @click=${() => this._select(s.id)}
            >
              <span class="agent">${s.agentId || s.agent || '?'}</span>
              <span class="badge ${s.status || ''}">${s.status || '?'}</span>
            </div>
          `)}
    `;
  }

  _select(id) {
    this.dispatchEvent(new CustomEvent('session-select', {
      detail: id, bubbles: true, composed: true,
    }));
  }
}
customElements.define('acp-sidebar', AcpSidebar);

// ── <acp-chat> ───────────────────────────────────────────────────────
// Scrollable message list. Renders each message as the appropriate component.
// Auto-scrolls to bottom on new messages.

class AcpChat extends LitElement {
  static properties = {
    messages: { type: Array, hasChanged: () => true },
    status: { type: String },
  };

  constructor() { super(); this.messages = []; }

  static styles = css`
    :host { display: flex; flex-direction: column; flex: 1; overflow: hidden; }
    .scroll { flex: 1; overflow-y: auto; padding: 20px 16px; }
    .inner { max-width: 760px; width: 100%; margin: 0 auto;
      display: flex; flex-direction: column; gap: 12px; }
    .typing {
      display: inline-flex; gap: 4px; padding: 10px 14px;
      background: #fff; border-radius: 14px; border: 1px solid #e5e5e5;
      border-top-left-radius: 4px; box-shadow: 0 1px 2px rgba(0,0,0,.04);
    }
    .dot { width: 6px; height: 6px; border-radius: 50%; background: #d1d5db; animation: typing 1.4s infinite; }
    .dot:nth-child(2) { animation-delay: .2s; }
    .dot:nth-child(3) { animation-delay: .4s; }
    @keyframes typing { 0%,60%,100%{opacity:.3;transform:translateY(0)}30%{opacity:1;transform:translateY(-3px)} }
    ::-webkit-scrollbar { width: 5px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { background: #ddd; border-radius: 3px; }
  `;

  render() {
    const showTyping = this.status === 'busy' &&
      !this.messages.some(m => m.type === 'agent' && m.streaming);
    return html`
      <div class="scroll" id="scroll">
        <div class="inner">
          ${this.messages.map(msg => this._renderMsg(msg))}
          ${showTyping ? html`
            <div class="typing">
              <div class="dot"></div><div class="dot"></div><div class="dot"></div>
            </div>
          ` : ''}
        </div>
      </div>
    `;
  }

  _renderMsg(msg) {
    switch (msg.type) {
      case 'user':
        return html`<acp-message role="user" .text=${msg.text}></acp-message>`;
      case 'agent':
        return html`<acp-message role="agent" .text=${msg.text} ?streaming=${msg.streaming}></acp-message>`;
      case 'thinking':
        return html`<acp-thinking .text=${msg.text} ?streaming=${msg.streaming}></acp-thinking>`;
      case 'tool':
        return html`<acp-tool-call .title=${msg.title} .kind=${msg.kind} .status=${msg.status}></acp-tool-call>`;
      case 'permission':
        return html`<acp-permission
          request-id=${msg.requestId}
          .toolCall=${msg.toolCall}
          .options=${msg.options}
          ?resolved=${msg.resolved}
        ></acp-permission>`;
      case 'system':
        return html`<acp-system-notice .text=${msg.text}></acp-system-notice>`;
      default:
        return '';
    }
  }

  updated() {
    const scroll = this.renderRoot.querySelector('#scroll');
    if (scroll) {
      requestAnimationFrame(() => { scroll.scrollTop = scroll.scrollHeight; });
    }
  }
}
customElements.define('acp-chat', AcpChat);

// ── <acp-app> ────────────────────────────────────────────────────────
// Root component. Owns all state. Wires AcpClient + SSE to child components.

class AcpApp extends LitElement {
  static properties = {
    status: { type: String },
    messages: { type: Array },
    sessions: { type: Array },
    agents: { type: Array },
    _sessionId: { state: true },
    _selectedAgent: { state: true },
    _apiKey: { state: true },
  };

  constructor() {
    super();
    this.status = 'connecting';
    this.messages = [];
    this.sessions = [];
    this.agents = [];
    this._sessionId = null;
    this._selectedAgent = '';
    this._apiKey = sessionStorage.getItem('acp_token') || '';
    this._client = null;
    this._sse = null;
    this._currentAgentMsg = null;
    this._currentThinking = null;
    this._rafPending = false;
  }

  static styles = css`
    :host { display: flex; flex-direction: column; height: 100%; }
    .body { display: flex; flex: 1; overflow: hidden; }
    .main { display: flex; flex-direction: column; flex: 1; overflow: hidden; }
  `;

  connectedCallback() {
    super.connectedCallback();
    this._client = new AcpClient(location.origin, this._apiKey);
    // Listen for permission responses from child components (once, not per SSE connect)
    this.addEventListener('permission-respond', async (e) => {
      const { requestId, optionId } = e.detail;
      try {
        await this._client.respondToPermission(this._sessionId, requestId, optionId);
        const perm = this.messages.find(
          m => m.type === 'permission' && m.requestId === requestId
        );
        if (perm) perm.resolved = true;
        this._scheduleUpdate();
      } catch (err) {
        this._addSystem('Permission error: ' + err.message);
      }
    });
    this._init();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this._sse?.close();
  }

  render() {
    return html`
      <acp-header
        .agents=${this.agents}
        selected-agent=${this._selectedAgent}
        .status=${this.status}
        api-key=${this._apiKey}
        @agent-change=${e => this._selectedAgent = e.detail}
        @api-key-change=${this._onApiKeyChange}
        @new-session=${this._newSession}
        @cancel-run=${this._cancelRun}
        @close-session=${this._closeSession}
      ></acp-header>
      <div class="body">
        <acp-sidebar
          .sessions=${this.sessions}
          active-id=${this._sessionId || ''}
          @session-select=${e => this._switchSession(e.detail)}
        ></acp-sidebar>
        <div class="main">
          <acp-chat .messages=${this.messages} .status=${this.status}></acp-chat>
          <acp-input
            ?disabled=${this.status !== 'ready'}
            @send-prompt=${e => this._sendPrompt(e.detail)}
          ></acp-input>
        </div>
      </div>
    `;
  }

  // ── Lifecycle ──

  async _init() {
    try {
      const [configRes, agentsRes] = await Promise.all([
        this._client.getConfig().catch(() => ({ workspace: '' })),
        this._client.listAgents(),
      ]);
      this._workspace = configRes.workspace || '';
      this.agents = (agentsRes.agents || []).filter(a => a !== 'mock');
      if (this.agents.length > 0) {
        this._selectedAgent = this.agents.includes('pi') ? 'pi' : this.agents[0];
        await this._newSession();
      } else {
        this.status = 'terminated';
        this._addSystem('No agents available');
      }
      await this._refreshSessions();
    } catch (e) {
      this.status = 'terminated';
      this._addSystem('Connection error: ' + e.message);
    }
  }

  _onApiKeyChange(e) {
    this._apiKey = e.detail;
    if (this._apiKey) sessionStorage.setItem('acp_token', this._apiKey);
    else sessionStorage.removeItem('acp_token');
    this._client.apiKey = this._apiKey;
    this._sse?.close();
    this.messages = [];
    this._init();
  }

  // ── Session Management ──

  async _newSession() {
    this._sse?.close();
    if (this._sessionId) {
      await this._client.closeSession(this._sessionId).catch(() => {});
    }
    this._sessionId = null;
    this.messages = [];
    this.status = 'connecting';

    try {
      const info = await this._client.createSession(
        this._selectedAgent,
        this._workspace || '.',
      );
      this._sessionId = info.id;
      this._addSystem(`${this._selectedAgent} session ready`);
      this.status = 'ready';
      this._connectSSE(info.id);
      await this._refreshSessions();
    } catch (e) {
      this._addSystem('Error: ' + e.message);
      this.status = 'terminated';
    }
  }

  async _closeSession() {
    if (!this._sessionId) return;
    this._sse?.close();
    await this._client.closeSession(this._sessionId).catch(() => {});
    this._addSystem('Session closed.');
    this.status = 'terminated';
    this._sessionId = null;
    await this._refreshSessions();
  }

  async _switchSession(id) {
    if (id === this._sessionId) return;
    this._sse?.close();
    this._sessionId = id;
    this.messages = [];
    this._currentAgentMsg = null;
    this._currentThinking = null;

    try {
      const info = await this._client.getSession(id);
      this.status = info.status || 'ready';
      this._addSystem(`Switched to session ${id.slice(0, 8)}...`);
      this._connectSSE(id);
    } catch (e) {
      this._addSystem('Error: ' + e.message);
      this.status = 'terminated';
    }
  }

  async _cancelRun() {
    if (!this._sessionId) return;
    try {
      await this._client.cancelRun(this._sessionId);
    } catch (e) {
      this._addSystem('Cancel failed: ' + e.message);
    }
  }

  async _refreshSessions() {
    try {
      const list = await this._client.listSessions();
      this.sessions = Array.isArray(list) ? list : [];
    } catch { /* ignore */ }
  }

  // ── Prompt ──

  async _sendPrompt(text) {
    if (!text || !this._sessionId) return;
    this.messages = [...this.messages, { type: 'user', text }];
    try {
      await this._client.prompt(this._sessionId, text);
    } catch (e) {
      this._addSystem('Error: ' + e.message);
    }
  }

  // ── SSE ──

  _connectSSE(sessionId) {
    this._sse?.close();
    this._sse = this._client.subscribe(sessionId);

    this._sse.addEventListener('session_status_changed', e => {
      this.status = e.detail.to;
      if (e.detail.to === 'terminated') this._sse?.close();
    });

    this._sse.addEventListener('run_started', () => {
      this._currentAgentMsg = null;
      this._currentThinking = null;
      this._scheduleUpdate();
    });

    this._sse.addEventListener('agent_message_chunk', e => {
      const text = e.detail.content?.text || '';
      if (!text) return;
      if (!this._currentAgentMsg) {
        this._currentAgentMsg = { type: 'agent', text: '', streaming: true };
        this.messages.push(this._currentAgentMsg);
      }
      this._currentAgentMsg.text += text;
      this._scheduleUpdate();
    });

    this._sse.addEventListener('agent_thought_chunk', e => {
      const text = e.detail.content?.text || '';
      if (!text) return;
      if (!this._currentThinking) {
        this._currentThinking = { type: 'thinking', text: '', streaming: true };
        this.messages.push(this._currentThinking);
      }
      this._currentThinking.text += text;
      this._scheduleUpdate();
    });

    this._sse.addEventListener('tool_call', e => {
      this._finalizeStreaming();
      this.messages.push({
        type: 'tool',
        id: e.detail.toolCallId,
        title: e.detail.title || 'tool',
        kind: e.detail.kind || '',
        status: e.detail.status || 'in_progress',
      });
      this._scheduleUpdate();
    });

    this._sse.addEventListener('tool_call_update', e => {
      const tool = this.messages.find(
        m => m.type === 'tool' && m.id === e.detail.toolCallId
      );
      if (tool) tool.status = e.detail.status;
      this._scheduleUpdate();
    });

    this._sse.addEventListener('run_completed', e => {
      this._finalizeStreaming();
      if (e.detail.stopReason && e.detail.stopReason !== 'end_turn') {
        this._addSystem('Run ended: ' + e.detail.stopReason);
      }
      this.status = 'ready';
      this._scheduleUpdate();
      this._refreshSessions();
    });

    this._sse.addEventListener('run_error', e => {
      this._finalizeStreaming();
      this._addSystem('Error: ' + (e.detail.error || 'unknown'));
      this.status = 'ready';
      this._scheduleUpdate();
    });

    this._sse.addEventListener('permission_request', e => {
      this.messages.push({
        type: 'permission',
        requestId: e.detail.requestId,
        toolCall: e.detail.toolCall || {},
        options: e.detail.options || [],
        resolved: false,
      });
      this._scheduleUpdate();
    });

    this._sse.addEventListener('permission_timeout', e => {
      const perm = this.messages.find(
        m => m.type === 'permission' && m.requestId === e.detail.requestId
      );
      if (perm) { perm.resolved = true; }
      this._addSystem('Permission timed out');
      this._scheduleUpdate();
    });

    this._sse.addEventListener('error', e => {
      console.error('SSE error:', e.detail);
    });
  }

  // ── Helpers ──

  _finalizeStreaming() {
    if (this._currentAgentMsg) {
      this._currentAgentMsg.streaming = false;
      this._currentAgentMsg = null;
    }
    if (this._currentThinking) {
      this._currentThinking.streaming = false;
      this._currentThinking = null;
    }
  }

  _addSystem(text) {
    this.messages = [...this.messages, { type: 'system', text }];
  }

  /** Batch streaming updates into one render per animation frame. */
  _scheduleUpdate() {
    if (this._rafPending) return;
    this._rafPending = true;
    requestAnimationFrame(() => {
      this._rafPending = false;
      this.messages = [...this.messages];
    });
  }
}
customElements.define('acp-app', AcpApp);
