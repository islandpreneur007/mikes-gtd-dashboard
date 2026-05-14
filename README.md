# Mike's GTD Dashboard

A single-surface daily-driver dashboard for Mike Grbic's GTD system, backed by a Notion workspace.

- **Live:** https://mikes-gtd-dashboard.vercel.app
- **Notion parent:** GTD Command Center
- **Spec:** see [`../docs/mvp-scope.md`](../docs/mvp-scope.md) (v0.2 approved May 14 2026)
- **Roadmap:** see [`../TODO.md`](../TODO.md)

## Architecture

```
Browser  ──fetch──▶  /api/notion  ──@notionhq/client──▶  Notion API
(static HTML in     (Vercel serverless           (6 GTD databases)
 public/)            function in api/)
```

The browser sends an `X-Auth-Token` header on every request; the serverless function compares it (constant-time) against the `GTD_AUTH_TOKEN` env var. CORS is restricted to the production origin plus `http://localhost:*` for `vercel dev`.

## API surface

| Method | URL | Body | Purpose |
|---|---|---|---|
| `GET`   | `/api/notion?section=inbox` | — | List items (paginated, follows `next_cursor`) |
| `POST`  | `/api/notion?section=inbox&action=add` | `{ name, area?, priority?, ... }` | Create an item |
| `PATCH` | `/api/notion?section=inbox&id=PAGE_ID` | `{ priority?, status?, ... }` | Update any subset of properties |
| `POST`  | `/api/notion?action=complete&id=PAGE_ID` | — | Archive the page (mark complete) |
| `POST`  | `/api/notion?section=src&action=move&id=PAGE_ID` | `{ toSection: 'nextactions', ...overrides }` | Re-create on the target DB and archive the source |

Valid `section` values: `inbox`, `goals`, `projects`, `nextactions`, `waitingfor`, `somedaymaybe`. (Reference, Tickler, and Today are added in Phase 2.)

## Local development

```bash
npm install
cp .env.example .env.local
# Fill in NOTION_API_KEY (from your Notion integration) and a fresh GTD_AUTH_TOKEN.
vercel dev
```

Open http://localhost:3000. On first load it prompts for the token — paste the same `GTD_AUTH_TOKEN` value. It's stashed in `localStorage` under `gtd-token`.

## Deploy

```bash
git push origin main   # Vercel auto-deploys main
# or one-shot:
vercel --prod
```

`NOTION_API_KEY` and `GTD_AUTH_TOKEN` must be set in the Vercel project's environment variables for all environments.

## Rotating the auth token

1. Generate a new value: `openssl rand -base64 32`
2. Update `GTD_AUTH_TOKEN` in Vercel (Production + Preview + Development)
3. Redeploy
4. On each browser that uses the dashboard, open DevTools → `localStorage.removeItem('gtd-token')` (or the next 401 will clear it automatically) and reload — the prompt re-appears.
