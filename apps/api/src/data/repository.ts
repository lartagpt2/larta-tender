import { ConflictException, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Pool, PoolClient } from 'pg';
export interface Tender {
  id: string;
  title: string;
  revision: number;
}
export interface Lot {
  id: string;
  name: string;
  ordinal: number;
}
export interface TenderRepository {
  list(actor: string): Promise<Tender[]>;
  get(actor: string, id: string): Promise<Tender>;
  create(actor: string, title: string): Promise<Tender>;
  lots(actor: string, id: string): Promise<Lot[]>;
}
export async function transaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
const visible = `t.owner_id=$1 OR EXISTS (SELECT 1 FROM tender_app.tender_member m WHERE m.tender_id=t.id AND m.user_id=$1)`;
export class PgTenderRepository implements TenderRepository {
  constructor(private readonly pool: Pool) {}
  async list(actor: string): Promise<Tender[]> {
    return (
      await this.pool.query<Tender>(
        `SELECT t.id,t.title,t.revision FROM tender_app.tender t WHERE ${visible} ORDER BY t.updated_at DESC,t.id LIMIT 100`,
        [actor],
      )
    ).rows;
  }
  async get(actor: string, id: string): Promise<Tender> {
    const result = await this.pool.query<Tender>(
      `SELECT t.id,t.title,t.revision FROM tender_app.tender t WHERE t.id=$2 AND (${visible})`,
      [actor, id],
    );
    if (!result.rows[0]) throw new NotFoundException();
    return result.rows[0];
  }
  async create(actor: string, title: string): Promise<Tender> {
    return transaction(this.pool, async (client) => {
      const id = randomUUID();
      const result = await client.query<Tender>(
        'INSERT INTO tender_app.tender(id,title,created_by,owner_id) VALUES($1,$2,$3,$3) RETURNING id,title,revision',
        [id, title, actor],
      );
      await client.query(
        'INSERT INTO tender_app.audit_event(id,actor_id,tender_id,action,entity_revision,entity,entity_id) VALUES($1,$2,$3,$4,1,$5,$3)',
        [randomUUID(), actor, id, 'tender.created', 'tender'],
      );
      return result.rows[0];
    });
  }
  async lots(actor: string, id: string): Promise<Lot[]> {
    // One statement prevents a separate access-check/read race.
    const result = await this.pool.query<{
      tender_id: string;
      id: string | null;
      name: string;
      ordinal: number;
    }>(
      `SELECT t.id AS tender_id,l.id,l.name,l.ordinal FROM tender_app.tender t LEFT JOIN tender_app.lot l ON l.tender_id=t.id WHERE t.id=$2 AND (${visible}) ORDER BY l.ordinal`,
      [actor, id],
    );
    if (!result.rows.length) throw new NotFoundException();
    return result.rows
      .filter((row) => row.id !== null)
      .map((row) => ({ id: row.id!, name: row.name, ordinal: row.ordinal }));
  }
}
// Called only from an authorized document transaction. The callback inserts the original
// document and its audit event; the deferred FK prevents committing a dangling receipt.
export async function receiveDocument(
  client: PoolClient,
  tenderId: string,
  key: string,
  hash: string,
  insert: (id: string) => Promise<void>,
): Promise<string> {
  const id = randomUUID();
  const claimed = await client.query(
    'INSERT INTO tender_app.document_receipt(tender_id,request_key,request_hash,document_id) VALUES($1,$2,$3,$4) ON CONFLICT(tender_id,request_key) DO NOTHING RETURNING document_id',
    [tenderId, key, hash, id],
  );
  if (claimed.rowCount) {
    await insert(id);
    return id;
  }
  // READ COMMITTED: a fresh statement sees the conflicting transaction after its commit.
  const existing = await client.query<{ document_id: string; request_hash: string }>(
    'SELECT document_id,request_hash FROM tender_app.document_receipt WHERE tender_id=$1 AND request_key=$2',
    [tenderId, key],
  );
  if (!existing.rows[0] || existing.rows[0].request_hash !== hash) throw new ConflictException();
  return existing.rows[0].document_id;
}
