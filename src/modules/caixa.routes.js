import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db.js';
import { autenticar, escopoUnidade, exigirPermissao } from '../middleware/auth.js';
import { requisicaoInvalida } from '../utils/erros.js';
import { id, paginacao, periodo, resolverPeriodo, validar } from '../utils/validacao.js';

export const caixaRouter = Router();
caixaRouter.use(autenticar);

const lancamentoSchema = z.object({
  unidade_id: id.optional(),
  tipo: z.enum(['ENTRADA', 'SAIDA']),
  categoria: z.enum(['COMPRA_INSUMOS', 'DESPESA', 'SUPRIMENTO', 'SANGRIA', 'OUTROS']),
  valor: z.number().positive().max(1e7).multipleOf(0.01),
  forma_pagamento: z.enum(['PIX', 'CARTAO_CREDITO', 'CARTAO_DEBITO', 'DINHEIRO']).optional(),
  descricao: z.string().trim().min(3).max(255),
});

caixaRouter.post('/lancamentos', exigirPermissao('caixa.lancar'), async (req, res) => {
  const d = validar(lancamentoSchema, req.body);
  const unidade = escopoUnidade(req, d.unidade_id);
  if (unidade == null) throw requisicaoInvalida('Informe a unidade');
  const { rows: [l] } = await query(
    `INSERT INTO lancamentos_caixa (unidade_id, tipo, categoria, valor, forma_pagamento, usuario_id, descricao)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [unidade, d.tipo, d.categoria, d.valor, d.forma_pagamento ?? null, req.auth.id, d.descricao]);
  res.status(201).json(l);
});

caixaRouter.get('/lancamentos', exigirPermissao('relatorios.ver'), async (req, res) => {
  const f = validar(paginacao.extend({ unidade_id: id.optional(), tipo: z.enum(['ENTRADA', 'SAIDA']).optional(), ...periodo }), req.query);
  Object.assign(f, resolverPeriodo(f));
  const unidade = escopoUnidade(req, f.unidade_id);
  const { rows } = await query(
    `SELECT l.*, u.nome AS unidade, us.nome AS usuario, count(*) OVER() AS total_registros
       FROM lancamentos_caixa l JOIN unidades u ON u.id = l.unidade_id LEFT JOIN usuarios us ON us.id = l.usuario_id
      WHERE ($1::int IS NULL OR l.unidade_id = $1) AND ($2::text IS NULL OR l.tipo = $2)
        AND l.criado_em::date BETWEEN $3 AND $4
      ORDER BY l.criado_em DESC, l.id DESC LIMIT $5 OFFSET $6`,
    [unidade, f.tipo ?? null, f.inicio, f.fim, f.limite, (f.pagina - 1) * f.limite]);
  res.json({ dados: rows.map(({ total_registros, ...l }) => l), total: rows[0]?.total_registros ?? 0, pagina: f.pagina });
});

export const auditoriaRouter = Router();
auditoriaRouter.use(autenticar, exigirPermissao('auditoria.ver'));

auditoriaRouter.get('/', async (req, res) => {
  const f = validar(paginacao.extend({
    acao: z.string().max(120).optional(),
    entidade: z.string().max(40).optional(),
    ator_tipo: z.enum(['USUARIO', 'CLIENTE', 'SISTEMA', 'ANONIMO']).optional(),
    ...periodo,
  }), req.query);
  Object.assign(f, resolverPeriodo(f));
  const unidade = req.auth.unidadeId;
  const { rows } = await query(
    `SELECT a.id, a.ator_tipo, a.ator_id, COALESCE(us.nome, c.nome) AS ator_nome, a.acao, a.entidade, a.entidade_id,
            a.ip, a.detalhes, a.criado_em, count(*) OVER() AS total_registros
       FROM audit_log a
       LEFT JOIN usuarios us ON a.ator_tipo = 'USUARIO' AND us.id = a.ator_id
       LEFT JOIN clientes c ON a.ator_tipo = 'CLIENTE' AND c.id = a.ator_id
      WHERE ($1::text IS NULL OR a.acao ILIKE '%' || $1 || '%') AND ($2::text IS NULL OR a.entidade = $2)
        AND ($3::text IS NULL OR a.ator_tipo = $3) AND a.criado_em::date BETWEEN $4 AND $5
        AND ($6::int IS NULL OR us.unidade_id = $6)
      ORDER BY a.id DESC LIMIT $7 OFFSET $8`,
    [f.acao ?? null, f.entidade ?? null, f.ator_tipo ?? null, f.inicio, f.fim, unidade, f.limite, (f.pagina - 1) * f.limite]);
  res.json({ dados: rows.map(({ total_registros, ...a }) => a), total: rows[0]?.total_registros ?? 0, pagina: f.pagina });
});
