import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import ai from '../apps/api/dist/document-ai/ai-repository.js';
import contracts from '../apps/api/dist/document-ai/contracts.js';
// Test-only executable: no production mock switch or route is registered.
import http from 'node:http';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { config } from 'dotenv';
import { quotePdf } from './task008-fixtures.mjs';
import { mockDraft } from './task008-mock.mjs';
import application from '../apps/api/dist/application.js';
config({ path: resolve('.env'), quiet: true });
if (process.env.PGDATABASE !== 'larta_test_task003') throw new Error('Synthetic approved DB required');
const digest = 'a'.repeat(64);
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => {
    body += chunk;
    if (body.length > 10 * 1024 * 1024) req.destroy();
  });
  req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/api/status')
      return res.end(JSON.stringify({ cloud: { disabled: true, source: 'synthetic-test' } }));
    if (req.url === '/api/show') return res.end(JSON.stringify({ capabilities: ['vision'] }));
    if (req.url === '/api/tags')
      return res.end(JSON.stringify({ models: [{ name: 'qwen3-vl:8b-instruct', digest }] }));
    if (req.url === '/api/chat') {
      const input = JSON.parse(body),
        pages = input.messages
          .filter((m) => m.role === 'user')
          .map((m) => ({
            page: Number(m.content.match(/Document page (\d+)/)?.[1] ?? 1),
            text: m.content.split('UNTRUSTED CONTENT:\n')[1] ?? '',
            ...(m.images ? { image: m.images[0] } : {}),
          }));
      return res.end(
        JSON.stringify({
          model: 'qwen3-vl:8b-instruct',
          done: true,
          done_reason: 'stop',
          message: { content: JSON.stringify(contracts.packWireDraft(mockDraft(pages))) },
        }),
      );
    }
    res.statusCode = 404;
    res.end('{}');
  });
});
await new Promise((done, reject) => {
  server.once('error', reject);
  server.listen(11434, '127.0.0.1', done);
});
process.env.DOCUMENT_AI_ENABLED = 'true';
process.env.OLLAMA_BASE_URL = 'http://127.0.0.1:11434';
process.env.OLLAMA_MODEL = 'qwen3-vl:8b-instruct';
process.env.OLLAMA_MODEL_DIGEST = digest;
process.env.DOCUMENT_AI_SYNTHETIC_SHA256 = [
  quotePdf(),
  quotePdf(true),
  quotePdf(false, 0.9),
  await readFile(resolve('tests/fixtures/tz-seven-items.pdf')),
]
  .map((b) => createHash('sha256').update(b).digest('hex'))
  .join(',');
const aiPool = new pg.Pool({ max: 2, connectionTimeoutMillis: 5000 });
const options = ai.aiOptions();
const aiRepo = new ai.PgAIRepository(aiPool, {
  ...options,
  jobRoot: resolve(options.workspace, 'temp/task008-e2e', randomUUID()),
});
const app = await application.createApplication({
  logger: false,
  environment: 'test',
  data: { aiRepository: aiRepo },
});
await app.listen(3000, '127.0.0.1');
async function close() {
  await app.close();
  server.close();
  await aiPool.end();
}
process.once('SIGINT', () => void close());
process.once('SIGTERM', () => void close());
