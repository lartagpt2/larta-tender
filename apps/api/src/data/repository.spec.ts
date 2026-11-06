import { ConflictException, NotFoundException } from '@nestjs/common';
import { Pool, PoolClient } from 'pg';
import { PgTenderRepository, receiveDocument, transaction } from './repository';
function fakeClient() {
  return { query: jest.fn(), release: jest.fn() };
}
describe('transaction boundary', () => {
  it('commits and releases', async () => {
    const client = fakeClient();
    const pool = { connect: async () => client } as unknown as Pool;
    expect(await transaction(pool, async () => 42)).toBe(42);
    expect(client.query.mock.calls).toEqual([['BEGIN'], ['COMMIT']]);
    expect(client.release).toHaveBeenCalledTimes(1);
  });
  it('rolls back and releases after a failed write', async () => {
    const client = fakeClient();
    const pool = { connect: async () => client } as unknown as Pool;
    await expect(
      transaction(pool, async () => {
        throw new Error('synthetic');
      }),
    ).rejects.toThrow('synthetic');
    expect(client.query.mock.calls).toEqual([['BEGIN'], ['ROLLBACK']]);
    expect(client.release).toHaveBeenCalledTimes(1);
  });
  it('audits creation in the same transaction and binds user input', async () => {
    const client = fakeClient();
    client.query.mockResolvedValue({ rows: [{ id: 'synthetic', title: 'title', revision: 1 }] });
    const repository = new PgTenderRepository({ connect: async () => client } as unknown as Pool);
    await repository.create('actor', "title'); DELETE FROM tender_app.tender;--");
    expect(client.query.mock.calls[1][0]).not.toContain('DELETE');
    expect(client.query.mock.calls[1][1][1]).toContain('DELETE');
    expect(client.query.mock.calls[2][0]).toContain('audit_event');
    expect(client.query.mock.calls[3][0]).toBe('COMMIT');
  });
  it('does not expose a missing/inaccessible tender', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [] });
    await expect(
      new PgTenderRepository({ query } as unknown as Pool).get('other', 'id'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(query.mock.calls[0][0]).toContain('t.owner_id=$1');
    expect(query.mock.calls[0][1]).toEqual(['other', 'id']);
  });
});
describe('document receipts (model mocks; PostgreSQL concurrency still requires integration)', () => {
  it('inserts the original only after claiming a key', async () => {
    const client = fakeClient();
    client.query.mockResolvedValue({ rowCount: 1 });
    const insert = jest.fn();
    const id = await receiveDocument(client as unknown as PoolClient, 't', 'k', 'a'.repeat(64), insert);
    expect(insert).toHaveBeenCalledWith(id);
    expect(client.query.mock.calls[0][0]).toContain('ON CONFLICT');
  });
  it('concurrent duplicate callers return one committed document without extra originals', async () => {
    const client = fakeClient();
    client.query.mockImplementation(async (sql: string) =>
      sql.startsWith('INSERT')
        ? { rowCount: 0 }
        : { rows: [{ document_id: 'original', request_hash: 'a'.repeat(64) }] },
    );
    const insert = jest.fn();
    expect(
      await Promise.all(
        Array.from({ length: 20 }, () =>
          receiveDocument(client as unknown as PoolClient, 't', 'k', 'a'.repeat(64), insert),
        ),
      ),
    ).toEqual(Array(20).fill('original'));
    expect(insert).not.toHaveBeenCalled();
  });
  it('rejects reusing a key for a different request', async () => {
    const client = fakeClient();
    client.query
      .mockResolvedValueOnce({ rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ document_id: 'original', request_hash: 'a'.repeat(64) }] });
    await expect(
      receiveDocument(client as unknown as PoolClient, 't', 'k', 'b'.repeat(64), jest.fn()),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});
