const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const https = require('https');
const router = express.Router();

const client = new Anthropic();

function githubRequest(method, endpoint, body) {
  return new Promise((resolve, reject) => {
    const headers = {
      'User-Agent': 'tong-app',
      'Accept': 'application/vnd.github.v3+json',
    };
    if (process.env.GITHUB_TOKEN) headers['Authorization'] = `token ${process.env.GITHUB_TOKEN}`;
    const data = body ? JSON.stringify(body) : null;
    if (data) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(data);
    }
    const req = https.request({ hostname: 'api.github.com', path: endpoint, method, headers }, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode, body: raw }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

router.get('/repos', async (req, res) => {
  try {
    const result = await githubRequest('GET', '/user/repos?per_page=100&sort=updated');
    if (result.status !== 200) return res.status(400).json({ error: 'Failed to fetch repos' });
    const repos = result.body.map(r => ({ name: r.full_name, private: r.private }));
    res.json(repos);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const SKIP_EXT = new Set(['.png','.jpg','.jpeg','.gif','.svg','.ico','.webp','.woff','.woff2','.ttf','.eot','.mp4','.zip','.gz','.pdf','.lock']);
const SKIP_DIR = new Set(['node_modules','.git','dist','build','.next','__pycache__','.venv','vendor','.claude']);

async function listFiles(repo) {
  const res = await githubRequest('GET', `/repos/${repo}/git/trees/HEAD?recursive=1`);
  if (res.status !== 200) throw new Error('Repo not found or inaccessible');
  return res.body.tree
    .filter(f => {
      if (f.type !== 'blob') return false;
      if (f.size > 200000) return false;
      const parts = f.path.split('/');
      if (parts.some(p => SKIP_DIR.has(p))) return false;
      const dot = f.path.lastIndexOf('.');
      if (dot !== -1 && SKIP_EXT.has(f.path.slice(dot).toLowerCase())) return false;
      return true;
    })
    .map(f => `${f.path} (${f.size}b)`)
    .join('\n');
}

async function readFile(repo, filePath) {
  const res = await githubRequest('GET', `/repos/${repo}/contents/${encodeURIComponent(filePath)}`);
  if (res.status !== 200) throw new Error(`File not found: ${filePath}`);
  return {
    content: Buffer.from(res.body.content, 'base64').toString('utf-8'),
    sha: res.body.sha,
  };
}

async function writeFile(repo, filePath, content, message) {
  let sha;
  try { const f = await readFile(repo, filePath); sha = f.sha; } catch {}
  const body = { message, content: Buffer.from(content).toString('base64') };
  if (sha) body.sha = sha;
  const res = await githubRequest('PUT', `/repos/${repo}/contents/${encodeURIComponent(filePath)}`, body);
  if (res.status !== 200 && res.status !== 201) throw new Error(JSON.stringify(res.body.message || res.body));
  return `Committed "${message}" to ${filePath}`;
}

const TOOLS = [
  {
    name: 'list_files',
    description: 'List all files in the GitHub repository.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'read_file',
    description: 'Read the full contents of a file from the GitHub repository.',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'File path, e.g. "src/index.js"' } },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description: 'Create or update a file in the GitHub repository. Commits directly to main branch.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to repo root' },
        content: { type: 'string', description: 'Complete new file content' },
        message: { type: 'string', description: 'Git commit message' },
      },
      required: ['path', 'content', 'message'],
    },
  },
];

router.post('/', async (req, res) => {
  const { messages, systemPrompt, repo } = req.body;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = data => res.write(`data: ${JSON.stringify(data)}\n\n`);

  try {
    const repoName = repo || process.env.GITHUB_REPO || '';
    const systemText = [
      systemPrompt || '',
      repoName
        ? `You have direct access to the GitHub repository "${repoName}" via tools. Use list_files to explore, read_file to read code, and write_file to make and commit changes. When asked to modify code, read the file first, then write the updated version.`
        : 'No repository configured.',
    ].filter(Boolean).join('\n\n');

    const system = [{ type: 'text', text: systemText, cache_control: { type: 'ephemeral' } }];
    const conversationMessages = [...messages];

    let rateLimits = null;

    while (true) {
      const stream = client.messages.stream({
        model: 'claude-sonnet-4-6',
        max_tokens: 8192,
        system,
        tools: repoName ? TOOLS : [],
        messages: conversationMessages,
      });

      try {
        const httpRes = await stream.response;
        const h = httpRes.headers;
        rateLimits = {
          tokensLimit: h.get('anthropic-ratelimit-tokens-limit'),
          tokensRemaining: h.get('anthropic-ratelimit-tokens-remaining'),
          tokensReset: h.get('anthropic-ratelimit-tokens-reset'),
          requestsRemaining: h.get('anthropic-ratelimit-requests-remaining'),
          requestsReset: h.get('anthropic-ratelimit-requests-reset'),
        };
      } catch {}

      for await (const chunk of stream) {
        if (chunk.type === 'content_block_delta' && chunk.delta.type === 'text_delta') {
          send({ text: chunk.delta.text });
        }
      }

      const final = await stream.finalMessage();

      if (final.stop_reason !== 'tool_use') {
        send({ done: true, usage: final.usage, rateLimits });
        break;
      }

      conversationMessages.push({ role: 'assistant', content: final.content });
      const toolResults = [];

      for (const block of final.content) {
        if (block.type !== 'tool_use') continue;
        send({ tool: block.name, input: block.input });
        let result;
        try {
          if (block.name === 'list_files') result = await listFiles(repoName);
          else if (block.name === 'read_file') result = (await readFile(repoName, block.input.path)).content;
          else if (block.name === 'write_file') result = await writeFile(repoName, block.input.path, block.input.content, block.input.message);
        } catch (err) {
          result = `Error: ${err.message}`;
        }
        send({ tool_done: block.name });
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: result });
      }

      conversationMessages.push({ role: 'user', content: toolResults });
    }
  } catch (err) {
    send({ error: err.message });
  } finally {
    res.end();
  }
});

module.exports = router;
