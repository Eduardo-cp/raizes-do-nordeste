import { query } from '../db.js';

function ator(req) {
  if (!req?.auth) return { tipo: 'ANONIMO', id: null };
  return { tipo: req.auth.tipo, id: req.auth.id };
}

export async function auditar(req, acao, { entidade, entidadeId, detalhes, executor } = {}) {
  const a = req ? ator(req) : { tipo: 'SISTEMA', id: null };
  try {
    await (executor ?? { query }).query(
      `INSERT INTO audit_log (ator_tipo, ator_id, acao, entidade, entidade_id, ip, detalhes)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [a.tipo, a.id, acao, entidade ?? null, entidadeId != null ? String(entidadeId) : null, req?.ip ?? null, detalhes ?? {}],
    );
  } catch (err) {
    console.error('[auditoria] falha ao registrar evento:', err.message);
  }
}

export function auditarEscritas(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  res.on('finish', () => {
    if (res.statusCode >= 400 || !req.auth || res.locals.auditado) return;
    const rota = req.route ? req.baseUrl + req.route.path : req.path;
    auditar(req, `${req.method} ${rota}`, {
      entidade: req.baseUrl.split('/').filter(Boolean)[1] ?? null,
      entidadeId: req.params?.id,
      detalhes: { status: res.statusCode },
    });
  });
  next();
}
