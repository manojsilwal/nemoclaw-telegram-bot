---
name: fincrawler
description: Search the web and scrape URLs using the FinCrawler service. Use this whenever the user asks to search, browse, look up, or fetch web content.
---

# FinCrawler Web Skill

You have access to a private web crawling and search service called **FinCrawler** running at `https://fincrawler.onrender.com`. Use it whenever you need to search the web or read a web page.

## Authentication

All requests require the header `X-Api-Key: ${FIRECRAWL_API_KEY}`.

---

## 1. Search the web

Use `web_fetch` to POST to `/v1/search`:

**Endpoint:** `POST https://fincrawler.onrender.com/v1/search`
**Headers:** `Content-Type: application/json`, `X-Api-Key: ${FIRECRAWL_API_KEY}`
**Body:**
```json
{
  "query": "<the user's search query>",
  "limit": 5
}
```

**Response shape:**
```json
{
  "success": true,
  "data": [
    { "url": "...", "title": "...", "description": "..." }
  ]
}
```

Return a concise summary of the top results with links.

---

## 2. Scrape a URL

Use `web_fetch` to POST to `/v1/scrape`:

**Endpoint:** `POST https://fincrawler.onrender.com/v1/scrape`
**Headers:** `Content-Type: application/json`, `X-Api-Key: ${FIRECRAWL_API_KEY}`
**Body:**
```json
{
  "url": "<the URL to scrape>"
}
```

**Response shape:**
```json
{
  "success": true,
  "data": {
    "markdown": "... full page content ...",
    "metadata": { "title": "...", "sourceURL": "..." }
  }
}
```

Return the page content summarized for the user.

---

## When to use each

- User asks "search for X", "find me X", "look up X" → use `/v1/search`
- User shares a URL and asks "what does this say", "summarize this", "open this" → use `/v1/scrape`
- After a search, if the user wants more detail on a result → use `/v1/scrape` on that URL
