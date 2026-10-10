import { Router } from 'express';
import { z } from 'zod';
import { query, transacao } from '../db.js';
import { autenticar, exigirPermissao, exigirUsuario } from '../middleware/auth.js';
import { conflito, naoEncontrado, proibido, requisicaoInvalida } from '../utils/erros.js';
import { idParam, validar } from '../utils/validacao.js';

export const router = Router();
router.use(autenticar, exigirUsuario);

function podeLer(req, res, next) {
  if (!req.auth.permissoes.has('perfis.gerenciar') && !req.auth.permissoes.has('usuarios.gerenciar')) throw proibido();
  next();
}

const LISTAR = `SELECT p.id, p.nome, p.descricao, p.sistema,
                       COALESCE(array_agg(pp.permissao ORDER BY pp.permissao) FILTER (WHERE pp.permissao IS NOT NULL), '{}') AS permissoes
                  FROM perfis p LEFT JOIN perfil_permissoes pp ON pp.perfil_id = p.id`;

router.get('/permissoes', podeLer, async (req, res) => {
  const { rows } = await query('SELECT codigo, descricao FROM permissoes ORDER BY codigo');
  res.json(rows);
});

router.get('/', podeLer, async (req, res) => {
  const { rows } = await query(`${LISTAR} GROUP BY p.id ORDER BY p.id`);
  res.json(rows);
});

const perfilSchema = z.object({
  nome: z.string().trim().toUpperCase().min(2).max(60),
  descricao: z.string().trim().max(255).optional(),
  permissoes: z.array(z.string()).max(100),
});

async function salvarPermissoes(client, perfilId, permissoes) {
  const unicas = [...new Set(permissoes)];
  const { rows } = await client.query('SELECT codigo FROM permissoes WHERE codigo = ANY($1)', [unicas]);
  if (rows.length !== unicas.length) {
    const validas = new Set(rows.map((r) => r.codigo));
    throw requisicaoInvalida('Permissões inexistentes', unicas.filter((p) => !validas.has(p)));
  }
  await client.query('DELETE FROM perfil_permissoes WHERE perfil_id = $1', [perfilId]);
  await client.query(
    'INSERT INTO perfil_permissoes (perfil_id, permissao) SELECT $1, unnest($2::varchar[])', [perfilId, unicas]);
}

router.post('/', exigirPermissao('perfis.gerenciar'), async (req, res) => {
  const d = validar(perfilSchema, req.body);
  const perfil = await transacao(async (client) => {
    const { rows: [p] } = await client.query(
      'INSERT INTO perfis (nome, descricao) VALUES ($1,$2) RETURNING id', [d.nome, d.descricao ?? null]);
    await salvarPermissoes(client, p.id, d.permissoes);
    return p;
  });
  const { rows: [p] } = await query(`${LISTAR} WHERE p.id = $1 GROUP BY p.id`, [perfil.id]);
  res.status(201).json(p);
});

router.put('/:id', exigirPermissao('perfis.gerenciar'), async (req, res) => {
  const { id } = validar(idParam, req.params);
  const d = validar(perfilSchema.partial({ nome: true }), req.body);
  const { rows: [atual] } = await query('SELECT id, nome FROM perfis WHERE id = $1', [id]);
  if (!atual) throw naoEncontrado('Perfil');
  if (atual.nome === 'ADMIN') throw proibido('O perfil ADMIN não pode ser alterado');
  await transacao(async (client) => {
    await client.query('UPDATE perfis SET nome = COALESCE($2, nome), descricao = COALESCE($3, descricao) WHERE id = $1',
      [id, d.nome, d.descricao]);
    await salvarPermissoes(client, id, d.permissoes);
  });
  const { rows: [p] } = await query(`${LISTAR} WHERE p.id = $1 GROUP BY p.id`, [id]);
  res.json(p);
});

router.delete('/:id', exigirPermissao('perfis.gerenciar'), async (req, res) => {
  const { id } = validar(idParam, req.params);
  const { rows: [p] } = await query('SELECT sistema FROM perfis WHERE id = $1', [id]);
  if (!p) throw naoEncontrado('Perfil');
  if (p.sistema) throw proibido('Perfis padrão do sistema não podem ser excluídos');
  const { rowCount } = await query('SELECT 1 FROM usuarios WHERE perfil_id = $1 LIMIT 1', [id]);
  if (rowCount) throw conflito('Há usuários usando este perfil');
  await query('DELETE FROM perfis WHERE id = $1', [id]);
  res.status(204).end();
});
