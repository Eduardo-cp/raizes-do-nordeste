import crypto from 'node:crypto';
import { config } from '../config.js';
import { naoAutenticado } from '../utils/erros.js';

const cobrancas = new Map();
const idempotencia = new Map();

export function assinarWebhookMock(corpo) {
  return crypto.createHmac('sha256', config.pagamentos.webhookSecret).update(corpo).digest('hex');
}

export const mockGateway = {
  nome: 'mock',

  async criarCobranca({ valor, metodo, cartao, idempotencyKey }) {
    if (idempotencia.has(idempotencyKey)) return idempotencia.get(idempotencyKey);
    if (cartao?.token === 'tok_erro') throw new Error('Provedor de pagamento indisponível (simulado)');

    const gatewayId = `mock_${crypto.randomUUID()}`;
    let resposta;
    if (metodo === 'PIX') {
      resposta = {
        gatewayId,
        status: 'PENDENTE',
        detalhes: {
          pix_copia_e_cola: `00020126580014BR.GOV.BCB.PIX0136${gatewayId}5204000053039865406${valor.toFixed(2)}5802BR`,
          expira_em: new Date(Date.now() + config.pedidoExpiracaoMin * 60_000).toISOString(),
        },
      };
    } else if (cartao?.token === 'tok_recusado') {
      resposta = { gatewayId, status: 'RECUSADO', detalhes: { motivo: 'saldo_insuficiente' } };
    } else {
      resposta = { gatewayId, status: 'APROVADO', detalhes: { autorizacao: crypto.randomInt(100000, 999999).toString(), final_cartao: '4242' } };
    }
    cobrancas.set(gatewayId, { status: resposta.status, valor });
    idempotencia.set(idempotencyKey, resposta);
    return resposta;
  },

  async estornar(gatewayId) {
    const c = cobrancas.get(gatewayId);
    if (c) c.status = 'ESTORNADO';
    return { ok: true };
  },

  async interpretarWebhook(req) {
    const assinatura = String(req.headers['x-assinatura'] || '');
    const esperada = assinarWebhookMock(req.rawBody ?? Buffer.from(''));
    const valida = assinatura.length === esperada.length &&
      crypto.timingSafeEqual(Buffer.from(assinatura), Buffer.from(esperada));
    if (!valida) throw naoAutenticado('Assinatura do webhook inválida');
    const { gateway_id: gatewayId, status } = req.body ?? {};
    if (!gatewayId || !['APROVADO', 'RECUSADO'].includes(status)) return null;
    const c = cobrancas.get(gatewayId);
    if (c) c.status = status;
    return { gatewayId, status, detalhes: {} };
  },
};
