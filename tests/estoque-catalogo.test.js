import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { api, como, pool, posicaoEstoque, prepararBanco, query, tokenUsuario, USUARIOS } from './helpers.js';

let admin, gerente;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

before(async () => {
  await prepararBanco();
  admin = como(await tokenUsuario(USUARIOS.admin));
  gerente = como(await tokenUsuario(USUARIOS.gerenteRecife));
});
after(() => pool.end());

test('cadastro de produto com categoria, preço, descrição e ficha técnica', async () => {
  const cat = await admin.post('/api/categorias', { nome: 'Caldos', descricao: 'Caldos quentes' });
  assert.equal(cat.status, 201);
  const r = await admin.post('/api/produtos', {
    categoria_id: cat.body.id, nome: 'Caldo de Charque', descricao: 'Caldo cremoso', preco: 12.9,
    composicao: [{ item_estoque_id: 4, quantidade: 0.05 }],
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.preco, 12.9);
  assert.equal(r.body.categoria, 'Caldos');
  assert.equal(r.body.composicao[0].item, 'Charque');

  assert.equal((await admin.post('/api/produtos', { categoria_id: cat.body.id, nome: 'Inválido', preco: -1 })).status, 400);
  assert.equal((await admin.post('/api/produtos', { categoria_id: cat.body.id, nome: 'Caldo de Charque', preco: 5 })).status, 409);
});

test('produto desativado some do catálogo público mas continua no painel', async () => {
  const { body: produtos } = await api().get('/api/produtos');
  const alvo = produtos.find((p) => p.nome === 'Caldo de Charque');
  assert.equal((await admin.delete(`/api/produtos/${alvo.id}`)).status, 204);
  assert.ok(!(await api().get('/api/produtos')).body.some((p) => p.id === alvo.id));
  assert.ok((await api().get('/api/produtos?incluir_inativos=true')).body.some((p) => p.id === alvo.id));
  const pedido = await gerente.post('/api/pedidos', { itens: [{ produto_id: alvo.id, quantidade: 1 }] });
  assert.equal(pedido.status, 400, 'não aceita pedido de produto inativo');
});

test('upload de imagem valida o conteúdo real do arquivo', async () => {
  const ok = await admin.post('/api/produtos/1/imagem').attach('imagem', PNG, { filename: 'tapioca.png', contentType: 'image/png' });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.match(ok.body.imagem_url, /^\/uploads\/produto-1-.*\.png$/);
  const img = await api().get(ok.body.imagem_url);
  assert.equal(img.status, 200);

  const falso = await admin.post('/api/produtos/1/imagem')
    .attach('imagem', Buffer.from('<script>alert(1)</script>'), { filename: 'foto.png', contentType: 'image/png' });
  assert.equal(falso.status, 400);
  const semArquivo = await admin.post('/api/produtos/1/imagem');
  assert.equal(semArquivo.status, 400);
});

test('entrada com custo atualiza o saldo e lança a compra no fluxo de caixa', async () => {
  const antes = await posicaoEstoque(1, 'Queijo coalho');
  const r = await gerente.post('/api/estoque/movimentacoes', {
    item_estoque_id: 2, tipo: 'ENTRADA', quantidade: 5, custo_total: 210, observacao: 'NF 1234 - Laticínios Sertão',
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.posicao.quantidade, antes.quantidade + 5);
  const { rows } = await query(`SELECT * FROM lancamentos_caixa WHERE categoria = 'COMPRA_INSUMOS' AND valor = 210`);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].tipo, 'SAIDA');
});

test('saída (perda) não pode consumir estoque reservado para pedidos', async () => {
  await gerente.post('/api/pedidos', { itens: [{ produto_id: 9, quantidade: 10 }] });
  const e = await posicaoEstoque(1, 'Guaraná lata 350ml');
  const r = await gerente.post('/api/estoque/movimentacoes', { item_estoque_id: 14, tipo: 'SAIDA', quantidade: e.quantidade });
  assert.equal(r.status, 409);
  const ok = await gerente.post('/api/estoque/movimentacoes', { item_estoque_id: 14, tipo: 'SAIDA', quantidade: 2, observacao: 'Latas amassadas' });
  assert.equal(ok.status, 201);
});

test('ajuste de inventário define o saldo contado e registra a diferença', async () => {
  const r = await gerente.post('/api/estoque/movimentacoes', { item_estoque_id: 1, tipo: 'AJUSTE', quantidade: 18.5, observacao: 'Inventário mensal' });
  assert.equal(r.status, 201);
  assert.equal(r.body.posicao.quantidade, 18.5);
  assert.equal(r.body.movimentacao.quantidade, -1.5);
});

test('alertas de reposição quando o disponível atinge o mínimo', async () => {
  const antes = (await gerente.get('/api/estoque/alertas')).body;
  assert.ok(!antes.some((a) => a.item === 'Café em pó'));
  await gerente.patch('/api/estoque/minimo', { item_estoque_id: 11, estoque_minimo: 5 });
  const depois = (await gerente.get('/api/estoque/alertas')).body;
  const cafe = depois.find((a) => a.item === 'Café em pó');
  assert.ok(cafe, 'café entrou nos alertas');
  assert.ok(cafe.sugestao_reposicao > 0);

  const fortaleza = (await admin.get('/api/estoque/alertas?unidade_id=2')).body.map((a) => a.item).sort();
  assert.deepEqual(fortaleza, ['Charque', 'Cocada'], 'alertas do seed de demonstração');
});

test('histórico de movimentações registra reservas, entradas e responsáveis', async () => {
  const r = await gerente.get('/api/estoque/movimentacoes?limite=100');
  assert.equal(r.status, 200);
  const tipos = new Set(r.body.dados.map((m) => m.tipo));
  for (const t of ['ENTRADA', 'SAIDA', 'AJUSTE', 'RESERVA']) assert.ok(tipos.has(t), `contém ${t}`);
  assert.ok(r.body.dados.find((m) => m.tipo === 'AJUSTE').usuario, 'registra quem fez');
});
