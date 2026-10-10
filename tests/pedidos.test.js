import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  api, como, idProduto, pool, posicaoEstoque, prepararBanco, query, tokenCliente, tokenUsuario, USUARIOS,
} from './helpers.js';
import { assinarWebhookMock } from '../src/pagamentos/mock.gateway.js';
import { expirarPedidosNaoPagos } from '../src/modules/pedidos.service.js';

const RECIFE = 1;
const FORTALEZA = 2;
let atendente, cozinha, gerenteFortaleza, maria, jose;
let tapiocaQueijo, guarana, cocada, coxinha;

before(async () => {
  await prepararBanco();
  atendente = como(await tokenUsuario(USUARIOS.atendenteRecife));
  cozinha = como(await tokenUsuario(USUARIOS.cozinhaRecife));
  gerenteFortaleza = como(await tokenUsuario(USUARIOS.gerenteFortaleza));
  maria = como(await tokenCliente('maria@exemplo.com'));
  jose = como(await tokenCliente('jose@exemplo.com'));
  tapiocaQueijo = await idProduto('Tapioca de Queijo Coalho');
  guarana = await idProduto('Guaraná Lata');
  cocada = await idProduto('Cocada');
  coxinha = await idProduto('Coxinha de Frango');
});
after(() => pool.end());

async function novoPedidoCliente(cliente = maria, itens = [{ produto_id: tapiocaQueijo, quantidade: 2 }]) {
  const r = await cliente.post('/api/pedidos', { unidade_id: RECIFE, itens });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body;
}

test('fluxo completo: pedido -> estoque reservado -> cartão aprovado -> preparo -> retirada', async () => {
  const antesQueijo = await posicaoEstoque(RECIFE, 'Queijo coalho');

  const pedido = await novoPedidoCliente();
  assert.equal(pedido.status, 'AGUARDANDO_PAGAMENTO');
  assert.equal(pedido.total, 29.8);
  assert.equal(pedido.canal, 'APP');
  let queijo = await posicaoEstoque(RECIFE, 'Queijo coalho');
  assert.equal(queijo.reservado, antesQueijo.reservado + 0.14);
  assert.equal(queijo.quantidade, antesQueijo.quantidade);

  const pag = await maria.post(`/api/pedidos/${pedido.id}/pagamentos`, { metodo: 'CARTAO_CREDITO', cartao: { token: 'tok_visa' } });
  assert.equal(pag.status, 201);
  assert.equal(pag.body.status, 'APROVADO');
  assert.equal(pag.body.status_pedido, 'PAGO');

  queijo = await posicaoEstoque(RECIFE, 'Queijo coalho');
  assert.equal(queijo.reservado, antesQueijo.reservado);
  assert.equal(queijo.quantidade, Math.round((antesQueijo.quantidade - 0.14) * 1000) / 1000);

  const { rows: caixa } = await query(`SELECT * FROM lancamentos_caixa WHERE pedido_id = $1`, [pedido.id]);
  assert.equal(caixa.length, 1);
  assert.equal(caixa[0].tipo, 'ENTRADA');
  assert.equal(caixa[0].valor, 29.8);

  for (const status of ['EM_PREPARO', 'PRONTO', 'ENTREGUE']) {
    const r = await cozinha.patch(`/api/pedidos/${pedido.id}/status`, { status });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.status, status);
  }

  const acomp = await api().get(`/api/acompanhamento/${pedido.codigo_acompanhamento}`);
  assert.equal(acomp.status, 200);
  assert.equal(acomp.body.status, 'ENTREGUE');
  assert.deepEqual(acomp.body.etapas.map((e) => e.status),
    ['AGUARDANDO_PAGAMENTO', 'PAGO', 'EM_PREPARO', 'PRONTO', 'ENTREGUE']);
  assert.equal(acomp.body.cliente, undefined, 'acompanhamento público não expõe dados pessoais');
});

test('cartão recusado -> PAGAMENTO_RECUSADO; nova tentativa aprovada -> PAGO', async () => {
  const pedido = await novoPedidoCliente();
  const recusa = await maria.post(`/api/pedidos/${pedido.id}/pagamentos`, { metodo: 'CARTAO_CREDITO', cartao: { token: 'tok_recusado' } });
  assert.equal(recusa.body.status, 'RECUSADO');
  assert.equal(recusa.body.status_pedido, 'PAGAMENTO_RECUSADO');

  const { rows: [r] } = await query(`SELECT count(*)::int AS n FROM movimentacoes_estoque WHERE pedido_id = $1 AND tipo = 'RESERVA'`, [pedido.id]);
  assert.ok(r.n > 0, 'o estoque continua reservado enquanto o cliente tenta de novo');

  const ok = await maria.post(`/api/pedidos/${pedido.id}/pagamentos`, { metodo: 'CARTAO_DEBITO', cartao: { token: 'tok_ok' } });
  assert.equal(ok.body.status, 'APROVADO');
  assert.equal(ok.body.status_pedido, 'PAGO');

  const segunda = await maria.post(`/api/pedidos/${pedido.id}/pagamentos`, { metodo: 'PIX' });
  assert.equal(segunda.status, 409, 'não permite pagar duas vezes');
});

test('PIX: fica pendente até o webhook assinado confirmar; webhook repetido é ignorado', async () => {
  const pedido = await novoPedidoCliente();
  const pix = await maria.post(`/api/pedidos/${pedido.id}/pagamentos`, { metodo: 'PIX' });
  assert.equal(pix.body.status, 'PENDENTE');
  assert.ok(pix.body.detalhes.pix_copia_e_cola);
  assert.equal(pix.body.status_pedido, 'AGUARDANDO_PAGAMENTO');

  const corpo = JSON.stringify({ gateway_id: pix.body.gateway_id, status: 'APROVADO' });

  const falso = await api().post('/api/webhooks/pagamentos/mock')
    .set('Content-Type', 'application/json').set('x-assinatura', 'a'.repeat(64)).send(corpo);
  assert.equal(falso.status, 401);

  const valido = await api().post('/api/webhooks/pagamentos/mock')
    .set('Content-Type', 'application/json').set('x-assinatura', assinarWebhookMock(corpo)).send(corpo);
  assert.equal(valido.status, 200);
  assert.equal(valido.body.processado, true);

  const repetido = await api().post('/api/webhooks/pagamentos/mock')
    .set('Content-Type', 'application/json').set('x-assinatura', assinarWebhookMock(corpo)).send(corpo);
  assert.equal(repetido.body.processado, false);

  const { rows } = await query('SELECT count(*)::int AS n FROM lancamentos_caixa WHERE pedido_id = $1', [pedido.id]);
  assert.equal(rows[0].n, 1, 'venda lançada uma única vez');
  const p = await maria.get(`/api/pedidos/${pedido.id}`);
  assert.equal(p.body.status, 'PAGO');
});

test('falha de comunicação com o provedor: 502 e pedido continua aguardando pagamento', async () => {
  const pedido = await novoPedidoCliente();
  const r = await maria.post(`/api/pedidos/${pedido.id}/pagamentos`, { metodo: 'CARTAO_CREDITO', cartao: { token: 'tok_erro' } });
  assert.equal(r.status, 502);
  const p = await maria.get(`/api/pedidos/${pedido.id}`);
  assert.equal(p.body.status, 'AGUARDANDO_PAGAMENTO');
});

test('estoque insuficiente bloqueia o pedido e não reserva nada', async () => {
  const antes = await posicaoEstoque(FORTALEZA, 'Cocada');
  const r = await gerenteFortaleza.post('/api/pedidos', { itens: [{ produto_id: cocada, quantidade: 6 }] });
  assert.equal(r.status, 409);
  assert.equal(r.body.detalhes[0].item, 'Cocada');
  assert.equal(r.body.detalhes[0].disponivel, 5);
  assert.deepEqual(await posicaoEstoque(FORTALEZA, 'Cocada'), antes);
  const { rows } = await query(`SELECT count(*)::int AS n FROM pedidos WHERE unidade_id = $1`, [FORTALEZA]);
  assert.equal(rows[0].n, 0, 'nenhum pedido criado (rollback)');
});

test('pedidos simultâneos não vendem o mesmo estoque duas vezes', async () => {
  const respostas = await Promise.all(Array.from({ length: 5 }, () =>
    gerenteFortaleza.post('/api/pedidos', { itens: [{ produto_id: cocada, quantidade: 2 }] })));
  const status = respostas.map((r) => r.status).sort();
  assert.deepEqual(status, [201, 201, 409, 409, 409]);
  const e = await posicaoEstoque(FORTALEZA, 'Cocada');
  assert.equal(e.reservado, 4);
  assert.ok(e.reservado <= e.quantidade);
});

test('cardápio mostra produto indisponível quando o estoque acaba', async () => {
  const disponivel = async () =>
    (await api().get(`/api/unidades/${FORTALEZA}/cardapio`)).body.find((p) => p.nome === 'Cocada').disponivel;
  assert.equal(await disponivel(), true, 'resta 1 cocada disponível');
  assert.equal((await gerenteFortaleza.post('/api/pedidos', { itens: [{ produto_id: cocada, quantidade: 1 }] })).status, 201);
  assert.equal(await disponivel(), false, 'todas reservadas');
  assert.equal((await api().get(`/api/unidades/${RECIFE}/cardapio`)).body.find((p) => p.nome === 'Cocada').disponivel, true,
    'disponibilidade é por unidade');
});

test('transições de status inválidas são bloqueadas', async () => {
  const pedido = await novoPedidoCliente();
  const r = await cozinha.patch(`/api/pedidos/${pedido.id}/status`, { status: 'EM_PREPARO' });
  assert.equal(r.status, 409, 'não prepara pedido não pago');
  const r2 = await cozinha.patch(`/api/pedidos/${pedido.id}/status`, { status: 'PAGO' });
  assert.equal(r2.status, 400, 'PAGO só pode ser definido pelo pagamento');
});

test('delivery: exige endereço e precisa sair para entrega antes de ser entregue', async () => {
  const semEndereco = await maria.post('/api/pedidos', { unidade_id: RECIFE, canal: 'DELIVERY', itens: [{ produto_id: guarana, quantidade: 1 }] });
  assert.equal(semEndereco.status, 400);

  const { body: pedido } = await maria.post('/api/pedidos', {
    unidade_id: RECIFE, canal: 'DELIVERY', endereco_entrega: 'Rua da Aurora, 100 - Recife', itens: [{ produto_id: guarana, quantidade: 1 }],
  });
  await maria.post(`/api/pedidos/${pedido.id}/pagamentos`, { metodo: 'CARTAO_CREDITO', cartao: { token: 'tok_ok' } });
  await cozinha.patch(`/api/pedidos/${pedido.id}/status`, { status: 'EM_PREPARO' });
  await cozinha.patch(`/api/pedidos/${pedido.id}/status`, { status: 'PRONTO' });
  assert.equal((await cozinha.patch(`/api/pedidos/${pedido.id}/status`, { status: 'ENTREGUE' })).status, 409);
  assert.equal((await cozinha.patch(`/api/pedidos/${pedido.id}/status`, { status: 'SAIU_PARA_ENTREGA' })).body.status, 'SAIU_PARA_ENTREGA');
  assert.equal((await cozinha.patch(`/api/pedidos/${pedido.id}/status`, { status: 'ENTREGUE' })).body.status, 'ENTREGUE');
});

test('cancelamento de pedido pago: estorna o pagamento, lança saída no caixa e devolve o estoque', async () => {
  const antes = await posicaoEstoque(RECIFE, 'Coxinha de frango (congelada)');
  const { body: pedido } = await atendente.post('/api/pedidos', { itens: [{ produto_id: coxinha, quantidade: 3 }] });
  assert.equal(pedido.canal, 'BALCAO');
  const pag = await atendente.post(`/api/pedidos/${pedido.id}/pagamentos`, { metodo: 'DINHEIRO' });
  assert.equal(pag.body.status, 'APROVADO');
  assert.equal((await posicaoEstoque(RECIFE, 'Coxinha de frango (congelada)')).quantidade, antes.quantidade - 3);

  assert.equal((await atendente.post(`/api/pedidos/${pedido.id}/cancelar`, { motivo: 'Cliente desistiu' })).status, 403);
  const gerente = como(await tokenUsuario(USUARIOS.gerenteRecife));
  const c = await gerente.post(`/api/pedidos/${pedido.id}/cancelar`, { motivo: 'Cliente desistiu' });
  assert.equal(c.status, 200, JSON.stringify(c.body));
  assert.equal(c.body.status, 'CANCELADO');
  assert.equal(c.body.pagamentos[0].status, 'ESTORNADO');
  assert.deepEqual(await posicaoEstoque(RECIFE, 'Coxinha de frango (congelada)'), antes);

  const { rows } = await query(`SELECT tipo, categoria, valor FROM lancamentos_caixa WHERE pedido_id = $1 ORDER BY id`, [pedido.id]);
  assert.deepEqual(rows.map((r) => r.tipo), ['ENTRADA', 'SAIDA']);
  assert.equal(rows[1].categoria, 'ESTORNO');
});

test('cliente cancela o próprio pedido não pago (reserva liberada) mas não o de outra pessoa', async () => {
  const antes = await posicaoEstoque(RECIFE, 'Goma de tapioca');
  const pedido = await novoPedidoCliente();
  assert.equal((await jose.get(`/api/pedidos/${pedido.id}`)).status, 404, 'outro cliente não vê o pedido');
  assert.equal((await jose.post(`/api/pedidos/${pedido.id}/cancelar`, { motivo: 'teste' })).status, 404);
  const c = await maria.post(`/api/pedidos/${pedido.id}/cancelar`, { motivo: 'Mudei de ideia' });
  assert.equal(c.body.status, 'CANCELADO');
  assert.deepEqual(await posicaoEstoque(RECIFE, 'Goma de tapioca'), antes);
});

test('pedido não pago expira, libera a reserva e um PIX aprovado depois é estornado automaticamente', async () => {
  const antes = await posicaoEstoque(RECIFE, 'Goma de tapioca');
  const pedido = await novoPedidoCliente();
  const pix = await maria.post(`/api/pedidos/${pedido.id}/pagamentos`, { metodo: 'PIX' });
  await query(`UPDATE pedidos SET criado_em = now() - interval '2 hours' WHERE id = $1`, [pedido.id]);

  const n = await expirarPedidosNaoPagos(30);
  assert.ok(n >= 1);
  assert.equal((await maria.get(`/api/pedidos/${pedido.id}`)).body.status, 'CANCELADO');
  assert.deepEqual(await posicaoEstoque(RECIFE, 'Goma de tapioca'), antes);

  const sim = await api().post(`/api/pagamentos/simulador/${pix.body.gateway_id}`).send({ status: 'APROVADO' });
  assert.equal(sim.body.processado, true);
  const p = await maria.get(`/api/pedidos/${pedido.id}`);
  assert.equal(p.body.status, 'CANCELADO');
  assert.equal(p.body.pagamentos[0].status, 'ESTORNADO');
  const { rows } = await query('SELECT count(*)::int AS n FROM lancamentos_caixa WHERE pedido_id = $1', [pedido.id]);
  assert.equal(rows[0].n, 0, 'nenhuma venda lançada');
});

test('validação de entrada: itens vazios, quantidade inválida e produto inexistente', async () => {
  assert.equal((await maria.post('/api/pedidos', { unidade_id: RECIFE, itens: [] })).status, 400);
  assert.equal((await maria.post('/api/pedidos', { unidade_id: RECIFE, itens: [{ produto_id: guarana, quantidade: 0 }] })).status, 400);
  assert.equal((await maria.post('/api/pedidos', { unidade_id: RECIFE, itens: [{ produto_id: 99999, quantidade: 1 }] })).status, 400);
  assert.equal((await maria.post('/api/pedidos', { unidade_id: RECIFE, canal: 'BALCAO', itens: [{ produto_id: guarana, quantidade: 1 }] })).status, 400);
  assert.equal((await maria.post(`/api/pedidos/1/pagamentos`, { metodo: 'DINHEIRO' })).status, 400);
});
