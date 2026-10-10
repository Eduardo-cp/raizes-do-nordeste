import { Router } from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import multer from 'multer';
import { z } from 'zod';
import { config } from '../config.js';
import { query, transacao } from '../db.js';
import { autenticar, exigirPermissao } from '../middleware/auth.js';
import { naoEncontrado, requisicaoInvalida } from '../utils/erros.js';
import { booleanoQuery, id, idParam, validar } from '../utils/validacao.js';

export const categoriasRouter = Router();

categoriasRouter.get('/', async (req, res) => {
  const { rows } = await query(
    `SELECT c.id, c.nome, c.descricao, c.ativo, count(p.id) FILTER (WHERE p.ativo)::int AS total_produtos
       FROM categorias c LEFT JOIN produtos p ON p.categoria_id = c.id
      GROUP BY c.id ORDER BY c.nome`);
  res.json(rows);
});

const categoriaSchema = z.object({
  nome: z.string().trim().min(2).max(80),
  descricao: z.string().trim().max(255).optional(),
  ativo: z.boolean().optional(),
});

categoriasRouter.post('/', autenticar, exigirPermissao('catalogo.gerenciar'), async (req, res) => {
  const d = validar(categoriaSchema, req.body);
  const { rows: [c] } = await query('INSERT INTO categorias (nome, descricao) VALUES ($1,$2) RETURNING *', [d.nome, d.descricao ?? null]);
  res.status(201).json(c);
});

categoriasRouter.patch('/:id', autenticar, exigirPermissao('catalogo.gerenciar'), async (req, res) => {
  const { id: cid } = validar(idParam, req.params);
  const d = validar(categoriaSchema.partial(), req.body);
  const { rows: [c] } = await query(
    `UPDATE categorias SET nome = COALESCE($2, nome), descricao = COALESCE($3, descricao), ativo = COALESCE($4, ativo)
      WHERE id = $1 RETURNING *`, [cid, d.nome, d.descricao, d.ativo]);
  if (!c) throw naoEncontrado('Categoria');
  res.json(c);
});

export const produtosRouter = Router();

const SELECT_PRODUTO = `
  SELECT p.id, p.nome, p.descricao, p.preco, p.imagem_url, p.ativo, p.categoria_id, c.nome AS categoria,
         p.criado_em, p.atualizado_em,
         COALESCE((SELECT json_agg(json_build_object('item_estoque_id', i.id, 'item', i.nome,
                                                     'quantidade', pc.quantidade, 'unidade_medida', i.unidade_medida) ORDER BY i.nome)
                     FROM produto_composicao pc JOIN itens_estoque i ON i.id = pc.item_estoque_id
                    WHERE pc.produto_id = p.id), '[]') AS composicao
    FROM produtos p JOIN categorias c ON c.id = p.categoria_id`;

async function buscarProduto(pid) {
  const { rows: [p] } = await query(`${SELECT_PRODUTO} WHERE p.id = $1`, [pid]);
  if (!p) throw naoEncontrado('Produto');
  return p;
}

produtosRouter.get('/', async (req, res) => {
  const f = validar(z.object({
    categoria_id: id.optional(),
    busca: z.string().trim().max(100).optional(),
    incluir_inativos: booleanoQuery,
  }), req.query);
  const { rows } = await query(
    `${SELECT_PRODUTO}
      WHERE ($1::int IS NULL OR p.categoria_id = $1)
        AND ($2::text IS NULL OR p.nome ILIKE '%' || $2 || '%')
        AND ($3::boolean OR (p.ativo AND c.ativo))
      ORDER BY c.nome, p.nome`,
    [f.categoria_id ?? null, f.busca || null, f.incluir_inativos ?? false]);
  res.json(rows);
});

produtosRouter.get('/:id', async (req, res) => {
  res.json(await buscarProduto(validar(idParam, req.params).id));
});

const composicaoSchema = z.array(z.object({
  item_estoque_id: id,
  quantidade: z.number().positive().max(100000),
})).max(50);

const produtoSchema = z.object({
  categoria_id: id,
  nome: z.string().trim().min(2).max(120),
  descricao: z.string().trim().max(2000).optional(),
  preco: z.number().positive().max(100000).multipleOf(0.01, 'O preço deve ter no máximo 2 casas decimais'),
  ativo: z.boolean().optional(),
  composicao: composicaoSchema.optional(),
});

async function salvarComposicao(client, produtoId, composicao) {
  const ids = composicao.map((c) => c.item_estoque_id);
  if (new Set(ids).size !== ids.length) throw requisicaoInvalida('Item repetido na composição');
  await client.query('DELETE FROM produto_composicao WHERE produto_id = $1', [produtoId]);
  for (const c of composicao) {
    await client.query('INSERT INTO produto_composicao (produto_id, item_estoque_id, quantidade) VALUES ($1,$2,$3)',
      [produtoId, c.item_estoque_id, c.quantidade]);
  }
}

produtosRouter.post('/', autenticar, exigirPermissao('catalogo.gerenciar'), async (req, res) => {
  const d = validar(produtoSchema, req.body);
  const pid = await transacao(async (client) => {
    const { rows: [p] } = await client.query(
      'INSERT INTO produtos (categoria_id, nome, descricao, preco, ativo) VALUES ($1,$2,$3,$4,$5) RETURNING id',
      [d.categoria_id, d.nome, d.descricao ?? null, d.preco, d.ativo ?? true]);
    if (d.composicao) await salvarComposicao(client, p.id, d.composicao);
    return p.id;
  });
  res.status(201).json(await buscarProduto(pid));
});

produtosRouter.patch('/:id', autenticar, exigirPermissao('catalogo.gerenciar'), async (req, res) => {
  const { id: pid } = validar(idParam, req.params);
  const d = validar(produtoSchema.partial(), req.body);
  await transacao(async (client) => {
    const { rowCount } = await client.query(
      `UPDATE produtos SET categoria_id = COALESCE($2, categoria_id), nome = COALESCE($3, nome),
              descricao = COALESCE($4, descricao), preco = COALESCE($5, preco), ativo = COALESCE($6, ativo),
              atualizado_em = now()
        WHERE id = $1`, [pid, d.categoria_id, d.nome, d.descricao, d.preco, d.ativo]);
    if (!rowCount) throw naoEncontrado('Produto');
    if (d.composicao) await salvarComposicao(client, pid, d.composicao);
  });
  res.json(await buscarProduto(pid));
});

produtosRouter.delete('/:id', autenticar, exigirPermissao('catalogo.gerenciar'), async (req, res) => {
  const { id: pid } = validar(idParam, req.params);
  const { rowCount } = await query('UPDATE produtos SET ativo = FALSE, atualizado_em = now() WHERE id = $1', [pid]);
  if (!rowCount) throw naoEncontrado('Produto');
  res.status(204).end();
});

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024, files: 1 } });

function detectarTipoImagem(buf) {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  return null;
}

produtosRouter.post('/:id/imagem', autenticar, exigirPermissao('catalogo.gerenciar'), upload.single('imagem'), async (req, res) => {
  const { id: pid } = validar(idParam, req.params);
  if (!req.file) throw requisicaoInvalida('Envie o arquivo no campo "imagem" (multipart/form-data)');
  const ext = detectarTipoImagem(req.file.buffer);
  if (!ext) throw requisicaoInvalida('Formato não suportado. Use JPG, PNG ou WEBP.');

  const { rows: [atual] } = await query('SELECT imagem_url FROM produtos WHERE id = $1', [pid]);
  if (!atual) throw naoEncontrado('Produto');

  await fs.mkdir(config.uploadDir, { recursive: true });
  const nomeArquivo = `produto-${pid}-${crypto.randomUUID()}.${ext}`;
  await fs.writeFile(path.join(config.uploadDir, nomeArquivo), req.file.buffer);
  await query('UPDATE produtos SET imagem_url = $2, atualizado_em = now() WHERE id = $1', [pid, `/uploads/${nomeArquivo}`]);
  if (atual.imagem_url?.startsWith('/uploads/')) {
    await fs.rm(path.join(config.uploadDir, path.basename(atual.imagem_url)), { force: true });
  }
  res.json(await buscarProduto(pid));
});
