import 'dotenv/config';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';

const ext = process.platform === 'win32' ? '.exe' : '';
const plataforma = process.platform === 'win32' ? 'windows' : process.platform;
const binDir = path.resolve(`node_modules/@embedded-postgres/${plataforma}-${process.arch}/native/bin`);
const dataDir = path.resolve('.pgdata');

const ehLocal = (u) => u && ['localhost', '127.0.0.1'].includes(new URL(u).hostname);
const url = new URL(ehLocal(process.env.DATABASE_URL) ? process.env.DATABASE_URL : 'postgres://postgres:postgres@localhost:5433/raizes');
const testUrl = new URL(ehLocal(process.env.TEST_DATABASE_URL) ? process.env.TEST_DATABASE_URL : 'postgres://postgres:postgres@localhost:5433/raizes_test');
const porta = url.port || '5432';

function executar(bin, args, { capturarErros = true } = {}) {
  const stdio = capturarErros ? ['ignore', 'ignore', 'pipe'] : 'ignore';
  return spawnSync(path.join(binDir, bin + ext), args, { stdio, encoding: 'utf8' });
}

async function criarBancos() {
  const admin = new pg.Client({
    host: url.hostname, port: Number(porta), user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password), database: 'postgres',
  });
  for (let tentativa = 1; ; tentativa++) {
    try {
      await admin.connect();
      break;
    } catch (err) {
      if (tentativa >= 20) throw err;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  for (const nome of [url.pathname.slice(1), testUrl.pathname.slice(1)]) {
    const { rowCount } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [nome]);
    if (!rowCount) {
      await admin.query(`CREATE DATABASE "${nome.replace(/"/g, '')}"`);
      console.log(`Banco "${nome}" criado.`);
    }
  }
  await admin.end();
}

async function start() {
  if (!fs.existsSync(binDir)) {
    console.error('Binários do PostgreSQL não encontrados. Rode "npm install" primeiro.');
    process.exit(1);
  }
  const maisLongo = path.join(binDir, '..', 'share', 'extension', 'plpgsql--1.0.sql');
  if (process.platform === 'win32' && maisLongo.length >= 255) {
    console.error('O caminho da pasta do projeto é longo demais para o Windows (limite de 260 caracteres).');
    console.error(`Pasta atual: ${process.cwd()}`);
    console.error('Mova o projeto para uma pasta mais curta, por exemplo C:\\raizes-do-nordeste, e rode "npm install" de novo.');
    process.exit(1);
  }
  if (!fs.existsSync(path.join(dataDir, 'PG_VERSION'))) {
    const pwfile = path.join(os.tmpdir(), `raizes-pw-${process.pid}`);
    fs.writeFileSync(pwfile, decodeURIComponent(url.password) || 'postgres');
    const r = executar('initdb', ['-D', dataDir, '-U', decodeURIComponent(url.username) || 'postgres',
      `--pwfile=${pwfile}`, '-A', 'scram-sha-256', '-E', 'UTF8', '--locale=C']);
    fs.rmSync(pwfile, { force: true });
    if (r.status !== 0) {
      console.error('Falha ao inicializar o banco:', r.stderr);
      process.exit(1);
    }
    console.log('Diretório de dados inicializado em .pgdata');
  }
  if (executar('pg_ctl', ['-D', dataDir, 'status']).status === 0) {
    console.log('PostgreSQL local já está rodando.');
  } else {
    const r = executar('pg_ctl', ['-D', dataDir, '-o', `-p ${porta}`, '-l', path.join(dataDir, 'servidor.log'), '-w', 'start'],
      { capturarErros: false });
    if (r.status !== 0) {
      console.error('Falha ao iniciar o PostgreSQL. Veja os detalhes em .pgdata/servidor.log');
      process.exit(1);
    }
    console.log(`PostgreSQL local rodando na porta ${porta}.`);
  }
  await criarBancos();
}

function stop() {
  const r = executar('pg_ctl', ['-D', dataDir, '-m', 'fast', 'stop']);
  console.log(r.status === 0 ? 'PostgreSQL local parado.' : 'PostgreSQL local não estava rodando.');
}

const comando = process.argv[2];
if (comando === 'start') await start();
else if (comando === 'stop') stop();
else console.log('Uso: node scripts/local-db.js start|stop');
