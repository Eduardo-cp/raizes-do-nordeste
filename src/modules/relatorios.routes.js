import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db.js';
import { autenticar, escopoUnidade, exigirPermissao } from '../middleware/auth.js';
import { responderRelatorio } from '../utils/csv.js';
import { id, periodo, resolverPeriodo, validar } from '../utils/validacao.js';

export const router = Router();
router.use(autenticar, exigirPermissao('relatorios.ver'));

const VENDIDOS = `('PAGO', 'EM_PREPARO', 'PRONTO', 'SAIU_PARA_ENTREGA', 'ENTREGUE')`;

function filtros(req) {
  const f = validar(z.object({ unidade_id: id.optional(), formato: z.enum(['json', 'csv']).optional(), ...periodo }), req.query);
  return { ...resolverPeriodo(f), unidade: escopoUnidade(req, f.unidade_id) };
}

router.get('/dashboard', async (req, res) => {
  const { unidade } = filtros(req);
  const [hoje, andamento, alertas, semana] = await Promise.all([
    query(`SELECT count(*) FILTER (WHERE status IN ${VENDIDOS})::int AS pedidos_vendidos,
                  COALESCE(sum(total) FILTER (WHERE status IN ${VENDIDOS}), 0) AS faturamento,
                  count(*) FILTER (WHERE status = 'CANCELADO')::int AS cancelados
             FROM pedidos WHERE criado_em::date = current_date AND ($1::int IS NULL OR unidade_id = $1)`, [unidade]),
    query(`SELECT status, count(*)::int AS quantidade FROM pedidos
            WHERE status IN ('AGUARDANDO_PAGAMENTO', 'PAGAMENTO_RECUSADO', 'PAGO', 'EM_PREPARO', 'PRONTO', 'SAIU_PARA_ENTREGA')
              AND ($1::int IS NULL OR unidade_id = $1) GROUP BY status`, [unidade]),
    query(`SELECT count(*)::int AS itens_abaixo_minimo FROM estoque e JOIN itens_estoque i ON i.id = e.item_estoque_id AND i.ativo
            WHERE (e.quantidade - e.reservado) <= e.estoque_minimo AND ($1::int IS NULL OR e.unidade_id = $1)`, [unidade]),
    query(`SELECT d::date AS data, COALESCE(sum(p.total), 0) AS faturamento, count(p.id)::int AS pedidos
             FROM generate_series(current_date - 6, current_date, interval '1 day') d
             LEFT JOIN pedidos p ON p.criado_em::date = d::date AND p.status IN ${VENDIDOS} AND ($1::int IS NULL OR p.unidade_id = $1)
            GROUP BY d ORDER BY d`, [unidade]),
  ]);
  const h = hoje.rows[0];
  res.json({
    hoje: { ...h, ticket_medio: h.pedidos_vendidos ? Math.round((h.faturamento / h.pedidos_vendidos) * 100) / 100 : 0 },
    pedidos_em_andamento: Object.fromEntries(andamento.rows.map((r) => [r.status, r.quantidade])),
    alertas_estoque: alertas.rows[0].itens_abaixo_minimo,
    ultimos_7_dias: semana.rows,
  });
});

router.get('/vendas', async (req, res) => {
  const { inicio, fim, unidade } = filtros(req);
  const params = [inicio, fim, unidade];
  const onde = `p.criado_em::date BETWEEN $1 AND $2 AND ($3::int IS NULL OR p.unidade_id = $3)`;
  const [resumo, porDia, porProduto, porCategoria, porCanal, porForma, porUnidade] = await Promise.all([
    query(`SELECT count(*) FILTER (WHERE p.status IN ${VENDIDOS})::int AS pedidos,
                  COALESCE(sum(p.total) FILTER (WHERE p.status IN ${VENDIDOS}), 0) AS faturamento,
                  count(*) FILTER (WHERE p.status = 'CANCELADO')::int AS cancelados
             FROM pedidos p WHERE ${onde}`, params),
    query(`SELECT p.criado_em::date AS data, count(*)::int AS pedidos, sum(p.total) AS faturamento
             FROM pedidos p WHERE ${onde} AND p.status IN ${VENDIDOS} GROUP BY 1 ORDER BY 1`, params),
    query(`SELECT pr.id AS produto_id, pr.nome AS produto, c.nome AS categoria,
                  sum(ip.quantidade)::int AS quantidade, sum(ip.quantidade * ip.preco_unitario) AS faturamento
             FROM itens_pedido ip JOIN pedidos p ON p.id = ip.pedido_id
             JOIN produtos pr ON pr.id = ip.produto_id JOIN categorias c ON c.id = pr.categoria_id
            WHERE ${onde} AND p.status IN ${VENDIDOS} GROUP BY pr.id, c.nome ORDER BY faturamento DESC`, params),
    query(`SELECT c.nome AS categoria, sum(ip.quantidade)::int AS quantidade, sum(ip.quantidade * ip.preco_unitario) AS faturamento
             FROM itens_pedido ip JOIN pedidos p ON p.id = ip.pedido_id
             JOIN produtos pr ON pr.id = ip.produto_id JOIN categorias c ON c.id = pr.categoria_id
            WHERE ${onde} AND p.status IN ${VENDIDOS} GROUP BY c.nome ORDER BY faturamento DESC`, params),
    query(`SELECT p.canal, count(*)::int AS pedidos, sum(p.total) AS faturamento
             FROM pedidos p WHERE ${onde} AND p.status IN ${VENDIDOS} GROUP BY 1 ORDER BY faturamento DESC`, params),
    query(`SELECT pg.metodo AS forma_pagamento, count(*)::int AS pagamentos, sum(pg.valor) AS valor
             FROM pagamentos pg JOIN pedidos p ON p.id = pg.pedido_id
            WHERE ${onde} AND pg.status = 'APROVADO' GROUP BY 1 ORDER BY valor DESC`, params),
    query(`SELECT u.id AS unidade_id, u.nome AS unidade, count(p.id)::int AS pedidos, COALESCE(sum(p.total), 0) AS faturamento
             FROM pedidos p JOIN unidades u ON u.id = p.unidade_id
            WHERE ${onde} AND p.status IN ${VENDIDOS} GROUP BY u.id ORDER BY faturamento DESC`, params),
  ]);
  const r = resumo.rows[0];
  const dados = {
    periodo: { inicio, fim }, unidade_id: unidade,
    resumo: { ...r, ticket_medio: r.pedidos ? Math.round((r.faturamento / r.pedidos) * 100) / 100 : 0 },
    por_dia: porDia.rows, por_produto: porProduto.rows, por_categoria: porCategoria.rows,
    por_canal: porCanal.rows, por_forma_pagamento: porForma.rows, por_unidade: porUnidade.rows,
  };
  responderRelatorio(req, res, `vendas_${inicio}_${fim}`, dados,
    porProduto.rows.map((p) => ({ produto: p.produto, categoria: p.categoria, quantidade: p.quantidade, faturamento: p.faturamento })));
});

router.get('/fluxo-caixa', async (req, res) => {
  const { inicio, fim, unidade } = filtros(req);
  const params = [inicio, fim, unidade];
  const onde = `l.criado_em::date BETWEEN $1 AND $2 AND ($3::int IS NULL OR l.unidade_id = $3)`;
  const [totais, porDia, porCategoria, porForma, saldoAnterior] = await Promise.all([
    query(`SELECT COALESCE(sum(valor) FILTER (WHERE tipo = 'ENTRADA'), 0) AS entradas,
                  COALESCE(sum(valor) FILTER (WHERE tipo = 'SAIDA'), 0) AS saidas
             FROM lancamentos_caixa l WHERE ${onde}`, params),
    query(`SELECT l.criado_em::date AS data,
                  COALESCE(sum(valor) FILTER (WHERE tipo = 'ENTRADA'), 0) AS entradas,
                  COALESCE(sum(valor) FILTER (WHERE tipo = 'SAIDA'), 0) AS saidas
             FROM lancamentos_caixa l WHERE ${onde} GROUP BY 1 ORDER BY 1`, params),
    query(`SELECT tipo, categoria, count(*)::int AS lancamentos, sum(valor) AS valor
             FROM lancamentos_caixa l WHERE ${onde} GROUP BY 1, 2 ORDER BY 1, valor DESC`, params),
    query(`SELECT forma_pagamento, sum(CASE WHEN tipo = 'ENTRADA' THEN valor ELSE -valor END) AS liquido
             FROM lancamentos_caixa l WHERE ${onde} AND forma_pagamento IS NOT NULL GROUP BY 1 ORDER BY 2 DESC`, params),
    query(`SELECT COALESCE(sum(CASE WHEN tipo = 'ENTRADA' THEN valor ELSE -valor END), 0) AS saldo
             FROM lancamentos_caixa l WHERE l.criado_em::date < $1 AND ($2::int IS NULL OR l.unidade_id = $2)`, [inicio, unidade]),
  ]);
  let acumulado = saldoAnterior.rows[0].saldo;
  const dias = porDia.rows.map((d) => {
    const saldo = Math.round((d.entradas - d.saidas) * 100) / 100;
    acumulado = Math.round((acumulado + saldo) * 100) / 100;
    return { ...d, saldo_dia: saldo, saldo_acumulado: acumulado };
  });
  const t = totais.rows[0];
  const dados = {
    periodo: { inicio, fim }, unidade_id: unidade,
    resumo: { saldo_inicial: saldoAnterior.rows[0].saldo, entradas: t.entradas, saidas: t.saidas,
      resultado: Math.round((t.entradas - t.saidas) * 100) / 100, saldo_final: acumulado },
    por_dia: dias, por_categoria: porCategoria.rows, por_forma_pagamento: porForma.rows,
  };
  responderRelatorio(req, res, `fluxo-caixa_${inicio}_${fim}`, dados, dias);
});

router.get('/estoque', async (req, res) => {
  const { inicio, fim, unidade } = filtros(req);
  const dias = Math.max(1, Math.round((new Date(fim) - new Date(inicio)) / 86_400_000) + 1);
  const { rows } = await query(
    `WITH mov AS (
       SELECT unidade_id, item_estoque_id,
              COALESCE(sum(quantidade) FILTER (WHERE tipo = 'ENTRADA'), 0) AS entradas,
              COALESCE(sum(quantidade) FILTER (WHERE tipo = 'BAIXA_PEDIDO'), 0)
                - COALESCE(sum(quantidade) FILTER (WHERE tipo = 'ESTORNO'), 0) AS consumo_vendas,
              COALESCE(sum(quantidade) FILTER (WHERE tipo = 'SAIDA'), 0) AS perdas,
              COALESCE(sum(quantidade) FILTER (WHERE tipo = 'AJUSTE'), 0) AS ajustes
         FROM movimentacoes_estoque
        WHERE criado_em::date BETWEEN $1 AND $2 AND ($3::int IS NULL OR unidade_id = $3)
        GROUP BY 1, 2)
     SELECT u.nome AS unidade, i.nome AS item, i.tipo, i.unidade_medida,
            e.quantidade AS saldo_atual, e.reservado, (e.quantidade - e.reservado) AS disponivel, e.estoque_minimo,
            COALESCE(m.entradas, 0) AS entradas, COALESCE(m.consumo_vendas, 0) AS consumo_vendas,
            COALESCE(m.perdas, 0) AS perdas, COALESCE(m.ajustes, 0) AS ajustes
       FROM estoque e
       JOIN itens_estoque i ON i.id = e.item_estoque_id AND i.ativo
       JOIN unidades u ON u.id = e.unidade_id
       LEFT JOIN mov m ON m.unidade_id = e.unidade_id AND m.item_estoque_id = e.item_estoque_id
      WHERE ($3::int IS NULL OR e.unidade_id = $3)
      ORDER BY u.nome, i.nome`, [inicio, fim, unidade]);
  const itens = rows.map((r) => {
    const consumoDiario = Math.round((r.consumo_vendas / dias) * 1000) / 1000;
    return {
      ...r,
      consumo_medio_diario: consumoDiario,
      dias_de_cobertura: consumoDiario > 0 ? Math.floor(r.disponivel / consumoDiario) : null,
      situacao: r.disponivel <= r.estoque_minimo ? 'REPOR' : 'OK',
    };
  });
  const dados = { periodo: { inicio, fim }, unidade_id: unidade, itens_abaixo_minimo: itens.filter((i) => i.situacao === 'REPOR').length, itens };
  responderRelatorio(req, res, `estoque_${inicio}_${fim}`, dados, itens);
});
