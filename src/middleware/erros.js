import multer from 'multer';
import { AppError } from '../utils/erros.js';
import { config } from '../config.js';

export function rotaNaoEncontrada(req, res) {
  res.status(404).json({ erro: 'Rota não encontrada' });
}

export function tratarErros(err, req, res, next) {
  if (err instanceof AppError) {
    return res.status(err.status).json({ erro: err.message, ...(err.detalhes && { detalhes: err.detalhes }) });
  }
  if (err.type === 'entity.parse.failed') return res.status(400).json({ erro: 'JSON malformado' });
  if (err.type === 'entity.too.large') return res.status(413).json({ erro: 'Requisição muito grande' });
  if (err instanceof multer.MulterError) {
    const msg = err.code === 'LIMIT_FILE_SIZE' ? 'Arquivo excede o tamanho máximo (2 MB)' : `Upload inválido: ${err.message}`;
    return res.status(400).json({ erro: msg });
  }
  if (err.code === '23505') return res.status(409).json({ erro: 'Registro duplicado', detalhes: err.detail });
  if (err.code === '23503') return res.status(409).json({ erro: 'Operação viola uma referência existente (registro em uso ou inexistente)' });
  if (err.code === '23514') return res.status(409).json({ erro: 'Operação viola uma regra de consistência dos dados' });
  if (err.code === '22P02' || err.code === '22003') return res.status(400).json({ erro: 'Valor inválido' });

  console.error('[erro]', req.method, req.originalUrl, err);
  res.status(500).json({ erro: 'Erro interno do servidor', ...(!config.producao && { detalhe: err.message }) });
}
