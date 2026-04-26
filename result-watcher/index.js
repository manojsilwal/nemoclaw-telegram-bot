#!/usr/bin/env node
/**
 * DreamRise Result Watcher
 * ─────────────────────────────────────────────────────────────────────────────
 * Polls Paperclip for newly-completed issues, generates a beautiful HTML report
 * page for each one, and sends a notification back to the originating Telegram
 * chat via the Bot API.
 *
 * Endpoints served:
 *   GET  /report/:issueId   → Beautiful HTML result report
 *   POST /track             → Register { issueId, chatId, title } for callbacks
 *   GET  /health            → { ok: true }
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Config ──────────────────────────────────────────────────────────────────
const PAPERCLIP_URL   = process.env.PAPERCLIP_URL    || "http://paperclip:3100";
const PAPERCLIP_COMPANY_ID = process.env.PAPERCLIP_COMPANY_ID;
const PAPERCLIP_API_KEY    = process.env.PAPERCLIP_API_KEY || "";
const TELEGRAM_BOT_TOKEN   = process.env.TELEGRAM_BOT_TOKEN;
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || "http://34.71.253.221:4000";
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || "30000");
const PORT = parseInt(process.env.PORT || "4000");
const STATE_FILE = process.env.STATE_FILE || "/data/watcher-state.json";

if (!PAPERCLIP_COMPANY_ID) { console.error("PAPERCLIP_COMPANY_ID is required"); process.exit(1); }
if (!TELEGRAM_BOT_TOKEN)   { console.error("TELEGRAM_BOT_TOKEN is required");   process.exit(1); }

// ─── State (persisted to disk) ───────────────────────────────────────────────
function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return { notified: {}, tracked: {}, reports: {} };
  }
}
function saveState(state) {
  const dir = path.dirname(STATE_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

let STATE = loadState();

// ─── Paperclip API helpers ────────────────────────────────────────────────────
const paperclipHeaders = {
  "Content-Type": "application/json",
  ...(PAPERCLIP_API_KEY ? { "Authorization": `Bearer ${PAPERCLIP_API_KEY}` } : {}),
};

async function paperclipFetch(path, opts = {}) {
  const res = await fetch(`${PAPERCLIP_URL}${path}`, {
    ...opts,
    headers: { ...paperclipHeaders, ...(opts.headers || {}) },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Paperclip ${opts.method || "GET"} ${path} → ${res.status}: ${text}`);
  }
  return res.json();
}

async function fetchDoneIssues() {
  return paperclipFetch(`/api/companies/${PAPERCLIP_COMPANY_ID}/issues?status=done&limit=50`);
}

async function fetchIssueDetails(issueId) {
  const [issue, workProducts, comments] = await Promise.all([
    paperclipFetch(`/api/issues/${issueId}`),
    paperclipFetch(`/api/issues/${issueId}/work-products`).catch(() => []),
    paperclipFetch(`/api/issues/${issueId}/comments`).catch(() => []),
  ]);
  issue.workProducts = Array.isArray(workProducts) ? workProducts : (workProducts.workProducts || []);
  issue.comments = Array.isArray(comments) ? comments : (comments.comments || []);
  return issue;
}

// ─── Telegram API helper ──────────────────────────────────────────────────────
async function telegramRequest(method, body) {
  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function sendTelegramResult(chatId, issue, reportUrl) {
  const workProducts = issue.workProducts || [];
  const primaryProduct = workProducts.find(wp => wp.isPrimary) || workProducts[0];
  const summary = primaryProduct?.summary || issue.description || "Task completed successfully.";

  // Truncate summary for Telegram
  const shortSummary = summary.length > 600 ? summary.slice(0, 600) + "…" : summary;

  const text = [
    `✅ *Task Completed!*`,
    ``,
    `📋 *${escapeMarkdown(issue.title)}*`,
    ``,
    shortSummary,
    ``,
    `🔗 [View Full Report](${reportUrl})`,
    `📊 [Open in Paperclip](${PAPERCLIP_URL})`,
  ].join("\n");

  return telegramRequest("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "Markdown",
    reply_markup: {
      inline_keyboard: [[
        { text: "📄 View Full Report", url: reportUrl },
        { text: "🏢 Open Paperclip", url: `${process.env.PAPERCLIP_PUBLIC_URL || PAPERCLIP_URL}` },
      ]],
    },
  });
}

function escapeMarkdown(text) {
  return (text || "").replace(/[_*[\]()~`>#+\-=|{}.!]/g, "\\$&");
}

// ─── Report HTML Generator ───────────────────────────────────────────────────
function generateReportHtml(issue) {
  const workProducts = issue.workProducts || [];
  const comments = issue.comments || [];
  const createdAt = new Date(issue.createdAt).toLocaleString();
  const updatedAt = new Date(issue.updatedAt).toLocaleString();

  const priorityColor = { high: "#ef4444", medium: "#f59e0b", low: "#10b981", urgent: "#dc2626" }[issue.priority] || "#6b7280";
  const priorityEmoji = { high: "🔴", medium: "🟡", low: "🟢", urgent: "🚨" }[issue.priority] || "⚪";

  const workProductCards = workProducts.map(wp => `
    <div class="card work-product ${wp.isPrimary ? 'primary' : ''}">
      <div class="card-header">
        <span class="badge ${wp.type}">${wp.type}</span>
        ${wp.isPrimary ? '<span class="badge primary-badge">⭐ Primary</span>' : ""}
        <span class="badge status-badge">${wp.status}</span>
      </div>
      <h3>${escapeHtml(wp.title)}</h3>
      ${wp.summary ? `<p class="summary">${escapeHtml(wp.summary)}</p>` : ""}
      ${wp.url ? `<a href="${escapeHtml(wp.url)}" target="_blank" class="view-link">View →</a>` : ""}
    </div>
  `).join("");

  const commentCards = comments.slice(0, 10).map(c => `
    <div class="comment">
      <div class="comment-meta">
        <span class="comment-author">${escapeHtml(c.authorName || "Agent")}</span>
        <span class="comment-time">${new Date(c.createdAt).toLocaleString()}</span>
      </div>
      <p>${escapeHtml(c.body || "")}</p>
    </div>
  `).join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(issue.title)} — DreamRise Report</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet">
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    
    :root {
      --bg: #0a0a0f;
      --bg-card: rgba(255,255,255,0.04);
      --bg-card-hover: rgba(255,255,255,0.07);
      --border: rgba(255,255,255,0.08);
      --border-glow: rgba(99,102,241,0.4);
      --text-primary: #f1f5f9;
      --text-secondary: #94a3b8;
      --text-muted: #475569;
      --accent: #6366f1;
      --accent-light: #818cf8;
      --success: #10b981;
      --warning: #f59e0b;
      --danger: #ef4444;
    }

    body {
      font-family: 'Inter', system-ui, sans-serif;
      background: var(--bg);
      color: var(--text-primary);
      min-height: 100vh;
      line-height: 1.6;
      background-image: radial-gradient(ellipse at 20% 50%, rgba(99,102,241,0.08) 0%, transparent 50%),
                        radial-gradient(ellipse at 80% 20%, rgba(139,92,246,0.06) 0%, transparent 50%);
    }

    .hero {
      background: linear-gradient(135deg, rgba(99,102,241,0.15) 0%, rgba(139,92,246,0.1) 50%, rgba(16,185,129,0.05) 100%);
      border-bottom: 1px solid var(--border);
      padding: 3rem 2rem 2.5rem;
      position: relative;
      overflow: hidden;
    }
    .hero::before {
      content: '';
      position: absolute;
      top: -50%;
      left: -10%;
      width: 120%;
      height: 200%;
      background: radial-gradient(ellipse, rgba(99,102,241,0.1) 0%, transparent 60%);
      pointer-events: none;
    }
    .hero-inner { max-width: 900px; margin: 0 auto; position: relative; }

    .brand {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      margin-bottom: 2rem;
    }
    .brand-logo {
      width: 36px; height: 36px;
      background: linear-gradient(135deg, var(--accent), #8b5cf6);
      border-radius: 10px;
      display: flex; align-items: center; justify-content: center;
      font-size: 18px;
    }
    .brand-name { font-size: 1rem; font-weight: 600; color: var(--text-secondary); letter-spacing: 0.05em; }

    .issue-status-row {
      display: flex; align-items: center; gap: 0.75rem; margin-bottom: 1rem; flex-wrap: wrap;
    }
    .status-chip {
      padding: 0.3rem 0.85rem;
      border-radius: 99px;
      font-size: 0.75rem;
      font-weight: 600;
      letter-spacing: 0.05em;
      text-transform: uppercase;
      background: rgba(16,185,129,0.15);
      color: var(--success);
      border: 1px solid rgba(16,185,129,0.3);
    }
    .priority-chip {
      padding: 0.3rem 0.85rem;
      border-radius: 99px;
      font-size: 0.75rem;
      font-weight: 600;
      background: rgba(239,68,68,0.12);
      color: ${priorityColor};
      border: 1px solid rgba(239,68,68,0.25);
    }

    h1.issue-title {
      font-size: clamp(1.5rem, 4vw, 2.5rem);
      font-weight: 700;
      line-height: 1.2;
      background: linear-gradient(135deg, #f1f5f9 0%, #94a3b8 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      margin-bottom: 1rem;
    }

    .meta-row {
      display: flex; gap: 2rem; flex-wrap: wrap; color: var(--text-muted); font-size: 0.85rem;
    }
    .meta-item { display: flex; align-items: center; gap: 0.4rem; }

    .container { max-width: 900px; margin: 0 auto; padding: 2.5rem 2rem; }

    .section { margin-bottom: 2.5rem; }
    .section-title {
      font-size: 0.75rem;
      font-weight: 600;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      color: var(--text-muted);
      margin-bottom: 1.25rem;
      display: flex; align-items: center; gap: 0.5rem;
    }
    .section-title::after {
      content: '';
      flex: 1;
      height: 1px;
      background: var(--border);
    }

    .card {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 14px;
      padding: 1.5rem;
      margin-bottom: 1rem;
      transition: border-color 0.2s, background 0.2s;
      backdrop-filter: blur(10px);
    }
    .card:hover { background: var(--bg-card-hover); border-color: rgba(255,255,255,0.12); }
    .card.primary { border-color: var(--border-glow); box-shadow: 0 0 0 1px rgba(99,102,241,0.1) inset; }

    .card-header { display: flex; gap: 0.5rem; margin-bottom: 0.75rem; flex-wrap: wrap; align-items: center; }
    
    .badge {
      padding: 0.2rem 0.65rem;
      border-radius: 99px;
      font-size: 0.7rem;
      font-weight: 600;
      letter-spacing: 0.03em;
      text-transform: uppercase;
    }
    .badge.document { background: rgba(99,102,241,0.15); color: var(--accent-light); }
    .badge.code { background: rgba(16,185,129,0.12); color: #34d399; }
    .badge.primary-badge { background: rgba(245,158,11,0.12); color: #fbbf24; }
    .badge.status-badge { background: rgba(255,255,255,0.06); color: var(--text-secondary); }

    .card h3 { font-size: 1.05rem; font-weight: 600; color: var(--text-primary); margin-bottom: 0.5rem; }
    .card .summary { color: var(--text-secondary); font-size: 0.9rem; line-height: 1.6; margin-bottom: 0.75rem; }
    .view-link {
      font-size: 0.85rem;
      color: var(--accent-light);
      text-decoration: none;
      font-weight: 500;
    }
    .view-link:hover { text-decoration: underline; }

    .description-box {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 14px;
      padding: 1.5rem;
      color: var(--text-secondary);
      font-size: 0.95rem;
      line-height: 1.7;
      white-space: pre-wrap;
    }

    .comment {
      border-left: 2px solid var(--border);
      padding: 0.75rem 1.25rem;
      margin-bottom: 1rem;
    }
    .comment-meta { display: flex; gap: 1rem; margin-bottom: 0.4rem; font-size: 0.8rem; }
    .comment-author { color: var(--accent-light); font-weight: 600; }
    .comment-time { color: var(--text-muted); }
    .comment p { color: var(--text-secondary); font-size: 0.9rem; }

    .empty-state {
      text-align: center;
      padding: 2.5rem;
      color: var(--text-muted);
      font-size: 0.9rem;
    }

    .footer {
      border-top: 1px solid var(--border);
      padding: 2rem;
      text-align: center;
      color: var(--text-muted);
      font-size: 0.8rem;
    }
    .footer a { color: var(--accent-light); text-decoration: none; }

    @media (max-width: 600px) {
      .hero { padding: 2rem 1.25rem 1.75rem; }
      .container { padding: 1.5rem 1.25rem; }
      .meta-row { gap: 1rem; }
    }
  </style>
</head>
<body>
  <div class="hero">
    <div class="hero-inner">
      <div class="brand">
        <div class="brand-logo">🌅</div>
        <span class="brand-name">DreamRise · Agent Report</span>
      </div>

      <div class="issue-status-row">
        <span class="status-chip">✅ Done</span>
        <span class="priority-chip">${priorityEmoji} ${issue.priority || "normal"} priority</span>
      </div>

      <h1 class="issue-title">${escapeHtml(issue.title)}</h1>

      <div class="meta-row">
        <span class="meta-item">📅 Created: ${createdAt}</span>
        <span class="meta-item">✅ Completed: ${updatedAt}</span>
        ${issue.assigneeAgentId ? `<span class="meta-item">🤖 Assigned to CEO</span>` : ""}
      </div>
    </div>
  </div>

  <div class="container">
    ${issue.description ? `
    <div class="section">
      <div class="section-title">📝 Task Description</div>
      <div class="description-box">${escapeHtml(issue.description)}</div>
    </div>` : ""}

    <div class="section">
      <div class="section-title">📦 Work Products (${workProducts.length})</div>
      ${workProducts.length > 0 ? workProductCards : '<div class="empty-state">No work products recorded yet.</div>'}
    </div>

    ${comments.length > 0 ? `
    <div class="section">
      <div class="section-title">💬 Agent Activity</div>
      ${commentCards}
    </div>` : ""}
  </div>

  <div class="footer">
    Generated by <a href="http://34.71.253.221:3100" target="_blank">DreamRise Paperclip</a> · 
    <a href="https://t.me/dream_rise_claw_bot" target="_blank">@dream_rise_claw_bot</a>
  </div>
</body>
</html>`;
}

function escapeHtml(text) {
  return String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ─── HTTP Server ──────────────────────────────────────────────────────────────
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", chunk => data += chunk);
    req.on("end", () => {
      try { resolve(JSON.parse(data)); }
      catch { resolve({}); }
    });
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost`);

  // Health check
  if (url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true, tracked: Object.keys(STATE.tracked).length }));
  }

  // Register a chat_id tracking entry for an issue
  if (url.pathname === "/track" && req.method === "POST") {
    const body = await readBody(req);
    const { issueId, chatId, title } = body;
    if (!issueId || !chatId) {
      res.writeHead(400, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "issueId and chatId are required" }));
    }
    STATE.tracked[issueId] = { chatId: String(chatId), title, trackedAt: Date.now() };
    saveState(STATE);
    console.log(`[track] Issue ${issueId} → chat ${chatId} (${title})`);
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true }));
  }

  // Serve a cached/generated report
  const reportMatch = url.pathname.match(/^\/report\/([a-zA-Z0-9-]+)$/);
  if (reportMatch) {
    const issueId = reportMatch[1];
    // Serve from cache if available
    if (STATE.reports[issueId]) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(STATE.reports[issueId]);
    }
    // Fetch live from Paperclip
    try {
      const issue = await fetchIssueDetails(issueId);
      const html = generateReportHtml(issue);
      STATE.reports[issueId] = html;
      saveState(STATE);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(html);
    } catch (err) {
      res.writeHead(404, { "Content-Type": "text/html" });
      return res.end(`<html><body style="font-family:sans-serif;padding:2rem;background:#0a0a0f;color:#94a3b8">
        <h1 style="color:#f1f5f9">Report not found</h1>
        <p>Issue <code>${escapeHtml(issueId)}</code> could not be loaded. ${escapeHtml(err.message)}</p>
      </body></html>`);
    }
  }

  // 404
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not found" }));
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[result-watcher] HTTP server listening on http://0.0.0.0:${PORT}`);
});

// ─── Poller ───────────────────────────────────────────────────────────────────
async function poll() {
  try {
    const data = await fetchDoneIssues();
    const issues = Array.isArray(data) ? data : (data.issues || data.data || []);

    for (const issue of issues) {
      const issueId = issue.id;

      // Skip if already notified
      if (STATE.notified[issueId]) continue;

      // Check if we're tracking this issue (have a chat to notify)
      const tracked = STATE.tracked[issueId];
      if (!tracked) {
        // Auto-track to a default chat if configured, otherwise skip
        const defaultChatId = process.env.DEFAULT_TELEGRAM_CHAT_ID;
        if (!defaultChatId) continue;
        STATE.tracked[issueId] = { chatId: defaultChatId, title: issue.title, trackedAt: Date.now() };
      }

      const chatId = STATE.tracked[issueId].chatId;
      console.log(`[poll] Issue done: ${issueId} "${issue.title}" → chat ${chatId}`);

      try {
        // Fetch full details to get work products
        const fullIssue = await fetchIssueDetails(issueId).catch(() => issue);

        // Generate and cache the report
        const html = generateReportHtml(fullIssue);
        STATE.reports[issueId] = html;

        const reportUrl = `${PUBLIC_BASE_URL}/report/${issueId}`;

        // Send Telegram notification
        const tgRes = await sendTelegramResult(chatId, fullIssue, reportUrl);
        if (tgRes.ok) {
          console.log(`[poll] ✅ Notified chat ${chatId} for issue ${issueId}`);
        } else {
          console.error(`[poll] ⚠️ Telegram error for ${issueId}:`, tgRes.description);
        }

        STATE.notified[issueId] = { at: Date.now(), chatId };
        saveState(STATE);
      } catch (err) {
        console.error(`[poll] ❌ Error processing issue ${issueId}:`, err.message);
      }
    }
  } catch (err) {
    console.error("[poll] ❌ Paperclip fetch failed:", err.message);
  }
}

// Initial poll + interval
poll();
setInterval(poll, POLL_INTERVAL_MS);
console.log(`[result-watcher] Polling Paperclip every ${POLL_INTERVAL_MS / 1000}s for completed issues`);
