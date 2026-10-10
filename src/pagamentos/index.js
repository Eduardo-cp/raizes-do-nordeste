import { config } from '../config.js';
import { AppError } from '../utils/erros.js';
import { mockGateway } from './mock.gateway.js';
import { mercadoPagoGateway } from './mercadopago.gateway.js';

const gateways = { mock: mockGateway, mercadopago: mercadoPagoGateway };

export function gatewayAtivo() {
  return gateways[config.pagamentos.gateway] ?? mockGateway;
}

export function gatewayPorNome(nome) {
  const g = gateways[nome];
  if (!g) throw new AppError(404, 'Gateway de pagamento desconhecido');
  return g;
}
