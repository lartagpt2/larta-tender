import { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createApplication } from './application';
import { TenderRepository } from './data/repository';
const actor = '10000000-0000-4000-8000-000000000001';
const id = '20000000-0000-4000-8000-000000000001';
const token = 'synthetic-token-for-tests-only-123456';
describe('tender API using synthetic repository', () => {
  let app: NestFastifyApplication;
  const repository: TenderRepository = {
    list: jest.fn(async () => []),
    get: jest.fn(async () => ({ id, title: 'Synthetic', revision: 1 })),
    create: jest.fn(async (_actor, title) => ({ id, title, revision: 1 })),
    lots: jest.fn(async () => []),
  };
  beforeAll(async () => {
    app = await createApplication({
      logger: false,
      environment: 'test',
      enableOpenApi: true,
      data: { enabled: true, token, actorId: actor, repository },
    });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });
  afterAll(async () => {
    await app.close();
  });
  it('requires server-configured authentication', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/tenders' })).statusCode).toBe(401);
  });
  it('takes the actor from configuration and validates writes', async () => {
    const headers = { authorization: `Bearer ${token}` };
    const response = await app.inject({
      method: 'POST',
      url: '/api/tenders',
      headers,
      payload: { title: 'Synthetic' },
    });
    expect(response.statusCode).toBe(201);
    expect(repository.create).toHaveBeenCalledWith(actor, 'Synthetic');
    for (const payload of [{ title: ' ' }, { title: 'x', ownerId: id }, { title: 42 }])
      expect((await app.inject({ method: 'POST', url: '/api/tenders', headers, payload })).statusCode).toBe(
        400,
      );
  });
  it('reads nested lots and rejects malformed IDs', async () => {
    const headers = { authorization: `Bearer ${token}` };
    expect((await app.inject({ method: 'GET', url: `/api/tenders/${id}/lots`, headers })).json()).toEqual([]);
    expect(repository.lots).toHaveBeenCalledWith(actor, id);
    expect((await app.inject({ method: 'GET', url: '/api/tenders/invalid', headers })).statusCode).toBe(400);
  });
  it('publishes the implemented contract', async () => {
    const spec = (await app.inject({ method: 'GET', url: '/api/openapi.json' })).json();
    expect(spec.paths['/api/tenders'].post).toBeDefined();
    expect(spec.paths['/api/tenders/{id}/lots'].get).toBeDefined();
  });
});
it('keeps production data access disabled even if explicitly enabled', async () => {
  const app = await createApplication({
    logger: false,
    environment: 'production',
    data: { enabled: true, token, actorId: actor },
  });
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
  try {
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/api/tenders',
          headers: { authorization: `Bearer ${token}` },
        })
      ).statusCode,
    ).toBe(503);
  } finally {
    spy.mockRestore();
    await app.close();
  }
});
