import crypto from 'node:crypto';
import { config } from '../config.js';
import { AppError, naoAutenticado } from '../utils/erros.js';

const API = 'https://api.mercadopago.com';

const STATUS = {
  approved: 'APROVADO',
  authorized: 'PENDENTE',
  pending: 'PENDENTE',
  in_process: 'PENDENTE',
  in_mediation: 'PENDENTE',
  rejected: 'RECUSADO',
  cancelled: 'RECUSADO',
  refunded: 'ESTORNADO',
  charged_back: 'ESTORNADO',
};

async function chamar(caminho, { method = 'GET', body, idempotencyKey } = {}) {
  const token = config.pagamentos.mercadoPago.accessToken;
  if (!token) throw new AppError(503, 'Mercado Pago não configurado (defina MP_ACCESS_TOKEN)');
  const resp = await fetch(API + caminho, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(idempotencyKey && { 'X-Idempotency-Key': idempotencyKey }),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  const dados = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(`Mercado Pago respondeu ${resp.status}: ${dados.message ?? 'erro desconhecido'}`);
  return dados;
}

export const mercadoPagoGateway = {
  nome: 'mercadopago',

  async criarCobranca({ pedidoId, valor, metodo, descricao, cartao, pagadorEmail, idempotencyKey }) {
    const body = {
      transaction_amount: valor,
      description: descricao,
      external_reference: String(pedidoId),
      notification_url: `${config.pagamentos.publicUrl}/api/webhooks/pagamentos/mercadopago`,
      payer: { email: pagadorEmail || 'cliente-balcao@raizesdonordeste.com.br' },
    };
    if (metodo === 'PIX') {
      body.payment_method_id = 'pix';
    } else {
      if (!cartao?.token || !cartao?.payment_method_id) {
        throw new AppError(400, 'Para cartão, envie cartao.token e cartao.payment_method_id gerados pelo MercadoPago.js');
      }
      body.token = cartao.token;
      body.payment_method_id = cartao.payment_method_id;
      body.installments = cartao.installments ?? 1;
    }
    const p = await chamar('/v1/payments', { method: 'POST', body, idempotencyKey });
    const tx = p.point_of_interaction?.transaction_data;
    return {
      gatewayId: String(p.id),
      status: STATUS[p.status] ?? 'PENDENTE',
      detalhes: {
        status_gateway: p.status,
        motivo: p.status_detail,
        ...(tx && { pix_copia_e_cola: tx.qr_code, pix_qr_code_base64: tx.qr_code_base64, link_pagamento: tx.ticket_url }),
      },
    };
  },

  async estornar(gatewayId) {
    await chamar(`/v1/pagamentos/${gatewayId}/refunds`, { method: 'POST', body: {}, idempotencyKey: crypto.randomUUID() });
    return { ok: true };
  },

  async interpretarWebhook(req) {
    const dataId = String(req.query['data.id'] ?? req.body?.data?.id ?? '');
    const tipo = req.query.type ?? req.body?.type;
    if (tipo !== 'payment' || !dataId) return null;

    const segredo = config.pagamentos.mercadoPago.webhookSecret;
    if (segredo) {
      const partes = Object.fromEntries(String(req.headers['x-signature'] || '').split(',').map((p) => p.trim().split('=')));
      const manifesto = `id:${dataId.toLowerCase()};request-id:${req.headers['x-request-id'] ?? ''};ts:${partes.ts};`;
      const esperado = crypto.createHmac('sha256', segredo).update(manifesto).digest('hex');
      const recebido = String(partes.v1 ?? '');
      if (recebido.length !== esperado.length || !crypto.timingSafeEqual(Buffer.from(recebido), Buffer.from(esperado))) {
        throw naoAutenticado('Assinatura do webhook inválida');
      }
    } else if (config.producao) {
      throw naoAutenticado('MP_WEBHOOK_SECRET não configurado');
    }
    const p = await chamar(`/v1/pagamentos/${dataId}`);
    return { gatewayId: String(p.id), status: STATUS[p.status] ?? 'PENDENTE', detalhes: { status_gateway: p.status, motivo: p.status_detail } };
  },
};
