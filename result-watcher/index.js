#!/usr/bin/env node
/**
 * DreamRise Result Watcher v2
 * Polls Paperclip for completed issues, renders rich HTML reports with
 * auto-detected property links (Zillow/Redfin), and notifies Telegram.
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Config ──────────────────────────────────────────────────────────────────
const PAPERCLIP_URL        = process.env.PAPERCLIP_URL || "http://paperclip:3100";
const PAPERCLIP_PUBLIC_URL = process.env.PAPERCLIP_PUBLIC_URL || PAPERCLIP_URL;
const PAPERCLIP_COMPANY_ID = process.env.PAPERCLIP_COMPANY_ID;
const PAPERCLIP_API_KEY    = process.env.PAPERCLIP_API_KEY || "";
const TELEGRAM_BOT_TOKEN   = process.env.TELEGRAM_BOT_TOKEN;
const DEFAULT_CHAT_ID      = process.env.DEFAULT_TELEGRAM_CHAT_ID || "";
const PUBLIC_BASE_URL      = process.env.PUBLIC_BASE_URL || "http://34.57.42.63:4000";
const POLL_INTERVAL_MS     = parseInt(process.env.POLL_INTERVAL_MS || "120000");
const PORT                 = parseInt(process.env.PORT || "4000");
const STATE_FILE           = process.env.STATE_FILE || "/data/watcher-state.json";
const TELEGRAPH_TOKEN      = process.env.TELEGRAPH_TOKEN || "";

if (!PAPERCLIP_COMPANY_ID) { console.error("PAPERCLIP_COMPANY_ID required"); process.exit(1); }
if (!TELEGRAM_BOT_TOKEN)   { console.error("TELEGRAM_BOT_TOKEN required");   process.exit(1); }

// ─── State ───────────────────────────────────────────────────────────────────
function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); }
  catch { return { notified: {}, tracked: {}, reports: {} }; }
}
function saveState(s) {
  const dir = path.dirname(STATE_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}
let STATE = loadState();

// ─── Paperclip helpers ───────────────────────────────────────────────────────
const PH = { "Content-Type": "application/json", ...(PAPERCLIP_API_KEY ? { Authorization: `Bearer ${PAPERCLIP_API_KEY}` } : {}) };

async function pcFetch(p) {
  const r = await fetch(`${PAPERCLIP_URL}${p}`, { headers: PH });
  if (!r.ok) throw new Error(`Paperclip ${p} → ${r.status}`);
  return r.json();
}
async function fetchDoneIssues() {
  return pcFetch(`/api/companies/${PAPERCLIP_COMPANY_ID}/issues?status=done&limit=50`);
}
async function fetchIssueDetails(id) {
  const [issue, wp, comments] = await Promise.all([
    pcFetch(`/api/issues/${id}`),
    pcFetch(`/api/issues/${id}/work-products`).catch(() => []),
    pcFetch(`/api/issues/${id}/comments`).catch(() => []),
  ]);
  issue.workProducts = Array.isArray(wp) ? wp : (wp.workProducts || []);
  issue.comments = Array.isArray(comments) ? comments : (comments.comments || []);
  return issue;
}
async function fetchSubIssues(parentId) {
  try {
    const data = await pcFetch(`/api/companies/${PAPERCLIP_COMPANY_ID}/issues?parentId=${parentId}&limit=20`);
    return Array.isArray(data) ? data : (data.issues || data.data || []);
  } catch { return []; }
}

// ─── Markdown → HTML ─────────────────────────────────────────────────────────
function mdToHtml(md) {
  if (!md) return "";
  let html = escapeHtml(md);
  // headings
  html = html.replace(/^#### (.+)$/gm, '<h4>$1</h4>');
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');
  // bold / italic
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
  // links
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  // unordered list items
  html = html.replace(/^[\s]*[-*] (.+)$/gm, '<li>$1</li>');
  html = html.replace(/((?:<li>.*<\/li>\n?)+)/g, '<ul>$1</ul>');
  // numbered list items
  html = html.replace(/^\d+\.\s+(.+)$/gm, '<li>$1</li>');
  // code
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  // line breaks → paragraphs
  html = html.replace(/\n{2,}/g, '</p><p>');
  html = html.replace(/\n/g, '<br>');
  return `<p>${html}</p>`;
}

// ─── Address Detection ───────────────────────────────────────────────────────
const US_STATES = "AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY";
const ADDR_RE = /\d+\s+[\w\s.]+(?:St|Street|Ave|Avenue|Blvd|Boulevard|Dr|Drive|Rd|Road|Ln|Lane|Way|Ct|Court|Pl|Place|Cir|Circle)[.,]?\s+[\w\s]+,?\s*(?:AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY)\s+\d{5}/gi;

function detectAddresses(text) {
  if (!text) return [];
  const matches = text.match(ADDR_RE) || [];
  return [...new Set(matches.map(a => a.trim()))];
}

function addressLinks(addr) {
  const enc = encodeURIComponent(addr);
  return {
    address: addr,
    zillow: `https://www.zillow.com/homes/${enc}_rb/`,
    redfin: `https://www.redfin.com/search#query=${enc}`,
  };
}

// ─── Telegraph (telegra.ph) ──────────────────────────────────────────────────
function mdToTelegraphNodes(md) {
  if (!md) return [];
  const nodes = [];
  const lines = md.split("\n");
  let listItems = [];
  const flushList = () => { if (listItems.length) { nodes.push({ tag: "ul", children: listItems }); listItems = []; } };
  for (const line of lines) {
    const h3 = line.match(/^###\s+(.+)/);
    const h2 = line.match(/^##\s+(.+)/);
    const li = line.match(/^[-*]\s+(.+)/);
    const num = line.match(/^\d+\.\s+(.+)/);
    if (h3) { flushList(); nodes.push({ tag: "h4", children: [inlineFormat(h3[1])] }); }
    else if (h2) { flushList(); nodes.push({ tag: "h3", children: [inlineFormat(h2[1])] }); }
    else if (li || num) { listItems.push({ tag: "li", children: [inlineFormat((li||num)[1])] }); }
    else if (line.trim() === "") { flushList(); }
    else { flushList(); nodes.push({ tag: "p", children: [inlineFormat(line)] }); }
  }
  flushList();
  return nodes;
}
function inlineFormat(text) {
  // Bold
  const parts = [];
  let remaining = text;
  const boldRe = /\*\*(.+?)\*\*/;
  while (true) {
    const m = remaining.match(boldRe);
    if (!m) break;
    if (m.index > 0) parts.push(remaining.slice(0, m.index));
    parts.push({ tag: "strong", children: [m[1]] });
    remaining = remaining.slice(m.index + m[0].length);
  }
  if (remaining) parts.push(remaining);
  return parts.length === 1 && typeof parts[0] === "string" ? parts[0] : { tag: "span", children: parts.length ? parts : [text] };
}

async function publishToTelegraph(issue, subIssues = []) {
  if (!TELEGRAPH_TOKEN) return null;
  const content = [];
  // Status + meta
  content.push({ tag: "p", children: [{ tag: "em", children: [`✅ Completed | ${issue.priority || "normal"} priority | ${new Date(issue.updatedAt).toLocaleString()}`] }] });
  // Description
  if (issue.description) {
    content.push({ tag: "h3", children: ["Task Description"] });
    content.push(...mdToTelegraphNodes(issue.description));
  }
  // Property links
  const allText = [issue.description, ...(issue.comments||[]).map(c=>c.body), ...(subIssues.flatMap(s=>(s.comments||[]).map(c=>c.body)))].join("\n");
  const addrs = detectAddresses(allText);
  if (addrs.length) {
    content.push({ tag: "h3", children: [`🏠 Property Links (${addrs.length})`] });
    for (const a of addrs) {
      const l = addressLinks(a);
      content.push({ tag: "p", children: [
        { tag: "strong", children: [a] }, " — ",
        { tag: "a", attrs: { href: l.zillow }, children: ["Zillow"] }, " | ",
        { tag: "a", attrs: { href: l.redfin }, children: ["Redfin"] },
      ]});
    }
  }
  // Comments
  const comments = issue.comments || [];
  if (comments.length) {
    content.push({ tag: "h3", children: ["Agent Activity"] });
    for (const c of comments) content.push(...mdToTelegraphNodes(c.body));
  }
  // Sub-issues
  for (const sub of subIssues) {
    content.push({ tag: "h3", children: [`Sub-Task: ${sub.title}`] });
    for (const c of (sub.comments||[])) content.push(...mdToTelegraphNodes(c.body));
  }
  // Footer
  content.push({ tag: "p", children: [{ tag: "em", children: ["Generated by DreamRise Agent"] }] });

  try {
    const res = await fetch("https://api.telegra.ph/createPage", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        access_token: TELEGRAPH_TOKEN,
        title: issue.title.slice(0, 256),
        author_name: "DreamRise Agent",
        author_url: "https://t.me/dream_rise_claw_bot",
        content,
        return_content: false,
      }),
    });
    const data = await res.json();
    if (data.ok) { console.log(`[telegraph] Published: ${data.result.url}`); return data.result.url; }
    console.error("[telegraph] Error:", data.error);
    return null;
  } catch (err) { console.error("[telegraph]", err.message); return null; }
}

// ─── Telegram ────────────────────────────────────────────────────────────────
async function tgSend(method, body) {
  const r = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  return r.json();
}
function escMd(t) { return (t||"").replace(/[_*[\]()~`>#+\-=|{}.!]/g, "\\$&"); }

async function sendTelegramResult(chatId, issue, reportUrl, telegraphUrl) {
  const viewUrl = telegraphUrl || reportUrl;
  const text = [
    `✅ *Task Completed\\!*`, ``,
    `📋 *${escMd(issue.title)}*`, ``,
    telegraphUrl ? `📖 [Read Report](${telegraphUrl})` : `🔗 [View Full Report](${reportUrl})`,
  ].join("\n");
  const buttons = [
    { text: telegraphUrl ? "📖 Read Report" : "📄 View Report", url: viewUrl },
  ];
  if (telegraphUrl) buttons.push({ text: "📊 Full Web Report", url: reportUrl });
  buttons.push({ text: "🏢 Open Paperclip", url: PAPERCLIP_PUBLIC_URL });
  return tgSend("sendMessage", {
    chat_id: chatId, text, parse_mode: "MarkdownV2",
    reply_markup: { inline_keyboard: [buttons] },
  });
}

// ─── HTML helpers ────────────────────────────────────────────────────────────
function escapeHtml(t) {
  return String(t||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

// ─── Report HTML ─────────────────────────────────────────────────────────────
function generateReportHtml(issue, subIssues = []) {
  const comments = issue.comments || [];
  const allText = [issue.description, ...comments.map(c=>c.body)].join("\n");
  const addresses = detectAddresses(allText);

  // Also scan sub-issue comments for addresses
  for (const sub of subIssues) {
    for (const c of (sub.comments || [])) {
      detectAddresses(c.body).forEach(a => { if (!addresses.includes(a)) addresses.push(a); });
    }
  }

  const propCards = addresses.map(a => {
    const l = addressLinks(a);
    return `<div class="prop-card">
      <div class="prop-addr">🏠 ${escapeHtml(a)}</div>
      <div class="prop-links">
        <a href="${l.zillow}" target="_blank" class="btn zillow">Zillow</a>
        <a href="${l.redfin}" target="_blank" class="btn redfin">Redfin</a>
      </div>
    </div>`;
  }).join("");

  const commentCards = comments.map(c => `
    <div class="comment-card">
      <div class="comment-meta">
        <span class="comment-author">🤖 ${escapeHtml(c.authorName||"Agent")}</span>
        <span class="comment-time">${new Date(c.createdAt).toLocaleString()}</span>
      </div>
      <div class="comment-body">${mdToHtml(c.body)}</div>
    </div>`).join("");

  const subCards = subIssues.map(sub => {
    const subComments = (sub.comments||[]).map(c =>
      `<div class="sub-comment">${mdToHtml(c.body)}</div>`
    ).join("");
    return `<div class="card sub-issue">
      <div class="card-header">
        <span class="badge ${sub.status==='done'?'done':'progress'}">${sub.status}</span>
        <h3>${escapeHtml(sub.title)}</h3>
      </div>
      ${subComments || '<p class="muted">No agent output yet.</p>'}
    </div>`;
  }).join("");

  const priorityColor = {high:"#ef4444",medium:"#f59e0b",low:"#10b981",urgent:"#dc2626"}[issue.priority]||"#6b7280";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>${escapeHtml(issue.title)} — DreamRise Report</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet">
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{--bg:#0a0a0f;--card:rgba(255,255,255,0.04);--card-h:rgba(255,255,255,0.07);--border:rgba(255,255,255,0.08);--glow:rgba(99,102,241,0.4);--t1:#f1f5f9;--t2:#94a3b8;--t3:#475569;--accent:#6366f1;--accent-l:#818cf8;--ok:#10b981;--warn:#f59e0b;--err:#ef4444}
body{font-family:'Inter',system-ui,sans-serif;background:var(--bg);color:var(--t1);min-height:100vh;line-height:1.6;background-image:radial-gradient(ellipse at 20% 50%,rgba(99,102,241,.08) 0%,transparent 50%),radial-gradient(ellipse at 80% 20%,rgba(139,92,246,.06) 0%,transparent 50%)}
.hero{background:linear-gradient(135deg,rgba(99,102,241,.15),rgba(139,92,246,.1) 50%,rgba(16,185,129,.05));border-bottom:1px solid var(--border);padding:3rem 2rem 2.5rem;position:relative;overflow:hidden}
.hero::before{content:'';position:absolute;top:-50%;left:-10%;width:120%;height:200%;background:radial-gradient(ellipse,rgba(99,102,241,.1),transparent 60%);pointer-events:none}
.hero-inner{max-width:900px;margin:0 auto;position:relative}
.brand{display:flex;align-items:center;gap:.75rem;margin-bottom:2rem}
.brand-logo{width:36px;height:36px;background:linear-gradient(135deg,var(--accent),#8b5cf6);border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:18px}
.brand-name{font-size:1rem;font-weight:600;color:var(--t2);letter-spacing:.05em}
.chips{display:flex;gap:.75rem;margin-bottom:1rem;flex-wrap:wrap}
.chip{padding:.3rem .85rem;border-radius:99px;font-size:.75rem;font-weight:600;letter-spacing:.05em;text-transform:uppercase}
.chip.done{background:rgba(16,185,129,.15);color:var(--ok);border:1px solid rgba(16,185,129,.3)}
.chip.pri{background:rgba(239,68,68,.12);color:${priorityColor};border:1px solid rgba(239,68,68,.25)}
h1.title{font-size:clamp(1.5rem,4vw,2.5rem);font-weight:700;line-height:1.2;background:linear-gradient(135deg,#f1f5f9,#94a3b8);-webkit-background-clip:text;-webkit-text-fill-color:transparent;margin-bottom:1rem}
.meta{display:flex;gap:2rem;flex-wrap:wrap;color:var(--t3);font-size:.85rem}
.container{max-width:900px;margin:0 auto;padding:2.5rem 2rem}
.section{margin-bottom:2.5rem}
.sec-title{font-size:.75rem;font-weight:600;letter-spacing:.1em;text-transform:uppercase;color:var(--t3);margin-bottom:1.25rem;display:flex;align-items:center;gap:.5rem}
.sec-title::after{content:'';flex:1;height:1px;background:var(--border)}
.card{background:var(--card);border:1px solid var(--border);border-radius:14px;padding:1.5rem;margin-bottom:1rem;backdrop-filter:blur(10px);transition:border-color .2s,background .2s}
.card:hover{background:var(--card-h);border-color:rgba(255,255,255,.12)}
.card-header{display:flex;gap:.5rem;margin-bottom:.75rem;flex-wrap:wrap;align-items:center}
.badge{padding:.2rem .65rem;border-radius:99px;font-size:.7rem;font-weight:600;text-transform:uppercase}
.badge.done{background:rgba(16,185,129,.12);color:#34d399}
.badge.progress{background:rgba(245,158,11,.12);color:#fbbf24}
.card h3{font-size:1.05rem;font-weight:600;color:var(--t1)}
.desc-box{background:var(--card);border:1px solid var(--border);border-radius:14px;padding:1.5rem;color:var(--t2);font-size:.95rem;line-height:1.7}
.desc-box h1,.desc-box h2,.desc-box h3,.desc-box h4{color:var(--t1);margin:1rem 0 .5rem}
.desc-box ul{margin:.5rem 0 .5rem 1.5rem}
.desc-box li{margin-bottom:.3rem}
.desc-box strong{color:var(--t1)}
.desc-box a{color:var(--accent-l);text-decoration:none}
.desc-box a:hover{text-decoration:underline}
.desc-box code{background:rgba(255,255,255,.08);padding:.1rem .4rem;border-radius:4px;font-size:.85em}
.prop-card{background:linear-gradient(135deg,rgba(16,185,129,.08),rgba(99,102,241,.06));border:1px solid rgba(16,185,129,.2);border-radius:12px;padding:1.25rem;margin-bottom:.75rem;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:.75rem}
.prop-addr{font-weight:600;color:var(--t1);font-size:.95rem}
.prop-links{display:flex;gap:.5rem}
.btn{padding:.4rem 1rem;border-radius:8px;font-size:.8rem;font-weight:600;text-decoration:none;transition:transform .15s,box-shadow .15s}
.btn:hover{transform:translateY(-1px);box-shadow:0 4px 12px rgba(0,0,0,.3)}
.btn.zillow{background:linear-gradient(135deg,#006AFF,#0050cc);color:#fff}
.btn.redfin{background:linear-gradient(135deg,#A02021,#8a1a1b);color:#fff}
.comment-card{border-left:3px solid var(--accent);background:var(--card);border-radius:0 12px 12px 0;padding:1.25rem;margin-bottom:1rem}
.comment-meta{display:flex;gap:1rem;margin-bottom:.5rem;font-size:.8rem}
.comment-author{color:var(--accent-l);font-weight:600}
.comment-time{color:var(--t3)}
.comment-body{color:var(--t2);font-size:.9rem;line-height:1.7}
.comment-body h1,.comment-body h2,.comment-body h3,.comment-body h4{color:var(--t1);margin:1rem 0 .5rem}
.comment-body ul{margin:.5rem 0 .5rem 1.5rem}
.comment-body li{margin-bottom:.25rem}
.comment-body strong{color:var(--t1)}
.sub-comment{color:var(--t2);font-size:.9rem;line-height:1.7;margin-top:.75rem}
.sub-comment h1,.sub-comment h2,.sub-comment h3,.sub-comment h4{color:var(--t1);margin:.75rem 0 .4rem}
.sub-comment ul{margin:.5rem 0 .5rem 1.5rem}
.sub-comment strong{color:var(--t1)}
.muted{color:var(--t3);font-size:.9rem}
.empty{text-align:center;padding:2.5rem;color:var(--t3);font-size:.9rem}
.footer{border-top:1px solid var(--border);padding:2rem;text-align:center;color:var(--t3);font-size:.8rem}
.footer a{color:var(--accent-l);text-decoration:none}
@media(max-width:600px){.hero{padding:2rem 1.25rem}.container{padding:1.5rem 1.25rem}.prop-card{flex-direction:column;align-items:flex-start}}
</style>
</head>
<body>
<div class="hero"><div class="hero-inner">
  <div class="brand"><div class="brand-logo">🌅</div><span class="brand-name">DreamRise · Agent Report</span></div>
  <div class="chips"><span class="chip done">✅ Done</span><span class="chip pri">${issue.priority||"normal"} priority</span></div>
  <h1 class="title">${escapeHtml(issue.title)}</h1>
  <div class="meta">
    <span>📅 Created: ${new Date(issue.createdAt).toLocaleString()}</span>
    <span>✅ Completed: ${new Date(issue.updatedAt).toLocaleString()}</span>
  </div>
</div></div>

<div class="container">
  ${issue.description ? `<div class="section"><div class="sec-title">📝 Task Description</div><div class="desc-box">${mdToHtml(issue.description)}</div></div>` : ""}

  ${addresses.length > 0 ? `<div class="section"><div class="sec-title">🏠 Property Links (${addresses.length})</div>${propCards}</div>` : ""}

  ${comments.length > 0 ? `<div class="section"><div class="sec-title">💬 Agent Activity (${comments.length})</div>${commentCards}</div>` : ""}

  ${subIssues.length > 0 ? `<div class="section"><div class="sec-title">📦 Sub-Tasks (${subIssues.length})</div>${subCards}</div>` : ""}
</div>

<div class="footer">Generated by <a href="${PAPERCLIP_PUBLIC_URL}" target="_blank">DreamRise Paperclip</a> · <a href="https://t.me/dream_rise_claw_bot" target="_blank">@dream_rise_claw_bot</a></div>
</body></html>`;
}

// ─── HTTP Server ─────────────────────────────────────────────────────────────
function readBody(req) {
  return new Promise((resolve, reject) => {
    let d = ""; req.on("data", c => d += c);
    req.on("end", () => { try { resolve(JSON.parse(d)); } catch { resolve({}); } });
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");

  if (url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true, tracked: Object.keys(STATE.tracked).length }));
  }

  if (url.pathname === "/track" && req.method === "POST") {
    const { issueId, chatId, title } = await readBody(req);
    if (!issueId || !chatId) { res.writeHead(400); return res.end('{"error":"issueId and chatId required"}'); }
    STATE.tracked[issueId] = { chatId: String(chatId), title, trackedAt: Date.now() };
    saveState(STATE);
    console.log(`[track] Issue ${issueId} → chat ${chatId} (${title})`);
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end('{"ok":true}');
  }

  const m = url.pathname.match(/^\/report\/([a-zA-Z0-9-]+)$/);
  if (m) {
    const id = m[1];
    if (STATE.reports[id]) { res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); return res.end(STATE.reports[id]); }
    try {
      const issue = await fetchIssueDetails(id);
      const subs = await fetchSubIssues(id);
      for (const s of subs) { try { const d = await fetchIssueDetails(s.id); s.comments = d.comments; } catch {} }
      const html = generateReportHtml(issue, subs);
      STATE.reports[id] = html; saveState(STATE);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); return res.end(html);
    } catch (err) {
      res.writeHead(404, { "Content-Type": "text/html" });
      return res.end(`<html><body style="font-family:sans-serif;padding:2rem;background:#0a0a0f;color:#94a3b8"><h1 style="color:#f1f5f9">Report not found</h1><p>${escapeHtml(err.message)}</p></body></html>`);
    }
  }

  res.writeHead(404); res.end('{"error":"Not found"}');
});

server.listen(PORT, "0.0.0.0", () => console.log(`[result-watcher] HTTP on http://0.0.0.0:${PORT}`));

// ─── Poller ──────────────────────────────────────────────────────────────────
async function poll() {
  try {
    const data = await fetchDoneIssues();
    const issues = Array.isArray(data) ? data : (data.issues || data.data || []);
    for (const issue of issues) {
      if (STATE.notified[issue.id]) continue;
      let chatId = STATE.tracked[issue.id]?.chatId || DEFAULT_CHAT_ID;
      if (!chatId) continue;

      console.log(`[poll] Done: ${issue.id} "${issue.title}" → chat ${chatId}`);
      try {
        const full = await fetchIssueDetails(issue.id).catch(() => issue);
        const subs = await fetchSubIssues(issue.id);
        for (const s of subs) { try { const d = await fetchIssueDetails(s.id); s.comments = d.comments; } catch {} }
        const html = generateReportHtml(full, subs);
        STATE.reports[issue.id] = html;
        const reportUrl = `${PUBLIC_BASE_URL}/report/${issue.id}`;
        const telegraphUrl = await publishToTelegraph(full, subs);
        const tg = await sendTelegramResult(chatId, full, reportUrl, telegraphUrl);
        if (tg.ok) console.log(`[poll] ✅ Notified chat ${chatId} (telegraph: ${telegraphUrl || 'n/a'})`);
        else console.error(`[poll] ⚠️ TG error:`, tg.description);
        STATE.notified[issue.id] = { at: Date.now(), chatId, telegraphUrl };
        saveState(STATE);
      } catch (err) { console.error(`[poll] ❌ ${issue.id}:`, err.message); }
    }
  } catch (err) { console.error("[poll] ❌ fetch failed:", err.message); }
}

poll();
setInterval(poll, POLL_INTERVAL_MS);
console.log(`[result-watcher] Polling every ${POLL_INTERVAL_MS/1000}s`);
