import crypto from 'node:crypto';
import { query, transacao } from '../db.js';
import { AppError, conflito, naoEncontrado, proibido, requisicaoInvalida } from '../utils/erros.js';
import { publicar } from '../utils/eventos.js';
import { gatewayAtivo, gatewayPorNome } from '../pagamentos/index.js';
import { baixarReserva, estornarBaixa, liberarReserva, publicarAlertas, reservar } from './estoque.service.js';
import { config } from '../config.js';

export const TRANSICOES = {
  AGUARDANDO_PAGAMENTO: ['PAGO', 'PAGAMENTO_RECUSADO', 'CANCELADO'],
  PAGAMENTO_RECUSADO: ['PAGO', 'CANCELADO'],
  PAGO: ['EM_PREPARO', 'CANCELADO'],
  EM_PREPARO: ['PRONTO', 'CANCELADO'],
  PRONTO: ['SAIU_PARA_ENTREGA', 'ENTREGUE'],
  SAIU_PARA_ENTREGA: ['ENTREGUE'],
  ENTREGUE: [],
  CANCELADO: [],
};
const NAO_PAGOS = ['AGUARDANDO_PAGAMENTO', 'PAGAMENTO_RECUSADO'];
export const STATUS_OPERACIONAIS = ['EM_PREPARO', 'PRONTO', 'SAIU_PARA_ENTREGA', 'ENTREGUE'];

const usuarioDoAtor = (ator) => (ator?.tipo === 'USUARIO' ? ator.id : null);

async function mudarStatus(client, pedido, para, { ator, observacao } = {}) {
  if (!TRANSICOES[pedido.status].includes(para)) {
    throw conflito(`Transição de status inválida: ${pedido.status} → ${para}`);
  }
  await client.query(
    `UPDATE pedidos SET status = $2::varchar, atualizado_em = now(),
            motivo_cancelamento = CASE WHEN $2::varchar = 'CANCELADO' THEN $3 ELSE motivo_cancelamento END
      WHERE id = $1`, [pedido.id, para, observacao ?? null]);
  await client.query(
    `INSERT INTO pedido_status_historico (pedido_id, status_de, status_para, usuario_id, observacao)
     VALUES ($1,$2,$3,$4,$5)`, [pedido.id, pedido.status, para, usuarioDoAtor(ator), observacao ?? null]);
  pedido.status = para;
}

async function travarPedido(client, pedidoId) {
  const { rows: [p] } = await client.query('SELECT * FROM pedidos WHERE id = $1 FOR UPDATE', [pedidoId]);
  if (!p) throw naoEncontrado('Pedido');
  return p;
}

function notificar(pedido) {
  publicar('pedido.atualizado', {
    id: pedido.id, unidade_id: pedido.unidade_id, status: pedido.status, canal: pedido.canal,
    total: pedido.total, codigo_acompanhamento: pedido.codigo_acompanhamento,
  });
}

export async function buscarPedido(pedidoId) {
  const { rows: [p] } = await query(
    `SELECT p.*, u.nome AS unidade, c.nome AS cliente, us.nome AS atendente
       FROM pedidos p JOIN unidades u ON u.id = p.unidade_id
       LEFT JOIN clientes c ON c.id = p.cliente_id
       LEFT JOIN usuarios us ON us.id = p.usuario_id
      WHERE p.id = $1`, [pedidoId]);
  if (!p) throw naoEncontrado('Pedido');
  const [itens, historico, pagamentos] = await Promise.all([
    query(`SELECT ip.id, ip.produto_id, pr.nome AS produto, ip.quantidade, ip.preco_unitario,
                  (ip.quantidade * ip.preco_unitario) AS subtotal, ip.observacao
             FROM itens_pedido ip JOIN produtos pr ON pr.id = ip.produto_id WHERE ip.pedido_id = $1 ORDER BY ip.id`, [pedidoId]),
    query(`SELECT h.status_de, h.status_para, h.observacao, h.criado_em, us.nome AS usuario
             FROM pedido_status_historico h LEFT JOIN usuarios us ON us.id = h.usuario_id
            WHERE h.pedido_id = $1 ORDER BY h.id`, [pedidoId]),
    query(`SELECT id, gateway, gateway_id, metodo, status, valor, detalhes, criado_em, atualizado_em
             FROM pagamentos WHERE pedido_id = $1 ORDER BY id`, [pedidoId]),
  ]);
  return { ...p, itens: itens.rows, historico: historico.rows, pagamentos: pagamentos.rows };
}

export async function criarPedido(d, ator) {
  const { pedidoId, itemIds } = await transacao(async (client) => {
    const { rowCount: unidadeAtiva } = await client.query('SELECT 1 FROM unidades WHERE id = $1 AND ativo', [d.unidade_id]);
    if (!unidadeAtiva) throw requisicaoInvalida('Unidade inexistente ou inativa');

    if (d.cliente_id) {
      const { rowCount } = await client.query('SELECT 1 FROM clientes WHERE id = $1 AND anonimizado_em IS NULL', [d.cliente_id]);
      if (!rowCount) throw requisicaoInvalida('Cliente inexistente');
    }

    const ids = [...new Set(d.itens.map((i) => i.produto_id))];
    const { rows: produtos } = await client.query(
      `SELECT p.id, p.nome, p.preco FROM produtos p JOIN categorias c ON c.id = p.categoria_id
        WHERE p.id = ANY($1) AND p.ativo AND c.ativo`, [ids]);
    const porId = new Map(produtos.map((p) => [p.id, p]));
    const indisponiveis = ids.filter((pid) => !porId.has(pid));
    if (indisponiveis.length) throw requisicaoInvalida('Produtos inexistentes ou fora do cardápio', { produto_ids: indisponiveis });

    const totalCentavos = d.itens.reduce((s, i) => s + Math.round(porId.get(i.produto_id).preco * 100) * i.quantidade, 0);

    const { rows: [pedido] } = await client.query(
      `INSERT INTO pedidos (unidade_id, cliente_id, usuario_id, canal, status, total, observacao, endereco_entrega)
       VALUES ($1,$2,$3,$4,'AGUARDANDO_PAGAMENTO',$5,$6,$7) RETURNING id`,
      [d.unidade_id, d.cliente_id ?? null, usuarioDoAtor(ator), d.canal, totalCentavos / 100,
        d.observacao ?? null, d.endereco_entrega ?? null]);
    for (const i of d.itens) {
      await client.query(
        'INSERT INTO itens_pedido (pedido_id, produto_id, quantidade, preco_unitario, observacao) VALUES ($1,$2,$3,$4,$5)',
        [pedido.id, i.produto_id, i.quantidade, porId.get(i.produto_id).preco, i.observacao ?? null]);
    }
    await client.query(
      `INSERT INTO pedido_status_historico (pedido_id, status_de, status_para, usuario_id)
       VALUES ($1, NULL, 'AGUARDANDO_PAGAMENTO', $2)`, [pedido.id, usuarioDoAtor(ator)]);

    const reservados = await reservar(client, {
      unidadeId: d.unidade_id, pedidoId: pedido.id, itens: d.itens, usuarioId: usuarioDoAtor(ator),
    });
    return { pedidoId: pedido.id, itemIds: reservados };
  });

  await publicarAlertas(d.unidade_id, itemIds);
  const pedido = await buscarPedido(pedidoId);
  publicar('pedido.criado', { id: pedido.id, unidade_id: pedido.unidade_id, status: pedido.status, canal: pedido.canal, total: pedido.total });
  return pedido;
}

function comTimeout(promessa, ms) {
  let timer;
  const limite = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('Tempo de resposta do provedor esgotado')), ms); });
  return Promise.race([promessa, limite]).finally(() => clearTimeout(timer));
}

export async function iniciarPagamento(pedidoId, { metodo, cartao }, ator) {
  const presencial = metodo === 'DINHEIRO';
  const gateway = presencial ? null : gatewayAtivo();
  const idempotencyKey = crypto.randomUUID();

  const { pagamentoId, pedido } = await transacao(async (client) => {
    const p = await travarPedido(client, pedidoId);
    if (!NAO_PAGOS.includes(p.status)) throw conflito(`Pedido não está aguardando pagamento (status atual: ${p.status})`);
    const { rows: [pg] } = await client.query(
      `INSERT INTO pagamentos (pedido_id, gateway, metodo, status, valor, idempotency_key)
       VALUES ($1,$2,$3,'PENDENTE',$4,$5) RETURNING id`,
      [p.id, presencial ? 'balcao' : gateway.nome, metodo, p.total, idempotencyKey]);
    return { pagamentoId: pg.id, pedido: p };
  });

  if (presencial) {
    await processarResultadoPagamento(pagamentoId, 'APROVADO', { registrado_por: ator.id }, ator);
    return buscarPagamento(pagamentoId);
  }

  let resposta;
  try {
    const { rows: [cli] } = await query('SELECT email FROM clientes WHERE id = $1', [pedido.cliente_id]);
    resposta = await comTimeout(gateway.criarCobranca({
      pedidoId: pedido.id, valor: pedido.total, metodo, cartao, idempotencyKey,
      descricao: `Raízes do Nordeste - Pedido #${pedido.id}`, pagadorEmail: cli?.email,
    }), 20_000);
  } catch (err) {
    await query(
      `UPDATE pagamentos SET status = 'RECUSADO', detalhes = $2, atualizado_em = now() WHERE id = $1`,
      [pagamentoId, { motivo: 'falha_comunicacao_gateway', erro: err.message }]);
    if (err instanceof AppError && err.status < 500) throw err;
    console.error('[pagamento] falha no gateway:', err.message);
    throw new AppError(502, 'Não foi possível contatar o serviço de pagamento. Tente novamente em instantes.');
  }

  await query('UPDATE pagamentos SET gateway_id = $2, detalhes = $3, atualizado_em = now() WHERE id = $1',
    [pagamentoId, resposta.gatewayId, resposta.detalhes ?? {}]);
  if (resposta.status !== 'PENDENTE') {
    await processarResultadoPagamento(pagamentoId, resposta.status, resposta.detalhes, ator);
  }
  return buscarPagamento(pagamentoId);
}

export async function buscarPagamento(pagamentoId) {
  const { rows: [pg] } = await query(
    `SELECT pg.id, pg.pedido_id, pg.gateway, pg.gateway_id, pg.metodo, pg.status, pg.valor, pg.detalhes,
            pg.criado_em, pg.atualizado_em, p.status AS status_pedido
       FROM pagamentos pg JOIN pedidos p ON p.id = pg.pedido_id WHERE pg.id = $1`, [pagamentoId]);
  return pg;
}

export async function processarResultadoPagamento(pagamentoId, status, detalhes = {}, ator = { tipo: 'SISTEMA' }) {
  const efeito = await transacao(async (client) => {
    const { rows: [ref] } = await client.query('SELECT pedido_id FROM pagamentos WHERE id = $1', [pagamentoId]);
    if (!ref) throw naoEncontrado('Pagamento');
    const pedido = await travarPedido(client, ref.pedido_id);
    const { rows: [pg] } = await client.query('SELECT * FROM pagamentos WHERE id = $1 FOR UPDATE', [pagamentoId]);
    if (pg.status !== 'PENDENTE') return { ignorado: true };

    const atualizarPagamento = (novo, extra = {}) => client.query(
      `UPDATE pagamentos SET status = $2, detalhes = detalhes || $3::jsonb, atualizado_em = now() WHERE id = $1`,
      [pg.id, novo, { ...detalhes, ...extra }]);

    if (status === 'APROVADO') {
      if (!NAO_PAGOS.includes(pedido.status)) {
        if (pg.gateway !== 'balcao') await gatewayPorNome(pg.gateway).estornar(pg.gateway_id, pg.valor);
        await atualizarPagamento('ESTORNADO', { motivo_estorno: `pedido não elegível (status ${pedido.status})` });
        return { pedido, estornoAutomatico: true };
      }
      await atualizarPagamento('APROVADO');
      await mudarStatus(client, pedido, 'PAGO', { ator, observacao: `Pagamento aprovado (${pg.metodo})` });
      const itemIds = await baixarReserva(client, pedido.id, usuarioDoAtor(ator));
      await client.query(
        `INSERT INTO lancamentos_caixa (unidade_id, tipo, categoria, valor, forma_pagamento, pedido_id, pagamento_id, usuario_id, descricao)
         VALUES ($1,'ENTRADA','VENDA',$2,$3,$4,$5,$6,$7)`,
        [pedido.unidade_id, pg.valor, pg.metodo, pedido.id, pg.id, usuarioDoAtor(ator), `Venda - pedido #${pedido.id}`]);
      return { pedido, itemIds, alterado: true };
    }

    if (status === 'RECUSADO') {
      await atualizarPagamento('RECUSADO');
      if (pedido.status === 'AGUARDANDO_PAGAMENTO') {
        await mudarStatus(client, pedido, 'PAGAMENTO_RECUSADO', { ator, observacao: detalhes?.motivo ?? 'Pagamento recusado' });
        return { pedido, alterado: true };
      }
      return { pedido };
    }
    return { pedido };
  });

  if (efeito.alterado) notificar(efeito.pedido);
  if (efeito.itemIds) await publicarAlertas(efeito.pedido.unidade_id, efeito.itemIds);
  return efeito;
}

export async function receberWebhook(nomeGateway, req) {
  const gateway = gatewayPorNome(nomeGateway);
  const evento = await gateway.interpretarWebhook(req);
  if (!evento || evento.status === 'PENDENTE') return { recebido: true, processado: false };
  const { rows: [pg] } = await query('SELECT id FROM pagamentos WHERE gateway = $1 AND gateway_id = $2', [gateway.nome, evento.gatewayId]);
  if (!pg) return { recebido: true, processado: false };
  const r = await processarResultadoPagamento(pg.id, evento.status, evento.detalhes);
  return { recebido: true, processado: !r.ignorado };
}

export async function alterarStatus(pedidoId, para, ator, observacao) {
  if (!STATUS_OPERACIONAIS.includes(para)) {
    throw requisicaoInvalida(`Status inválido. Use: ${STATUS_OPERACIONAIS.join(', ')} (ou o endpoint de cancelamento)`);
  }
  const pedido = await transacao(async (client) => {
    const p = await travarPedido(client, pedidoId);
    if (ator.unidadeId != null && ator.unidadeId !== p.unidade_id) throw proibido('Acesso restrito aos dados da sua unidade');
    if (para === 'SAIU_PARA_ENTREGA' && p.canal !== 'DELIVERY') throw conflito('Somente pedidos de delivery saem para entrega');
    if (para === 'ENTREGUE' && p.canal === 'DELIVERY' && p.status !== 'SAIU_PARA_ENTREGA') {
      throw conflito('Pedidos de delivery precisam sair para entrega antes de serem entregues');
    }
    await mudarStatus(client, p, para, { ator, observacao });
    return p;
  });
  notificar(pedido);
  return buscarPedido(pedidoId);
}

export async function cancelarPedido(pedidoId, motivo, ator) {
  const { pedido, itemIds } = await transacao(async (client) => {
    const p = await travarPedido(client, pedidoId);
    if (ator.tipo === 'CLIENTE') {
      if (p.cliente_id !== ator.id) throw naoEncontrado('Pedido');
      if (!NAO_PAGOS.includes(p.status)) throw conflito('Pedido já pago: solicite o cancelamento diretamente à unidade');
    }
    if (ator.tipo === 'USUARIO' && ator.unidadeId != null && ator.unidadeId !== p.unidade_id) {
      throw proibido('Acesso restrito aos dados da sua unidade');
    }
    if (!TRANSICOES[p.status].includes('CANCELADO')) throw conflito(`Pedido não pode ser cancelado no status ${p.status}`);

    const statusAnterior = p.status;
    let itens = [];
    if (NAO_PAGOS.includes(statusAnterior)) itens = await liberarReserva(client, p.id, usuarioDoAtor(ator));
    if (statusAnterior === 'PAGO') itens = await estornarBaixa(client, p.id, usuarioDoAtor(ator));

    if (['PAGO', 'EM_PREPARO'].includes(statusAnterior)) {
      const { rows: [pg] } = await client.query(
        `SELECT * FROM pagamentos WHERE pedido_id = $1 AND status = 'APROVADO' FOR UPDATE`, [p.id]);
      if (pg) {
        if (pg.gateway !== 'balcao') {
          try {
            await comTimeout(gatewayPorNome(pg.gateway).estornar(pg.gateway_id, pg.valor), 20_000);
          } catch (err) {
            console.error('[pagamento] falha no estorno:', err.message);
            throw new AppError(502, 'Não foi possível estornar o pagamento no provedor. O pedido não foi cancelado; tente novamente.');
          }
        }
        await client.query(
          `UPDATE pagamentos SET status = 'ESTORNADO', detalhes = detalhes || $2::jsonb, atualizado_em = now() WHERE id = $1`,
          [pg.id, { motivo_estorno: motivo }]);
        await client.query(
          `INSERT INTO lancamentos_caixa (unidade_id, tipo, categoria, valor, forma_pagamento, pedido_id, pagamento_id, usuario_id, descricao)
           VALUES ($1,'SAIDA','ESTORNO',$2,$3,$4,$5,$6,$7)`,
          [p.unidade_id, pg.valor, pg.metodo, p.id, pg.id, usuarioDoAtor(ator), `Estorno - pedido #${p.id}`]);
      }
    }
    await mudarStatus(client, p, 'CANCELADO', { ator, observacao: motivo });
    return { pedido: p, itemIds: itens };
  });
  notificar(pedido);
  await publicarAlertas(pedido.unidade_id, itemIds);
  return buscarPedido(pedidoId);
}

export async function expirarPedidosNaoPagos(minutos = config.pedidoExpiracaoMin) {
  const { rows } = await query(
    `SELECT id FROM pedidos WHERE status = ANY($1) AND criado_em < now() - make_interval(mins => $2)`,
    [NAO_PAGOS, minutos]);
  let expirados = 0;
  for (const { id } of rows) {
    try {
      await cancelarPedido(id, 'Expirado: pagamento não confirmado no prazo', { tipo: 'SISTEMA' });
      expirados++;
    } catch (err) {
      if (!(err instanceof AppError)) console.error('[expiracao] pedido', id, err.message);
    }
  }
  return expirados;
}
