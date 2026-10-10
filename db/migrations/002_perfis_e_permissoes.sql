INSERT INTO permissoes (codigo, descricao) VALUES
  ('unidades.gerenciar',       'Cadastrar e editar unidades da rede'),
  ('usuarios.gerenciar',       'Cadastrar, editar e desativar usuários'),
  ('perfis.gerenciar',         'Criar perfis e configurar permissões'),
  ('clientes.ver',             'Consultar clientes e histórico de pedidos'),
  ('clientes.gerenciar',       'Cadastrar e editar clientes'),
  ('catalogo.gerenciar',       'Gerenciar categorias, produtos, preços e imagens'),
  ('estoque.ver',              'Consultar posição e alertas de estoque'),
  ('estoque.gerenciar',        'Cadastrar itens e registrar movimentações de estoque'),
  ('pedidos.ver',              'Consultar pedidos da unidade'),
  ('pedidos.criar',            'Registrar pedidos (balcão/telefone)'),
  ('pedidos.atualizar_status', 'Avançar o status de preparo/entrega'),
  ('pedidos.cancelar',         'Cancelar pedidos (com estorno quando pago)'),
  ('pagamentos.registrar',     'Registrar pagamentos presenciais (dinheiro)'),
  ('caixa.lancar',             'Registrar lançamentos manuais de caixa'),
  ('relatorios.ver',           'Acessar relatórios gerenciais'),
  ('lgpd.gerenciar',           'Atender solicitações de titulares (exportar/anonimizar)'),
  ('auditoria.ver',            'Consultar a trilha de auditoria');

INSERT INTO perfis (nome, descricao, sistema) VALUES
  ('ADMIN',     'Administrador da rede: acesso total', TRUE),
  ('GERENTE',   'Gerente de unidade', TRUE),
  ('ATENDENTE', 'Atendimento no balcão e caixa', TRUE),
  ('COZINHA',   'Equipe de preparo', TRUE);

INSERT INTO perfil_permissoes (perfil_id, permissao)
SELECT p.id, pe.codigo FROM perfis p CROSS JOIN permissoes pe WHERE p.nome = 'ADMIN';

INSERT INTO perfil_permissoes (perfil_id, permissao)
SELECT p.id, pe.codigo FROM perfis p CROSS JOIN permissoes pe
WHERE p.nome = 'GERENTE' AND pe.codigo NOT IN ('unidades.gerenciar', 'perfis.gerenciar');

INSERT INTO perfil_permissoes (perfil_id, permissao)
SELECT p.id, x.codigo FROM perfis p
CROSS JOIN (VALUES ('clientes.ver'), ('clientes.gerenciar'), ('pedidos.ver'), ('pedidos.criar'),
                   ('pedidos.atualizar_status'), ('pagamentos.registrar'), ('estoque.ver')) AS x(codigo)
WHERE p.nome = 'ATENDENTE';

INSERT INTO perfil_permissoes (perfil_id, permissao)
SELECT p.id, x.codigo FROM perfis p
CROSS JOIN (VALUES ('pedidos.ver'), ('pedidos.atualizar_status'), ('estoque.ver')) AS x(codigo)
WHERE p.nome = 'COZINHA';
