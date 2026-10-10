import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { query } from '../db.js';
import { naoAutenticado, proibido } from '../utils/erros.js';

export function gerarToken(tipo, id) {
  return jwt.sign({ tipo }, config.jwt.segredo, {
    subject: String(id),
    expiresIn: config.jwt.expiraEm,
    algorithm: 'HS256',
  });
}

async function carregarUsuario(id) {
  const { rows: [u] } = await query(
    `SELECT u.id, u.nome, u.email, u.unidade_id, u.ativo, p.nome AS perfil,
            COALESCE(array_agg(pp.permissao) FILTER (WHERE pp.permissao IS NOT NULL), '{}') AS permissoes
       FROM usuarios u
       JOIN perfis p ON p.id = u.perfil_id
       LEFT JOIN perfil_permissoes pp ON pp.perfil_id = p.id
      WHERE u.id = $1
      GROUP BY u.id, p.nome`,
    [id],
  );
  if (!u || !u.ativo) return null;
  return {
    tipo: 'USUARIO', id: u.id, nome: u.nome, email: u.email, perfil: u.perfil,
    unidadeId: u.unidade_id, permissoes: new Set(u.permissoes),
  };
}

async function carregarCliente(id) {
  const { rows: [c] } = await query('SELECT id, nome, email, anonimizado_em FROM clientes WHERE id = $1', [id]);
  if (!c || c.anonimizado_em) return null;
  return { tipo: 'CLIENTE', id: c.id, nome: c.nome, email: c.email, permissoes: new Set() };
}

export async function autenticar(req, res, next) {
  const [esquema, token] = (req.headers.authorization || '').split(' ');
  if (esquema !== 'Bearer' || !token) throw naoAutenticado();
  let payload;
  try {
    payload = jwt.verify(token, config.jwt.segredo, { algorithms: ['HS256'] });
  } catch {
    throw naoAutenticado('Token inválido ou expirado');
  }
  const id = Number(payload.sub);
  const ator = payload.tipo === 'USUARIO' ? await carregarUsuario(id)
    : payload.tipo === 'CLIENTE' ? await carregarCliente(id) : null;
  if (!ator) throw naoAutenticado('Conta inexistente ou desativada');
  req.auth = ator;
  next();
}

export function exigirPermissao(...permissoes) {
  return (req, res, next) => {
    if (req.auth?.tipo !== 'USUARIO') throw proibido();
    const faltando = permissoes.filter((p) => !req.auth.permissoes.has(p));
    if (faltando.length) throw proibido(`Permissão necessária: ${faltando.join(', ')}`);
    next();
  };
}

export function exigirCliente(req, res, next) {
  if (req.auth?.tipo !== 'CLIENTE') throw proibido('Operação disponível apenas para clientes');
  next();
}

export function exigirUsuario(req, res, next) {
  if (req.auth?.tipo !== 'USUARIO') throw proibido('Operação disponível apenas para funcionários');
  next();
}

export const temPermissao = (req, permissao) => req.auth?.tipo === 'USUARIO' && req.auth.permissoes.has(permissao);

export function escopoUnidade(req, unidadeSolicitada) {
  const propria = req.auth.unidadeId;
  if (propria == null) return unidadeSolicitada ?? null;
  if (unidadeSolicitada != null && Number(unidadeSolicitada) !== propria) {
    throw proibido('Acesso restrito aos dados da sua unidade');
  }
  return propria;
}

export function verificarUnidade(req, unidadeId) {
  if (req.auth.unidadeId != null && req.auth.unidadeId !== unidadeId) {
    throw proibido('Acesso restrito aos dados da sua unidade');
  }
}
