import http from 'node:http';
import contracts from '../../apps/api/dist/document-ai/contracts.js';
import { mockDraft } from '../task008-mock.mjs';
export async function startMockAI() {
  const digest = 'a'.repeat(64);
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 10 * 1024 * 1024) req.destroy();
    });
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/extract') return res.end(JSON.stringify(mockDraft(JSON.parse(body).pages)));
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
    server.listen(0, '127.0.0.1', done);
  });
  return {
    provider: {
      async extract(pages) {
        const response = await fetch('http://127.0.0.1:' + server.address().port + '/extract', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ pages }),
          signal: AbortSignal.timeout(5000),
        });
        if (!response.ok) throw new Error('mock_ai_failed');
        return {
          ...contracts.validateDraft(
            await response.json(),
            pages,
            pages.some((p) => p.image),
          ),
          model: 'mock/qwen3-vl',
          digest,
          durationMs: 1,
        };
      },
    },
    digest,
    baseUrl: 'http://127.0.0.1:' + server.address().port,
    close: () => new Promise((done, reject) => server.close((e) => (e ? reject(e) : done()))),
  };
}
