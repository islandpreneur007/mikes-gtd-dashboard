const { Client } = require('@notionhq/client');
module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { endpoint, params } = req.body;
  if (!endpoint) return res.status(400).json({ error: 'Missing endpoint' });
  const key = process.env.NOTION_API_KEY;
  if (!key) return res.status(500).json({ error: 'NOTION_API_KEY not set' });
  try {
    const notion = new Client({ auth: key });
    let result;
    switch (endpoint) {
      case 'search': result = await notion.search(params || {}); break;
      case 'getPage': result = await notion.pages.retrieve({ page_id: params.pageId }); break;
      case 'getBlockChildren': result = await notion.blocks.children.list({ block_id: params.blockId, page_size: 100 }); break;
      case 'queryDatabase': result = await notion.databases.query(params); break;
      default: return res.status(400).json({ error: 'Unknown endpoint' });
    }
    res.status(200).json(result);
  } catch (err) {
    console.error('Notion API error:', err);
    res.status(500).json({ error: err.message });
  }
};
