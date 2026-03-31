// examples/acp-components.js
// Lit web components for ACP Cloud Runtime Web UI.
// Depends on: lit (CDN), marked (global), hljs (global), ./acp-client.js

import { LitElement, html, css } from 'https://cdn.jsdelivr.net/npm/lit@3/+esm';

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
