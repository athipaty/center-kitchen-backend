const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const axios = require('axios');
const router = express.Router();

const client = new Anthropic();

// File cache: avoid re-reading the same file within 5 minutes
const fileCache = new Map();
const FILE_CACHE_TTL = 5 * 60 * 1000;
function getCached(key) {
  const entry = fileCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > FILE_CACHE_TTL) { fileCache.delete(key); return null; }
  return entry.value;
}
function setCache(key, value) { fileCache.set(key, { value, ts: Date.now() }); }

const MODEL_RATES = {
  'claude-haiku-4-5':  { input: 1.00, output: 5.00 },
  'claude-sonnet-4-6': { input: 3.00, output: 15.00 },
  'claude-opus-4-7':   { input: 5.00, output: 25.00 },
};
const DEFAULT_MODEL = 'claude-haiku-4-5';
const MAX_HISTORY = 20;

async function githubRequest(method, endpoint, body) {
  const headers = {
    'User-Agent': 'tong-app',
    'Accept': 'application/vnd.github.v3+json',
  };
  if (process.env.GITHUB_TOKEN) headers['Authorization'] = `token ${process.env.GITHUB_TOKEN.trim()}`;
  const res = await axios({ method, url: `https://api.github.com${endpoint}`, headers, data: body, validateStatus: () => true });
  return { status: res.status, body: res.data, headers: res.headers };
}

router.get('/test-token', async (req, res) => {
  if (!process.env.GITHUB_TOKEN) return res.json({ ok: false, error: 'GITHUB_TOKEN is not set on the server' });
  try {
    const result = await githubRequest('GET', '/user');
    if (result.status === 200) return res.json({
      ok: true,
      user: result.body.login,
      scopes: result.headers['x-oauth-scopes'] || 'none (fine-grained token)',
      tokenLength: process.env.GITHUB_TOKEN.trim().length,
    });
    return res.json({ ok: false, status: result.status, error: result.body.message });
  } catch (err) {
    return res.json({ ok: false, error: err.message });
  }
});

router.get('/test-write', async (req, res) => {
  try {
    const repo = 'athipaty/tong';
    const filePath = 'test-api-write.txt';
    let sha;
    const getRes = await githubRequest('GET', `/repos/${repo}/contents/${filePath}`);
    if (getRes.status === 200) sha = getRes.body.sha;
    const body = { message: 'test write from API', content: Buffer.from('test ' + Date.now()).toString('base64') };
    if (sha) body.sha = sha;
    const putRes = await githubRequest('PUT', `/repos/${repo}/contents/${filePath}`, body);
    res.json({ ok: putRes.status === 200 || putRes.status === 201, status: putRes.status, body: putRes.body });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

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
  if (res.status !== 200) throw new Error(`Repo "${repo}" not found or inaccessible`);
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

function encodePath(filePath) {
  return filePath.split('/').map(encodeURIComponent).join('/');
}

async function readFile(repo, filePath) {
  const cacheKey = `${repo}:${filePath}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;
  const res = await githubRequest('GET', `/repos/${repo}/contents/${encodePath(filePath)}`);
  if (res.status !== 200) throw new Error(`File not found: ${filePath} in ${repo}`);
  const result = {
    content: Buffer.from(res.body.content, 'base64').toString('utf-8'),
    sha: res.body.sha,
  };
  setCache(cacheKey, result);
  return result;
}

async function writeFile(repo, filePath, content, message) {
  let sha;
  try { const f = await readFile(repo, filePath); sha = f.sha; } catch {}
  const body = { message, content: Buffer.from(content).toString('base64') };
  if (sha) body.sha = sha;
  const res = await githubRequest('PUT', `/repos/${repo}/contents/${encodePath(filePath)}`, body);
  if (res.status !== 200 && res.status !== 201) throw new Error(JSON.stringify(res.body.message || res.body));
  // Invalidate cache after write
  fileCache.delete(`${repo}:${filePath}`);
  return `Committed "${message}" to ${repo}/${filePath}`;
}

const TOOLS = [
  {
    name: 'list_files',
    description: 'List all files in a GitHub repository.',
    input_schema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Repository full name, e.g. "athipaty/tong"' },
      },
      required: ['repo'],
    },
  },
  {
    name: 'read_file',
    description: 'Read the full contents of a file from a GitHub repository.',
    input_schema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Repository full name, e.g. "athipaty/tong"' },
        path: { type: 'string', description: 'File path, e.g. "src/index.js"' },
      },
      required: ['repo', 'path'],
    },
  },
  {
    name: 'write_file',
    description: 'Create or update a file in a GitHub repository. Commits directly to main branch.',
    input_schema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Repository full name, e.g. "athipaty/tong"' },
        path: { type: 'string', description: 'File path relative to repo root' },
        content: { type: 'string', description: 'Complete new file content' },
        message: { type: 'string', description: 'Git commit message' },
      },
      required: ['repo', 'path', 'content', 'message'],
    },
  },
];

router.post('/', async (req, res) => {
  const { messages, systemPrompt, repos, model } = req.body;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = data => res.write(`data: ${JSON.stringify(data)}\n\n`);

  try {
    const repoList = Array.isArray(repos) ? repos : [];
    const repoContext = repoList.length > 0
      ? `You have access to these GitHub repositories:\n${repoList.map(r => `- ${r}`).join('\n')}\n\nUse list_files to explore a repo, read_file to read code, and write_file to commit changes. Always specify the repo parameter. When modifying code, read the file first then write the updated version.`
      : 'No repositories selected.';

    const systemText = [systemPrompt || '', repoContext].filter(Boolean).join('\n\n');
    const system = [{ type: 'text', text: systemText, cache_control: { type: 'ephemeral' } }];

    // Trim history to last MAX_HISTORY messages to save tokens
    const trimmed = messages.slice(-MAX_HISTORY);
    const conversationMessages = [...trimmed];
    const selectedModel = MODEL_RATES[model] ? model : DEFAULT_MODEL;
    let rateLimits = null;

    while (true) {
      const stream = client.messages.stream({
        model: selectedModel,
        max_tokens: 4096,
        system,
        tools: repoList.length > 0 ? TOOLS : [],
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
        const rates = MODEL_RATES[selectedModel];
        const u = final.usage;
        const cost = rates
          ? ((u.input_tokens * rates.input + u.output_tokens * rates.output) / 1_000_000
            + ((u.cache_read_input_tokens || 0) * rates.input * 0.1) / 1_000_000)
          : null;
        send({ done: true, usage: final.usage, rateLimits, cost, model: selectedModel });
        break;
      }

      conversationMessages.push({ role: 'assistant', content: final.content });
      const toolResults = [];

      for (const block of final.content) {
        if (block.type !== 'tool_use') continue;
        send({ tool: block.name, input: block.input });
        let result;
        try {
          if (block.name === 'list_files') result = await listFiles(block.input.repo);
          else if (block.name === 'read_file') result = (await readFile(block.input.repo, block.input.path)).content;
          else if (block.name === 'write_file') result = await writeFile(block.input.repo, block.input.path, block.input.content, block.input.message);
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
