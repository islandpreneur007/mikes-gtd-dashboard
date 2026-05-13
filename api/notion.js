const { Client } = require('@notionhq/client');
const DB_MAP = {
  inbox: 'ab01950547b44070acd1f63090f1a9b9',
  goals: '6b890f65220d44a29d21b0861f9b053f',
  projects: 'dfff8706d2c14942b95bdac448e7a61e',
  nextactions: '258b99608f484a629f302a115ea2613c',
  waitingfor: '563c48ebe0464e6e9de7bc17c125f086',
  somedaymaybe: 'c675782834a3474ab52a87352bc23017',
};
function notion() { return new Client({ auth: process.env.NOTION_API_KEY }); }
function serializePage(page) {
  const p = { id: page.id, url: page.url };
  for (const [key, val] of Object.entries(page.properties || {})) {
    if (val.title?.length) p[key] = val.title.map(t => t.plain_text).join('');
    else if (val.rich_text?.length) p[key] = val.rich_text.map(t => t.plain_text).join('');
    else if (val.select?.name) p[key] = val.select.name;
    else if (val.multi_select?.length) p[key] = val.multi_select.map(s => s.name);
    else if (val.status?.name) p[key] = val.status.name;
    else if (val.date?.start) p[key] = val.date.start;
    else if (val.formula?.type === 'string') p[key] = val.formula.string;
    else if (val.number != null) p[key] = val.number;
    else if (val.checkbox != null) p[key] = val.checkbox;
  }
  return p;
}
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  const section = (req.query.section || '').toLowerCase().replace(/\s+/g, '');
  const dbId = DB_MAP[section];
  if (!dbId) return res.status(400).json({ error: 'Unknown section: ' + req.query.section });
  try {
    const n = notion();
    if (req.method === 'POST' && req.query.action === 'add') {
      const body = req.body || {};
      const properties = { Name: { title: [{ text: { content: body.name || 'Untitled' } }] } };
      if (body.area) properties.Area = { multi_select: body.area.split(',').map(a => ({ name: a.trim() })) };
      if (body.priority) properties.Priority = { select: { name: body.priority } };
      if (body.status) properties.Status = { status: { name: body.status } };
      if (body.context) properties.Context = { multi_select: body.context.split(',').map(c => ({ name: c.trim() })) };
      if (body.energy) properties.Energy = { select: { name: body.energy } };
      if (body.why) properties['Why It Matters'] = { rich_text: [{ text: { content: body.why } }] };
      if (body.waitingOn) properties['Waiting On'] = { rich_text: [{ text: { content: body.waitingOn } }] };
      if (body.need) properties.Need = { rich_text: [{ text: { content: body.need } }] };
      if (body.since) properties.Since = { date: { start: body.since } };
      if (body.followUp) properties['Follow Up'] = { date: { start: body.followUp } };
      if (body.nextAction) properties['Next Action'] = { rich_text: [{ text: { content: body.nextAction } }] };
      const created = await n.pages.create({ parent: { database_id: dbId }, properties });
      return res.status(200).json({ ok: true, page: serializePage(created) });
    }
    const results = await n.databases.query({ database_id: dbId, page_size: 100 });
    return res.status(200).json({ section, count: results.results.length, pages: results.results.map(serializePage) });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message || String(err) });
  }
};
