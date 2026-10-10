import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const pastaMigracoes = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../db/migrations');

export async function migrar(pool, { silencioso = false } = {}) {
  await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    nome VARCHAR(255) PRIMARY KEY, aplicado_em TIMESTAMPTZ NOT NULL DEFAULT now())`);
  const { rows } = await pool.query('SELECT nome FROM schema_migrations');
  const aplicadas = new Set(rows.map((r) => r.nome));
  const arquivos = fs.readdirSync(pastaMigracoes).filter((f) => f.endsWith('.sql')).sort();

  for (const arquivo of arquivos) {
    if (aplicadas.has(arquivo)) continue;
    const sql = fs.readFileSync(path.join(pastaMigracoes, arquivo), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (nome) VALUES ($1)', [arquivo]);
      await client.query('COMMIT');
      if (!silencioso) console.log(`Migração aplicada: ${arquivo}`);
    } catch (err) {
      await client.query('ROLLBACK');
      throw new Error(`Falha na migração ${arquivo}: ${err.message}`);
    } finally {
      client.release();
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { pool } = await import('../src/db.js');
  try {
    await migrar(pool);
    console.log('Banco atualizado.');
  } finally {
    await pool.end();
  }
}
