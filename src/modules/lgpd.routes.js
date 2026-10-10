import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { query, transacao } from '../db.js';
import { autenticar, exigirCliente, exigirPermissao } from '../middleware/auth.js';
import { auditar } from '../middleware/auditoria.js';
import { conflito, naoEncontrado, requisicaoInvalida } from '../utils/erros.js';
import { idParam, validar } from '../utils/validacao.js';

export const router = Router();

router.get('/politica', (req, res) => {
  res.json({
    controlador: 'Rede Raízes do Nordeste',
    encarregado_contato: 'privacidade@raizesdonordeste.com.br',
    dados_coletados: ['nome', 'e-mail', 'telefone', 'preferências de consumo', 'histórico de pedidos', 'endereço de entrega (delivery)'],
    finalidades: {
      'execução do pedido': 'identificar, preparar, entregar e cobrar o pedido (base legal: execução de contrato, art. 7º, V)',
      'histórico e preferências': 'agilizar novos pedidos e personalizar o atendimento (base legal: consentimento, art. 7º, I)',
      'comunicações de marketing': 'somente com consentimento específico, revogável a qualquer momento',
      'obrigações fiscais': 'guarda dos registros de venda (base legal: obrigação legal, art. 7º, II)',
    },
    dados_de_pagamento: 'Dados de cartão são tratados exclusivamente pelo provedor de pagamento; o sistema não os armazena.',
    direitos_do_titular: {
      acesso_portabilidade: 'GET /api/lgpd/meus-dados',
      correcao: 'PATCH /api/me',
      revogar_marketing: 'PATCH /api/me { "consentimento_marketing": false }',
      eliminacao: 'DELETE /api/lgpd/minha-conta',
    },
    seguranca: ['senhas com hash bcrypt', 'controle de acesso por perfil e unidade', 'trilha de auditoria de acessos', 'HTTPS obrigatório em produção'],
  });
});

async function exportarDados(clienteId) {
  const { rows: [cliente] } = await query(
    `SELECT id, nome, email, telefone, preferencias, consentimento_termos_em, consentimento_marketing,
            anonimizado_em, criado_em, atualizado_em FROM clientes WHERE id = $1`, [clienteId]);
  if (!cliente) throw naoEncontrado('Cliente');
  const { rows: pedidos } = await query(
    `SELECT p.id, u.nome AS unidade, p.canal, p.status, p.total, p.endereco_entrega, p.observacao, p.criado_em,
            (SELECT json_agg(json_build_object('produto', pr.nome, 'quantidade', ip.quantidade, 'preco_unitario', ip.preco_unitario))
               FROM itens_pedido ip JOIN produtos pr ON pr.id = ip.produto_id WHERE ip.pedido_id = p.id) AS itens,
            (SELECT json_agg(json_build_object('metodo', pg.metodo, 'status', pg.status, 'valor', pg.valor, 'data', pg.criado_em))
               FROM pagamentos pg WHERE pg.pedido_id = p.id) AS pagamentos
       FROM pedidos p JOIN unidades u ON u.id = p.unidade_id
      WHERE p.cliente_id = $1 ORDER BY p.criado_em`, [clienteId]);
  return { gerado_em: new Date().toISOString(), titular: cliente, pedidos };
}

async function anonimizar(clienteId) {
  return transacao(async (client) => {
    const { rows: [c] } = await client.query('SELECT id, anonimizado_em FROM clientes WHERE id = $1 FOR UPDATE', [clienteId]);
    if (!c) throw naoEncontrado('Cliente');
    if (c.anonimizado_em) throw conflito('Os dados deste cliente já foram anonimizados');
    const { rowCount: emAndamento } = await client.query(
      `SELECT 1 FROM pedidos WHERE cliente_id = $1 AND status NOT IN ('ENTREGUE', 'CANCELADO')`, [clienteId]);
    if (emAndamento) throw conflito('O cliente possui pedidos em andamento; conclua-os antes da eliminação dos dados');
    await client.query(
      `UPDATE clientes SET nome = 'Titular anonimizado #' || id, email = NULL, telefone = NULL, senha_hash = NULL,
              preferencias = '{}'::jsonb, consentimento_marketing = FALSE, anonimizado_em = now(), atualizado_em = now()
        WHERE id = $1`, [clienteId]);
    await client.query('UPDATE pedidos SET endereco_entrega = NULL, observacao = NULL WHERE cliente_id = $1', [clienteId]);
  });
}

router.get('/meus-dados', autenticar, exigirCliente, async (req, res) => {
  const dados = await exportarDados(req.auth.id);
  await auditar(req, 'LGPD_EXPORTACAO', { entidade: 'clientes', entidadeId: req.auth.id });
  res.setHeader('Content-Disposition', 'attachment; filename="meus-dados-raizes.json"');
  res.json(dados);
});

router.delete('/minha-conta', autenticar, exigirCliente, async (req, res) => {
  const { senha } = validar(z.object({ senha: z.string().min(1).max(72) }), req.body);
  const { rows: [c] } = await query('SELECT senha_hash FROM clientes WHERE id = $1', [req.auth.id]);
  if (!c.senha_hash || !(await bcrypt.compare(senha, c.senha_hash))) throw requisicaoInvalida('Senha incorreta');
  await anonimizar(req.auth.id);
  await auditar(req, 'LGPD_ELIMINACAO', { entidade: 'clientes', entidadeId: req.auth.id, detalhes: { solicitante: 'titular' } });
  res.json({ mensagem: 'Seus dados pessoais foram eliminados. Registros fiscais foram mantidos de forma anônima.' });
});

router.get('/clientes/:id/exportar', autenticar, exigirPermissao('lgpd.gerenciar'), async (req, res) => {
  const { id } = validar(idParam, req.params);
  const dados = await exportarDados(id);
  await auditar(req, 'LGPD_EXPORTACAO', { entidade: 'clientes', entidadeId: id, detalhes: { solicitante: 'funcionario' } });
  res.json(dados);
});

router.post('/clientes/:id/anonimizar', autenticar, exigirPermissao('lgpd.gerenciar'), async (req, res) => {
  const { id } = validar(idParam, req.params);
  await anonimizar(id);
  res.locals.auditado = true;
  await auditar(req, 'LGPD_ELIMINACAO', { entidade: 'clientes', entidadeId: id, detalhes: { solicitante: 'funcionario' } });
  res.json({ mensagem: 'Dados pessoais do cliente anonimizados.' });
});
