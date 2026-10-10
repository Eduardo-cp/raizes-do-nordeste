import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { api, como, pool, prepararBanco, query, tokenCliente, tokenUsuario, USUARIOS } from './helpers.js';
import { criarApp } from '../src/app.js';

let admin, gerente, atendente, maria;

before(async () => {
  await prepararBanco();
  admin = como(await tokenUsuario(USUARIOS.admin));
  gerente = como(await tokenUsuario(USUARIOS.gerenteRecife));
  atendente = como(await tokenUsuario(USUARIOS.atendenteRecife));
  maria = como(await tokenCliente('maria@exemplo.com'));
  const { body: pedido } = await maria.post('/api/pedidos', { unidade_id: 1, itens: [{ produto_id: 2, quantidade: 2 }, { produto_id: 9, quantidade: 1 }] });
  await maria.post(`/api/pedidos/${pedido.id}/pagamentos`, { metodo: 'CARTAO_CREDITO', cartao: { token: 'tok_ok' } });
});
after(() => pool.end());

test('cadastro de cliente no balcão exige confirmação de consentimento', async () => {
  assert.equal((await atendente.post('/api/clientes', { nome: 'Seu Chico', telefone: '(81) 98888-7777' })).status, 400);
  const r = await atendente.post('/api/clientes', {
    nome: 'Seu Chico', telefone: '(81) 98888-7777', preferencias: { cuscuz: 'bem molhadinho' }, consentimento_termos: true,
  });
  assert.equal(r.status, 201);
  assert.equal(r.body.preferencias.cuscuz, 'bem molhadinho');
});

test('ficha do cliente traz histórico e favoritos, e o acesso fica auditado', async () => {
  const { rows: [c] } = await query(`SELECT id FROM clientes WHERE email = 'maria@exemplo.com'`);
  const r = await atendente.get(`/api/clientes/${c.id}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.resumo.total_pedidos, 1);
  assert.equal(r.body.resumo.produtos_favoritos[0].nome, 'Tapioca de Queijo Coalho');
  const hist = await atendente.get(`/api/clientes/${c.id}/pedidos`);
  assert.equal(hist.body.dados.length, 1);
  const { rows } = await query(`SELECT * FROM audit_log WHERE acao = 'CLIENTE_CONSULTADO' AND entidade_id = $1`, [String(c.id)]);
  assert.equal(rows.length, 1);
});

test('cliente atualiza preferências e revoga consentimento de marketing', async () => {
  const r = await maria.patch('/api/me', { preferencias: { sem_cebola: true }, consentimento_marketing: false });
  assert.equal(r.status, 200);
  assert.equal(r.body.consentimento_marketing, false);
  assert.equal((await maria.get('/api/me/pedidos')).body.dados.length, 1);
});

test('política de privacidade é pública', async () => {
  const r = await api().get('/api/lgpd/politica');
  assert.equal(r.status, 200);
  assert.ok(r.body.finalidades);
});

test('titular exporta todos os seus dados (portabilidade)', async () => {
  const r = await maria.get('/api/lgpd/meus-dados');
  assert.equal(r.status, 200);
  assert.equal(r.body.titular.email, 'maria@exemplo.com');
  assert.equal(r.body.titular.senha_hash, undefined);
  assert.equal(r.body.pedidos.length, 1);
  assert.equal(r.body.pedidos[0].pagamentos[0].status, 'APROVADO');
});

test('eliminação: anonimiza o titular, bloqueia o login e preserva os registros fiscais', async () => {
  assert.equal((await maria.delete('/api/lgpd/minha-conta', { senha: 'errada' })).status, 400);
  assert.equal((await maria.delete('/api/lgpd/minha-conta', { senha: 'Cliente@2026' })).status, 409,
    'com pedido em andamento, a eliminação é adiada');
  const { rows: [emAndamento] } = await query(`SELECT p.id FROM pedidos p JOIN clientes c ON c.id = p.cliente_id WHERE c.email = 'maria@exemplo.com'`);
  for (const status of ['EM_PREPARO', 'PRONTO', 'ENTREGUE']) await atendente.patch(`/api/pedidos/${emAndamento.id}/status`, { status });

  const r = await maria.delete('/api/lgpd/minha-conta', { senha: 'Cliente@2026' });
  assert.equal(r.status, 200);

  const { rows: [c] } = await query(`SELECT * FROM clientes WHERE nome LIKE 'Titular anonimizado%'`);
  assert.equal(c.email, null);
  assert.equal(c.telefone, null);
  assert.equal(c.senha_hash, null);
  assert.deepEqual(c.preferencias, {});
  assert.equal((await maria.get('/api/me/pedidos')).status, 401, 'token antigo deixa de valer');
  assert.equal((await api().post('/api/auth/clientes/login').send({ email: 'maria@exemplo.com', senha: 'Cliente@2026' })).status, 401);

  const { rows: pedidos } = await query('SELECT total FROM pedidos WHERE cliente_id = $1', [c.id]);
  assert.equal(pedidos.length, 1, 'venda mantida (obrigação fiscal), sem identificação');
  const { rows: audit } = await query(`SELECT * FROM audit_log WHERE acao = 'LGPD_ELIMINACAO'`);
  assert.equal(audit.length, 1);
});

test('solicitação de titular atendida pela loja exige permissão lgpd.gerenciar', async () => {
  const { rows: [jose] } = await query(`SELECT id FROM clientes WHERE email = 'jose@exemplo.com'`);
  assert.equal((await atendente.get(`/api/lgpd/clientes/${jose.id}/exportar`)).status, 403);
  assert.equal((await gerente.get(`/api/lgpd/clientes/${jose.id}/exportar`)).status, 200);
  assert.equal((await gerente.post(`/api/lgpd/clientes/${jose.id}/anonimizar`)).status, 200);
  assert.equal((await gerente.post(`/api/lgpd/clientes/${jose.id}/anonimizar`)).status, 409);
});

test('trilha de auditoria registra logins, falhas e operações de escrita', async () => {
  await api().post('/api/auth/login').send({ email: USUARIOS.admin, senha: 'errada123' });
  const r = await admin.get('/api/auditoria?limite=100');
  assert.equal(r.status, 200);
  const acoes = r.body.dados.map((a) => a.acao);
  assert.ok(acoes.includes('LOGIN'));
  assert.ok(acoes.includes('LOGIN_FALHOU'));
  assert.ok(acoes.some((a) => a.startsWith('POST /api/pedidos')));
  assert.ok(!JSON.stringify(r.body).includes('Cliente@2026'), 'nunca registra senhas');
});

test('relatório de vendas consolida faturamento, produtos, canais e formas de pagamento', async () => {
  const r = await admin.get('/api/relatorios/vendas');
  assert.equal(r.status, 200);
  assert.equal(r.body.resumo.pedidos, 1);
  assert.equal(r.body.resumo.faturamento, 35.8);
  assert.equal(r.body.resumo.ticket_medio, 35.8);
  assert.equal(r.body.por_produto[0].produto, 'Tapioca de Queijo Coalho');
  assert.equal(r.body.por_canal[0].canal, 'APP');
  assert.equal(r.body.por_forma_pagamento[0].forma_pagamento, 'CARTAO_CREDITO');
  assert.match(r.body.por_dia[0].data, /^\d{4}-\d{2}-\d{2}$/);
});

test('relatórios exportam CSV (Excel pt-BR) e validam o período', async () => {
  const r = await admin.get('/api/relatorios/vendas?formato=csv');
  assert.equal(r.status, 200);
  assert.match(r.headers['content-type'], /text\/csv/);
  assert.match(r.text, /produto;categoria;quantidade;faturamento/);
  assert.match(r.text, /Tapioca de Queijo Coalho;Tapiocas;2;29,8/);
  assert.equal((await admin.get('/api/relatorios/vendas?inicio=2026-12-01&fim=2026-01-01')).status, 400);
  assert.equal((await admin.get('/api/relatorios/vendas?inicio=ontem')).status, 400);
});

test('fluxo de caixa: entradas, saídas manuais e saldo acumulado', async () => {
  const l = await gerente.post('/api/caixa/lancamentos', { tipo: 'SAIDA', categoria: 'DESPESA', valor: 15.8, descricao: 'Gás de cozinha' });
  assert.equal(l.status, 201);
  assert.equal((await gerente.post('/api/caixa/lancamentos', { tipo: 'ENTRADA', categoria: 'VENDA', valor: 10, descricao: 'fraude' })).status, 400,
    'vendas só entram pelo fluxo de pagamento');
  const r = await admin.get('/api/relatorios/fluxo-caixa');
  assert.equal(r.body.resumo.entradas, 35.8);
  assert.equal(r.body.resumo.saidas, 15.8);
  assert.equal(r.body.resumo.resultado, 20);
  assert.equal(r.body.por_dia.at(-1).saldo_acumulado, 20);
});

test('relatório de estoque mostra consumo, cobertura e itens a repor', async () => {
  const r = await admin.get('/api/relatorios/estoque?unidade_id=1');
  const queijo = r.body.itens.find((i) => i.item === 'Queijo coalho');
  assert.equal(queijo.consumo_vendas, 0.14);
  assert.ok(queijo.dias_de_cobertura > 0);
  const d = await admin.get('/api/relatorios/dashboard');
  assert.equal(d.status, 200);
  assert.equal(d.body.hoje.pedidos_vendidos, 1);
  assert.equal(d.body.alertas_estoque, 2);
  assert.equal(d.body.ultimos_7_dias.length, 7);
});

test('painel recebe eventos de pedidos em tempo real (SSE) apenas da própria unidade', async () => {
  const servidor = criarApp().listen(0);
  const porta = servidor.address().port;
  const token = await tokenUsuario(USUARIOS.gerenteRecife);
  const controle = new AbortController();
  const resp = await fetch(`http://localhost:${porta}/api/eventos`, { headers: { Authorization: `Bearer ${token}` }, signal: controle.signal });
  const leitor = resp.body.getReader();
  const recebidos = [];
  const lendo = (async () => {
    const dec = new TextDecoder();
    try {
      for (;;) {
        const { value, done } = await leitor.read();
        if (done) break;
        recebidos.push(dec.decode(value));
      }
    } catch { }
  })();

  const fortaleza = como(await tokenUsuario(USUARIOS.gerenteFortaleza));
  await fortaleza.post('/api/pedidos', { itens: [{ produto_id: 10, quantidade: 1 }] });
  await atendente.post('/api/pedidos', { itens: [{ produto_id: 10, quantidade: 1 }] });
  await new Promise((r) => setTimeout(r, 200));
  controle.abort();
  await lendo;
  servidor.closeAllConnections();
  servidor.close();

  const texto = recebidos.join('');
  assert.match(texto, /event: conectado/);
  const eventosRecebidos = texto.split('\n\n').filter((b) => b.includes('event: pedido.criado'));
  assert.equal(eventosRecebidos.length, 1, 'recebe só o pedido da própria unidade');
  assert.match(eventosRecebidos[0], /"unidade_id":1/);
});
