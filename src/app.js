import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import swaggerUi from 'swagger-ui-express';
import YAML from 'yaml';
import { config } from './config.js';
import { query } from './db.js';
import { auditarEscritas } from './middleware/auditoria.js';
import { rotaNaoEncontrada, tratarErros } from './middleware/erros.js';
import { router as authRouter } from './modules/auth.routes.js';
import { router as unidadesRouter } from './modules/unidades.routes.js';
import { router as usuariosRouter } from './modules/usuarios.routes.js';
import { router as perfisRouter } from './modules/perfis.routes.js';
import { router as clientesRouter, meRouter } from './modules/clientes.routes.js';
import { router as lgpdRouter } from './modules/lgpd.routes.js';
import { categoriasRouter, produtosRouter } from './modules/catalogo.routes.js';
import { router as estoqueRouter } from './modules/estoque.routes.js';
import { router as pedidosRouter, acompanhamentoRouter, simuladorRouter, webhooksRouter } from './modules/pedidos.routes.js';
import { router as relatoriosRouter } from './modules/relatorios.routes.js';
import { caixaRouter, auditoriaRouter } from './modules/caixa.routes.js';
import { router as eventosRouter } from './modules/eventos.routes.js';

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function criarApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        connectSrc: ["'self'"],
      },
    },
  }));
  if (config.corsOrigins.length) app.use(cors({ origin: config.corsOrigins }));

  app.use(express.json({ limit: '100kb', verify: (req, res, buf) => { req.rawBody = buf; } }));

  if (!config.teste) {
    app.use((req, res, next) => {
      const inicio = Date.now();
      res.on('finish', () => {
        console.log(JSON.stringify({ em: new Date().toISOString(), metodo: req.method, rota: req.originalUrl.split('?')[0], status: res.statusCode, ms: Date.now() - inicio }));
      });
      next();
    });
  }

  const limiteGeral = rateLimit({ windowMs: 60_000, limit: config.teste ? 10_000 : 300, standardHeaders: 'draft-7', legacyHeaders: false,
    message: { erro: 'Muitas requisições. Tente novamente em instantes.' } });
  const limiteLogin = rateLimit({ windowMs: 15 * 60_000, limit: config.teste ? 10_000 : 20, standardHeaders: 'draft-7', legacyHeaders: false,
    message: { erro: 'Muitas tentativas de login. Aguarde alguns minutos.' } });
  app.use('/api', limiteGeral);
  app.use(['/api/auth/login', '/api/auth/clientes/login', '/api/auth/clientes/registro'], limiteLogin);

  app.use('/api', auditarEscritas);

  app.get('/api/health', async (req, res) => {
    try {
      await query('SELECT 1');
      res.json({ status: 'ok', banco: 'ok', uptime_s: Math.round(process.uptime()) });
    } catch {
      res.status(503).json({ status: 'degradado', banco: 'indisponivel' });
    }
  });

  app.use('/api/auth', authRouter);
  app.use('/api/me', meRouter);
  app.use('/api/unidades', unidadesRouter);
  app.use('/api/usuarios', usuariosRouter);
  app.use('/api/perfis', perfisRouter);
  app.use('/api/clientes', clientesRouter);
  app.use('/api/lgpd', lgpdRouter);
  app.use('/api/categorias', categoriasRouter);
  app.use('/api/produtos', produtosRouter);
  app.use('/api/estoque', estoqueRouter);
  app.use('/api/pedidos', pedidosRouter);
  app.use('/api/acompanhamento', acompanhamentoRouter);
  app.use('/api/webhooks', webhooksRouter);
  app.use('/api/pagamentos/simulador', simuladorRouter);
  app.use('/api/caixa', caixaRouter);
  app.use('/api/relatorios', relatoriosRouter);
  app.use('/api/auditoria', auditoriaRouter);
  app.use('/api/eventos', eventosRouter);

  const openapi = YAML.parse(fs.readFileSync(path.join(raiz, 'docs/openapi.yaml'), 'utf8'));
  app.get('/api/docs/openapi.json', (req, res) => res.json(openapi));
  app.use('/api/docs', helmet({ contentSecurityPolicy: false }), swaggerUi.serve, swaggerUi.setup(openapi, {
    customSiteTitle: 'Raízes do Nordeste - API',
  }));
  app.use('/api', rotaNaoEncontrada);

  app.use('/uploads', express.static(config.uploadDir, { fallthrough: false, index: false,
    setHeaders: (res) => res.setHeader('X-Content-Type-Options', 'nosniff') }));
  app.use(express.static(path.join(raiz, 'public')));

  app.use(rotaNaoEncontrada);
  app.use(tratarErros);
  return app;
}
