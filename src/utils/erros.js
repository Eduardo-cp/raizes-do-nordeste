export class AppError extends Error {
  constructor(status, mensagem, detalhes) {
    super(mensagem);
    this.status = status;
    this.detalhes = detalhes;
  }
}

export const requisicaoInvalida = (msg, detalhes) => new AppError(400, msg, detalhes);
export const naoAutenticado = (msg = 'Autenticação necessária') => new AppError(401, msg);
export const proibido = (msg = 'Você não tem permissão para esta operação') => new AppError(403, msg);
export const naoEncontrado = (recurso = 'Recurso') => new AppError(404, `${recurso} não encontrado`);
export const conflito = (msg, detalhes) => new AppError(409, msg, detalhes);
