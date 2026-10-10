const $app = document.getElementById('app');
const $abas = document.getElementById('abas');
const $sessao = document.getElementById('sessao');

const estado = {
  token: sessionStorage.getItem('token'),
  perfil: null,
  aba: null,
  carrinho: new Map(),
  cardapio: [],
  unidades: [],
  unidadeSelecionada: null,
  sse: null,
};

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const moeda = (v) => Number(v ?? 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const num = (v) => Number(v ?? 0).toLocaleString('pt-BR', { maximumFractionDigits: 3 });
const hora = (d) => new Date(d).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
const dataHora = (d) => new Date(d).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
const hoje = () => new Date().toISOString().slice(0, 10);
const diasAtras = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
const pode = (p) => estado.perfil?.permissoes?.includes(p);

const NOMES_STATUS = {
  AGUARDANDO_PAGAMENTO: 'Aguardando pagamento', PAGAMENTO_RECUSADO: 'Pagamento recusado', PAGO: 'Pago',
  EM_PREPARO: 'Em preparo', PRONTO: 'Pronto', SAIU_PARA_ENTREGA: 'Saiu para entrega', ENTREGUE: 'Entregue', CANCELADO: 'Cancelado',
};
const etiqueta = (s) => `<span class="etiqueta st-${esc(s)}">${esc(NOMES_STATUS[s] ?? s)}</span>`;
const ICONES = { Tapiocas: '🫓', Cuscuz: '🌽', Salgados: '🥟', Bebidas: '🥤', Sobremesas: '🍮' };

function avisar(msg, tipo = '') {
  const el = document.createElement('div');
  el.className = `aviso ${tipo}`;
  el.textContent = msg;
  document.getElementById('avisos').append(el);
  setTimeout(() => el.remove(), 5000);
}

async function api(url, { method = 'GET', body, bruto = false } = {}) {
  const headers = {};
  if (estado.token) headers.Authorization = `Bearer ${estado.token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const resp = await fetch(url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  if (resp.status === 401 && estado.token) {
    sair();
    throw new Error('Sessão expirada. Entre novamente.');
  }
  if (bruto) return resp;
  const dados = resp.status === 204 ? null : await resp.json().catch(() => ({}));
  if (!resp.ok) {
    let msg = dados?.erro ?? `Erro ${resp.status}`;
    if (Array.isArray(dados?.detalhes)) {
      msg += ': ' + dados.detalhes.map((d) => d.mensagem ?? (d.item ? `${d.item} (disponível ${num(d.disponivel)}, necessário ${num(d.necessario)})` : JSON.stringify(d))).join('; ');
    }
    throw new Error(msg);
  }
  return dados;
}

const tentar = (fn) => async (...args) => {
  try { await fn(...args); } catch (e) { avisar(e.message, 'erro'); }
};

async function iniciar() {
  const rota = location.hash.match(/^#\/acompanhar\/([\w-]+)/);
  if (rota) return telaAcompanhamento(rota[1]);
  estado.unidades = await api('/api/unidades').catch(() => []);
  if (!estado.token) return telaLogin();
  try {
    estado.perfil = await api('/api/auth/me');
  } catch {
    return telaLogin();
  }
  montarAbas();
}

function sair() {
  estado.token = null;
  estado.perfil = null;
  sessionStorage.removeItem('token');
  estado.sse?.abort();
  estado.carrinho.clear();
  telaLogin();
}

function montarAbas() {
  const p = estado.perfil;
  const abas = p.tipo === 'CLIENTE'
    ? [['cardapio', 'Fazer pedido', telaCardapioCliente], ['meus', 'Meus pedidos', telaMeusPedidos], ['privacidade', 'Privacidade', telaPrivacidade]]
    : [
      pode('pedidos.ver') && ['pedidos', 'Pedidos', telaQuadroPedidos],
      pode('pedidos.criar') && ['novo', 'Novo pedido', telaNovoPedido],
      pode('estoque.ver') && ['estoque', 'Estoque', telaEstoque],
      pode('relatorios.ver') && ['relatorios', 'Relatórios', telaRelatorios],
      pode('clientes.ver') && ['clientes', 'Clientes', telaClientes],
    ].filter(Boolean);

  $abas.innerHTML = abas.map(([id, nome]) => `<button data-aba="${id}">${nome}</button>`).join('');
  $abas.onclick = (e) => {
    const b = e.target.closest('button[data-aba]');
    if (b) abrirAba(b.dataset.aba);
  };
  estado.telas = Object.fromEntries(abas.map(([id, , fn]) => [id, fn]));
  const unidade = estado.unidades.find((u) => u.id === p.unidade_id);
  $sessao.innerHTML = `<span>${esc(p.nome)} · ${esc(p.perfil ?? 'Cliente')}${unidade ? ' · ' + esc(unidade.nome) : ''}</span><button id="btn-sair">Sair</button>`;
  document.getElementById('btn-sair').onclick = sair;
  if (p.tipo === 'USUARIO' && pode('pedidos.ver')) conectarTempoReal();
  abrirAba(abas[0]?.[0]);
}

function abrirAba(id) {
  estado.aba = id;
  [...$abas.children].forEach((b) => b.classList.toggle('ativa', b.dataset.aba === id));
  tentar(estado.telas[id])();
}

async function conectarTempoReal() {
  estado.sse?.abort();
  const controle = new AbortController();
  estado.sse = controle;
  try {
    const resp = await fetch('/api/eventos', { headers: { Authorization: `Bearer ${estado.token}` }, signal: controle.signal });
    const leitor = resp.body.getReader();
    const dec = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { value, done } = await leitor.read();
      if (done) break;
      buffer += dec.decode(value, { stream: true });
      const blocos = buffer.split('\n\n');
      buffer = blocos.pop();
      for (const b of blocos) {
        const tipo = b.match(/^event: (.+)$/m)?.[1];
        const dados = b.match(/^data: (.+)$/m)?.[1];
        if (tipo && dados) aoReceberEvento(tipo, JSON.parse(dados));
      }
    }
  } catch { }
  if (!controle.signal.aborted && estado.token) setTimeout(conectarTempoReal, 3000);
}

let recarregarQuadro;
function aoReceberEvento(tipo, dados) {
  if (tipo === 'pedido.criado') avisar(`Novo pedido #${dados.id} (${dados.canal})`, 'ok');
  if (tipo === 'estoque.alerta') avisar(`Estoque baixo: ${dados.item} (${num(dados.disponivel)} ${dados.unidade_medida})`, 'alerta');
  if (tipo.startsWith('pedido') && estado.aba === 'pedidos') {
    clearTimeout(recarregarQuadro);
    recarregarQuadro = setTimeout(tentar(telaQuadroPedidos), 300);
  }
}

function telaLogin(modo = 'funcionario') {
  $abas.innerHTML = '';
  $sessao.innerHTML = '';
  const cliente = modo !== 'funcionario';
  $app.innerHTML = `
    <div class="login cartao">
      <div class="alternar">
        <button data-modo="funcionario" class="${!cliente ? 'ativa' : ''}">Funcionário</button>
        <button data-modo="cliente" class="${modo === 'cliente' ? 'ativa' : ''}">Cliente</button>
        <button data-modo="cadastro" class="${modo === 'cadastro' ? 'ativa' : ''}">Criar conta</button>
      </div>
      ${modo === 'cadastro' ? `
        <form class="form" id="form-cadastro">
          <label>Nome <input name="nome" required minlength="2"></label>
          <label>E-mail <input name="email" type="email" required></label>
          <label>Telefone <input name="telefone" placeholder="(81) 99999-0000"></label>
          <label>Senha <input name="senha" type="password" required minlength="8" placeholder="mín. 8 caracteres, letras e números"></label>
          <label class="check"><input type="checkbox" name="termos" required> Li e aceito os termos de uso e a <a href="/api/lgpd/politica" target="_blank">política de privacidade</a></label>
          <label class="check"><input type="checkbox" name="marketing"> Quero receber promoções (opcional)</label>
          <button class="btn">Criar conta</button>
        </form>` : `
        <form class="form" id="form-login">
          <label>E-mail <input name="email" type="email" required autocomplete="username"></label>
          <label>Senha <input name="senha" type="password" required autocomplete="current-password"></label>
          <button class="btn">Entrar</button>
        </form>
        <p class="dica">Demonstração — ${cliente
          ? 'cliente: <code>maria@exemplo.com</code> / <code>Cliente@2026</code>'
          : 'senha <code>Raizes@2026</code> para: <code>admin@raizes.com.br</code>, <code>gerente.recife@raizes.com.br</code>, <code>atendente.recife@raizes.com.br</code>, <code>cozinha.recife@raizes.com.br</code>'}</p>`}
    </div>`;
  $app.querySelector('.alternar').onclick = (e) => {
    const b = e.target.closest('button');
    if (b) telaLogin(b.dataset.modo);
  };
  const form = $app.querySelector('form');
  form.onsubmit = tentar(async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(form));
    let r;
    if (modo === 'cadastro') {
      r = await api('/api/auth/clientes/registro', { method: 'POST', body: {
        nome: f.nome, email: f.email, senha: f.senha, telefone: f.telefone || undefined,
        consentimento_termos: !!f.termos, consentimento_marketing: !!f.marketing,
      } });
    } else {
      r = await api(cliente ? '/api/auth/clientes/login' : '/api/auth/login', { method: 'POST', body: { email: f.email, senha: f.senha } });
    }
    estado.token = r.token;
    sessionStorage.setItem('token', r.token);
    estado.perfil = await api('/api/auth/me');
    montarAbas();
  });
}

const COLUNAS = [
  ['Aguardando pagamento', ['AGUARDANDO_PAGAMENTO', 'PAGAMENTO_RECUSADO']],
  ['Na fila (pago)', ['PAGO']],
  ['Em preparo', ['EM_PREPARO']],
  ['Pronto / em entrega', ['PRONTO', 'SAIU_PARA_ENTREGA']],
];

function proximosPassos(p) {
  const passos = { PAGO: ['EM_PREPARO', 'Iniciar preparo'], EM_PREPARO: ['PRONTO', 'Marcar pronto'], SAIU_PARA_ENTREGA: ['ENTREGUE', 'Entregue'] };
  if (p.status === 'PRONTO') return p.canal === 'DELIVERY' ? [['SAIU_PARA_ENTREGA', 'Saiu p/ entrega']] : [['ENTREGUE', 'Retirado / entregue']];
  return passos[p.status] ? [passos[p.status]] : [];
}

async function telaQuadroPedidos() {
  const ativos = COLUNAS.flatMap(([, s]) => s).join(',');
  const { dados } = await api(`/api/pedidos?status=${ativos}&limite=100&inicio=${diasAtras(2)}`);
  $app.innerHTML = `
    <h1>Pedidos em andamento <span class="ao-vivo">ao vivo</span></h1>
    <div class="quadro">
      ${COLUNAS.map(([titulo, status]) => {
        const lista = dados.filter((p) => status.includes(p.status)).reverse();
        return `<div class="coluna"><h2>${titulo} <span>${lista.length}</span></h2>
          ${lista.map(cartaoPedido).join('') || '<div class="vazio">Nenhum pedido</div>'}</div>`;
      }).join('')}
    </div>`;
  $app.querySelector('.quadro').onclick = tentar(async (e) => {
    const b = e.target.closest('button[data-acao]');
    if (!b) return;
    const id = b.dataset.id;
    if (b.dataset.acao === 'status') {
      await api(`/api/pedidos/${id}/status`, { method: 'PATCH', body: { status: b.dataset.status } });
    } else if (b.dataset.acao === 'dinheiro') {
      await api(`/api/pedidos/${id}/pagamentos`, { method: 'POST', body: { metodo: 'DINHEIRO' } });
      avisar(`Pagamento em dinheiro registrado (#${id})`, 'ok');
    } else if (b.dataset.acao === 'cancelar') {
      const motivo = prompt(`Motivo do cancelamento do pedido #${id}:`);
      if (!motivo) return;
      await api(`/api/pedidos/${id}/cancelar`, { method: 'POST', body: { motivo } });
      avisar(`Pedido #${id} cancelado`, 'ok');
    }
    await telaQuadroPedidos();
  });
}

function cartaoPedido(p) {
  const botoes = [];
  if (pode('pedidos.atualizar_status')) {
    for (const [status, rotulo] of proximosPassos(p)) {
      botoes.push(`<button class="btn peq verde" data-acao="status" data-id="${p.id}" data-status="${status}">${rotulo}</button>`);
    }
  }
  if (['AGUARDANDO_PAGAMENTO', 'PAGAMENTO_RECUSADO'].includes(p.status) && pode('pagamentos.registrar')) {
    botoes.push(`<button class="btn peq" data-acao="dinheiro" data-id="${p.id}">Receber em dinheiro</button>`);
  }
  if (pode('pedidos.cancelar') && ['AGUARDANDO_PAGAMENTO', 'PAGAMENTO_RECUSADO', 'PAGO', 'EM_PREPARO'].includes(p.status)) {
    botoes.push(`<button class="btn peq sec" data-acao="cancelar" data-id="${p.id}">Cancelar</button>`);
  }
  return `<div class="pedido">
    <div class="cab"><span>#${p.id}</span><span>${moeda(p.total)}</span></div>
    <div>${etiqueta(p.status)} <span class="meta">${esc(p.canal)} · ${hora(p.criado_em)}${estado.perfil.unidade_id ? '' : ' · ' + esc(p.unidade)}</span></div>
    <ul>${(p.itens ?? []).map((i) => `<li>${i.quantidade}× ${esc(i.produto)}${i.observacao ? ` <em class="meta">(${esc(i.observacao)})</em>` : ''}</li>`).join('')}</ul>
    ${p.cliente ? `<div class="meta">Cliente: ${esc(p.cliente)}</div>` : ''}
    ${p.endereco_entrega ? `<div class="meta">📍 ${esc(p.endereco_entrega)}</div>` : ''}
    ${p.observacao ? `<div class="meta">Obs.: ${esc(p.observacao)}</div>` : ''}
    <div class="acoes">${botoes.join('')}</div>
  </div>`;
}

function seletorUnidade(id = 'sel-unidade') {
  return `<label>Unidade <select id="${id}">${estado.unidades.map((u) =>
    `<option value="${u.id}" ${u.id === estado.unidadeSelecionada ? 'selected' : ''}>${esc(u.nome)}</option>`).join('')}</select></label>`;
}

async function carregarCardapio() {
  estado.cardapio = await api(`/api/unidades/${estado.unidadeSelecionada}/cardapio`);
}

function htmlCardapio() {
  const categorias = [...new Set(estado.cardapio.map((p) => p.categoria))];
  return categorias.map((c) => `
    <h2>${ICONES[c] ?? '🍽️'} ${esc(c)}</h2>
    <div class="grade" style="margin-bottom:20px">
      ${estado.cardapio.filter((p) => p.categoria === c).map((p) => `
        <div class="produto ${p.disponivel ? '' : 'indisponivel'}">
          <div class="foto">${p.imagem_url ? `<img src="${esc(p.imagem_url)}" alt="">` : ICONES[c] ?? '🍽️'}</div>
          <div class="corpo">
            <strong>${esc(p.nome)}</strong>
            <span class="meta">${esc(p.descricao)}</span>
            <span class="preco">${moeda(p.preco)}</span>
            <button class="btn peq" data-add="${p.id}" ${p.disponivel ? '' : 'disabled'}>${p.disponivel ? 'Adicionar' : 'Esgotado'}</button>
          </div>
        </div>`).join('')}
    </div>`).join('');
}

function totalCarrinho() {
  return [...estado.carrinho.values()].reduce((s, i) => s + Math.round(i.produto.preco * 100) * i.quantidade, 0) / 100;
}

function htmlCarrinho(extras) {
  const itens = [...estado.carrinho.values()];
  return `<div class="cartao carrinho">
    <h2>🧺 Pedido</h2>
    ${itens.length ? `<ul>${itens.map((i) => `
      <li><span>${esc(i.produto.nome)}</span>
        <span><button class="btn peq sec" data-menos="${i.produto.id}">−</button> ${i.quantidade}
        <button class="btn peq sec" data-add="${i.produto.id}">+</button></span></li>`).join('')}</ul>
      <div class="total">${moeda(totalCarrinho())}</div>` : '<div class="vazio">Adicione itens do cardápio</div>'}
    ${extras}
  </div>`;
}

function tratarCliqueCarrinho(e, redesenhar) {
  const add = e.target.closest('[data-add]');
  const menos = e.target.closest('[data-menos]');
  if (!add && !menos) return;
  const id = Number((add ?? menos).dataset.add ?? (add ?? menos).dataset.menos);
  const atual = estado.carrinho.get(id);
  if (add) {
    const produto = estado.cardapio.find((p) => p.id === id);
    estado.carrinho.set(id, { produto, quantidade: (atual?.quantidade ?? 0) + 1 });
  } else if (atual) {
    if (atual.quantidade <= 1) estado.carrinho.delete(id);
    else atual.quantidade--;
  }
  redesenhar();
}

function htmlPagamento(pedido, presencial) {
  return `<div class="cartao">
    <h2>Pedido #${pedido.id} criado — ${moeda(pedido.total)}</h2>
    <p>${etiqueta(pedido.status)} Os itens foram reservados no estoque. Escolha a forma de pagamento:</p>
    <div class="linha">
      ${presencial ? '<button class="btn verde" data-pagar="DINHEIRO">💵 Dinheiro</button>' : ''}
      <button class="btn" data-pagar="PIX">⚡ PIX</button>
      <label>Cartão (ambiente de testes)
        <select id="token-cartao">
          <option value="tok_aprovado">Cartão aprovado</option>
          <option value="tok_recusado">Cartão recusado (saldo insuficiente)</option>
          <option value="tok_erro">Falha no provedor</option>
        </select></label>
      <button class="btn" data-pagar="CARTAO_CREDITO">💳 Crédito</button>
      <button class="btn sec" data-pagar="CARTAO_DEBITO">💳 Débito</button>
    </div>
    <div id="resultado-pagamento" style="margin-top:12px"></div>
    <p class="meta">Acompanhamento: <a href="#/acompanhar/${esc(pedido.codigo_acompanhamento)}" target="_blank">abrir página do pedido</a></p>
  </div>`;
}

async function ocupado(area, mensagem, fn) {
  const botoes = [...area.querySelectorAll('button')];
  botoes.forEach((b) => { b.disabled = true; });
  document.getElementById('resultado-pagamento').innerHTML = `<p class="meta">⏳ ${mensagem}</p>`;
  try {
    return await fn();
  } catch (e) {
    document.getElementById('resultado-pagamento').innerHTML = '';
    throw e;
  } finally {
    botoes.forEach((b) => { b.disabled = false; });
  }
}

async function pagar(pedido, metodo) {
  const cartao = metodo.startsWith('CARTAO') ? { token: document.getElementById('token-cartao').value } : undefined;
  const area = document.getElementById('area-pagamento');
  const pg = await ocupado(area, 'Processando pagamento…', () => api(`/api/pedidos/${pedido.id}/pagamentos`, { method: 'POST', body: { metodo, cartao } }));
  const $r = document.getElementById('resultado-pagamento');
  if (pg.status === 'APROVADO') {
    $r.innerHTML = `<p>✅ Pagamento aprovado. Pedido enviado para a cozinha. ${etiqueta(pg.status_pedido)}</p>`;
    avisar('Pagamento aprovado', 'ok');
  } else if (pg.status === 'RECUSADO') {
    $r.innerHTML = `<p>❌ Pagamento recusado (${esc(pg.detalhes?.motivo ?? '')}). Tente outra forma de pagamento. ${etiqueta(pg.status_pedido)}</p>`;
  } else {
    $r.innerHTML = `<p>⏳ PIX gerado. Copia e cola:</p><textarea readonly rows="2" style="width:100%">${esc(pg.detalhes?.pix_copia_e_cola)}</textarea>
      <p class="dica">Ambiente de testes: simule a resposta do banco →
      <button class="btn peq verde" data-simular="APROVADO" data-gw="${esc(pg.gateway_id)}">Confirmar PIX</button>
      <button class="btn peq vermelho" data-simular="RECUSADO" data-gw="${esc(pg.gateway_id)}">Recusar</button></p>`;
  }
}

function tratarCliquePagamento(e, pedido) {
  const b = e.target.closest('[data-pagar]');
  if (b) return pagar(pedido, b.dataset.pagar);
  const s = e.target.closest('[data-simular]');
  if (s) {
    return ocupado(document.getElementById('area-pagamento'), 'Aguardando o banco…', async () => {
      await api(`/api/pagamentos/simulador/${s.dataset.gw}`, { method: 'POST', body: { status: s.dataset.simular } });
      return api(`/api/pedidos/${pedido.id}`);
    }).then((p) => {
      document.getElementById('resultado-pagamento').innerHTML = `<p>Resposta do banco recebida via webhook: ${etiqueta(p.status)}</p>`;
    });
  }
}

async function telaNovoPedido() {
  estado.unidadeSelecionada ??= estado.perfil.unidade_id ?? estado.unidades[0]?.id;
  await carregarCardapio();
  const desenhar = () => {
    $app.innerHTML = `
      <h1>Novo pedido (balcão)</h1>
      ${estado.perfil.unidade_id ? '' : `<div class="linha" style="margin-bottom:12px">${seletorUnidade()}</div>`}
      <div class="duas-colunas">
        <div>${htmlCardapio()}</div>
        <div class="lateral">${htmlCarrinho(`
          <form class="form" id="form-pedido">
            <label>Canal <select name="canal"><option value="BALCAO">Balcão</option><option value="TOTEM">Totem</option><option value="DELIVERY">Delivery (telefone)</option></select></label>
            <label>Endereço (delivery) <input name="endereco_entrega"></label>
            <label>Observação <input name="observacao" maxlength="500" placeholder="ex.: sem cebola"></label>
            <button class="btn" ${estado.carrinho.size ? '' : 'disabled'}>Registrar pedido</button>
          </form>`)}
          <div id="area-pagamento"></div>
        </div>
      </div>`;
    document.getElementById('sel-unidade')?.addEventListener('change', tentar(async (e) => {
      estado.unidadeSelecionada = Number(e.target.value);
      estado.carrinho.clear();
      await telaNovoPedido();
    }));
    const form = document.getElementById('form-pedido');
    form.onsubmit = tentar(async (e) => {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(form));
      const pedido = await api('/api/pedidos', { method: 'POST', body: {
        unidade_id: estado.unidadeSelecionada, canal: f.canal, observacao: f.observacao || undefined,
        endereco_entrega: f.endereco_entrega || undefined,
        itens: [...estado.carrinho.values()].map((i) => ({ produto_id: i.produto.id, quantidade: i.quantidade })),
      } });
      estado.carrinho.clear();
      await carregarCardapio();
      desenhar();
      const area = document.getElementById('area-pagamento');
      area.innerHTML = htmlPagamento(pedido, pode('pagamentos.registrar'));
      area.onclick = tentar((ev) => tratarCliquePagamento(ev, pedido));
    });
  };
  $app.onclick = (e) => { tratarCliqueCarrinho(e, desenhar); };
  desenhar();
}

async function telaCardapioCliente() {
  estado.unidadeSelecionada ??= estado.unidades[0]?.id;
  await carregarCardapio();
  const desenhar = () => {
    $app.innerHTML = `
      <h1>Olá, ${esc(estado.perfil.nome.split(' ')[0])}! O que vai ser hoje?</h1>
      <div class="linha" style="margin-bottom:12px">${seletorUnidade()}</div>
      <div class="duas-colunas">
        <div>${htmlCardapio()}</div>
        <div class="lateral">${htmlCarrinho(`
          <form class="form" id="form-pedido">
            <label>Como quer receber? <select name="canal"><option value="APP">Retirar na loja</option><option value="DELIVERY">Delivery</option></select></label>
            <label>Endereço (delivery) <input name="endereco_entrega"></label>
            <label>Observação <input name="observacao" maxlength="500"></label>
            <button class="btn" ${estado.carrinho.size ? '' : 'disabled'}>Fazer pedido</button>
          </form>`)}
          <div id="area-pagamento"></div>
        </div>
      </div>`;
    document.getElementById('sel-unidade').addEventListener('change', tentar(async (e) => {
      estado.unidadeSelecionada = Number(e.target.value);
      estado.carrinho.clear();
      await telaCardapioCliente();
    }));
    const form = document.getElementById('form-pedido');
    form.onsubmit = tentar(async (e) => {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(form));
      const pedido = await api('/api/pedidos', { method: 'POST', body: {
        unidade_id: estado.unidadeSelecionada, canal: f.canal, observacao: f.observacao || undefined,
        endereco_entrega: f.endereco_entrega || undefined,
        itens: [...estado.carrinho.values()].map((i) => ({ produto_id: i.produto.id, quantidade: i.quantidade })),
      } });
      estado.carrinho.clear();
      desenhar();
      const area = document.getElementById('area-pagamento');
      area.innerHTML = htmlPagamento(pedido, false);
      area.onclick = tentar((ev) => tratarCliquePagamento(ev, pedido));
    });
  };
  $app.onclick = (e) => { tratarCliqueCarrinho(e, desenhar); };
  desenhar();
}

async function telaMeusPedidos() {
  $app.onclick = null;
  const { dados } = await api('/api/me/pedidos?limite=50');
  $app.innerHTML = `<h1>Meus pedidos</h1>
    <div class="cartao">${dados.length ? `<table>
      <thead><tr><th>#</th><th>Data</th><th>Unidade</th><th>Itens</th><th>Status</th><th class="num">Total</th><th></th></tr></thead>
      <tbody>${dados.map((p) => `<tr>
        <td>${p.id}</td><td>${dataHora(p.criado_em)}</td><td>${esc(p.unidade)}</td>
        <td>${(p.itens ?? []).map((i) => `${i.quantidade}× ${esc(i.produto)}`).join(', ')}</td>
        <td>${etiqueta(p.status)}</td><td class="num">${moeda(p.total)}</td>
        <td><a href="#/acompanhar/${esc(p.codigo_acompanhamento)}" target="_blank">Acompanhar</a></td></tr>`).join('')}</tbody></table>`
      : '<div class="vazio">Você ainda não fez pedidos.</div>'}</div>`;
}

async function telaPrivacidade() {
  $app.onclick = null;
  const eu = await api('/api/auth/me');
  $app.innerHTML = `<h1>Privacidade e meus dados (LGPD)</h1>
    <div class="cartao">
      <p><strong>Consentimento dos termos:</strong> ${dataHora(eu.consentimento_termos_em)}</p>
      <label class="check"><input type="checkbox" id="mkt" ${eu.consentimento_marketing ? 'checked' : ''}> Aceito receber comunicações de marketing</label>
      <div class="linha" style="margin-top:16px">
        <button class="btn sec" id="exportar">⬇ Baixar meus dados (JSON)</button>
        <button class="btn vermelho" id="excluir">Excluir minha conta</button>
      </div>
      <p class="meta">A exclusão anonimiza seus dados pessoais. Registros de vendas são mantidos sem identificação, por obrigação fiscal.</p>
    </div>`;
  document.getElementById('mkt').onchange = tentar(async (e) => {
    await api('/api/me', { method: 'PATCH', body: { consentimento_marketing: e.target.checked } });
    avisar('Preferência salva', 'ok');
  });
  document.getElementById('exportar').onclick = tentar(async () => {
    const resp = await api('/api/lgpd/meus-dados', { bruto: true });
    baixar(await resp.blob(), 'meus-dados-raizes.json');
  });
  document.getElementById('excluir').onclick = tentar(async () => {
    const senha = prompt('Para confirmar a exclusão definitiva, digite sua senha:');
    if (!senha) return;
    await api('/api/lgpd/minha-conta', { method: 'DELETE', body: { senha } });
    alert('Seus dados foram eliminados.');
    sair();
  });
}

async function telaEstoque() {
  $app.onclick = null;
  estado.unidadeSelecionada ??= estado.perfil.unidade_id ?? estado.unidades[0]?.id;
  const unidade = estado.perfil.unidade_id ?? estado.unidadeSelecionada;
  const posicao = await api(`/api/estoque?unidade_id=${unidade}`);
  const alertas = posicao.filter((p) => p.abaixo_minimo);
  $app.innerHTML = `
    <h1>Estoque</h1>
    ${estado.perfil.unidade_id ? '' : `<div class="linha" style="margin-bottom:12px">${seletorUnidade()}</div>`}
    ${alertas.length ? `<div class="cartao" style="border-color:#f0b4ae"><strong>⚠ ${alertas.length} item(ns) precisam de reposição:</strong>
      ${alertas.map((a) => esc(a.item)).join(', ')}</div>` : ''}
    <div class="duas-colunas">
      <div class="cartao"><table>
        <thead><tr><th>Item</th><th class="num">Saldo</th><th class="num">Reservado</th><th class="num">Disponível</th><th class="num">Mínimo</th><th>Un.</th></tr></thead>
        <tbody>${posicao.map((p) => `<tr class="${p.abaixo_minimo ? 'alerta' : ''}">
          <td>${esc(p.item)} <span class="meta">${p.tipo === 'INGREDIENTE' ? 'ingrediente' : 'pronto'}</span></td>
          <td class="num">${num(p.quantidade)}</td><td class="num">${num(p.reservado)}</td>
          <td class="num"><strong>${num(p.disponivel)}</strong></td><td class="num">${num(p.estoque_minimo)}</td><td>${esc(p.unidade_medida)}</td></tr>`).join('')}
        </tbody></table></div>
      ${pode('estoque.gerenciar') ? `<div class="cartao"><h2>Registrar movimentação</h2>
        <form class="form" id="form-mov">
          <label>Item <select name="item_estoque_id">${posicao.map((p) => `<option value="${p.item_estoque_id}">${esc(p.item)} (${esc(p.unidade_medida)})</option>`).join('')}</select></label>
          <label>Tipo <select name="tipo"><option value="ENTRADA">Entrada (compra)</option><option value="SAIDA">Saída (perda/avaria)</option><option value="AJUSTE">Ajuste (inventário: saldo contado)</option></select></label>
          <label>Quantidade <input name="quantidade" type="number" step="0.001" min="0" required></label>
          <label>Custo total R$ (entradas, opcional) <input name="custo_total" type="number" step="0.01" min="0"></label>
          <label>Observação <input name="observacao" maxlength="255" placeholder="ex.: NF 1234"></label>
          <button class="btn">Registrar</button>
        </form></div>` : ''}
    </div>`;
  document.getElementById('sel-unidade')?.addEventListener('change', tentar(async (e) => {
    estado.unidadeSelecionada = Number(e.target.value);
    await telaEstoque();
  }));
  const form = document.getElementById('form-mov');
  if (form) {
    form.onsubmit = tentar(async (e) => {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(form));
      await api('/api/estoque/movimentacoes', { method: 'POST', body: {
        unidade_id: unidade, item_estoque_id: Number(f.item_estoque_id), tipo: f.tipo, quantidade: Number(f.quantidade),
        custo_total: f.custo_total ? Number(f.custo_total) : undefined, observacao: f.observacao || undefined,
      } });
      avisar('Movimentação registrada', 'ok');
      await telaEstoque();
    });
  }
}

function baixar(blob, nome) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = nome;
  a.click();
  URL.revokeObjectURL(a.href);
}

async function telaRelatorios(inicio = diasAtras(13), fim = hoje()) {
  $app.onclick = null;
  const q = `inicio=${inicio}&fim=${fim}`;
  const [dash, vendas, caixa, estoque] = await Promise.all([
    api('/api/relatorios/dashboard'),
    api(`/api/relatorios/vendas?${q}`),
    api(`/api/relatorios/fluxo-caixa?${q}`),
    api(`/api/relatorios/estoque?${q}`),
  ]);
  const maxDia = Math.max(1, ...vendas.por_dia.map((d) => d.faturamento));
  $app.innerHTML = `
    <h1>Relatórios gerenciais</h1>
    <div class="kpis">
      <div class="kpi"><div class="rotulo">Faturamento hoje</div><div class="valor">${moeda(dash.hoje.faturamento)}</div></div>
      <div class="kpi"><div class="rotulo">Pedidos hoje</div><div class="valor">${dash.hoje.pedidos_vendidos}</div></div>
      <div class="kpi"><div class="rotulo">Ticket médio hoje</div><div class="valor">${moeda(dash.hoje.ticket_medio)}</div></div>
      <div class="kpi"><div class="rotulo">Itens a repor</div><div class="valor">${dash.alertas_estoque}</div></div>
    </div>
    <div class="cartao"><form class="linha" id="form-periodo">
      <label>Início <input type="date" name="inicio" value="${inicio}"></label>
      <label>Fim <input type="date" name="fim" value="${fim}"></label>
      <button class="btn">Atualizar</button>
      <button type="button" class="btn sec" data-csv="vendas">⬇ Vendas (CSV)</button>
      <button type="button" class="btn sec" data-csv="fluxo-caixa">⬇ Caixa (CSV)</button>
      <button type="button" class="btn sec" data-csv="estoque">⬇ Estoque (CSV)</button>
    </form></div>
    <div class="kpis">
      <div class="kpi"><div class="rotulo">Faturamento no período</div><div class="valor">${moeda(vendas.resumo.faturamento)}</div></div>
      <div class="kpi"><div class="rotulo">Pedidos vendidos</div><div class="valor">${vendas.resumo.pedidos}</div></div>
      <div class="kpi"><div class="rotulo">Ticket médio</div><div class="valor">${moeda(vendas.resumo.ticket_medio)}</div></div>
      <div class="kpi"><div class="rotulo">Resultado de caixa</div><div class="valor">${moeda(caixa.resumo.resultado)}</div></div>
    </div>
    <div class="duas-colunas">
      <div class="cartao"><h2>Vendas por dia</h2><table><tbody>
        ${vendas.por_dia.map((d) => `<tr><td style="width:90px">${d.data.split('-').reverse().slice(0, 2).join('/')}</td>
          <td><div class="barra" style="width:${(d.faturamento / maxDia) * 100}%"></div></td>
          <td class="num" style="width:110px">${moeda(d.faturamento)}</td><td class="num meta" style="width:70px">${d.pedidos} ped.</td></tr>`).join('')
          || '<tr><td class="vazio">Sem vendas no período</td></tr>'}
      </tbody></table></div>
      <div class="cartao"><h2>Por forma de pagamento</h2><table><tbody>
        ${vendas.por_forma_pagamento.map((f) => `<tr><td>${esc(f.forma_pagamento)}</td><td class="num">${moeda(f.valor)}</td></tr>`).join('')}
      </tbody></table><h2 style="margin-top:16px">Por canal</h2><table><tbody>
        ${vendas.por_canal.map((c) => `<tr><td>${esc(c.canal)}</td><td class="num">${c.pedidos}</td><td class="num">${moeda(c.faturamento)}</td></tr>`).join('')}
      </tbody></table>
      ${vendas.por_unidade.length > 1 ? `<h2 style="margin-top:16px">Por unidade</h2><table><tbody>
        ${vendas.por_unidade.map((u) => `<tr><td>${esc(u.unidade)}</td><td class="num">${moeda(u.faturamento)}</td></tr>`).join('')}</tbody></table>` : ''}
      </div>
    </div>
    <div class="duas-colunas">
      <div class="cartao"><h2>Produtos mais vendidos</h2><table>
        <thead><tr><th>Produto</th><th>Categoria</th><th class="num">Qtd.</th><th class="num">Faturamento</th></tr></thead><tbody>
        ${vendas.por_produto.map((p) => `<tr><td>${esc(p.produto)}</td><td>${esc(p.categoria)}</td><td class="num">${p.quantidade}</td><td class="num">${moeda(p.faturamento)}</td></tr>`).join('')}
      </tbody></table></div>
      <div class="cartao"><h2>Fluxo de caixa</h2><table><tbody>
        <tr><td>Saldo inicial</td><td class="num">${moeda(caixa.resumo.saldo_inicial)}</td></tr>
        <tr><td>Entradas</td><td class="num">${moeda(caixa.resumo.entradas)}</td></tr>
        <tr><td>Saídas</td><td class="num">−${moeda(caixa.resumo.saidas)}</td></tr>
        <tr><td><strong>Saldo final</strong></td><td class="num"><strong>${moeda(caixa.resumo.saldo_final)}</strong></td></tr>
      </tbody></table>
      <h2 style="margin-top:16px">Por categoria</h2><table><tbody>
        ${caixa.por_categoria.map((c) => `<tr><td>${c.tipo === 'ENTRADA' ? '＋' : '−'} ${esc(c.categoria)}</td><td class="num">${moeda(c.valor)}</td></tr>`).join('')}
      </tbody></table></div>
    </div>
    <div class="cartao"><h2>Movimentação e cobertura de estoque</h2><table>
      <thead><tr>${estado.perfil.unidade_id ? '' : '<th>Unidade</th>'}<th>Item</th><th class="num">Entradas</th><th class="num">Consumo (vendas)</th><th class="num">Perdas</th><th class="num">Disponível</th><th class="num">Cobertura</th><th>Situação</th></tr></thead><tbody>
      ${estoque.itens.map((i) => `<tr class="${i.situacao === 'REPOR' ? 'alerta' : ''}">${estado.perfil.unidade_id ? '' : `<td>${esc(i.unidade)}</td>`}
        <td>${esc(i.item)}</td><td class="num">${num(i.entradas)}</td><td class="num">${num(i.consumo_vendas)}</td><td class="num">${num(i.perdas)}</td>
        <td class="num">${num(i.disponivel)} ${esc(i.unidade_medida)}</td><td class="num">${i.dias_de_cobertura ?? '—'}${i.dias_de_cobertura != null ? ' dias' : ''}</td>
        <td>${i.situacao === 'REPOR' ? '<strong style="color:var(--vermelho)">Repor</strong>' : 'OK'}</td></tr>`).join('')}
    </tbody></table></div>`;

  const form = document.getElementById('form-periodo');
  form.onsubmit = tentar(async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(form));
    await telaRelatorios(f.inicio, f.fim);
  });
  form.onclick = tentar(async (e) => {
    const b = e.target.closest('[data-csv]');
    if (!b) return;
    const resp = await api(`/api/relatorios/${b.dataset.csv}?${q}&formato=csv`, { bruto: true });
    baixar(await resp.blob(), `${b.dataset.csv}_${inicio}_${fim}.csv`);
  });
}

async function telaClientes(busca = '') {
  $app.onclick = null;
  const { dados } = await api(`/api/clientes?limite=50${busca ? `&busca=${encodeURIComponent(busca)}` : ''}`);
  $app.innerHTML = `
    <h1>Clientes</h1>
    <div class="duas-colunas">
      <div class="cartao">
        <form class="linha" id="form-busca" style="margin-bottom:12px"><label style="flex:1">Buscar <input name="busca" value="${esc(busca)}" placeholder="nome, e-mail ou telefone"></label><button class="btn">Buscar</button></form>
        <table><thead><tr><th>Nome</th><th>Contato</th><th>Marketing</th></tr></thead><tbody>
        ${dados.map((c) => `<tr data-cliente="${c.id}" style="cursor:pointer"><td>${esc(c.nome)}</td><td>${esc(c.email ?? '')} ${esc(c.telefone ?? '')}</td><td>${c.consentimento_marketing ? 'Sim' : 'Não'}</td></tr>`).join('')
          || '<tr><td colspan="3" class="vazio">Nenhum cliente encontrado</td></tr>'}
        </tbody></table>
      </div>
      <div id="detalhe-cliente">
        ${pode('clientes.gerenciar') ? `<div class="cartao"><h2>Cadastrar cliente</h2>
          <form class="form" id="form-cliente">
            <label>Nome <input name="nome" required minlength="2"></label>
            <label>Telefone <input name="telefone"></label>
            <label>E-mail <input name="email" type="email"></label>
            <label>Preferências <input name="pref" placeholder="ex.: sem cebola, tapioca bem torrada"></label>
            <label class="check"><input type="checkbox" name="termos" required> Cliente consentiu com o tratamento dos dados</label>
            <label class="check"><input type="checkbox" name="marketing"> Aceita receber promoções</label>
            <button class="btn">Cadastrar</button>
          </form></div>` : ''}
      </div>
    </div>`;
  const fb = document.getElementById('form-busca');
  fb.onsubmit = tentar(async (e) => {
    e.preventDefault();
    await telaClientes(new FormData(fb).get('busca'));
  });
  const fc = document.getElementById('form-cliente');
  if (fc) {
    fc.onsubmit = tentar(async (e) => {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(fc));
      await api('/api/clientes', { method: 'POST', body: {
        nome: f.nome, telefone: f.telefone || undefined, email: f.email || undefined,
        preferencias: f.pref ? { observacoes: f.pref } : undefined, consentimento_termos: !!f.termos, consentimento_marketing: !!f.marketing,
      } });
      avisar('Cliente cadastrado', 'ok');
      await telaClientes();
    });
  }
  $app.querySelector('tbody').onclick = tentar(async (e) => {
    const tr = e.target.closest('[data-cliente]');
    if (!tr) return;
    const c = await api(`/api/clientes/${tr.dataset.cliente}`);
    document.getElementById('detalhe-cliente').innerHTML = `<div class="cartao">
      <h2>${esc(c.nome)}</h2>
      <p class="meta">${esc(c.email ?? '')} ${esc(c.telefone ?? '')} · cliente desde ${dataHora(c.criado_em)}</p>
      <p><strong>${c.resumo.total_pedidos}</strong> pedidos · <strong>${moeda(c.resumo.total_gasto)}</strong> gastos</p>
      <p><strong>Favoritos:</strong> ${c.resumo.produtos_favoritos.map((f) => `${esc(f.nome)} (${f.quantidade})`).join(', ') || '—'}</p>
      <p><strong>Preferências:</strong> ${Object.entries(c.preferencias).map(([k, v]) => `${esc(k)}: ${esc(v)}`).join('; ') || '—'}</p>
      <p class="meta">🔒 Consulta registrada na trilha de auditoria (LGPD).</p></div>`;
  });
}

async function telaAcompanhamento(codigo) {
  $abas.innerHTML = '';
  $sessao.innerHTML = '';
  const desenhar = async () => {
    try {
      const p = await api(`/api/acompanhamento/${codigo}`);
      $app.innerHTML = `<div class="login cartao">
        <h1>Pedido #${p.id} ${etiqueta(p.status)}</h1>
        <p class="meta">${esc(p.unidade)} · ${esc(p.canal)} · ${moeda(p.total)}</p>
        <ul>${p.itens.map((i) => `<li>${i.quantidade}× ${esc(i.produto)}</li>`).join('')}</ul>
        <h2>Andamento</h2>
        <ul class="linha-tempo">${p.etapas.map((e) => `<li>${etiqueta(e.status)} <span class="meta">${dataHora(e.criado_em)}</span></li>`).join('')}</ul>
        <p class="meta">Atualiza automaticamente. Dúvidas: ${esc(p.telefone_unidade ?? '')}</p></div>`;
      return !['ENTREGUE', 'CANCELADO'].includes(p.status);
    } catch (e) {
      $app.innerHTML = `<div class="login cartao vazio">${esc(e.message)}</div>`;
      return false;
    }
  };
  if (await desenhar()) {
    const t = setInterval(async () => { if (!(await desenhar())) clearInterval(t); }, 5000);
  }
}

window.addEventListener('hashchange', () => location.reload());
tentar(iniciar)();
