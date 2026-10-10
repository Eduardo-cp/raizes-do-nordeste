import { z } from 'zod';
import { requisicaoInvalida } from './erros.js';

export function validar(schema, dados) {
  const r = schema.safeParse(dados ?? {});
  if (!r.success) {
    throw requisicaoInvalida(
      'Dados inválidos',
      r.error.issues.map((i) => ({ campo: i.path.join('.'), mensagem: i.message })),
    );
  }
  return r.data;
}

export const id = z.coerce.number().int().positive();
export const idParam = z.object({ id });

export const senhaForte = z
  .string()
  .min(8, 'A senha deve ter ao menos 8 caracteres')
  .max(72)
  .regex(/[A-Za-z]/, 'A senha deve conter letras')
  .regex(/\d/, 'A senha deve conter números');

export const email = z.email('E-mail inválido').max(160).transform((e) => e.toLowerCase().trim());
export const telefone = z.string().trim().regex(/^[\d\s()+-]{8,20}$/, 'Telefone inválido');

export const paginacao = z.object({
  pagina: z.coerce.number().int().min(1).default(1),
  limite: z.coerce.number().int().min(1).max(100).default(20),
});

export const periodo = {
  inicio: z.iso.date('Data inválida (use AAAA-MM-DD)').optional(),
  fim: z.iso.date('Data inválida (use AAAA-MM-DD)').optional(),
};

export function resolverPeriodo({ inicio, fim }) {
  const hoje = new Date();
  const f = fim ?? hoje.toISOString().slice(0, 10);
  const i = inicio ?? new Date(hoje.getTime() - 29 * 86_400_000).toISOString().slice(0, 10);
  if (i > f) throw requisicaoInvalida('A data de início deve ser anterior ou igual à data de fim');
  return { inicio: i, fim: f };
}

export const booleanoQuery = z
  .enum(['true', 'false'])
  .transform((v) => v === 'true')
  .optional();
