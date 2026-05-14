// api/notion.js — Vercel serverless proxy to Mike's Notion GTD workspace.
//
// Phase 1 surface area:
//   GET    /api/notion?section=inbox                           -> list (paginated)
//   POST   /api/notion?section=inbox&action=add                -> create item
//   PATCH  /api/notion?section=inbox&id=PAGE_ID                -> update properties
//   POST   /api/notion?action=complete&id=PAGE_ID              -> archive page (mark complete)
//   POST   /api/notion?section=src&action=move&id=PAGE_ID      -> copy to body.toSection's DB
//                                                                 then archive the source
//
// All requests require an `X-Auth-Token` header that matches process.env.GTD_AUTH_TOKEN.
// CORS is restricted to the production origin (and http://localhost:* for `vercel dev`).
//
// Property-name assumption: every GTD database uses "Name" as its title property.
// (Pre-existing convention — preserved here so the Phase-1 changes stay surgical.)

const { Client } = require('@notionhq/client');

const DB_MAP = {
  inbox:        'ab01950547b44070acd1f63090f1a9b9',
  goals:        '6b890f65220d44a29d21b0861f9b053f',
  projects:     'dfff8706d2c14942b95bdac448e7a61e',
  nextactions:  '258b99608f484a629f302a115ea2613c',
  waitingfor:   '563c48ebe0464e6e9de7bc17c125f086',
  somedaymaybe: 'c675782834a3474ab52a87352bc23017',
};

const ALLOWED_ORIGINS = new Set([
  'https://mikes-gtd-dashboard.vercel.app',
]);
const LOCALHOST_ORIGIN = /^http:\/\/localhost(:\d+)?$/;

// Body-key → [Notion property name, value-builder]. Keep keys camelCase
// to match what the frontend (and our own `pageToBody`) emits.
const PROPERTY_BUILDERS = {
  name:       (v) => ['Name',           { title:        [{ text: { content: String(v) } }] }],
  area:       (v) => ['Area',           { multi_select: toMultiSelect(v) }],
  priority:   (v) => ['Priority',       { select:       { name: String(v) } }],
  status:     (v) => ['Status',         { status:       { name: String(v) } }],
  context:    (v) => ['Context',        { multi_select: toMultiSelect(v) }],
  energy:     (v) => ['Energy',         { select:       { name: String(v) } }],
  why:        (v) => ['Why It Matters', { rich_text:    [{ text: { content: String(v) } }] }],
  waitingOn:  (v) => ['Waiting On',     { rich_text:    [{ text: { content: String(v) } }] }],
  need:       (v) => ['Need',           { rich_text:    [{ text: { content: String(v) } }] }],
  since:      (v) => ['Since',          { date:         { start: String(v) } }],
  followUp:   (v) => ['Follow Up',      { date:         { start: String(v) } }],
  nextAction: (v) => ['Next Action',    { rich_text:    [{ text: { content: String(v) } }] }],
};

function toMultiSelect(v) {
  const list = Array.isArray(v) ? v : String(v).split(',');
  return list.map((x) => ({ name: String(x).trim() })).filter((x) => x.name);
}

function buildProperties(body) {
  const properties = {};
  for (const [key, value] of Object.entries(body || {})) {
    if (value == null || value === '' || (Array.isArray(value) && value.length === 0)) continue;
    const builder = PROPERTY_BUILDERS[key];
    if (!builder) continue;
    const [propName, propValue] = builder(value);
    properties[propName] = propValue;
  }
  return properties;
}

function serializePage(page) {
  const out = { id: page.id, url: page.url };
  for (const [key, val] of Object.entries(page.properties || {})) {
    if (val.title?.length)             out[key] = val.title.map((t) => t.plain_text).join('');
    else if (val.rich_text?.length)    out[key] = val.rich_text.map((t) => t.plain_text).join('');
    else if (val.select?.name)         out[key] = val.select.name;
    else if (val.multi_select?.length) out[key] = val.multi_select.map((s) => s.name);
    else if (val.status?.name)         out[key] = val.status.name;
    else if (val.date?.start)          out[key] = val.date.start;
    else if (val.formula?.type === 'string') out[key] = val.formula.string;
    else if (val.number != null)       out[key] = val.number;
    else if (val.checkbox != null)     out[key] = val.checkbox;
  }
  return out;
}

// Inverse of buildProperties — used when moving a page across databases so
// we can re-emit its properties on the target DB through buildProperties().
function pageToBody(serialized) {
  return {
    name:       serialized.Name,
    area:       serialized.Area,
    priority:   serialized.Priority,
    status:     serialized.Status,
    context:    serialized.Context,
    energy:     serialized.Energy,
    why:        serialized['Why It Matters'],
    waitingOn:  serialized['Waiting On'],
    need:       serialized.Need,
    since:      serialized.Since,
    followUp:   serialized['Follow Up'],
    nextAction: serialized['Next Action'],
  };
}

function applyCors(req, res) {
  const origin = req.headers.origin;
  if (origin && (ALLOWED_ORIGINS.has(origin) || LOCALHOST_ORIGIN.test(origin))) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Auth-Token');
}

// Constant-time string compare. The token is high-entropy so timing leaks
// would be hard to exploit either way, but this is cheap insurance.
function timingSafeEqualStr(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

function checkAuth(req) {
  const expected = process.env.GTD_AUTH_TOKEN;
  if (!expected) return { ok: false, status: 500, msg: 'Server misconfigured: GTD_AUTH_TOKEN not set' };
  const provided = req.headers['x-auth-token'] || '';
  if (!timingSafeEqualStr(expected, provided)) {
    return { ok: false, status: 401, msg: 'Invalid or missing X-Auth-Token' };
  }
  return { ok: true };
}

// Follow next_cursor until exhausted. Fixes the silent-truncate-at-100 bug.
async function queryAll(n, databaseId) {
  const all = [];
  let cursor;
  do {
    const res = await n.databases.query({
      database_id: databaseId,
      page_size: 100,
      start_cursor: cursor,
    });
    all.push(...res.results);
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);
  return all;
}

module.exports = async (req, res) => {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(204).end();

  const auth = checkAuth(req);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.msg });

  const n = new Client({ auth: process.env.NOTION_API_KEY });
  const action  = (req.query.action  || '').toLowerCase();
  const section = (req.query.section || '').toLowerCase().replace(/\s+/g, '');
  const pageId  = req.query.id;

  try {
    // Mark complete → archive the Notion page. Section is optional here; the
    // page_id is globally unique inside the integration.
    if (req.method === 'POST' && action === 'complete') {
      if (!pageId) return res.status(400).json({ error: 'Missing id' });
      const updated = await n.pages.update({ page_id: pageId, archived: true });
      return res.status(200).json({ ok: true, id: updated.id, archived: true });
    }

    // Move across DBs = create-on-target + archive-source. The new page gets
    // a new Notion ID; callers should refresh both lists.
    if (req.method === 'POST' && action === 'move') {
      if (!pageId) return res.status(400).json({ error: 'Missing id' });
      const body = req.body || {};
      const targetSection = (body.toSection || '').toLowerCase().replace(/\s+/g, '');
      const targetDbId = DB_MAP[targetSection];
      if (!targetDbId) return res.status(400).json({ error: 'Unknown toSection: ' + body.toSection });

      const sourcePage = await n.pages.retrieve({ page_id: pageId });
      const carried = pageToBody(serializePage(sourcePage));
      // Anything the caller passes in `body` (besides toSection) overrides the carried value.
      const merged = { ...carried, ...body };
      delete merged.toSection;

      const properties = buildProperties(merged);
      const created = await n.pages.create({ parent: { database_id: targetDbId }, properties });
      await n.pages.update({ page_id: pageId, archived: true });
      return res.status(200).json({ ok: true, fromId: pageId, page: serializePage(created) });
    }

    // From here on we need a known section to resolve a DB.
    const dbId = DB_MAP[section];
    if (!dbId) return res.status(400).json({ error: 'Unknown section: ' + req.query.section });

    if (req.method === 'POST' && action === 'add') {
      const body = req.body || {};
      if (!body.name) body.name = 'Untitled';
      const properties = buildProperties(body);
      const created = await n.pages.create({ parent: { database_id: dbId }, properties });
      return res.status(200).json({ ok: true, page: serializePage(created) });
    }

    if (req.method === 'PATCH') {
      if (!pageId) return res.status(400).json({ error: 'Missing id' });
      const properties = buildProperties(req.body || {});
      if (!Object.keys(properties).length) {
        return res.status(400).json({ error: 'No updatable properties supplied' });
      }
      const updated = await n.pages.update({ page_id: pageId, properties });
      return res.status(200).json({ ok: true, page: serializePage(updated) });
    }

    if (req.method === 'GET') {
      const pages = await queryAll(n, dbId);
      return res.status(200).json({
        section,
        count: pages.length,
        pages: pages.map(serializePage),
      });
    }

    return res.status(405).json({ error: 'Method not allowed: ' + req.method });
  } catch (err) {
    console.error(err);
    const status = Number.isInteger(err?.status) ? err.status : 500;
    return res.status(status).json({ error: err.message || String(err) });
  }
};
