import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db.js';
import { autenticar, exigirPermissao } from '../middleware/auth.js';
import { naoEncontrado } from '../utils/erros.js';
import { idParam, telefone, validar } from '../utils/validacao.js';

export const router = Router();

const unidadeSchema = z.object({
  nome: z.string().trim().min(2).max(120),
  endereco: z.string().trim().max(255).optional(),
  telefone: telefone.optional(),
  ativo: z.boolean().optional(),
});

router.get('/', async (req, res) => {
  const { rows } = await query('SELECT id, nome, endereco, telefone, ativo FROM unidades WHERE ativo ORDER BY nome');
  res.json(rows);
});

router.get('/:id/cardapio', async (req, res) => {
  const { id } = validar(idParam, req.params);
  const { rowCount } = await query('SELECT 1 FROM unidades WHERE id = $1 AND ativo', [id]);
  if (!rowCount) throw naoEncontrado('Unidade');
  const { rows } = await query(
    `SELECT p.id, p.nome, p.descricao, p.preco, p.imagem_url, c.id AS categoria_id, c.nome AS categoria,
            COALESCE(bool_and(COALESCE(e.quantidade - e.reservado, 0) >= pc.quantidade), TRUE) AS disponivel
       FROM produtos p
       JOIN categorias c ON c.id = p.categoria_id AND c.ativo
       LEFT JOIN produto_composicao pc ON pc.produto_id = p.id
       LEFT JOIN estoque e ON e.item_estoque_id = pc.item_estoque_id AND e.unidade_id = $1
      WHERE p.ativo
      GROUP BY p.id, c.id
      ORDER BY c.nome, p.nome`,
    [id],
  );
  res.json(rows);
});

router.post('/', autenticar, exigirPermissao('unidades.gerenciar'), async (req, res) => {
  const d = validar(unidadeSchema, req.body);
  const { rows: [u] } = await query(
    'INSERT INTO unidades (nome, endereco, telefone) VALUES ($1,$2,$3) RETURNING *',
    [d.nome, d.endereco ?? null, d.telefone ?? null]);
  await query(
    `INSERT INTO estoque (unidade_id, item_estoque_id)
     SELECT $1, id FROM itens_estoque WHERE ativo ON CONFLICT DO NOTHING`, [u.id]);
  res.status(201).json(u);
});

router.patch('/:id', autenticar, exigirPermissao('unidades.gerenciar'), async (req, res) => {
  const { id } = validar(idParam, req.params);
  const d = validar(unidadeSchema.partial(), req.body);
  const { rows: [u] } = await query(
    `UPDATE unidades SET nome = COALESCE($2, nome), endereco = COALESCE($3, endereco),
            telefone = COALESCE($4, telefone), ativo = COALESCE($5, ativo)
      WHERE id = $1 RETURNING *`,
    [id, d.nome, d.endereco, d.telefone, d.ativo]);
  if (!u) throw naoEncontrado('Unidade');
  res.json(u);
});
