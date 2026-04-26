---
name: paperclip
description: >
  Send work tasks to the Paperclip company's CEO agent, who will break them
  down and delegate to the right workers. Use this whenever the user asks you
  to "assign a task", "tell the team", "have the company work on", or any
  request that should be handled by the Paperclip org chart rather than by
  you directly.
---

# Paperclip Skill

You have access to a Paperclip company management platform running at
`${PAPERCLIP_URL}` (default: `http://paperclip:3100` on GCP, `http://localhost:3100` locally).
The company is **DreamRise** (`PAPERCLIP_COMPANY_ID=DreamRise`) and the CEO agent
is **DreamRise Chief** (`PAPERCLIP_CEO_AGENT_ID=DreamRise Chief`). Paperclip operates
as the company's control plane — it manages the CEO and a full org chart of worker
agents. Your job is to **create an issue assigned to the DreamRise Chief CEO** and
then **invoke the CEO heartbeat** so the CEO wakes up immediately, reviews
the task, and delegates it to the right workers.

## Authentication

All requests use `Authorization: Bearer ${PAPERCLIP_API_KEY}`.

> If `PAPERCLIP_API_KEY` is empty or unset, omit the Authorization header
> entirely — Paperclip is running in local trusted mode and no token is needed.

---

## Workflow: Submit a task to the company

### Step 1 — Create an issue assigned to the CEO

Use `web_fetch` to `POST` to `/api/companies/${PAPERCLIP_COMPANY_ID}/issues`.

**Endpoint:** `POST ${PAPERCLIP_URL}/api/companies/${PAPERCLIP_COMPANY_ID}/issues`
**Headers:**
```json
{
  "Content-Type": "application/json",
  "Authorization": "Bearer ${PAPERCLIP_API_KEY}"
}
```
**Body:**
```json
{
  "title": "<one-line summary of the task>",
  "description": "<full task detail in markdown, including context from the conversation>",
  "status": "todo",
  "priority": "high",
  "assigneeAgentId": "${PAPERCLIP_CEO_AGENT_ID}"
}
```

> **DreamRise values** (hardcoded defaults, override via env if needed):
> - `PAPERCLIP_COMPANY_ID` = `DreamRise`
> - `PAPERCLIP_CEO_AGENT_ID` = `DreamRise Chief`

**Response shape (success — HTTP 201):**
```json
{
  "id": "iss_...",
  "title": "...",
  "status": "todo",
  "assigneeAgentId": "...",
  "companyId": "..."
}
```

Save the returned `id` as `issueId`.

---

### Step 2 — Invoke the CEO heartbeat

After creating the issue, trigger the CEO immediately instead of waiting for
the scheduled heartbeat interval.

**Endpoint:** `POST ${PAPERCLIP_URL}/api/agents/${PAPERCLIP_CEO_AGENT_ID}/heartbeat/invoke`
**Headers:**
```json
{
  "Content-Type": "application/json",
  "Authorization": "Bearer ${PAPERCLIP_API_KEY}"
}
```
**Body:** `{}` (empty object)

**Response shape (success — HTTP 200):**
```json
{ "runId": "run_..." }
```

---

### Step 3 — Register the issue for result delivery

After creating the issue, register the Telegram `chat_id` with the result-watcher
so it knows where to send the completion notification.

**Endpoint:** `POST http://result-watcher:4000/track`
**Headers:**
```json
{ "Content-Type": "application/json" }
```
**Body:**
```json
{
  "issueId": "<the issue id returned in Step 1>",
  "chatId": "<the Telegram chat_id of the user who sent the message>",
  "title": "<the issue title>"
}
```

> If the result-watcher call fails, ignore the error and continue — it is non-critical.
> The watcher will still detect the completed issue on its next poll and use the
> `DEFAULT_TELEGRAM_CHAT_ID` fallback if configured.

---

### Step 4 — Reply to the user

After all calls succeed, reply with a confirmation like:

```
✅ Task submitted to the DreamRise Chief (CEO).

**Task:** <title>
**Issue ID:** iss_...
**Status:** todo → DreamRise Chief reviewing now

The CEO will break this down and delegate to the right DreamRise workers.
I'll send you a full report here once the work is complete! 📊
```

If the CEO heartbeat invoke fails (non-2xx), still confirm the issue was
created and tell the user the CEO will pick it up on its next scheduled
heartbeat.

---

## When to use each endpoint

| Situation | Action |
|---|---|
| User wants to hand off a goal/task to the company | Create issue + invoke heartbeat |
| User asks "what is the team working on?" | `GET ${PAPERCLIP_URL}/api/companies/${PAPERCLIP_COMPANY_ID}/issues?status=in_progress` |
| User asks "did the team finish X?" | `GET ${PAPERCLIP_URL}/api/companies/${PAPERCLIP_COMPANY_ID}/issues?status=done` |
| User wants to check a specific issue | `GET ${PAPERCLIP_URL}/api/issues/{issueId}` |

---

## Error handling

| HTTP Status | Meaning | What to tell the user |
|---|---|---|
| 401 | Missing/invalid API key | "Paperclip rejected the request — check PAPERCLIP_API_KEY" |
| 404 | Wrong company or agent ID | "Couldn't find the company or CEO agent — check PAPERCLIP_COMPANY_ID / PAPERCLIP_CEO_AGENT_ID" |
| 409 | Conflict (already exists) | Describe the conflict and ask user how to proceed |
| 5xx | Paperclip server error | "Paperclip is having trouble — try again in a moment" |

---

## Environment variables reference

| Variable | Description |
|---|---|
| `PAPERCLIP_URL` | Base URL of Paperclip (default: `http://localhost:3100`) |
| `PAPERCLIP_COMPANY_ID` | Your Paperclip company ID (from company settings page) |
| `PAPERCLIP_CEO_AGENT_ID` | Agent ID of the CEO (from agents page) |
| `PAPERCLIP_API_KEY` | Board API key; leave blank for local trusted mode |
