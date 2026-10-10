# Raízes do Nordeste — Sistema de Gestão

> 📘 **Primeira vez aqui?** Leia o [Guia completo](docs/GUIA.md): instalação passo a passo, uso de cada tela, roteiro de apresentação, solução de problemas e perguntas frequentes da avaliação.

Sistema de gestão para a rede de lanchonetes **Raízes do Nordeste**. É composto por uma API REST (Node.js + PostgreSQL) e um painel web que centralizam:

| Módulo | O que faz |
|---|---|
| **Clientes** | Cadastro (app ou balcão), preferências, contato, histórico de pedidos e produtos favoritos |
| **Produtos e categorias** | Cardápio com categorias, preços, descrições, upload de imagens e ficha técnica (insumos por produto) |
| **Usuários e perfis** | Perfis ADMIN, GERENTE, ATENDENTE e COZINHA, além de perfis personalizados com permissões configuráveis. Cada usuário fica restrito à sua unidade |
| **Pedidos** | Fluxo completo do pedido até a entrega, com máquina de estados, acompanhamento público e painel em tempo real |
| **Estoque** | Reserva automática ao pedir, baixa ao pagar, entradas, perdas, inventário e alertas de reposição em tempo real |
| **Relatórios** | Vendas, fluxo de caixa, estoque (consumo e dias de cobertura) e painel do dia, com exportação em CSV |
| **Pagamentos** | Integração com serviço externo: gateway simulado (testes) e Mercado Pago (sandbox), com PIX, cartão e webhook assinado |

---

## 1. Como executar

### Opção A — Local, sem instalar o PostgreSQL (recomendado para a avaliação)

Requer apenas o **Node.js 20+**.

```bash
npm install
cp .env.example .env          # no Windows: copy .env.example .env
npm run db:local:start        # sobe um PostgreSQL local (porta 5433) usando binários do npm
npm run db:migrate            # cria as tabelas
npm run db:seed               # carrega a demonstração (2 unidades, cardápio, 14 dias de vendas)
npm start
```

Acesse:
- **Painel web:** http://localhost:3000
- **Documentação interativa da API (Swagger):** http://localhost:3000/api/docs

Para parar o banco: `npm run db:local:stop`. Para recriar tudo do zero: `npm run db:reset` (funciona apenas em banco local).

> No Windows, com login de Administrador, o PostgreSQL se recusa a iniciar diretamente; o script usa o `pg_ctl`, que contorna isso automaticamente.

### Opção B — PostgreSQL existente (ex.: Supabase, Render, RDS)

No `.env`, defina `DATABASE_URL` com a URL do banco e `DATABASE_SSL=true`. Depois rode `npm run db:migrate` e, se quiser, `npm run db:seed`.

> **Supabase:** a conexão direta (`db.<projeto>.supabase.co`) só funciona via IPv6. Em redes apenas IPv4, use a URL do **Session pooler** (painel → *Connect* → *Session pooler*, porta 5432).

---

## 2. Acessos de demonstração

| Perfil | E-mail | Senha | Unidade |
|---|---|---|---|
| Administrador da rede | admin@raizes.com.br | `Raizes@2026` | todas |
| Gerente | gerente.recife@raizes.com.br | `Raizes@2026` | Recife |
| Atendente | atendente.recife@raizes.com.br | `Raizes@2026` | Recife |
| Cozinha | cozinha.recife@raizes.com.br | `Raizes@2026` | Recife |
| Gerente | gerente.fortaleza@raizes.com.br | `Raizes@2026` | Fortaleza |
| Cliente | maria@exemplo.com | `Cliente@2026` | — |

**Cartões de teste (gateway simulado):** qualquer token é aprovado. Use `tok_recusado` para ver uma recusa e `tok_erro` para simular o provedor fora do ar. No painel, essas opções aparecem em um seletor.

---

## 3. Roteiro de demonstração (fluxo real da lanchonete)

O fluxo pedido pelo cliente, passo a passo:

1. **O cliente realiza o pedido.** Entre como `maria@exemplo.com`, escolha a unidade e monte o pedido.
2. **O sistema verifica a disponibilidade.** Os insumos da ficha técnica são reservados. Se faltar algo, o pedido é recusado com a lista do que falta, e produtos esgotados aparecem como "Esgotado".
3. **O sistema solicita o pagamento ao serviço externo.** Escolha PIX ou cartão.
4. **Recebe a confirmação ou a negativa.** O cartão responde na hora. No PIX, clique em "Confirmar PIX" para simular o banco enviando o webhook assinado.
5. **Atualiza o pedido.** O status passa a `PAGO`, o estoque é baixado e a venda é lançada no caixa. Na recusa, o status fica `PAGAMENTO_RECUSADO` e o cliente pode tentar de novo.
6. **A unidade prepara o pedido.** Em outra janela, entre como `cozinha.recife@...`. O pedido aparece **ao vivo** no quadro, onde a cozinha clica em "Iniciar preparo" e depois em "Marcar pronto".
7. **O cliente acompanha e recebe ou retira.** Em "Meus pedidos" → "Acompanhar", a página pública se atualiza sozinha até `ENTREGUE`.

Depois, entre como `admin@raizes.com.br` para ver os **Relatórios** (vendas, caixa e cobertura de estoque) e os **alertas de reposição** (Charque e Cocada em Fortaleza).

---

## 4. Testes

```bash
npm run db:local:start   # se ainda não estiver rodando
npm test
```

São **44 testes automatizados** de integração, executados contra um PostgreSQL real, sem simular o banco. Eles cobrem:

- **Fluxo de pedidos:** o cenário completo de 7 passos; cartão recusado seguido de nova tentativa; PIX com webhook; webhook com assinatura falsa ou repetido; provedor fora do ar; estoque insuficiente; **5 pedidos simultâneos disputando o mesmo estoque**; delivery; cancelamento com estorno; expiração de pedido não pago; PIX aprovado depois do cancelamento (estorno automático).
- **Segurança:** login e bloqueio após 5 tentativas; token forjado ou com `alg=none`; perfis; isolamento entre unidades; escalonamento de privilégios; perfis configuráveis; cabeçalhos de segurança.
- **Estoque e catálogo:** ficha técnica; upload validando o conteúdo real do arquivo; perdas não consomem estoque reservado; inventário; alertas.
- **LGPD e relatórios:** consentimento; exportação; anonimização; auditoria; relatórios e CSV; eventos em tempo real (SSE) filtrados por unidade.

---

## 5. Arquitetura

```
public/                 Painel web (HTML + JS puro, sem etapa de build)
src/
  app.js                Montagem do Express: segurança, rotas, documentação
  server.js             Inicialização, rotina de expiração, encerramento gracioso
  config.js / db.js     Configuração por variáveis de ambiente; pool de conexões e transações
  middleware/           auth (JWT + permissões + escopo de unidade), auditoria, erros
  modules/              Uma rota por módulo + serviços com as regras de negócio
    pedidos.service.js  Máquina de estados, pagamento, cancelamento, expiração
    estoque.service.js  Reserva/baixa/estorno com bloqueio de linhas (FOR UPDATE)
  pagamentos/           Contrato de gateway + implementações simulada e Mercado Pago
db/migrations/          Esquema SQL versionado
scripts/                Banco local, migração, dados de demonstração, reset
tests/                  Testes de integração (node:test + supertest)
docs/                   OpenAPI, arquitetura, LGPD
```

O passo a passo completo de uso está em [docs/GUIA.md](docs/GUIA.md). As decisões técnicas estão descritas em [docs/ARQUITETURA.md](docs/ARQUITETURA.md). A conformidade com a LGPD está em [docs/LGPD.md](docs/LGPD.md).

## 6. Variáveis de ambiente

Veja o [.env.example](.env.example). Em produção, `JWT_SECRET`, `WEBHOOK_SECRET` e `DATABASE_URL` são **obrigatórias**: a aplicação não inicia sem elas.

## 7. Integração com o Mercado Pago (sandbox)

1. Crie uma aplicação em https://www.mercadopago.com.br/developers e copie o **Access Token de teste**.
2. No `.env`, defina `PAYMENT_GATEWAY=mercadopago`, `MP_ACCESS_TOKEN=TEST-...`, `MP_WEBHOOK_SECRET=...` e `PUBLIC_URL` com uma URL pública (ex.: ngrok) para receber os webhooks.
3. Pagamentos com cartão exigem o token gerado pelo SDK MercadoPago.js no front-end. O número do cartão nunca passa pelo servidor.

## 8. Diagramas do Sistema

Os diagramas estão disponíveis na pasta `docs`:

- [Diagrama de Casos de Uso](docs/diagrama-casos-uso.png)
- [Diagrama de Classes](docs/diagrama-classes.png)
- [Diagrama Entidade-Relacionamento (DER)](docs/diagrama-der.png)
- [Documentação da Arquitetura](docs/ARQUITETURA.md)

