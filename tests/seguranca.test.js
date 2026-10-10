import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import { api, como, limparCacheTokens, pool, prepararBanco, query, tokenUsuario, USUARIOS } from './helpers.js';

before(async () => {
  await prepararBanco();
  limparCacheTokens();
});
after(() => pool.end());

test('login válido retorna token e permissões; senha errada retorna 401 genérico', async () => {
  const ok = await api().post('/api/auth/login').send({ email: USUARIOS.atendenteRecife, senha: 'Raizes@2026' });
  assert.equal(ok.status, 200);
  assert.ok(ok.body.token);
  assert.equal(ok.body.usuario.perfil, 'ATENDENTE');
  assert.ok(ok.body.usuario.permissoes.includes('pedidos.criar'));
  assert.equal(ok.body.usuario.senha_hash, undefined, 'nunca devolve o hash da senha');

  const errada = await api().post('/api/auth/login').send({ email: USUARIOS.atendenteRecife, senha: 'errada123' });
  const inexistente = await api().post('/api/auth/login').send({ email: 'ninguem@x.com', senha: 'errada123' });
  assert.equal(errada.status, 401);
  assert.equal(inexistente.status, 401);
  assert.equal(errada.body.erro, inexistente.body.erro, 'mesma mensagem: não revela se o e-mail existe');
});

test('conta é bloqueada temporariamente após 5 tentativas falhas', async () => {
  for (let i = 0; i < 5; i++) {
    await api().post('/api/auth/login').send({ email: USUARIOS.cozinhaRecife, senha: 'errada123' });
  }
  const r = await api().post('/api/auth/login').send({ email: USUARIOS.cozinhaRecife, senha: 'Raizes@2026' });
  assert.equal(r.status, 423, 'mesmo com a senha certa, fica bloqueada');
  await query(`UPDATE usuarios SET bloqueado_ate = NULL WHERE email = $1`, [USUARIOS.cozinhaRecife]);
});

test('rotas protegidas exigem token válido', async () => {
  assert.equal((await api().get('/api/pedidos')).status, 401);
  assert.equal((await api().get('/api/pedidos').set('Authorization', 'Bearer abc.def.ghi')).status, 401);
  const forjado = jwt.sign({ tipo: 'USUARIO' }, 'segredo-errado', { subject: '1' });
  assert.equal((await api().get('/api/pedidos').set('Authorization', `Bearer ${forjado}`)).status, 401);
  const semAlg = jwt.sign({ tipo: 'USUARIO', sub: '1' }, '', { algorithm: 'none' });
  assert.equal((await api().get('/api/pedidos').set('Authorization', `Bearer ${semAlg}`)).status, 401);
});

test('registro de cliente exige consentimento e senha forte', async () => {
  const base = { nome: 'Ana Lima', email: 'ana@exemplo.com', senha: 'Segura123' };
  assert.equal((await api().post('/api/auth/clientes/registro').send(base)).status, 400);
  assert.equal((await api().post('/api/auth/clientes/registro').send({ ...base, senha: '123', consentimento_termos: true })).status, 400);
  const ok = await api().post('/api/auth/clientes/registro').send({ ...base, consentimento_termos: true });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.cliente.consentimento_marketing, false, 'marketing é opt-in');
  const dup = await api().post('/api/auth/clientes/registro').send({ ...base, email: 'ANA@exemplo.com', consentimento_termos: true });
  assert.equal(dup.status, 409, 'e-mail é único (sem diferenciar maiúsculas)');
  const { rows: [c] } = await query(`SELECT senha_hash FROM clientes WHERE email = 'ana@exemplo.com'`);
  assert.match(c.senha_hash, /^\$2[aby]\$/, 'senha armazenada com bcrypt');
});

test('usuário desativado perde o acesso imediatamente, mesmo com token válido', async () => {
  const admin = como(await tokenUsuario(USUARIOS.admin));
  const criado = await admin.post('/api/usuarios', { nome: 'Temp', email: 'temp@raizes.com.br', senha: 'Temp12345', perfil_id: 3, unidade_id: 1 });
  assert.equal(criado.status, 201);
  const login = await api().post('/api/auth/login').send({ email: 'temp@raizes.com.br', senha: 'Temp12345' });
  const temp = como(login.body.token);
  assert.equal((await temp.get('/api/pedidos')).status, 200);
  await admin.patch(`/api/usuarios/${criado.body.id}`, { ativo: false });
  assert.equal((await temp.get('/api/pedidos')).status, 401);
});

test('cada perfil só acessa o que lhe é permitido', async () => {
  const atendente = como(await tokenUsuario(USUARIOS.atendenteRecife));
  const cozinha = como(await tokenUsuario(USUARIOS.cozinhaRecife));
  const gerente = como(await tokenUsuario(USUARIOS.gerenteRecife));

  assert.equal((await atendente.get('/api/relatorios/vendas')).status, 403);
  assert.equal((await atendente.post('/api/produtos', { categoria_id: 1, nome: 'X', preco: 1 })).status, 403);
  assert.equal((await cozinha.post('/api/pedidos', { itens: [{ produto_id: 1, quantidade: 1 }] })).status, 403);
  assert.equal((await cozinha.get('/api/clientes')).status, 403);
  assert.equal((await gerente.get('/api/relatorios/vendas')).status, 200);
  assert.equal((await gerente.post('/api/unidades', { nome: 'Nova' })).status, 403, 'gerente não cria unidades');
  assert.equal((await gerente.get('/api/auditoria')).status, 200);
});

test('isolamento por unidade: gerente de Recife não acessa dados de Fortaleza', async () => {
  const gerente = como(await tokenUsuario(USUARIOS.gerenteRecife));
  assert.equal((await gerente.get('/api/estoque?unidade_id=2')).status, 403);
  assert.equal((await gerente.get('/api/relatorios/vendas?unidade_id=2')).status, 403);
  const estoque = await gerente.get('/api/estoque');
  assert.ok(estoque.body.every((e) => e.unidade_id === 1), 'sem filtro, vê só a própria unidade');

  const fortaleza = como(await tokenUsuario(USUARIOS.gerenteFortaleza));
  const { body: pedido } = await fortaleza.post('/api/pedidos', { itens: [{ produto_id: 9, quantidade: 1 }] });
  assert.equal((await gerente.get(`/api/pedidos/${pedido.id}`)).status, 403);
  assert.equal((await gerente.post(`/api/pedidos/${pedido.id}/cancelar`, { motivo: 'invasão' })).status, 403);

  const admin = como(await tokenUsuario(USUARIOS.admin));
  assert.equal((await admin.get(`/api/pedidos/${pedido.id}`)).status, 200, 'administração da rede vê todas');
});

test('não há escalonamento de privilégios na gestão de usuários', async () => {
  const gerente = como(await tokenUsuario(USUARIOS.gerenteRecife));
  const { rows: perfis } = await query('SELECT id, nome FROM perfis');
  const id = Object.fromEntries(perfis.map((p) => [p.nome, p.id]));

  const admin = await gerente.post('/api/usuarios', { nome: 'Hacker', email: 'h@raizes.com.br', senha: 'Hacker123', perfil_id: id.ADMIN });
  assert.equal(admin.status, 403, 'gerente não cria ADMIN');
  const outraUnidade = await gerente.post('/api/usuarios', { nome: 'Fulano', email: 'x@raizes.com.br', senha: 'Xxxxx1234', perfil_id: id.ATENDENTE, unidade_id: 2 });
  assert.equal(outraUnidade.status, 403, 'gerente não cria usuário em outra unidade');
  const ok = await gerente.post('/api/usuarios', { nome: 'Novo Atendente', email: 'novo@raizes.com.br', senha: 'Novo12345', perfil_id: id.ATENDENTE });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.unidade_id, 1, 'herda a unidade do gerente');

  const { rows: [adm] } = await query(`SELECT id FROM usuarios WHERE email = $1`, [USUARIOS.admin]);
  assert.equal((await gerente.patch(`/api/usuarios/${adm.id}`, { senha: 'Trocada123' })).status, 403, 'não altera conta de nível superior');
});

test('perfis são configuráveis e a mudança vale imediatamente', async () => {
  const admin = como(await tokenUsuario(USUARIOS.admin));
  const cozinha = como(await tokenUsuario(USUARIOS.cozinhaRecife));
  const { rows: [perfil] } = await query(`SELECT id FROM perfis WHERE nome = 'COZINHA'`);
  assert.equal((await cozinha.get('/api/estoque/movimentacoes')).status, 200);
  assert.equal((await cozinha.post('/api/estoque/movimentacoes', { item_estoque_id: 1, tipo: 'ENTRADA', quantidade: 1 })).status, 403);

  const r = await admin.put(`/api/perfis/${perfil.id}`, { permissoes: ['pedidos.ver', 'pedidos.atualizar_status', 'estoque.ver', 'estoque.gerenciar'] });
  assert.equal(r.status, 200);
  assert.equal((await cozinha.post('/api/estoque/movimentacoes', { item_estoque_id: 1, tipo: 'ENTRADA', quantidade: 1 })).status, 201);

  const { rows: [adm] } = await query(`SELECT id FROM perfis WHERE nome = 'ADMIN'`);
  assert.equal((await admin.put(`/api/perfis/${adm.id}`, { permissoes: [] })).status, 403, 'ADMIN é protegido');
  assert.equal((await admin.put(`/api/perfis/${perfil.id}`, { permissoes: ['permissao.inventada'] })).status, 400);
});

test('cabeçalhos de segurança e erros sem vazamento de detalhes internos', async () => {
  const r = await api().get('/api/health');
  assert.equal(r.status, 200);
  assert.equal(r.headers['x-powered-by'], undefined);
  assert.equal(r.headers['x-content-type-options'], 'nosniff');
  assert.ok(r.headers['content-security-policy']);
  const malformado = await api().post('/api/auth/login').set('Content-Type', 'application/json').send('{"email":');
  assert.equal(malformado.status, 400);
  assert.equal(malformado.body.stack, undefined);
});
