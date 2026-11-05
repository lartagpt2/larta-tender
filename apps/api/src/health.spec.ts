import { HealthController, HealthService } from './app.module';
import { createApplication } from './application';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
test('health service reports application readiness without probing the database', () => {
  expect(new HealthController(new HealthService()).health()).toEqual({
    status: 'ok',
    service: 'larta-tender',
    persistence: 'not-configured',
  });
});
describe('HTTP boundary', () => {
  let app: NestFastifyApplication;
  beforeAll(async () => {
    app = await createApplication({ environment: 'test', enableOpenApi: true, logger: false });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });
  afterAll(async () => {
    await app.close();
  });
  test('health is available under the API prefix and generates its own correlation ID', async () => {
    const result = await app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { 'x-correlation-id': 'untrusted input' },
    });
    expect(result.statusCode).toBe(200);
    expect(result.json().status).toBe('ok');
    expect(result.headers['x-correlation-id']).toMatch(/^[a-f0-9-]{36}$/);
  });
  test('unknown resources return safe structured errors with matching correlation ID', async () => {
    const result = await app.inject({ method: 'GET', url: '/api/not-found?secret=do-not-echo' });
    expect(result.statusCode).toBe(404);
    expect(result.json()).toEqual({
      statusCode: 404,
      message: 'Ресурс не найден',
      correlationId: result.headers['x-correlation-id'],
    });
    expect(result.body).not.toContain('do-not-echo');
  });
  test('OpenAPI is explicitly enabled in test mode', async () => {
    const result = await app.inject({ method: 'GET', url: '/api/openapi.json' });
    expect(result.statusCode).toBe(200);
    expect(result.json().paths['/api/health']).toBeDefined();
  });
});
test('production hides OpenAPI even if the flag is enabled', async () => {
  const app = await createApplication({ environment: 'production', enableOpenApi: true, logger: false });
  try {
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    expect((await app.inject({ method: 'GET', url: '/api/openapi.json' })).statusCode).toBe(404);
  } finally {
    await app.close();
  }
});
test('OpenAPI remains hidden without explicit opt-in', async () => {
  const app = await createApplication({ environment: 'test', enableOpenApi: false, logger: false });
  try {
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    expect((await app.inject({ method: 'GET', url: '/api/openapi.json' })).statusCode).toBe(404);
  } finally {
    await app.close();
  }
});
