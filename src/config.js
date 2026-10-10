import 'dotenv/config';
import path from 'node:path';

const env = process.env.NODE_ENV || 'development';
const producao = env === 'production';

function obrigatorio(nome, padraoDev) {
  const valor = process.env[nome];
  if (valor) return valor;
  if (producao) throw new Error(`Variável de ambiente obrigatória ausente: ${nome}`);
  return padraoDev;
}

export const config = {
  env,
  producao,
  teste: env === 'test',
  port: Number(process.env.PORT || 3000),
  databaseUrl:
    env === 'test'
      ? process.env.TEST_DATABASE_URL || 'postgres://postgres:postgres@localhost:5433/raizes_test'
      : obrigatorio('DATABASE_URL', 'postgres://postgres:postgres@localhost:5433/raizes'),
  databaseSsl: env !== 'test' && process.env.DATABASE_SSL === 'true',
  jwt: {
    segredo: obrigatorio('JWT_SECRET', 'segredo-apenas-para-desenvolvimento'),
    expiraEm: process.env.JWT_EXPIRES_IN || '8h',
  },
  corsOrigins: (process.env.CORS_ORIGINS || '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean),
  pagamentos: {
    gateway: process.env.PAYMENT_GATEWAY || 'mock',
    webhookSecret: obrigatorio('WEBHOOK_SECRET', 'segredo-webhook-desenvolvimento'),
    mercadoPago: {
      accessToken: process.env.MP_ACCESS_TOKEN || '',
      webhookSecret: process.env.MP_WEBHOOK_SECRET || '',
    },
    publicUrl: process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || 3000}`,
  },
  pedidoExpiracaoMin: Number(process.env.PEDIDO_EXPIRACAO_MIN || 30),
  uploadDir: path.resolve(process.env.UPLOAD_DIR || 'uploads'),
  login: { maxTentativas: 5, bloqueioMin: 15 },
};
