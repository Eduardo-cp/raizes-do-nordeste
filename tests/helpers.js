import request from 'supertest';
import { criarApp } from '../src/app.js';
import { pool, query } from '../src/db.js';
import { migrar } from '../scripts/migrate.js';
import { semear, SENHA_DEMO_CLIENTES, SENHA_DEMO_USUARIOS } from '../scripts/seed.js';

export const app = criarApp();
export const api = () => request(app);
export { pool, query };

export async function prepararBanco() {
  if (!pool.options.connectionString.includes('test')) throw new Error('Testes só rodam em banco de teste!');
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrar(pool, { silencioso: true });
  await semear(pool, { historico: false, silencioso: true });
}

const cacheTokens = new Map();

export async function tokenUsuario(email) {
  if (cacheTokens.has(email)) return cacheTokens.get(email);
  const r = await api().post('/api/auth/login').send({ email, senha: SENHA_DEMO_USUARIOS });
  if (r.status !== 200) throw new Error(`Login falhou para ${email}: ${r.status} ${JSON.stringify(r.body)}`);
  cacheTokens.set(email, r.body.token);
  return r.body.token;
}

export async function tokenCliente(email) {
  const r = await api().post('/api/auth/clientes/login').send({ email, senha: SENHA_DEMO_CLIENTES });
  if (r.status !== 200) throw new Error(`Login de cliente falhou: ${r.status}`);
  return r.body.token;
}

export function limparCacheTokens() {
  cacheTokens.clear();
}

export const USUARIOS = {
  admin: 'admin@raizes.com.br',
  gerenteRecife: 'gerente.recife@raizes.com.br',
  atendenteRecife: 'atendente.recife@raizes.com.br',
  cozinhaRecife: 'cozinha.recife@raizes.com.br',
  gerenteFortaleza: 'gerente.fortaleza@raizes.com.br',
};

export function como(token) {
  const auth = (req) => req.set('Authorization', `Bearer ${token}`);
  return {
    get: (url) => auth(api().get(url)),
    post: (url, body) => auth(api().post(url)).send(body),
    patch: (url, body) => auth(api().patch(url)).send(body),
    put: (url, body) => auth(api().put(url)).send(body),
    delete: (url, body) => auth(api().delete(url)).send(body),
  };
}

export async function idProduto(nome) {
  const { rows: [p] } = await query('SELECT id FROM produtos WHERE nome = $1', [nome]);
  return p.id;
}

export async function posicaoEstoque(unidadeId, nomeItem) {
  const { rows: [e] } = await query(
    `SELECT e.quantidade, e.reservado FROM estoque e JOIN itens_estoque i ON i.id = e.item_estoque_id
      WHERE e.unidade_id = $1 AND i.nome = $2`, [unidadeId, nomeItem]);
  return e;
}
