# Conformidade com a LGPD (Lei 13.709/2018)

## Dados pessoais tratados

| Dado | Finalidade | Base legal (art. 7º) |
|---|---|---|
| Nome, e-mail, telefone | Identificar o cliente e comunicar o andamento do pedido | V: execução de contrato |
| Endereço de entrega | Entregar pedidos de delivery | V: execução de contrato |
| Histórico de pedidos | Registro fiscal da venda | II: obrigação legal |
| Preferências de consumo | Personalizar o atendimento | I: consentimento |
| Aceite de marketing | Enviar promoções | I: consentimento específico (opt-in) |
| Dados de funcionários (nome, e-mail) | Controle de acesso | V / IX: execução de contrato e legítimo interesse |

**Não são coletados** CPF, data de nascimento nem dados de cartão. Os pagamentos são tokenizados pelo provedor (art. 6º, III: necessidade/minimização).

## Como cada princípio e direito foi implementado

| Requisito | Implementação |
|---|---|
| **Consentimento** (art. 8º) | O cadastro exige `consentimento_termos: true`, gravado com data e hora (`consentimento_termos_em`). No balcão, o atendente confirma o consentimento verbal. O marketing é **opt-in**, com `false` por padrão |
| **Revogação** (art. 8º §5) | O titular pode desligar o marketing a qualquer momento (`PATCH /api/me` ou na tela "Privacidade") |
| **Transparência** (art. 9º) | `GET /api/lgpd/politica` informa as finalidades, as bases legais, os dados coletados e o contato do encarregado |
| **Acesso e portabilidade** (art. 18, II e V) | `GET /api/lgpd/meus-dados` exporta em JSON os dados cadastrais, os pedidos e os pagamentos |
| **Correção** (art. 18, III) | `PATCH /api/me` |
| **Eliminação** (art. 18, VI) | `DELETE /api/lgpd/minha-conta` (confirmada com a senha) ou atendimento pela loja (`lgpd.gerenciar`). Os dados pessoais são **anonimizados** e os registros de venda ficam sem identificação, porque a guarda é obrigação fiscal (art. 16, I). A eliminação é adiada enquanto houver pedido em andamento |
| **Segurança** (art. 46) | Senhas com hash bcrypt; JWT; controle de acesso por perfil e unidade; CSP; limite de requisições; bloqueio após tentativas falhas; SSL com o banco (`DATABASE_SSL`); HTTPS obrigatório em produção (via proxy reverso) |
| **Prevenção e responsabilização** (art. 6º, VIII e X) | Trilha de auditoria (`audit_log`): logins, falhas de login, **cada consulta à ficha de um cliente**, exportações, eliminações e todas as operações de escrita, com autor, IP e data |
| **Minimização nos logs** | Os logs de acesso guardam apenas método, rota e status: nunca o corpo, a query string, senhas ou tokens |
| **Menor privilégio** | Cada perfil vê apenas o necessário. A cozinha não acessa clientes. Usuários de uma unidade não veem os dados de outra. O acompanhamento público do pedido não expõe dados pessoais |

## Pendências de processo (fora do software)

- Nomear o encarregado (DPO) e divulgar o canal de contato.
- Publicar os termos de uso e a política de privacidade em linguagem simples, no app e na loja.
- Formalizar contratos de operador com o provedor de pagamento e com a hospedagem.
- Definir a política de retenção. Sugestão: anonimizar clientes inativos há mais de 5 anos, prazo compatível com a guarda fiscal.
- Ter um plano de resposta a incidentes, incluindo a comunicação à ANPD (art. 48).
