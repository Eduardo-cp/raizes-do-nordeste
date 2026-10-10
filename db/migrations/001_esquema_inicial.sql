CREATE TABLE unidades (
  id          SERIAL PRIMARY KEY,
  nome        VARCHAR(120) NOT NULL UNIQUE,
  endereco    VARCHAR(255),
  telefone    VARCHAR(20),
  ativo       BOOLEAN NOT NULL DEFAULT TRUE,
  criado_em   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE permissoes (
  codigo      VARCHAR(60) PRIMARY KEY,
  descricao   VARCHAR(255) NOT NULL
);

CREATE TABLE perfis (
  id          SERIAL PRIMARY KEY,
  nome        VARCHAR(60) NOT NULL UNIQUE,
  descricao   VARCHAR(255),
  sistema     BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE TABLE perfil_permissoes (
  perfil_id   INT NOT NULL REFERENCES perfis(id) ON DELETE CASCADE,
  permissao   VARCHAR(60) NOT NULL REFERENCES permissoes(codigo) ON DELETE CASCADE,
  PRIMARY KEY (perfil_id, permissao)
);

CREATE TABLE usuarios (
  id                 SERIAL PRIMARY KEY,
  nome               VARCHAR(120) NOT NULL,
  email              VARCHAR(160) NOT NULL UNIQUE,
  senha_hash         VARCHAR(100) NOT NULL,
  perfil_id          INT NOT NULL REFERENCES perfis(id),
  unidade_id         INT REFERENCES unidades(id),
  ativo              BOOLEAN NOT NULL DEFAULT TRUE,
  tentativas_falhas  INT NOT NULL DEFAULT 0,
  bloqueado_ate      TIMESTAMPTZ,
  criado_em          TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE clientes (
  id                        SERIAL PRIMARY KEY,
  nome                      VARCHAR(120) NOT NULL,
  email                     VARCHAR(160) UNIQUE,
  telefone                  VARCHAR(20),
  senha_hash                VARCHAR(100),
  preferencias              JSONB NOT NULL DEFAULT '{}'::jsonb,
  consentimento_termos_em   TIMESTAMPTZ NOT NULL,
  consentimento_marketing   BOOLEAN NOT NULL DEFAULT FALSE,
  anonimizado_em            TIMESTAMPTZ,
  tentativas_falhas         INT NOT NULL DEFAULT 0,
  bloqueado_ate             TIMESTAMPTZ,
  criado_em                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE categorias (
  id          SERIAL PRIMARY KEY,
  nome        VARCHAR(80) NOT NULL UNIQUE,
  descricao   VARCHAR(255),
  ativo       BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE produtos (
  id            SERIAL PRIMARY KEY,
  categoria_id  INT NOT NULL REFERENCES categorias(id),
  nome          VARCHAR(120) NOT NULL UNIQUE,
  descricao     TEXT,
  preco         NUMERIC(10,2) NOT NULL CHECK (preco > 0),
  imagem_url    VARCHAR(255),
  ativo         BOOLEAN NOT NULL DEFAULT TRUE,
  criado_em     TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE itens_estoque (
  id              SERIAL PRIMARY KEY,
  nome            VARCHAR(120) NOT NULL UNIQUE,
  tipo            VARCHAR(20) NOT NULL CHECK (tipo IN ('INGREDIENTE', 'PRODUTO_ACABADO')),
  unidade_medida  VARCHAR(10) NOT NULL CHECK (unidade_medida IN ('UN', 'KG', 'G', 'L', 'ML')),
  ativo           BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE produto_composicao (
  produto_id       INT NOT NULL REFERENCES produtos(id) ON DELETE CASCADE,
  item_estoque_id  INT NOT NULL REFERENCES itens_estoque(id),
  quantidade       NUMERIC(12,3) NOT NULL CHECK (quantidade > 0),
  PRIMARY KEY (produto_id, item_estoque_id)
);

CREATE TABLE estoque (
  unidade_id       INT NOT NULL REFERENCES unidades(id),
  item_estoque_id  INT NOT NULL REFERENCES itens_estoque(id),
  quantidade       NUMERIC(12,3) NOT NULL DEFAULT 0 CHECK (quantidade >= 0),
  reservado        NUMERIC(12,3) NOT NULL DEFAULT 0 CHECK (reservado >= 0),
  estoque_minimo   NUMERIC(12,3) NOT NULL DEFAULT 0 CHECK (estoque_minimo >= 0),
  atualizado_em    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (unidade_id, item_estoque_id),
  CHECK (reservado <= quantidade)
);

CREATE TABLE pedidos (
  id                     SERIAL PRIMARY KEY,
  codigo_acompanhamento  UUID NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  unidade_id             INT NOT NULL REFERENCES unidades(id),
  cliente_id             INT REFERENCES clientes(id),
  usuario_id             INT REFERENCES usuarios(id),
  canal                  VARCHAR(20) NOT NULL CHECK (canal IN ('BALCAO', 'APP', 'DELIVERY', 'TOTEM')),
  status                 VARCHAR(30) NOT NULL CHECK (status IN (
                           'AGUARDANDO_PAGAMENTO', 'PAGAMENTO_RECUSADO', 'PAGO', 'EM_PREPARO',
                           'PRONTO', 'SAIU_PARA_ENTREGA', 'ENTREGUE', 'CANCELADO')),
  total                  NUMERIC(10,2) NOT NULL CHECK (total >= 0),
  observacao             VARCHAR(500),
  endereco_entrega       VARCHAR(255),
  motivo_cancelamento    VARCHAR(255),
  criado_em              TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_pedidos_unidade_status ON pedidos (unidade_id, status);
CREATE INDEX idx_pedidos_criado_em ON pedidos (criado_em);
CREATE INDEX idx_pedidos_cliente ON pedidos (cliente_id);

CREATE TABLE itens_pedido (
  id               SERIAL PRIMARY KEY,
  pedido_id        INT NOT NULL REFERENCES pedidos(id) ON DELETE CASCADE,
  produto_id       INT NOT NULL REFERENCES produtos(id),
  quantidade       INT NOT NULL CHECK (quantidade > 0),
  preco_unitario   NUMERIC(10,2) NOT NULL,
  observacao       VARCHAR(255)
);
CREATE INDEX idx_itens_pedido_pedido ON itens_pedido (pedido_id);

CREATE TABLE pedido_status_historico (
  id            SERIAL PRIMARY KEY,
  pedido_id     INT NOT NULL REFERENCES pedidos(id) ON DELETE CASCADE,
  status_de     VARCHAR(30),
  status_para   VARCHAR(30) NOT NULL,
  usuario_id    INT REFERENCES usuarios(id),
  observacao    VARCHAR(255),
  criado_em     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_historico_pedido ON pedido_status_historico (pedido_id);

CREATE TABLE pagamentos (
  id               SERIAL PRIMARY KEY,
  pedido_id        INT NOT NULL REFERENCES pedidos(id),
  gateway          VARCHAR(30) NOT NULL,
  gateway_id       VARCHAR(100),
  metodo           VARCHAR(20) NOT NULL CHECK (metodo IN ('PIX', 'CARTAO_CREDITO', 'CARTAO_DEBITO', 'DINHEIRO')),
  status           VARCHAR(20) NOT NULL CHECK (status IN ('PENDENTE', 'APROVADO', 'RECUSADO', 'ESTORNADO')),
  valor            NUMERIC(10,2) NOT NULL CHECK (valor > 0),
  idempotency_key  UUID NOT NULL UNIQUE,
  detalhes         JSONB NOT NULL DEFAULT '{}'::jsonb,
  criado_em        TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (gateway, gateway_id)
);
CREATE INDEX idx_pagamentos_pedido ON pagamentos (pedido_id);
CREATE UNIQUE INDEX uq_pagamento_aprovado_por_pedido ON pagamentos (pedido_id) WHERE status = 'APROVADO';

CREATE TABLE movimentacoes_estoque (
  id               BIGSERIAL PRIMARY KEY,
  unidade_id       INT NOT NULL REFERENCES unidades(id),
  item_estoque_id  INT NOT NULL REFERENCES itens_estoque(id),
  tipo             VARCHAR(20) NOT NULL CHECK (tipo IN (
                     'ENTRADA', 'SAIDA', 'AJUSTE', 'RESERVA', 'LIBERACAO_RESERVA', 'BAIXA_PEDIDO', 'ESTORNO')),
  quantidade       NUMERIC(12,3) NOT NULL,
  pedido_id        INT REFERENCES pedidos(id),
  usuario_id       INT REFERENCES usuarios(id),
  observacao       VARCHAR(255),
  criado_em        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_mov_unidade_data ON movimentacoes_estoque (unidade_id, criado_em);
CREATE INDEX idx_mov_pedido ON movimentacoes_estoque (pedido_id);

CREATE TABLE lancamentos_caixa (
  id              BIGSERIAL PRIMARY KEY,
  unidade_id      INT NOT NULL REFERENCES unidades(id),
  tipo            VARCHAR(10) NOT NULL CHECK (tipo IN ('ENTRADA', 'SAIDA')),
  categoria       VARCHAR(30) NOT NULL CHECK (categoria IN (
                    'VENDA', 'ESTORNO', 'COMPRA_INSUMOS', 'DESPESA', 'SUPRIMENTO', 'SANGRIA', 'OUTROS')),
  valor           NUMERIC(10,2) NOT NULL CHECK (valor > 0),
  forma_pagamento VARCHAR(20),
  pedido_id       INT REFERENCES pedidos(id),
  pagamento_id    INT REFERENCES pagamentos(id),
  usuario_id      INT REFERENCES usuarios(id),
  descricao       VARCHAR(255),
  criado_em       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_caixa_unidade_data ON lancamentos_caixa (unidade_id, criado_em);

CREATE TABLE audit_log (
  id          BIGSERIAL PRIMARY KEY,
  ator_tipo   VARCHAR(10) NOT NULL CHECK (ator_tipo IN ('USUARIO', 'CLIENTE', 'SISTEMA', 'ANONIMO')),
  ator_id     INT,
  acao        VARCHAR(120) NOT NULL,
  entidade    VARCHAR(40),
  entidade_id VARCHAR(40),
  ip          VARCHAR(64),
  detalhes    JSONB NOT NULL DEFAULT '{}'::jsonb,
  criado_em   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_audit_criado_em ON audit_log (criado_em);
CREATE INDEX idx_audit_entidade ON audit_log (entidade, entidade_id);
