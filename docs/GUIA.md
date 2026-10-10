# Guia completo do sistema Raízes do Nordeste

Este guia explica, passo a passo, como instalar, usar, demonstrar e explicar o sistema de gestão da rede Raízes do Nordeste. Não exige experiência prévia com Node.js.

## Sumário

1. [O que é o sistema](#1-o-que-é-o-sistema)
2. [Requisitos do computador](#2-requisitos-do-computador)
3. [Instalação passo a passo](#3-instalação-passo-a-passo)
4. [Uso do dia a dia: ligar e desligar](#4-uso-do-dia-a-dia-ligar-e-desligar)
5. [Acessos de demonstração](#5-acessos-de-demonstração)
6. [Conhecendo as telas](#6-conhecendo-as-telas)
7. [Como cada requisito do projeto foi atendido](#8-como-cada-requisito-do-projeto-foi-atendido)
8. [A API e a documentação Swagger](#9-a-api-e-a-documentação-swagger)
9. [Testes automatizados](#10-testes-automatizados)
10. [Configurações opcionais](#11-configurações-opcionais)
11. [Solução de problemas](#12-solução-de-problemas)
12. [Glossário](#14-glossário)

---

## 1. O que é o sistema

O sistema centraliza a operação de uma rede de lanchonetes com várias unidades. Ele tem duas partes:

- **API REST (o "servidor"):** feita em Node.js, guarda os dados em um banco PostgreSQL e aplica todas as regras de negócio.
- **Painel web:** as telas usadas pelos funcionários (administrador, gerente, atendente e cozinha) e pelos clientes. Ele roda no navegador e conversa com a API.

A demonstração já vem com dados prontos: **2 unidades** (Recife - Boa Viagem e Fortaleza - Aldeota), **13 produtos** em 5 categorias (Tapiocas, Cuscuz, Salgados, Bebidas e Sobremesas), **6 funcionários**, **2 clientes** e cerca de **260 pedidos** dos últimos 14 dias, para que os relatórios tenham conteúdo.

---

## 2. Requisitos do computador

| Item | Detalhe |
|---|---|
| Sistema operacional | Windows 10/11, macOS ou Linux |
| Node.js | Versão **20 ou mais recente** |
| Navegador | Chrome, Edge ou Firefox atualizado |
| Internet | Necessária apenas na instalação (para baixar as dependências) |
| PostgreSQL | **Não precisa instalar.** O projeto traz um PostgreSQL próprio para uso local |
| Portas livres | **3000** (sistema) e **5433** (banco local) |

### Como instalar o Node.js

1. Acesse https://nodejs.org e baixe a versão **LTS**.
2. Instale com as opções padrão (Avançar, Avançar, Concluir).
3. Abra um terminal novo e confira:
   ```
   node -v
   ```
   Deve aparecer `v20` ou superior (por exemplo, `v22.11.0`).

> **Como abrir o terminal no Windows:** abra a pasta do projeto no Explorador de Arquivos, clique na barra de endereço, digite `cmd` e pressione Enter. O terminal já abre dentro da pasta certa.

---

## 3. Instalação passo a passo

Faça isto **uma única vez**. Todos os comandos são digitados no terminal, dentro da pasta do projeto (`raizes-do-nordeste`).

> **No Windows, deixe o projeto em uma pasta curta**, como a Área de Trabalho, Documentos ou `C:\raizes-do-nordeste`. O Windows limita os caminhos de arquivo a 260 caracteres, e o banco local não funciona se a pasta estiver dentro de muitas subpastas.

**Passo 1 — Instalar as dependências**
```
npm install
```
Leva de 1 a 3 minutos. Baixa as bibliotecas usadas pelo projeto e o PostgreSQL local. Avisos em amarelo (`npm warn`) são normais e podem ser ignorados.

**Passo 2 — Criar o arquivo de configuração**

No Windows:
```
copy .env.example .env
```
No macOS/Linux:
```
cp .env.example .env
```
O arquivo `.env` guarda as configurações (porta, banco, senhas internas). Os valores padrão já funcionam para a demonstração.

**Passo 3 — Ligar o banco de dados local**
```
npm run db:local:start
```
Resultado esperado:
```
Diretório de dados inicializado em .pgdata
PostgreSQL local rodando na porta 5433.
Banco "raizes" criado.
Banco "raizes_test" criado.
```

**Passo 4 — Criar as tabelas**
```
npm run db:migrate
```
Resultado esperado:
```
Migração aplicada: 001_esquema_inicial.sql
Migração aplicada: 002_perfis_e_permissoes.sql
Banco atualizado.
```

**Passo 5 — Carregar os dados de demonstração**
```
npm run db:seed
```
Resultado esperado: `Dados de demonstração criados.`, seguido da lista de usuários.

**Passo 6 — Iniciar o sistema**
```
npm start
```
Resultado esperado:
```
Raízes do Nordeste rodando em http://localhost:3000
  Painel:        http://localhost:3000/
  Documentação:  http://localhost:3000/api/docs
  Pagamentos:    gateway "mock"
```

**Passo 7 — Abrir no navegador**

Acesse **http://localhost:3000**. A tela de login deve aparecer.

> **Importante:** o terminal onde você rodou `npm start` precisa **ficar aberto** enquanto usa o sistema. Se fechá-lo, o sistema para.

---

## 4. Uso do dia a dia: ligar e desligar

Depois da instalação, não é preciso repetir tudo.

| Ação | Comando |
|---|---|
| Ligar o banco | `npm run db:local:start` |
| Ligar o sistema | `npm start` |
| Desligar o sistema | `Ctrl + C` no terminal do `npm start` |
| Desligar o banco | `npm run db:local:stop` |
| Voltar aos dados originais da demonstração | `npm run db:reset` |

**Antes de cada apresentação**, rode `npm run db:reset`. Ele apaga tudo o que foi feito nos testes e recarrega os dados de demonstração limpos. Esse comando só funciona com o banco local, para nunca apagar um banco real por engano.

---

## 5. Acessos de demonstração

### Funcionários

Todos usam a senha **`Raizes@2026`**.

| Perfil | E-mail | Unidade | O que pode fazer |
|---|---|---|---|
| Administrador | `admin@raizes.com.br` | Todas | Tudo, em todas as unidades |
| Gerente | `gerente.recife@raizes.com.br` | Recife | Tudo na sua unidade, exceto criar unidades e configurar perfis |
| Gerente | `gerente.fortaleza@raizes.com.br` | Fortaleza | O mesmo, na unidade de Fortaleza |
| Atendente | `atendente.recife@raizes.com.br` | Recife | Registrar pedidos, receber em dinheiro, cadastrar clientes, ver estoque |
| Cozinha | `cozinha.recife@raizes.com.br` | Recife | Ver pedidos e avançar o preparo; ver estoque |

### Clientes

| Nome | E-mail | Senha |
|---|---|---|
| Maria das Graças | `maria@exemplo.com` | `Cliente@2026` |
| José Ferreira | `jose@exemplo.com` | `Cliente@2026` |

Na tela de login, escolha **Funcionário** ou **Cliente** antes de digitar o e-mail. Também é possível criar uma conta nova em **Criar conta**.

### Cartões de teste

Os pagamentos rodam em **ambiente de testes**: nenhum dinheiro real é movimentado. Na tela de pagamento há um seletor:

| Opção | Resultado |
|---|---|
| Cartão aprovado | O pagamento é aprovado na hora |
| Cartão recusado (saldo insuficiente) | O pagamento é recusado e o cliente pode tentar de novo |
| Falha no provedor | Simula o serviço de pagamento fora do ar |

> **Dica:** para usar dois perfis ao mesmo tempo (por exemplo, cliente e cozinha), abra **outra aba** ou **outra janela** do navegador. Cada aba mantém o seu próprio login.

---

## 6. Conhecendo as telas

### 6.1 Tela de login

Três opções no topo: **Funcionário**, **Cliente** e **Criar conta**. No cadastro, a caixa "Li e aceito os termos de uso e a política de privacidade" é obrigatória (exigência da LGPD). A caixa de promoções é opcional e vem desmarcada.

Após 5 tentativas de senha errada, a conta fica bloqueada por 15 minutos (proteção contra ataques).

### 6.2 Cliente: Fazer pedido

1. Escolha a **unidade** no seletor do topo.
2. Clique em **Adicionar** nos produtos desejados. O carrinho, à direita, acompanha a rolagem da página.
3. Use **−** e **+** para ajustar as quantidades.
4. Em "Como quer receber?", escolha **Retirar na loja** ou **Delivery** (o delivery exige endereço).
5. Clique em **Fazer pedido**.

Produtos sem ingredientes suficientes aparecem como **Esgotado** e não podem ser adicionados. A disponibilidade é calculada em tempo real a partir do estoque de cada unidade.

Depois de criar o pedido, aparecem as opções de pagamento:
- **PIX:** gera um código "copia e cola". Como é ambiente de testes, use os botões **Confirmar PIX** ou **Recusar** para simular a resposta do banco.
- **Crédito / Débito:** escolha o tipo de cartão de teste no seletor.

Enquanto o pagamento é processado, os botões ficam desativados e aparece "Processando pagamento…".

### 6.3 Cliente: Meus pedidos

Lista todos os pedidos do cliente com status, itens e total. O link **Acompanhar** abre a página pública do pedido.

### 6.4 Página de acompanhamento

Mostra o status atual e a linha do tempo do pedido (Aguardando pagamento → Pago → Em preparo → Pronto → Entregue). **Atualiza sozinha a cada 5 segundos.** Não exige login e não mostra nenhum dado pessoal: só quem tem o link consegue ver.

### 6.5 Cliente: Privacidade

- Mostra quando os termos foram aceitos.
- Permite **ligar ou desligar** o recebimento de promoções.
- **Baixar meus dados:** gera um arquivo JSON com todos os dados e pedidos do cliente.
- **Excluir minha conta:** pede a senha e anonimiza os dados pessoais. As vendas continuam registradas, mas sem identificação, por obrigação fiscal. Se houver pedido em andamento, a exclusão é recusada até que ele seja concluído.

### 6.6 Funcionário: Pedidos (quadro da cozinha)

Quadro com quatro colunas: **Aguardando pagamento**, **Na fila (pago)**, **Em preparo** e **Pronto / em entrega**. O indicador "● ao vivo" mostra que o quadro está conectado: pedidos novos aparecem **sozinhos, sem recarregar a página**, com um aviso no canto da tela.

Botões de cada cartão, conforme o perfil:
- **Iniciar preparo** → **Marcar pronto** → **Retirado / entregue** (ou **Saiu p/ entrega** → **Entregue**, no delivery).
- **Receber em dinheiro:** para pedidos de balcão ainda não pagos.
- **Cancelar:** apenas gerente e administrador. Se o pedido já estava pago, o valor é estornado automaticamente e o estoque volta (quando o preparo ainda não começou).

O sistema não permite pular etapas: um pedido não pago não pode ir para o preparo, e um delivery precisa "sair para entrega" antes de ser entregue.

### 6.7 Funcionário: Novo pedido (balcão)

Igual à tela do cliente, com estas diferenças:
- Canais **Balcão**, **Totem** e **Delivery (telefone)**.
- A opção de pagamento **Dinheiro** (para quem tem permissão).
- O administrador escolhe a unidade; os demais funcionários usam sempre a própria.

### 6.8 Funcionário: Estoque

- A tabela mostra, para cada item: **saldo**, **reservado** (separado para pedidos ainda não pagos), **disponível** e **mínimo**. Os itens no mínimo ou abaixo dele ficam destacados em vermelho, e um aviso no topo lista o que precisa de reposição.
- O formulário **Registrar movimentação** (gerente e administrador) aceita três tipos:
  - **Entrada (compra):** soma ao estoque. Se informar o custo total, a compra entra automaticamente no fluxo de caixa como saída.
  - **Saída (perda/avaria):** retira do estoque. Não permite retirar o que está reservado para pedidos.
  - **Ajuste (inventário):** informe a quantidade contada fisicamente; o sistema registra a diferença.

Na demonstração, a unidade de **Fortaleza** começa com **Charque** e **Cocada** abaixo do mínimo, para mostrar os alertas.

### 6.9 Funcionário: Relatórios

Disponível para gerente (da própria unidade) e administrador (rede toda).
- **Indicadores do dia:** faturamento, pedidos, ticket médio e itens a repor.
- **Filtro de período** (início e fim) e botões para **baixar em CSV** (abre direto no Excel).
- **Vendas por dia** (gráfico de barras), **por forma de pagamento**, **por canal** e **por unidade**.
- **Produtos mais vendidos.**
- **Fluxo de caixa:** saldo inicial, entradas, saídas, saldo final e totais por categoria (vendas, estornos, compras de insumos…).
- **Movimentação e cobertura de estoque:** entradas, consumo pelas vendas, perdas e **dias de cobertura** (por quantos dias o estoque atual dura no ritmo de consumo do período).

### 6.10 Funcionário: Clientes

- Busca por nome, e-mail ou telefone.
- Clique em um cliente para ver a ficha: total de pedidos, total gasto, produtos favoritos e preferências. **Cada consulta fica registrada na trilha de auditoria** (exigência da LGPD).
- **Cadastrar cliente** no balcão, com confirmação obrigatória do consentimento.

---

## 7. Como cada requisito do projeto foi atendido

| Requisito do enunciado | Como foi atendido | Onde ver |
|---|---|---|
| **Gerenciamento de clientes**: cadastro, histórico de pedidos, preferências e contato | Cadastro pelo app ou no balcão; preferências livres (JSON); ficha com total gasto e produtos favoritos | Tela Clientes; `src/modules/clientes.routes.js` |
| **Produtos e categorias**: categorização, preços, descrições e imagens | Cadastro completo, upload de imagem validado pelo conteúdo do arquivo e ficha técnica de ingredientes | Swagger, seção Catálogo; `src/modules/catalogo.routes.js` |
| **Gerenciamento de usuários**: perfis por unidade | 4 perfis padrão e perfis personalizados; cada usuário fica restrito à sua unidade | Login com cada perfil; `src/middleware/auth.js` |
| **Processamento de pedidos**: do pedido até a entrega | Máquina de estados com 8 status, histórico de cada mudança e acompanhamento público | Quadro de pedidos; `src/modules/pedidos.service.js` |
| **Controle de estoque** em tempo real com alertas | Reserva, baixa e estorno automáticos; alertas instantâneos no painel | Tela Estoque; `src/modules/estoque.service.js` |
| **Relatórios gerenciais**: vendas, fluxo de caixa e estoque | Três relatórios completos, painel do dia e exportação em CSV | Tela Relatórios; `src/modules/relatorios.routes.js` |
| **Integração com pagamento externo** | Gateway simulado para testes e integração com o Mercado Pago (sandbox), com PIX, cartão e webhook assinado | Tela de pagamento; `src/pagamentos/` |
| **Segurança dos dados** | Senhas criptografadas, tokens JWT, bloqueio de tentativas, consultas protegidas contra SQL injection, cabeçalhos de segurança | `docs/ARQUITETURA.md`, seção Segurança |
| **Conformidade com a LGPD** | Consentimento registrado, exportação e exclusão dos dados, auditoria de acessos, minimização dos dados | `docs/LGPD.md` |
| **Controle de acessos** detalhado e configurável | 17 permissões combináveis em perfis (o ADMIN tem todas; o GERENTE tem 15; o ATENDENTE, 7; a COZINHA, 3) | Swagger, seção Usuários e perfis |
| **Disponibilidade** | Verificação de saúde (`/api/health`), encerramento gracioso, tempo limite nas chamadas externas, cancelamento automático de pedidos abandonados | `src/server.js`, `src/app.js` |
| **Documentação e testes** | README, este guia, documentação da arquitetura e da LGPD, Swagger e 44 testes automatizados | Pasta `docs/` e pasta `tests/` |

---

## 8. A API e a documentação Swagger

Acesse **http://localhost:3000/api/docs**. Ali estão todas as rotas da API, organizadas por módulo, e é possível testá-las direto pelo navegador:

1. Abra **Autenticação → POST /auth/login** e clique em **Try it out**.
2. Use `{"email": "admin@raizes.com.br", "senha": "Raizes@2026"}` e clique em **Execute**.
3. Copie o valor de `token` da resposta.
4. Clique em **Authorize** (cadeado no topo), cole o token e confirme.
5. Agora todas as rotas podem ser testadas como administrador.

Os erros seguem sempre o mesmo formato: `{ "erro": "mensagem", "detalhes": [...] }`.

| Código | Significado |
|---|---|
| 400 | Dados inválidos (o campo `detalhes` diz qual campo está errado) |
| 401 | Não está logado ou o login expirou |
| 403 | Logado, mas sem permissão para essa ação |
| 404 | Não encontrado |
| 409 | Regra de negócio impediu a ação (por exemplo, estoque insuficiente) |
| 423 | Conta bloqueada temporariamente por excesso de tentativas |
| 502 | O serviço de pagamento não respondeu |

---

## 9. Testes automatizados

Com o banco local ligado (`npm run db:local:start`), rode:
```
npm test
```
São **44 testes** de integração, divididos em quatro arquivos:

| Arquivo | Testes | O que verifica |
|---|---|---|
| `tests/pedidos.test.js` | 13 | Fluxo completo, pagamentos, webhook, falha do provedor, estoque insuficiente, 5 pedidos simultâneos disputando o mesmo estoque, delivery, cancelamento com estorno, expiração |
| `tests/lgpd-relatorios.test.js` | 13 | Consentimento, exportação, anonimização, auditoria, relatórios, CSV, eventos em tempo real |
| `tests/seguranca.test.js` | 10 | Login, bloqueio, token falso, perfis, isolamento entre unidades, escalonamento de privilégio |
| `tests/estoque-catalogo.test.js` | 8 | Produtos, upload de imagem, entradas, perdas, inventário, alertas |

Os testes usam um banco separado (`raizes_test`), que é recriado do zero a cada execução. Eles **nunca** alteram os dados da demonstração.

Resultado esperado no final:
```
ℹ tests 44
ℹ pass 44
ℹ fail 0
```

---

## 10. Configurações opcionais

Todas as configurações ficam no arquivo `.env`. Depois de alterá-lo, reinicie o sistema (`Ctrl + C` e `npm start`).

| Variável | Para que serve | Padrão |
|---|---|---|
| `PORT` | Porta do sistema | `3000` |
| `DATABASE_URL` | Endereço do banco de dados | Banco local, porta 5433 |
| `DATABASE_SSL` | `true` para bancos na nuvem que exigem conexão segura | `false` |
| `JWT_SECRET` | Chave que assina os logins. **Troque por um valor longo e aleatório** se o sistema for usado de verdade | Valor de exemplo |
| `PAYMENT_GATEWAY` | `mock` (testes) ou `mercadopago` | `mock` |
| `PEDIDO_EXPIRACAO_MIN` | Minutos até um pedido não pago ser cancelado e o estoque liberado | `30` |

### Usar um banco na nuvem (Supabase)

1. Crie um projeto gratuito em https://supabase.com.
2. No painel do projeto, clique em **Connect** e copie a URL do **Session pooler** (não a "Direct connection", que só funciona em redes IPv6).
3. No `.env`, coloque essa URL em `DATABASE_URL` (com a senha do banco) e defina `DATABASE_SSL=true`.
4. Rode `npm run db:migrate` e `npm run db:seed`.

### Usar o Mercado Pago (ambiente de testes)

1. Crie uma aplicação em https://www.mercadopago.com.br/developers e copie o **Access Token de teste** (começa com `TEST-`).
2. No `.env`, defina `PAYMENT_GATEWAY=mercadopago`, `MP_ACCESS_TOKEN` e `MP_WEBHOOK_SECRET`.
3. Para receber as confirmações de PIX, o sistema precisa de um endereço público (por exemplo, com o ngrok). Coloque esse endereço em `PUBLIC_URL`.

Para a apresentação, o gateway simulado (`mock`) é o recomendado: funciona sem internet e mostra todos os cenários.

---

## 11. Solução de problemas

| Problema | Causa provável | Solução |
|---|---|---|
| `'node' não é reconhecido como um comando` | O Node.js não está instalado ou o terminal foi aberto antes da instalação | Instale o Node.js (seção 2) e abra um terminal novo |
| `npm start` mostra `EADDRINUSE: address already in use :::3000` | O sistema já está rodando em outro terminal, ou outro programa usa a porta 3000 | Feche o outro terminal ou mude `PORT=3001` no `.env` e acesse http://localhost:3001 |
| "Não é possível acessar esse site" no navegador | O sistema não está ligado, ou o endereço foi digitado errado | Confira se o terminal do `npm start` está aberto e use exatamente `http://localhost:3000` |
| `ECONNREFUSED ... 5433` ao iniciar | O banco local está desligado | Rode `npm run db:local:start` |
| `database "raizes" does not exist` | O banco não foi criado | Rode `npm run db:local:start` novamente |
| `relation "..." does not exist` | As tabelas não foram criadas | Rode `npm run db:migrate` |
| A tela abre, mas sem produtos | Os dados de demonstração não foram carregados | Rode `npm run db:seed` |
| "Banco já possui dados; seed ignorado" | Os dados já foram carregados antes | Normal. Para recarregar do zero, use `npm run db:reset` |
| "Conta temporariamente bloqueada" | 5 senhas erradas seguidas | Aguarde 15 minutos ou rode `npm run db:reset` |
| "O caminho da pasta do projeto é longo demais para o Windows" | A pasta do projeto está dentro de muitas subpastas, e o Windows limita os caminhos de arquivo a 260 caracteres | Mova a pasta para um local curto, como `C:\raizes-do-nordeste` ou a Área de Trabalho, e rode `npm install` de novo |
| "Falha ao iniciar o PostgreSQL" | Outro programa usa a porta 5433, ou a pasta `.pgdata` está corrompida | Veja os detalhes em `.pgdata/servidor.log`. Em último caso, rode `npm run db:local:stop`, apague a pasta `.pgdata` e repita os passos 3 a 5 da instalação |
| Os testes falham com `database "raizes_test" does not exist` | O banco local não foi iniciado | Rode `npm run db:local:start` antes de `npm test` |

---

## 12. Glossário

| Termo | Significado |
|---|---|
| **API REST** | A parte do sistema que recebe pedidos de outros programas (como o painel) pela internet e devolve dados |
| **Banco de dados** | Onde as informações ficam guardadas de forma permanente |
| **Migração** | Script que cria ou altera as tabelas do banco de forma controlada |
| **Seed** | Script que carrega os dados de demonstração |
| **JWT (token)** | "Crachá" digital entregue no login, que identifica o usuário nas próximas ações |
| **Perfil / permissão** | Conjunto de ações que um tipo de usuário pode realizar |
| **Gateway de pagamento** | O serviço externo que processa os pagamentos (aqui, simulado ou Mercado Pago) |
| **Webhook** | Aviso automático que o serviço de pagamento envia ao sistema quando um pagamento é confirmado |
| **Ficha técnica** | Lista dos ingredientes que cada produto consome |
| **Reserva de estoque** | Ingredientes separados para um pedido ainda não pago |
| **Anonimização** | Remoção definitiva dos dados que identificam uma pessoa |
| **Swagger** | Página que documenta a API e permite testá-la pelo navegador |
| **SSE (tempo real)** | Tecnologia que permite ao servidor avisar o navegador na hora em que algo acontece |
