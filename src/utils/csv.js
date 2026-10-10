export function paraCsv(linhas) {
  if (!linhas.length) return '';
  const colunas = Object.keys(linhas[0]);
  const escapar = (v) => {
    if (v === null || v === undefined) return '';
    let s = typeof v === 'number' ? String(v).replace('.', ',') : String(v);
    if (/^[=+\-@]/.test(s)) s = `'${s}`;
    return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [colunas.join(';'), ...linhas.map((l) => colunas.map((c) => escapar(l[c])).join(';'))].join('\n');
}

export function responderRelatorio(req, res, nomeArquivo, dados, linhasCsv) {
  if (req.query.formato === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${nomeArquivo}.csv"`);
    return res.send('﻿' + paraCsv(linhasCsv));
  }
  return res.json(dados);
}
