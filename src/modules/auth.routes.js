import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { query } from '../db.js';
import { config } from '../config.js';
import { autenticar, gerarToken } from '../middleware/auth.js';
import { auditar } from '../middleware/auditoria.js';
import { AppError, naoAutenticado, requisicaoInvalida } from '../utils/erros.js';
import { email, senhaForte, telefone, validar } from '../utils/validacao.js';

export const router = Router();

const HASH_FICTICIO = bcrypt.hashSync('senha-ficticia-123', 10);

const loginSchema = z.object({ email, senha: z.string().min(1).max(72) });

async function autenticarCredenciais(req, tabela, { email: emailInformado, senha }) {
  const { rows: [conta] } = await query(
    `SELECT id, senha_hash, tentativas_falhas, bloqueado_ate,
            ${tabela === 'usuarios' ? 'ativo' : '(anonimizado_em IS NULL) AS ativo'}
       FROM ${tabela} WHERE email = $1`,
    [emailInformado],
  );

  if (conta?.bloqueado_ate && conta.bloqueado_ate > new Date()) {
    throw new AppError(423, 'Conta temporariamente bloqueada por excesso de tentativas. Tente novamente mais tarde.');
  }
  const senhaOk = await bcrypt.compare(senha, conta?.senha_hash ?? HASH_FICTICIO);
  if (!conta || !conta.senha_hash || !senhaOk || !conta.ativo) {
    if (conta) {
      const tentativas = conta.tentativas_falhas + 1;
      const bloquear = tentativas >= config.login.maxTentativas;
      await query(
        `UPDATE ${tabela} SET tentativas_falhas = $2,
                bloqueado_ate = CASE WHEN $3 THEN now() + make_interval(mins => $4) ELSE NULL END
          WHERE id = $1`,
        [conta.id, bloquear ? 0 : tentativas, bloquear, config.login.bloqueioMin],
      );
    }
    await auditar(req, 'LOGIN_FALHOU', { entidade: tabela, entidadeId: conta?.id, detalhes: { email: emailInformado } });
    throw naoAutenticado('E-mail ou senha inválidos');
  }
  await query(`UPDATE ${tabela} SET tentativas_falhas = 0, bloqueado_ate = NULL WHERE id = $1`, [conta.id]);
  return conta.id;
}

router.post('/login', async (req, res) => {
  const dados = validar(loginSchema, req.body);
  const id = await autenticarCredenciais(req, 'usuarios', dados);
  const { rows: [u] } = await query(
    `SELECT u.id, u.nome, u.email, u.unidade_id, p.nome AS perfil,
            array(SELECT permissao FROM perfil_permissoes WHERE perfil_id = u.perfil_id ORDER BY 1) AS permissoes
       FROM usuarios u JOIN perfis p ON p.id = u.perfil_id WHERE u.id = $1`, [id]);
  await auditar({ auth: { tipo: 'USUARIO', id }, ip: req.ip }, 'LOGIN', { entidade: 'usuarios', entidadeId: id });
  res.json({ token: gerarToken('USUARIO', id), tipo: 'USUARIO', usuario: u });
});

const registroSchema = z.object({
  nome: z.string().trim().min(2).max(120),
  email,
  senha: senhaForte,
  telefone: telefone.optional(),
  preferencias: z.record(z.string(), z.unknown()).optional(),
  consentimento_termos: z.literal(true, { message: 'É necessário aceitar os termos de uso e a política de privacidade' }),
  consentimento_marketing: z.boolean().default(false),
});

router.post('/clientes/registro', async (req, res) => {
  const d = validar(registroSchema, req.body);
  const hash = await bcrypt.hash(d.senha, 10);
  const { rows: [c] } = await query(
    `INSERT INTO clientes (nome, email, telefone, senha_hash, preferencias, consentimento_termos_em, consentimento_marketing)
     VALUES ($1,$2,$3,$4,$5, now(), $6)
     ON CONFLICT (email) DO NOTHING
     RETURNING id, nome, email, telefone, preferencias, consentimento_marketing, criado_em`,
    [d.nome, d.email, d.telefone ?? null, hash, d.preferencias ?? {}, d.consentimento_marketing],
  );
  if (!c) throw new AppError(409, 'Já existe uma conta com este e-mail');
  await auditar({ auth: { tipo: 'CLIENTE', id: c.id }, ip: req.ip }, 'CLIENTE_REGISTRADO', {
    entidade: 'clientes', entidadeId: c.id, detalhes: { consentimento_marketing: d.consentimento_marketing },
  });
  res.status(201).json({ token: gerarToken('CLIENTE', c.id), tipo: 'CLIENTE', cliente: c });
});

router.post('/clientes/login', async (req, res) => {
  const dados = validar(loginSchema, req.body);
  const id = await autenticarCredenciais(req, 'clientes', dados);
  const { rows: [c] } = await query(
    'SELECT id, nome, email, telefone, preferencias, consentimento_marketing FROM clientes WHERE id = $1', [id]);
  res.json({ token: gerarToken('CLIENTE', id), tipo: 'CLIENTE', cliente: c });
});

router.get('/me', autenticar, async (req, res) => {
  const { auth } = req;
  if (auth.tipo === 'USUARIO') {
    return res.json({
      tipo: 'USUARIO', id: auth.id, nome: auth.nome, email: auth.email, perfil: auth.perfil,
      unidade_id: auth.unidadeId, permissoes: [...auth.permissoes].sort(),
    });
  }
  const { rows: [c] } = await query(
    `SELECT id, nome, email, telefone, preferencias, consentimento_termos_em, consentimento_marketing, criado_em
       FROM clientes WHERE id = $1`, [auth.id]);
  res.json({ tipo: 'CLIENTE', ...c });
});

const trocaSenhaSchema = z.object({ senha_atual: z.string().min(1).max(72), nova_senha: senhaForte });

router.patch('/senha', autenticar, async (req, res) => {
  const d = validar(trocaSenhaSchema, req.body);
  const tabela = req.auth.tipo === 'USUARIO' ? 'usuarios' : 'clientes';
  const { rows: [conta] } = await query(`SELECT senha_hash FROM ${tabela} WHERE id = $1`, [req.auth.id]);
  if (!conta.senha_hash || !(await bcrypt.compare(d.senha_atual, conta.senha_hash))) {
    throw requisicaoInvalida('Senha atual incorreta');
  }
  await query(`UPDATE ${tabela} SET senha_hash = $2, atualizado_em = now() WHERE id = $1`,
    [req.auth.id, await bcrypt.hash(d.nova_senha, 10)]);
  res.json({ mensagem: 'Senha alterada com sucesso' });
});
