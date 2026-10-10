import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { query } from '../db.js';
import { autenticar, escopoUnidade, exigirPermissao, verificarUnidade } from '../middleware/auth.js';
import { naoEncontrado, proibido, requisicaoInvalida } from '../utils/erros.js';
import { email, id, idParam, paginacao, senhaForte, validar } from '../utils/validacao.js';

export const router = Router();
router.use(autenticar, exigirPermissao('usuarios.gerenciar'));

const CAMPOS = `u.id, u.nome, u.email, u.perfil_id, p.nome AS perfil, u.unidade_id, un.nome AS unidade,
                u.ativo, u.criado_em, u.atualizado_em`;
const FROM = `FROM usuarios u JOIN perfis p ON p.id = u.perfil_id LEFT JOIN unidades un ON un.id = u.unidade_id`;

async function validarAtribuicao(req, perfilId, unidadeId) {
  const { rowCount: perfilExiste } = await query('SELECT 1 FROM perfis WHERE id = $1', [perfilId]);
  if (!perfilExiste) throw requisicaoInvalida('Perfil inexistente');
  const { rows } = await query('SELECT permissao FROM perfil_permissoes WHERE perfil_id = $1', [perfilId]);
  const excedentes = rows.map((r) => r.permissao).filter((p) => !req.auth.permissoes.has(p));
  if (excedentes.length) throw proibido(`Você não pode atribuir um perfil com permissões que não possui: ${excedentes.join(', ')}`);
  if (req.auth.unidadeId != null && unidadeId !== req.auth.unidadeId) {
    throw proibido('Você só pode gerenciar usuários da sua unidade');
  }
  if (unidadeId != null) {
    const { rowCount } = await query('SELECT 1 FROM unidades WHERE id = $1', [unidadeId]);
    if (!rowCount) throw requisicaoInvalida('Unidade inexistente');
  }
}

router.get('/', async (req, res) => {
  const f = validar(paginacao.extend({ unidade_id: id.optional(), busca: z.string().max(100).optional() }), req.query);
  const unidade = escopoUnidade(req, f.unidade_id);
  const { rows } = await query(
    `SELECT ${CAMPOS}, count(*) OVER() AS total_registros ${FROM}
      WHERE ($1::int IS NULL OR u.unidade_id = $1)
        AND ($2::text IS NULL OR u.nome ILIKE '%' || $2 || '%' OR u.email ILIKE '%' || $2 || '%')
      ORDER BY u.nome LIMIT $3 OFFSET $4`,
    [unidade, f.busca ?? null, f.limite, (f.pagina - 1) * f.limite]);
  res.json({ dados: rows.map(({ total_registros, ...u }) => u), total: rows[0]?.total_registros ?? 0, pagina: f.pagina });
});

router.get('/:id', async (req, res) => {
  const { id: uid } = validar(idParam, req.params);
  const { rows: [u] } = await query(`SELECT ${CAMPOS} ${FROM} WHERE u.id = $1`, [uid]);
  if (!u) throw naoEncontrado('Usuário');
  verificarUnidade(req, u.unidade_id);
  res.json(u);
});

const criarSchema = z.object({
  nome: z.string().trim().min(2).max(120),
  email,
  senha: senhaForte,
  perfil_id: id,
  unidade_id: id.nullable().optional(),
});

router.post('/', async (req, res) => {
  const d = validar(criarSchema, req.body);
  const unidadeId = d.unidade_id === undefined ? req.auth.unidadeId : d.unidade_id;
  await validarAtribuicao(req, d.perfil_id, unidadeId);
  const { rows: [u] } = await query(
    `INSERT INTO usuarios (nome, email, senha_hash, perfil_id, unidade_id) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [d.nome, d.email, await bcrypt.hash(d.senha, 10), d.perfil_id, unidadeId]);
  const { rows: [criado] } = await query(`SELECT ${CAMPOS} ${FROM} WHERE u.id = $1`, [u.id]);
  res.status(201).json(criado);
});

const editarSchema = z.object({
  nome: z.string().trim().min(2).max(120).optional(),
  perfil_id: id.optional(),
  unidade_id: id.nullable().optional(),
  ativo: z.boolean().optional(),
  senha: senhaForte.optional(),
});

router.patch('/:id', async (req, res) => {
  const { id: uid } = validar(idParam, req.params);
  const d = validar(editarSchema, req.body);
  const { rows: [atual] } = await query('SELECT id, perfil_id, unidade_id FROM usuarios WHERE id = $1', [uid]);
  if (!atual) throw naoEncontrado('Usuário');
  verificarUnidade(req, atual.unidade_id);
  await validarAtribuicao(req, atual.perfil_id, atual.unidade_id);
  if (uid === req.auth.id && (d.ativo === false || d.perfil_id !== undefined)) {
    throw requisicaoInvalida('Você não pode desativar nem alterar o perfil da sua própria conta');
  }
  const perfilId = d.perfil_id ?? atual.perfil_id;
  const unidadeId = d.unidade_id === undefined ? atual.unidade_id : d.unidade_id;
  if (d.perfil_id !== undefined || d.unidade_id !== undefined) await validarAtribuicao(req, perfilId, unidadeId);

  await query(
    `UPDATE usuarios SET nome = COALESCE($2, nome), perfil_id = $3, unidade_id = $4, ativo = COALESCE($5, ativo),
            senha_hash = COALESCE($6, senha_hash), atualizado_em = now(),
            tentativas_falhas = CASE WHEN $6 IS NOT NULL THEN 0 ELSE tentativas_falhas END,
            bloqueado_ate = CASE WHEN $6 IS NOT NULL THEN NULL ELSE bloqueado_ate END
      WHERE id = $1`,
    [uid, d.nome, perfilId, unidadeId, d.ativo, d.senha ? await bcrypt.hash(d.senha, 10) : null]);
  const { rows: [u] } = await query(`SELECT ${CAMPOS} ${FROM} WHERE u.id = $1`, [uid]);
  res.json(u);
});
