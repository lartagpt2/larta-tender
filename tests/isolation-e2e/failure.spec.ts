import { randomUUID } from 'node:crypto';
import { test, expect } from '../isolated-fixture';
test('C: retain committed tender and file after a simulated scenario error', async ({ request }) => {
  const created = await request.post('/api/tenders', {
    data: { title: 'Synthetic TASK-014 forced failure' },
  });
  expect(created.status()).toBe(201);
  const tender = await created.json();
  const upload = await request.post('/api/tenders/' + tender.id + '/tz', {
    headers: { 'idempotency-key': randomUUID() },
    multipart: {
      file: {
        name: 'synthetic-failure.txt',
        mimeType: 'text/plain',
        buffer: Buffer.from('Synthetic TASK-014 retained file'),
      },
    },
  });
  expect(upload.status()).toBe(201);
  test.fail();
  throw new Error('TASK-014 expected scenario failure after committed tender and document');
});
