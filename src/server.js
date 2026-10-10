import { criarApp } from './app.js';
import { config } from './config.js';
import { pool } from './db.js';
import { expirarPedidosNaoPagos } from './modules/pedidos.service.js';

const app = criarApp();
const servidor = app.listen(config.port, () => {
  console.log(`Raízes do Nordeste rodando em http://localhost:${config.port}`);
  console.log(`  Painel:        http://localhost:${config.port}/`);
  console.log(`  Documentação:  http://localhost:${config.port}/api/docs`);
  console.log(`  Pagamentos:    gateway "${config.pagamentos.gateway}"`);
});

const rotinaExpiracao = setInterval(async () => {
  try {
    const n = await expirarPedidosNaoPagos();
    if (n) console.log(`[expiracao] ${n} pedido(s) não pago(s) cancelado(s)`);
  } catch (err) {
    console.error('[expiracao] falha:', err.message);
  }
}, 60_000);

function encerrar(sinal) {
  console.log(`${sinal} recebido, encerrando...`);
  clearInterval(rotinaExpiracao);
  servidor.close(async () => {
    await pool.end();
    process.exit(0);
  });
  servidor.closeAllConnections?.();
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', () => encerrar('SIGTERM'));
process.on('SIGINT', () => encerrar('SIGINT'));
process.on('unhandledRejection', (err) => console.error('[processo] promessa rejeitada sem tratamento:', err));
