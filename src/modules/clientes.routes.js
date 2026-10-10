import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db.js';
import { autenticar, escopoUnidade, exigirCliente, exigirPermissao } from '../middleware/auth.js';
import { auditar } from '../middleware/auditoria.js';
import { naoEncontrado } from '../utils/erros.js';
import { email, idParam, paginacao, telefone, validar } from '../utils/validacao.js';

export const router = Router();
router.use(autenticar);

const CAMPOS = `id, nome, email, telefone, preferencias, consentimento_termos_em, consentimento_marketing,
                anonimizado_em, criado_em, atualizado_em`;

router.get('/', exigirPermissao('clientes.ver'), async (req, res) => {
  const f = validar(paginacao.extend({ busca: z.string().trim().max(100).optional() }), req.query);
  const { rows } = await query(
    `SELECT ${CAMPOS}, count(*) OVER() AS total_registros FROM clientes
      WHERE anonimizado_em IS NULL
        AND ($1::text IS NULL OR nome ILIKE '%' || $1 || '%' OR email ILIKE '%' || $1 || '%' OR telefone LIKE '%' || $1 || '%')
      ORDER BY nome LIMIT $2 OFFSET $3`,
    [f.busca || null, f.limite, (f.pagina - 1) * f.limite]);
  res.json({ dados: rows.map(({ total_registros, ...c }) => c), total: rows[0]?.total_registros ?? 0, pagina: f.pagina });
});

router.get('/:id', exigirPermissao('clientes.ver'), async (req, res) => {
  const { id: cid } = validar(idParam, req.params);
  const { rows: [c] } = await query(`SELECT ${CAMPOS} FROM clientes WHERE id = $1`, [cid]);
  if (!c) throw naoEncontrado('Cliente');
  const { rows: [resumo] } = await query(
    `SELECT count(*)::int AS total_pedidos, COALESCE(sum(total), 0) AS total_gasto, max(criado_em) AS ultimo_pedido
       FROM pedidos WHERE cliente_id = $1 AND status NOT IN ('CANCELADO', 'AGUARDANDO_PAGAMENTO', 'PAGAMENTO_RECUSADO')`, [cid]);
  const { rows: favoritos } = await query(
    `SELECT pr.id, pr.nome, sum(ip.quantidade)::int AS quantidade
       FROM itens_pedido ip JOIN pedidos p ON p.id = ip.pedido_id JOIN produtos pr ON pr.id = ip.produto_id
      WHERE p.cliente_id = $1 AND p.status <> 'CANCELADO'
      GROUP BY pr.id ORDER BY quantidade DESC LIMIT 3`, [cid]);
  await auditar(req, 'CLIENTE_CONSULTADO', { entidade: 'clientes', entidadeId: cid });
  res.json({ ...c, resumo: { ...resumo, produtos_favoritos: favoritos } });
});

router.get('/:id/pedidos', exigirPermissao('clientes.ver', 'pedidos.ver'), async (req, res) => {
  const { id: cid } = validar(idParam, req.params);
  const f = validar(paginacao, req.query);
  const unidade = escopoUnidade(req, undefined);
  res.json(await listarPedidosDoCliente(cid, f, unidade));
});

const clienteSchema = z.object({
  nome: z.string().trim().min(2).max(120),
  email: email.optional(),
  telefone: telefone.optional(),
  preferencias: z.record(z.string(), z.unknown()).optional(),
  consentimento_termos: z.literal(true, { message: 'Confirme o consentimento do cliente para o tratamento dos dados' }),
  consentimento_marketing: z.boolean().default(false),
});

router.post('/', exigirPermissao('clientes.gerenciar'), async (req, res) => {
  const d = validar(clienteSchema, req.body);
  const { rows: [c] } = await query(
    `INSERT INTO clientes (nome, email, telefone, preferencias, consentimento_termos_em, consentimento_marketing)
     VALUES ($1,$2,$3,$4, now(), $5) RETURNING ${CAMPOS}`,
    [d.nome, d.email ?? null, d.telefone ?? null, d.preferencias ?? {}, d.consentimento_marketing]);
  res.status(201).json(c);
});

const editarSchema = z.object({
  nome: z.string().trim().min(2).max(120).optional(),
  email: email.nullable().optional(),
  telefone: telefone.nullable().optional(),
  preferencias: z.record(z.string(), z.unknown()).optional(),
  consentimento_marketing: z.boolean().optional(),
});

async function atualizarCliente(cid, d) {
  const { rows: [c] } = await query(
    `UPDATE clientes SET
        nome = COALESCE($2, nome),
        email = CASE WHEN $3::boolean THEN $4 ELSE email END,
        telefone = CASE WHEN $5::boolean THEN $6 ELSE telefone END,
        preferencias = COALESCE($7, preferencias),
        consentimento_marketing = COALESCE($8, consentimento_marketing),
        atualizado_em = now()
      WHERE id = $1 AND anonimizado_em IS NULL RETURNING ${CAMPOS}`,
    [cid, d.nome, d.email !== undefined, d.email ?? null, d.telefone !== undefined, d.telefone ?? null,
      d.preferencias ?? null, d.consentimento_marketing]);
  if (!c) throw naoEncontrado('Cliente');
  return c;
}

router.patch('/:id', exigirPermissao('clientes.gerenciar'), async (req, res) => {
  const { id: cid } = validar(idParam, req.params);
  res.json(await atualizarCliente(cid, validar(editarSchema, req.body)));
});

export const meRouter = Router();
meRouter.use(autenticar, exigirCliente);

meRouter.patch('/', async (req, res) => {
  const d = validar(editarSchema.omit({ email: true }), req.body);
  res.json(await atualizarCliente(req.auth.id, d));
});

meRouter.get('/pedidos', async (req, res) => {
  res.json(await listarPedidosDoCliente(req.auth.id, validar(paginacao, req.query), null));
});

async function listarPedidosDoCliente(clienteId, { pagina, limite }, unidadeId) {
  const { rows } = await query(
    `SELECT p.id, p.codigo_acompanhamento, p.unidade_id, u.nome AS unidade, p.canal, p.status, p.total, p.criado_em,
            count(*) OVER() AS total_registros,
            (SELECT json_agg(json_build_object('produto', pr.nome, 'quantidade', ip.quantidade, 'preco_unitario', ip.preco_unitario))
               FROM itens_pedido ip JOIN produtos pr ON pr.id = ip.produto_id WHERE ip.pedido_id = p.id) AS itens
       FROM pedidos p JOIN unidades u ON u.id = p.unidade_id
      WHERE p.cliente_id = $1 AND ($2::int IS NULL OR p.unidade_id = $2)
      ORDER BY p.criado_em DESC LIMIT $3 OFFSET $4`,
    [clienteId, unidadeId, limite, (pagina - 1) * limite]);
  return { dados: rows.map(({ total_registros, ...p }) => p), total: rows[0]?.total_registros ?? 0, pagina };
}
