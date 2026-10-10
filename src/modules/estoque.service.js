import { query } from '../db.js';
import { conflito } from '../utils/erros.js';
import { publicar } from '../utils/eventos.js';

const arred = (n) => Math.round(n * 1000) / 1000;

async function calcularNecessidade(client, itens) {
  const ids = [...new Set(itens.map((i) => i.produto_id))];
  const { rows } = await client.query(
    `SELECT pc.produto_id, pc.item_estoque_id, pc.quantidade, i.nome AS item, p.nome AS produto
       FROM produto_composicao pc
       JOIN itens_estoque i ON i.id = pc.item_estoque_id
       JOIN produtos p ON p.id = pc.produto_id
      WHERE pc.produto_id = ANY($1)`, [ids]);
  const necessidade = new Map();
  for (const it of itens) {
    for (const c of rows.filter((r) => r.produto_id === it.produto_id)) {
      const atual = necessidade.get(c.item_estoque_id) ?? { quantidade: 0, item: c.item, produtos: new Set() };
      atual.quantidade = arred(atual.quantidade + c.quantidade * it.quantidade);
      atual.produtos.add(c.produto);
      necessidade.set(c.item_estoque_id, atual);
    }
  }
  return necessidade;
}

async function travarEstoque(client, unidadeId, itemIds) {
  const { rows } = await client.query(
    `SELECT item_estoque_id, quantidade, reservado FROM estoque
      WHERE unidade_id = $1 AND item_estoque_id = ANY($2)
      ORDER BY item_estoque_id FOR UPDATE`, [unidadeId, itemIds]);
  return new Map(rows.map((r) => [r.item_estoque_id, r]));
}

export async function reservar(client, { unidadeId, pedidoId, itens, usuarioId }) {
  const necessidade = await calcularNecessidade(client, itens);
  const itemIds = [...necessidade.keys()];
  const estoque = await travarEstoque(client, unidadeId, itemIds);

  const faltas = [];
  for (const [itemId, n] of necessidade) {
    const e = estoque.get(itemId);
    const disponivel = e ? arred(e.quantidade - e.reservado) : 0;
    if (disponivel < n.quantidade) {
      faltas.push({ item: n.item, necessario: n.quantidade, disponivel, produtos_afetados: [...n.produtos] });
    }
  }
  if (faltas.length) throw conflito('Estoque insuficiente para atender o pedido', faltas);

  for (const [itemId, n] of necessidade) {
    await client.query(
      'UPDATE estoque SET reservado = reservado + $3, atualizado_em = now() WHERE unidade_id = $1 AND item_estoque_id = $2',
      [unidadeId, itemId, n.quantidade]);
    await client.query(
      `INSERT INTO movimentacoes_estoque (unidade_id, item_estoque_id, tipo, quantidade, pedido_id, usuario_id)
       VALUES ($1,$2,'RESERVA',$3,$4,$5)`, [unidadeId, itemId, n.quantidade, pedidoId, usuarioId ?? null]);
  }
  return itemIds;
}

async function reservasDoPedido(client, pedidoId) {
  const { rows } = await client.query(
    `SELECT item_estoque_id, unidade_id, sum(quantidade) AS quantidade FROM movimentacoes_estoque
      WHERE pedido_id = $1 AND tipo = 'RESERVA' GROUP BY item_estoque_id, unidade_id ORDER BY item_estoque_id`, [pedidoId]);
  return rows;
}

async function aplicar(client, pedidoId, usuarioId, tipo, sqlSet) {
  const reservas = await reservasDoPedido(client, pedidoId);
  if (!reservas.length) return [];
  await travarEstoque(client, reservas[0].unidade_id, reservas.map((r) => r.item_estoque_id));
  for (const r of reservas) {
    await client.query(
      `UPDATE estoque SET ${sqlSet}, atualizado_em = now() WHERE unidade_id = $1 AND item_estoque_id = $2`,
      [r.unidade_id, r.item_estoque_id, r.quantidade]);
    await client.query(
      `INSERT INTO movimentacoes_estoque (unidade_id, item_estoque_id, tipo, quantidade, pedido_id, usuario_id)
       VALUES ($1,$2,$3,$4,$5,$6)`, [r.unidade_id, r.item_estoque_id, tipo, r.quantidade, pedidoId, usuarioId ?? null]);
  }
  return reservas.map((r) => r.item_estoque_id);
}

export const baixarReserva = (client, pedidoId, usuarioId) =>
  aplicar(client, pedidoId, usuarioId, 'BAIXA_PEDIDO', 'quantidade = quantidade - $3, reservado = reservado - $3');

export const liberarReserva = (client, pedidoId, usuarioId) =>
  aplicar(client, pedidoId, usuarioId, 'LIBERACAO_RESERVA', 'reservado = reservado - $3');

export const estornarBaixa = (client, pedidoId, usuarioId) =>
  aplicar(client, pedidoId, usuarioId, 'ESTORNO', 'quantidade = quantidade + $3');

export async function publicarAlertas(unidadeId, itemIds) {
  if (!itemIds?.length) return;
  const { rows } = await query(
    `SELECT e.unidade_id, e.item_estoque_id, i.nome AS item, i.unidade_medida,
            e.quantidade, e.reservado, (e.quantidade - e.reservado) AS disponivel, e.estoque_minimo
       FROM estoque e JOIN itens_estoque i ON i.id = e.item_estoque_id
      WHERE e.unidade_id = $1 AND e.item_estoque_id = ANY($2) AND (e.quantidade - e.reservado) <= e.estoque_minimo`,
    [unidadeId, itemIds]);
  for (const alerta of rows) publicar('estoque.alerta', alerta);
}
