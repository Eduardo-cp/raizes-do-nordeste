import bcrypt from 'bcryptjs';
import { pathToFileURL } from 'node:url';

export const SENHA_DEMO_USUARIOS = 'Raizes@2026';
export const SENHA_DEMO_CLIENTES = 'Cliente@2026';

const ITENS = [
  ['Goma de tapioca', 'INGREDIENTE', 'KG'],
  ['Queijo coalho', 'INGREDIENTE', 'KG'],
  ['Carne de sol', 'INGREDIENTE', 'KG'],
  ['Charque', 'INGREDIENTE', 'KG'],
  ['Flocão de milho', 'INGREDIENTE', 'KG'],
  ['Ovo', 'INGREDIENTE', 'UN'],
  ['Manteiga de garrafa', 'INGREDIENTE', 'L'],
  ['Coco ralado', 'INGREDIENTE', 'KG'],
  ['Leite condensado', 'INGREDIENTE', 'KG'],
  ['Polpa de cajá', 'INGREDIENTE', 'KG'],
  ['Café em pó', 'INGREDIENTE', 'KG'],
  ['Coxinha de frango (congelada)', 'PRODUTO_ACABADO', 'UN'],
  ['Pastel de carne de sol (congelado)', 'PRODUTO_ACABADO', 'UN'],
  ['Guaraná lata 350ml', 'PRODUTO_ACABADO', 'UN'],
  ['Água mineral 500ml', 'PRODUTO_ACABADO', 'UN'],
  ['Cocada', 'PRODUTO_ACABADO', 'UN'],
  ['Bolo de rolo (fatia)', 'PRODUTO_ACABADO', 'UN'],
];

const CATEGORIAS = [
  ['Tapiocas', 'Tapiocas feitas na hora com goma fresca'],
  ['Cuscuz', 'Cuscuz nordestino de flocão de milho'],
  ['Salgados', 'Salgados fritos na hora'],
  ['Bebidas', 'Sucos regionais, cafés e refrigerantes'],
  ['Sobremesas', 'Doces tradicionais do Nordeste'],
];

const PRODUTOS = [
  ['Tapiocas', 'Tapioca de Carne de Sol com Queijo Coalho', 'Carne de sol desfiada, queijo coalho e manteiga de garrafa', 22.9,
    [['Goma de tapioca', 0.1], ['Carne de sol', 0.08], ['Queijo coalho', 0.05], ['Manteiga de garrafa', 0.01]]],
  ['Tapiocas', 'Tapioca de Queijo Coalho', 'Queijo coalho derretido com manteiga de garrafa', 14.9,
    [['Goma de tapioca', 0.1], ['Queijo coalho', 0.07], ['Manteiga de garrafa', 0.01]]],
  ['Tapiocas', 'Tapioca de Coco com Leite Condensado', 'Doce, com coco ralado fresco', 13.9,
    [['Goma de tapioca', 0.1], ['Coco ralado', 0.03], ['Leite condensado', 0.04]]],
  ['Cuscuz', 'Cuscuz com Charque', 'Cuscuz de milho com charque acebolado', 19.9,
    [['Flocão de milho', 0.15], ['Charque', 0.1], ['Manteiga de garrafa', 0.01]]],
  ['Cuscuz', 'Cuscuz com Ovo e Queijo', 'Cuscuz com dois ovos e queijo coalho', 15.9,
    [['Flocão de milho', 0.15], ['Ovo', 2], ['Queijo coalho', 0.05]]],
  ['Salgados', 'Coxinha de Frango', 'Coxinha cremosa frita na hora', 7.5, [['Coxinha de frango (congelada)', 1]]],
  ['Salgados', 'Pastel de Carne de Sol', 'Pastel crocante recheado com carne de sol', 9.0, [['Pastel de carne de sol (congelado)', 1]]],
  ['Bebidas', 'Suco de Cajá 400ml', 'Suco natural da polpa de cajá', 9.9, [['Polpa de cajá', 0.1]]],
  ['Bebidas', 'Guaraná Lata', 'Refrigerante 350ml', 6.0, [['Guaraná lata 350ml', 1]]],
  ['Bebidas', 'Água Mineral', 'Garrafa 500ml', 4.0, [['Água mineral 500ml', 1]]],
  ['Bebidas', 'Cafezinho', 'Café coado na hora', 4.5, [['Café em pó', 0.01]]],
  ['Sobremesas', 'Cocada', 'Cocada branca artesanal', 6.5, [['Cocada', 1]]],
  ['Sobremesas', 'Bolo de Rolo', 'Fatia do tradicional bolo de rolo pernambucano', 8.9, [['Bolo de rolo (fatia)', 1]]],
];

const ESTOQUE_INICIAL = {
  'Goma de tapioca': [20, 5], 'Queijo coalho': [10, 3], 'Carne de sol': [8, 2], 'Charque': [6, 2],
  'Flocão de milho': [15, 4], 'Ovo': [180, 60], 'Manteiga de garrafa': [3, 1], 'Coco ralado': [4, 1],
  'Leite condensado': [5, 1.5], 'Polpa de cajá': [6, 2], 'Café em pó': [2, 0.5],
  'Coxinha de frango (congelada)': [120, 40], 'Pastel de carne de sol (congelado)': [80, 30],
  'Guaraná lata 350ml': [96, 24], 'Água mineral 500ml': [96, 24], 'Cocada': [40, 10], 'Bolo de rolo (fatia)': [30, 10],
};

function geradorAleatorio(semente) {
  let s = semente;
  return () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296);
}

export async function semear(pool, { historico = true, silencioso = false } = {}) {
  const log = (...a) => !silencioso && console.log(...a);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: [jaSemeado] } = await client.query('SELECT count(*)::int AS n FROM unidades');
    if (jaSemeado.n > 0) {
      log('Banco já possui dados; seed ignorado (use "npm run db:reset" para recriar).');
      await client.query('ROLLBACK');
      return;
    }

    const { rows: unidades } = await client.query(`
      INSERT INTO unidades (nome, endereco, telefone) VALUES
        ('Recife - Boa Viagem', 'Av. Conselheiro Aguiar, 1000 - Boa Viagem, Recife/PE', '(81) 3000-0001'),
        ('Fortaleza - Aldeota', 'Av. Santos Dumont, 2000 - Aldeota, Fortaleza/CE', '(85) 3000-0002')
      RETURNING id, nome`);
    const [recife, fortaleza] = unidades;

    const { rows: perfis } = await client.query('SELECT id, nome FROM perfis');
    const perfil = Object.fromEntries(perfis.map((p) => [p.nome, p.id]));
    const hashUsuario = await bcrypt.hash(SENHA_DEMO_USUARIOS, 10);
    const usuarios = [
      ['Administrador da Rede', 'admin@raizes.com.br', 'ADMIN', null],
      ['Gerente Recife', 'gerente.recife@raizes.com.br', 'GERENTE', recife.id],
      ['Atendente Recife', 'atendente.recife@raizes.com.br', 'ATENDENTE', recife.id],
      ['Cozinha Recife', 'cozinha.recife@raizes.com.br', 'COZINHA', recife.id],
      ['Gerente Fortaleza', 'gerente.fortaleza@raizes.com.br', 'GERENTE', fortaleza.id],
      ['Atendente Fortaleza', 'atendente.fortaleza@raizes.com.br', 'ATENDENTE', fortaleza.id],
    ];
    const idUsuario = {};
    for (const [nome, email, p, unidade] of usuarios) {
      const { rows: [u] } = await client.query(
        'INSERT INTO usuarios (nome, email, senha_hash, perfil_id, unidade_id) VALUES ($1,$2,$3,$4,$5) RETURNING id',
        [nome, email, hashUsuario, perfil[p], unidade]);
      idUsuario[email] = u.id;
    }

    const idCategoria = {};
    for (const [nome, descricao] of CATEGORIAS) {
      const { rows: [c] } = await client.query('INSERT INTO categorias (nome, descricao) VALUES ($1,$2) RETURNING id', [nome, descricao]);
      idCategoria[nome] = c.id;
    }
    const idItem = {};
    for (const [nome, tipo, um] of ITENS) {
      const { rows: [i] } = await client.query(
        'INSERT INTO itens_estoque (nome, tipo, unidade_medida) VALUES ($1,$2,$3) RETURNING id', [nome, tipo, um]);
      idItem[nome] = i.id;
    }
    const produtos = [];
    for (const [cat, nome, descricao, preco, composicao] of PRODUTOS) {
      const { rows: [p] } = await client.query(
        'INSERT INTO produtos (categoria_id, nome, descricao, preco) VALUES ($1,$2,$3,$4) RETURNING id',
        [idCategoria[cat], nome, descricao, preco]);
      for (const [item, qtd] of composicao) {
        await client.query('INSERT INTO produto_composicao (produto_id, item_estoque_id, quantidade) VALUES ($1,$2,$3)',
          [p.id, idItem[item], qtd]);
      }
      produtos.push({ id: p.id, preco, nome });
    }

    for (const u of unidades) {
      for (const [item, [qtd, minimo]] of Object.entries(ESTOQUE_INICIAL)) {
        let quantidade = qtd;
        if (u.id === fortaleza.id && (item === 'Charque' || item === 'Cocada')) quantidade = minimo / 2;
        await client.query(
          'INSERT INTO estoque (unidade_id, item_estoque_id, quantidade, estoque_minimo) VALUES ($1,$2,$3,$4)',
          [u.id, idItem[item], quantidade, minimo]);
        await client.query(
          `INSERT INTO movimentacoes_estoque (unidade_id, item_estoque_id, tipo, quantidade, observacao, criado_em)
           VALUES ($1,$2,'ENTRADA',$3,'Estoque inicial', now() - interval '15 days')`,
          [u.id, idItem[item], quantidade]);
      }
    }

    const hashCliente = await bcrypt.hash(SENHA_DEMO_CLIENTES, 10);
    const { rows: clientes } = await client.query(`
      INSERT INTO clientes (nome, email, telefone, senha_hash, preferencias, consentimento_termos_em, consentimento_marketing) VALUES
        ('Maria das Graças', 'maria@exemplo.com', '(81) 99999-0001', $1, '{"sem_cebola": true, "bebida_favorita": "Suco de Cajá"}', now(), TRUE),
        ('José Ferreira', 'jose@exemplo.com', '(85) 99999-0002', $1, '{"observacoes": "Tapioca bem torradinha"}', now(), FALSE)
      RETURNING id`, [hashCliente]);

    if (historico) {
      await gerarHistoricoDeVendas(client, { unidades, produtos, clientes, idUsuario });
    }

    await client.query('COMMIT');
    log('Dados de demonstração criados.');
    log(`  Usuários: admin@raizes.com.br, gerente.recife@..., atendente.recife@..., cozinha.recife@... (senha: ${SENHA_DEMO_USUARIOS})`);
    log(`  Clientes: maria@exemplo.com, jose@exemplo.com (senha: ${SENHA_DEMO_CLIENTES})`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function gerarHistoricoDeVendas(client, { unidades, produtos, clientes, idUsuario }) {
  const rand = geradorAleatorio(42);
  const metodos = ['PIX', 'CARTAO_CREDITO', 'CARTAO_DEBITO', 'DINHEIRO'];
  const canais = ['BALCAO', 'BALCAO', 'APP', 'DELIVERY'];
  const { rows: composicoes } = await client.query('SELECT produto_id, item_estoque_id, quantidade FROM produto_composicao');

  for (let dia = 14; dia >= 1; dia--) {
    for (const unidade of unidades) {
      const atendente = unidade.nome.startsWith('Recife') ? idUsuario['atendente.recife@raizes.com.br'] : idUsuario['atendente.fortaleza@raizes.com.br'];
      const qtdPedidos = 6 + Math.floor(rand() * 8);
      for (let n = 0; n < qtdPedidos; n++) {
        const hora = 8 + Math.floor(rand() * 12);
        const quando = `now() - interval '${dia} days' + interval '${hora - new Date().getHours()} hours'`;
        const itens = [];
        const qtdItens = 1 + Math.floor(rand() * 3);
        for (let i = 0; i < qtdItens; i++) {
          itens.push({ produto: produtos[Math.floor(rand() * produtos.length)], quantidade: 1 + Math.floor(rand() * 2) });
        }
        const total = itens.reduce((s, i) => s + Math.round(i.produto.preco * 100) * i.quantidade, 0) / 100;
        const canal = canais[Math.floor(rand() * canais.length)];
        const clienteId = canal === 'BALCAO' ? null : clientes[Math.floor(rand() * clientes.length)].id;
        const metodo = canal === 'BALCAO' ? metodos[Math.floor(rand() * metodos.length)] : metodos[Math.floor(rand() * 3)];

        const { rows: [pedido] } = await client.query(
          `INSERT INTO pedidos (unidade_id, cliente_id, usuario_id, canal, status, total, criado_em, atualizado_em)
           VALUES ($1,$2,$3,$4,'ENTREGUE',$5, ${quando}, ${quando}) RETURNING id, criado_em`,
          [unidade.id, clienteId, canal === 'BALCAO' ? atendente : null, canal, total]);
        for (const i of itens) {
          await client.query('INSERT INTO itens_pedido (pedido_id, produto_id, quantidade, preco_unitario) VALUES ($1,$2,$3,$4)',
            [pedido.id, i.produto.id, i.quantidade, i.produto.preco]);
          for (const c of composicoes.filter((c) => c.produto_id === i.produto.id)) {
            await client.query(
              `INSERT INTO movimentacoes_estoque (unidade_id, item_estoque_id, tipo, quantidade, pedido_id, criado_em)
               VALUES ($1,$2,'BAIXA_PEDIDO',$3,$4,$5)`,
              [unidade.id, c.item_estoque_id, Number(c.quantidade) * i.quantidade, pedido.id, pedido.criado_em]);
          }
        }
        await client.query(
          `INSERT INTO pedido_status_historico (pedido_id, status_de, status_para, criado_em) VALUES
             ($1, NULL, 'AGUARDANDO_PAGAMENTO', $2), ($1, 'AGUARDANDO_PAGAMENTO', 'PAGO', $2),
             ($1, 'PAGO', 'EM_PREPARO', $2), ($1, 'EM_PREPARO', 'PRONTO', $2), ($1, 'PRONTO', 'ENTREGUE', $2)`,
          [pedido.id, pedido.criado_em]);
        const { rows: [pag] } = await client.query(
          `INSERT INTO pagamentos (pedido_id, gateway, gateway_id, metodo, status, valor, idempotency_key, criado_em, atualizado_em)
           VALUES ($1, $2, $3, $4, 'APROVADO', $5, gen_random_uuid(), $6, $6) RETURNING id`,
          [pedido.id, metodo === 'DINHEIRO' ? 'balcao' : 'mock', metodo === 'DINHEIRO' ? null : `hist_${pedido.id}`, metodo, total, pedido.criado_em]);
        await client.query(
          `INSERT INTO lancamentos_caixa (unidade_id, tipo, categoria, valor, forma_pagamento, pedido_id, pagamento_id, descricao, criado_em)
           VALUES ($1,'ENTRADA','VENDA',$2,$3,$4,$5,$6,$7)`,
          [unidade.id, total, metodo, pedido.id, pag.id, `Venda - pedido #${pedido.id}`, pedido.criado_em]);
      }
      if (dia % 3 === 0) {
        await client.query(
          `INSERT INTO lancamentos_caixa (unidade_id, tipo, categoria, valor, descricao, criado_em)
           VALUES ($1,'SAIDA','COMPRA_INSUMOS',$2,'Compra de insumos (fornecedor)', now() - interval '${dia} days')`,
          [unidade.id, 250 + Math.round(rand() * 200)]);
      }
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { pool } = await import('../src/db.js');
  try {
    await semear(pool);
  } finally {
    await pool.end();
  }
}
