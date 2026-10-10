import { pool } from '../src/db.js';
import { config } from '../src/config.js';
import { migrar } from './migrate.js';
import { semear } from './seed.js';

const host = new URL(config.databaseUrl).hostname;
const local = ['localhost', '127.0.0.1', '::1'].includes(host);
if (config.producao || (!local && !process.argv.includes('--confirmo-apagar-banco-remoto'))) {
  console.error(`Reset bloqueado: o banco "${host}" não é local. Isto APAGARIA todos os dados.`);
  console.error('Para um banco remoto novo, use "npm run db:migrate" e "npm run db:seed".');
  process.exit(1);
}

try {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrar(pool);
  await semear(pool);
} finally {
  await pool.end();
}
