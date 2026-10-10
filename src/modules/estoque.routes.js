import { Router } from 'express';
import { z } from 'zod';
import { query, transacao } from '../db.js';
import { autenticar, escopoUnidade, exigirPermissao } from '../middleware/auth.js';
import { conflito, naoEncontrado, requisicaoInvalida } from '../utils/erros.js';
import { booleanoQuery, id, idParam, paginacao, periodo, resolverPeriodo, validar } from '../utils/validacao.js';
import { publicarAlertas } from './estoque.service.js';

export const router = Router();
router.use(autenticar);

const itemSchema = z.object({
  nome: z.string().trim().min(2).max(120),
  tipo: z.enum(['INGREDIENTE', 'PRODUTO_ACABADO']),
  unidade_medida: z.enum(['UN', 'KG', 'G', 'L', 'ML']),
  ativo: z.boolean().optional(),
});

router.get('/itens', exigirPermissao('estoque.ver'), async (req, res) => {
  const { rows } = await query('SELECT * FROM itens_estoque ORDER BY nome');
  res.json(rows);
});

router.post('/itens', exigirPermissao('estoque.gerenciar'), async (req, res) => {
  const d = validar(itemSchema, req.body);
  const item = await transacao(async (client) => {
    const { rows: [i] } = await client.query(
      'INSERT INTO itens_estoque (nome, tipo, unidade_medida) VALUES ($1,$2,$3) RETURNING *', [d.nome, d.tipo, d.unidade_medida]);
    await client.query('INSERT INTO estoque (unidade_id, item_estoque_id) SELECT id, $1 FROM unidades', [i.id]);
    return i;
  });
  res.status(201).json(item);
});

router.patch('/itens/:id', exigirPermissao('estoque.gerenciar'), async (req, res) => {
  const { id: iid } = validar(idParam, req.params);
  const d = validar(itemSchema.partial(), req.body);
  const { rows: [i] } = await query(
    `UPDATE itens_estoque SET nome = COALESCE($2, nome), tipo = COALESCE($3, tipo),
            unidade_medida = COALESCE($4, unidade_medida), ativo = COALESCE($5, ativo)
      WHERE id = $1 RETURNING *`, [iid, d.nome, d.tipo, d.unidade_medida, d.ativo]);
  if (!i) throw naoEncontrado('Item de estoque');
  res.json(i);
});

const SELECT_POSICAO = `
  SELECT e.unidade_id, u.nome AS unidade, e.item_estoque_id, i.nome AS item, i.tipo, i.unidade_medida,
         e.quantidade, e.reservado, (e.quantidade - e.reservado) AS disponivel, e.estoque_minimo,
         (e.quantidade - e.reservado) <= e.estoque_minimo AS abaixo_minimo, e.atualizado_em
    FROM estoque e
    JOIN itens_estoque i ON i.id = e.item_estoque_id AND i.ativo
    JOIN unidades u ON u.id = e.unidade_id`;

router.get('/', exigirPermissao('estoque.ver'), async (req, res) => {
  const f = validar(z.object({ unidade_id: id.optional(), abaixo_minimo: booleanoQuery }), req.query);
  const unidade = escopoUnidade(req, f.unidade_id);
  const { rows } = await query(
    `${SELECT_POSICAO}
      WHERE ($1::int IS NULL OR e.unidade_id = $1)
        AND (NOT $2::boolean OR (e.quantidade - e.reservado) <= e.estoque_minimo)
      ORDER BY u.nome, i.nome`, [unidade, f.abaixo_minimo ?? false]);
  res.json(rows);
});

router.get('/alertas', exigirPermissao('estoque.ver'), async (req, res) => {
  const f = validar(z.object({ unidade_id: id.optional() }), req.query);
  const unidade = escopoUnidade(req, f.unidade_id);
  const { rows } = await query(
    `${SELECT_POSICAO}
      WHERE ($1::int IS NULL OR e.unidade_id = $1) AND (e.quantidade - e.reservado) <= e.estoque_minimo
      ORDER BY (e.quantidade - e.reservado) / NULLIF(e.estoque_minimo, 0) NULLS LAST, i.nome`, [unidade]);
  res.json(rows.map((r) => ({
    ...r,
    sugestao_reposicao: Math.max(0, Math.round((r.estoque_minimo * 2 - r.disponivel) * 1000) / 1000),
  })));
});

router.patch('/minimo', exigirPermissao('estoque.gerenciar'), async (req, res) => {
  const d = validar(z.object({ unidade_id: id.optional(), item_estoque_id: id, estoque_minimo: z.number().min(0).max(1e6) }), req.body);
  const unidade = escopoUnidade(req, d.unidade_id);
  if (unidade == null) throw requisicaoInvalida('Informe a unidade');
  const { rowCount } = await query(
    'UPDATE estoque SET estoque_minimo = $3, atualizado_em = now() WHERE unidade_id = $1 AND item_estoque_id = $2',
    [unidade, d.item_estoque_id, d.estoque_minimo]);
  if (!rowCount) throw naoEncontrado('Posição de estoque');
  await publicarAlertas(unidade, [d.item_estoque_id]);
  const { rows: [p] } = await query(`${SELECT_POSICAO} WHERE e.unidade_id = $1 AND e.item_estoque_id = $2`, [unidade, d.item_estoque_id]);
  res.json(p);
});

const movimentacaoSchema = z.object({
  unidade_id: id.optional(),
  item_estoque_id: id,
  tipo: z.enum(['ENTRADA', 'SAIDA', 'AJUSTE']),
  quantidade: z.number().min(0).max(1e6),
  custo_total: z.number().positive().max(1e7).optional(),
  observacao: z.string().trim().max(255).optional(),
}).refine((d) => d.tipo === 'AJUSTE' || d.quantidade > 0, { message: 'A quantidade deve ser maior que zero', path: ['quantidade'] })
  .refine((d) => !d.custo_total || d.tipo === 'ENTRADA', { message: 'Custo só se aplica a entradas', path: ['custo_total'] });

router.post('/movimentacoes', exigirPermissao('estoque.gerenciar'), async (req, res) => {
  const d = validar(movimentacaoSchema, req.body);
  const unidade = escopoUnidade(req, d.unidade_id);
  if (unidade == null) throw requisicaoInvalida('Informe a unidade');

  const movimentacao = await transacao(async (client) => {
    const { rows: [e] } = await client.query(
      'SELECT quantidade, reservado FROM estoque WHERE unidade_id = $1 AND item_estoque_id = $2 FOR UPDATE',
      [unidade, d.item_estoque_id]);
    if (!e) throw naoEncontrado('Posição de estoque');

    let delta;
    if (d.tipo === 'ENTRADA') delta = d.quantidade;
    else if (d.tipo === 'SAIDA') {
      if (d.quantidade > e.quantidade - e.reservado) {
        throw conflito('Quantidade maior que o saldo disponível (parte do estoque pode estar reservada para pedidos)');
      }
      delta = -d.quantidade;
    } else {
      if (d.quantidade < e.reservado) throw conflito(`O saldo não pode ficar abaixo do reservado para pedidos (${e.reservado})`);
      delta = Math.round((d.quantidade - e.quantidade) * 1000) / 1000;
    }

    await client.query(
      'UPDATE estoque SET quantidade = quantidade + $3, atualizado_em = now() WHERE unidade_id = $1 AND item_estoque_id = $2',
      [unidade, d.item_estoque_id, delta]);
    const { rows: [mov] } = await client.query(
      `INSERT INTO movimentacoes_estoque (unidade_id, item_estoque_id, tipo, quantidade, usuario_id, observacao)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [unidade, d.item_estoque_id, d.tipo, d.tipo === 'AJUSTE' ? delta : d.quantidade, req.auth.id, d.observacao ?? null]);
    if (d.custo_total) {
      await client.query(
        `INSERT INTO lancamentos_caixa (unidade_id, tipo, categoria, valor, usuario_id, descricao)
         VALUES ($1, 'SAIDA', 'COMPRA_INSUMOS', $2, $3, $4)`,
        [unidade, d.custo_total, req.auth.id, `Compra de insumos - movimentação #${mov.id}`]);
    }
    return mov;
  });
  await publicarAlertas(unidade, [d.item_estoque_id]);
  const { rows: [posicao] } = await query(`${SELECT_POSICAO} WHERE e.unidade_id = $1 AND e.item_estoque_id = $2`, [unidade, d.item_estoque_id]);
  res.status(201).json({ movimentacao, posicao });
});

router.get('/movimentacoes', exigirPermissao('estoque.ver'), async (req, res) => {
  const f = validar(paginacao.extend({
    unidade_id: id.optional(),
    item_estoque_id: id.optional(),
    tipo: z.enum(['ENTRADA', 'SAIDA', 'AJUSTE', 'RESERVA', 'LIBERACAO_RESERVA', 'BAIXA_PEDIDO', 'ESTORNO']).optional(),
    ...periodo,
  }), req.query);
  Object.assign(f, resolverPeriodo(f));
  const unidade = escopoUnidade(req, f.unidade_id);
  const { rows } = await query(
    `SELECT m.id, m.unidade_id, u.nome AS unidade, m.item_estoque_id, i.nome AS item, i.unidade_medida, m.tipo,
            m.quantidade, m.pedido_id, m.usuario_id, us.nome AS usuario, m.observacao, m.criado_em,
            count(*) OVER() AS total_registros
       FROM movimentacoes_estoque m
       JOIN itens_estoque i ON i.id = m.item_estoque_id
       JOIN unidades u ON u.id = m.unidade_id
       LEFT JOIN usuarios us ON us.id = m.usuario_id
      WHERE ($1::int IS NULL OR m.unidade_id = $1) AND ($2::int IS NULL OR m.item_estoque_id = $2)
        AND ($3::text IS NULL OR m.tipo = $3)
        AND m.criado_em >= $4::date AND m.criado_em < $5::date + 1
      ORDER BY m.criado_em DESC, m.id DESC LIMIT $6 OFFSET $7`,
    [unidade, f.item_estoque_id ?? null, f.tipo ?? null, f.inicio, f.fim, f.limite, (f.pagina - 1) * f.limite]);
  res.json({ dados: rows.map(({ total_registros, ...m }) => m), total: rows[0]?.total_registros ?? 0, pagina: f.pagina });
});
