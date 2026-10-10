import { Router } from 'express';
import { autenticar, exigirUsuario } from '../middleware/auth.js';
import { eventos } from '../utils/eventos.js';

export const router = Router();

router.get('/', autenticar, exigirUsuario, (req, res) => {
  const { unidadeId, permissoes } = req.auth;
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(`event: conectado\ndata: ${JSON.stringify({ unidade_id: unidadeId })}\n\n`);

  const enviar = ({ tipo, dados, em }) => {
    if (unidadeId != null && dados.unidade_id !== unidadeId) return;
    if (tipo.startsWith('pedido') && !permissoes.has('pedidos.ver')) return;
    if (tipo.startsWith('estoque') && !permissoes.has('estoque.ver')) return;
    res.write(`event: ${tipo}\ndata: ${JSON.stringify({ ...dados, em })}\n\n`);
  };
  eventos.on('evento', enviar);
  const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
  req.on('close', () => {
    clearInterval(ping);
    eventos.off('evento', enviar);
  });
});
