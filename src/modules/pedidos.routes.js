import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db.js';
import { config } from '../config.js';
import { autenticar, escopoUnidade, exigirPermissao, temPermissao, verificarUnidade } from '../middleware/auth.js';
import { AppError, naoEncontrado, proibido, requisicaoInvalida } from '../utils/erros.js';
import { id, idParam, paginacao, periodo, resolverPeriodo, validar } from '../utils/validacao.js';
import { assinarWebhookMock } from '../pagamentos/mock.gateway.js';
import {
  alterarStatus, buscarPedido, cancelarPedido, criarPedido, iniciarPagamento, receberWebhook, STATUS_OPERACIONAIS,
} from './pedidos.service.js';

export const router = Router();
router.use(autenticar);

const CANAIS = ['BALCAO', 'APP', 'DELIVERY', 'TOTEM'];

const pedidoSchema = z.object({
  unidade_id: id.optional(),
  cliente_id: id.optional(),
  canal: z.enum(CANAIS).optional(),
  itens: z.array(z.object({
    produto_id: id,
    quantidade: z.number().int().min(1).max(50),
    observacao: z.string().trim().max(255).optional(),
  })).min(1, 'O pedido precisa de ao menos um item').max(30),
  observacao: z.string().trim().max(500).optional(),
  endereco_entrega: z.string().trim().min(5).max(255).optional(),
}).refine((d) => d.canal !== 'DELIVERY' || d.endereco_entrega, {
  message: 'Endereço de entrega é obrigatório para delivery', path: ['endereco_entrega'],
});

router.post('/', async (req, res) => {
  const d = validar(pedidoSchema, req.body);
  if (req.auth.tipo === 'CLIENTE') {
    if (!d.unidade_id) throw requisicaoInvalida('Informe a unidade (unidade_id)');
    d.canal ??= 'APP';
    if (!['APP', 'DELIVERY'].includes(d.canal)) throw requisicaoInvalida('Clientes podem pedir pelos canais APP ou DELIVERY');
    d.cliente_id = req.auth.id;
  } else {
    if (!temPermissao(req, 'pedidos.criar')) throw proibido('Permissão necessária: pedidos.criar');
    d.unidade_id = escopoUnidade(req, d.unidade_id);
    if (!d.unidade_id) throw requisicaoInvalida('Informe a unidade (unidade_id)');
    d.canal ??= 'BALCAO';
  }
  res.status(201).json(await criarPedido(d, req.auth));
});

router.get('/', async (req, res) => {
  const f = validar(paginacao.extend({
    unidade_id: id.optional(),
    status: z.string().optional().transform((s) => (s ? s.split(',').map((x) => x.trim().toUpperCase()) : null)),
    canal: z.enum(CANAIS).optional(),
    ...periodo,
  }), req.query);
  Object.assign(f, resolverPeriodo(f));

  let unidade = null;
  let cliente = null;
  if (req.auth.tipo === 'CLIENTE') cliente = req.auth.id;
  else {
    if (!temPermissao(req, 'pedidos.ver')) throw proibido('Permissão necessária: pedidos.ver');
    unidade = escopoUnidade(req, f.unidade_id);
  }
  const { rows } = await query(
    `SELECT p.id, p.codigo_acompanhamento, p.unidade_id, u.nome AS unidade, p.cliente_id, c.nome AS cliente,
            p.canal, p.status, p.total, p.observacao, p.endereco_entrega, p.criado_em, p.atualizado_em,
            (SELECT json_agg(json_build_object('produto', pr.nome, 'quantidade', ip.quantidade, 'observacao', ip.observacao) ORDER BY ip.id)
               FROM itens_pedido ip JOIN produtos pr ON pr.id = ip.produto_id WHERE ip.pedido_id = p.id) AS itens,
            count(*) OVER() AS total_registros
       FROM pedidos p JOIN unidades u ON u.id = p.unidade_id LEFT JOIN clientes c ON c.id = p.cliente_id
      WHERE ($1::int IS NULL OR p.unidade_id = $1) AND ($2::int IS NULL OR p.cliente_id = $2)
        AND ($3::text[] IS NULL OR p.status = ANY($3)) AND ($4::text IS NULL OR p.canal = $4)
        AND p.criado_em >= $5::date AND p.criado_em < $6::date + 1
      ORDER BY p.criado_em DESC, p.id DESC LIMIT $7 OFFSET $8`,
    [unidade, cliente, f.status, f.canal ?? null, f.inicio, f.fim, f.limite, (f.pagina - 1) * f.limite]);
  res.json({ dados: rows.map(({ total_registros, ...p }) => p), total: rows[0]?.total_registros ?? 0, pagina: f.pagina });
});

async function pedidoAcessivel(req) {
  const { id: pid } = validar(idParam, req.params);
  const { rows: [p] } = await query('SELECT id, unidade_id, cliente_id FROM pedidos WHERE id = $1', [pid]);
  if (!p) throw naoEncontrado('Pedido');
  if (req.auth.tipo === 'CLIENTE') {
    if (p.cliente_id !== req.auth.id) throw naoEncontrado('Pedido');
  } else {
    if (!temPermissao(req, 'pedidos.ver')) throw proibido('Permissão necessária: pedidos.ver');
    verificarUnidade(req, p.unidade_id);
  }
  return p;
}

router.get('/:id', async (req, res) => {
  const p = await pedidoAcessivel(req);
  res.json(await buscarPedido(p.id));
});

router.patch('/:id/status', exigirPermissao('pedidos.atualizar_status'), async (req, res) => {
  const { id: pid } = validar(idParam, req.params);
  const d = validar(z.object({ status: z.enum(STATUS_OPERACIONAIS), observacao: z.string().trim().max(255).optional() }), req.body);
  res.json(await alterarStatus(pid, d.status, req.auth, d.observacao));
});

router.post('/:id/cancelar', async (req, res) => {
  const { id: pid } = validar(idParam, req.params);
  const { motivo } = validar(z.object({ motivo: z.string().trim().min(3).max(255) }), req.body);
  if (req.auth.tipo === 'USUARIO' && !temPermissao(req, 'pedidos.cancelar')) throw proibido('Permissão necessária: pedidos.cancelar');
  res.json(await cancelarPedido(pid, motivo, req.auth));
});

const pagamentoSchema = z.object({
  metodo: z.enum(['PIX', 'CARTAO_CREDITO', 'CARTAO_DEBITO', 'DINHEIRO']),
  cartao: z.object({
    token: z.string().min(3).max(200),
    payment_method_id: z.string().max(40).optional(),
    installments: z.number().int().min(1).max(12).optional(),
  }).optional(),
}).refine((d) => !d.metodo.startsWith('CARTAO') || d.cartao, { message: 'Informe o token do cartão', path: ['cartao'] });

router.post('/:id/pagamentos', async (req, res) => {
  const p = await pedidoAcessivel(req);
  const d = validar(pagamentoSchema, req.body);
  if (req.auth.tipo === 'CLIENTE' && d.metodo === 'DINHEIRO') throw requisicaoInvalida('Pagamento em dinheiro é feito no balcão da unidade');
  if (req.auth.tipo === 'USUARIO') {
    const permissao = d.metodo === 'DINHEIRO' ? 'pagamentos.registrar' : 'pedidos.criar';
    if (!temPermissao(req, permissao)) throw proibido(`Permissão necessária: ${permissao}`);
  }
  const pagamento = await iniciarPagamento(p.id, d, req.auth);
  res.status(201).json(pagamento);
});

export const acompanhamentoRouter = Router();

acompanhamentoRouter.get('/:codigo', async (req, res) => {
  const { codigo } = validar(z.object({ codigo: z.uuid('Código inválido') }), req.params);
  const { rows: [p] } = await query(
    `SELECT p.id, p.status, p.canal, p.total, p.criado_em, p.atualizado_em, u.nome AS unidade, u.telefone AS telefone_unidade
       FROM pedidos p JOIN unidades u ON u.id = p.unidade_id WHERE p.codigo_acompanhamento = $1`, [codigo]);
  if (!p) throw naoEncontrado('Pedido');
  const [{ rows: itens }, { rows: etapas }] = await Promise.all([
    query(`SELECT pr.nome AS produto, ip.quantidade FROM itens_pedido ip JOIN produtos pr ON pr.id = ip.produto_id
            WHERE ip.pedido_id = $1 ORDER BY ip.id`, [p.id]),
    query('SELECT status_para AS status, criado_em FROM pedido_status_historico WHERE pedido_id = $1 ORDER BY id', [p.id]),
  ]);
  res.json({ ...p, itens, etapas });
});

export const webhooksRouter = Router();

webhooksRouter.post('/pagamentos/:gateway', async (req, res) => {
  const resultado = await receberWebhook(req.params.gateway, req);
  res.json(resultado);
});

export const simuladorRouter = Router();

simuladorRouter.post('/:gatewayId', async (req, res) => {
  if (config.producao) throw new AppError(404, 'Rota não encontrada');
  const d = validar(z.object({ status: z.enum(['APROVADO', 'RECUSADO']) }), req.body);
  const corpo = JSON.stringify({ gateway_id: req.params.gatewayId, status: d.status });
  const falsoReq = {
    headers: { 'x-assinatura': assinarWebhookMock(corpo) }, rawBody: Buffer.from(corpo), body: JSON.parse(corpo), query: {},
  };
  res.json(await receberWebhook('mock', falsoReq));
});
