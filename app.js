'use strict';
/* Ventas · FG Agro — ventas por pedido, compras, stock a precio medio, tarifa, deudas y comisiones.
   Todo se guarda en el propio móvil (IndexedDB) y funciona sin conexión. */

const APP_VERSION = '1.2.0';
const CATEGORIAS = ['Fertilizantes', 'Fitosanitarios', 'Herbicidas', 'Bioestimulantes']; // las de Stock fincas (no se tocan)

/* ---------- Utilidades ---------- */
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nf = (n, min = 2, max = 2) => Number(n).toLocaleString('es-ES', { minimumFractionDigits: min, maximumFractionDigits: max, useGrouping: 'always' });
const eur = (n) => nf(n) + ' €';
const eur0 = (n) => nf(n, 0, 0) + ' €';
const qf = (n) => nf(n, 0, 2);
const pctf = (p) => nf(p * 100, 0, 1) + ' %';
const round = (n, d) => { const k = 10 ** d; return Math.round((n + Number.EPSILON * Math.sign(n)) * k) / k; };
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2, 10));
const byName = (a, b) => a.nombre.localeCompare(b.nombre, 'es');
const EPS = 0.005;

function parseNum(s) {
  s = String(s ?? '').trim().replace(/\s/g, '').replace(/[€%]/g, '');
  if (!s) return NaN;
  const c = s.lastIndexOf(','), d = s.lastIndexOf('.');
  if (c > -1 && d > -1) s = c > d ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  else if (c > -1) s = s.replace(',', '.');
  return /^-?(\d+\.?\d*|\.\d+)$/.test(s) ? parseFloat(s) : NaN;
}
const fmtIn = (n, d = 4) => (n === '' || n == null || !isFinite(n) ? '' : String(round(n, d)).replace('.', ','));

function todayISO() { const d = new Date(); return new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); }
const thisYear = () => Number(todayISO().slice(0, 4));
const fmtDate = (iso) => iso.slice(8, 10) + '/' + iso.slice(5, 7) + '/' + iso.slice(0, 4);
const yearOf = (iso) => Number(iso.slice(0, 4));
const monthOf = (iso) => iso.slice(0, 7);
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const MES_C = ['E', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D'];
function monthLabel(ym) { const [y, m] = ym.split('-').map(Number); const s = MESES[m - 1] + ' ' + y; return s.charAt(0).toUpperCase() + s.slice(1); }

/* ---------- Almacenamiento (IndexedDB) ---------- */
let dbp;
function idb() {
  if (!dbp) dbp = new Promise((res, rej) => {
    const r = indexedDB.open('ventas-fgagro', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbp;
}
async function dbGet(k) {
  const db = await idb();
  return new Promise((res, rej) => { const q = db.transaction('kv').objectStore('kv').get(k); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
}
async function dbSet(k, v) {
  const db = await idb();
  return new Promise((res, rej) => { const t = db.transaction('kv', 'readwrite'); t.objectStore('kv').put(v, k); t.oncomplete = () => res(); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error); });
}

/* ---------- Estado ---------- */
let state;
let saveChain = Promise.resolve();
function persist() {
  saveChain = saveChain.then(() => dbSet('state', state)).catch((e) => toast('No se pudo guardar en el móvil: ' + (e && e.message || e), true));
  markDirty();
  return saveChain;
}

/* La app no lleva datos dentro (el repositorio es público). En un móvil nuevo empieza vacía
   y se restaura desde la hoja de Google o desde un fichero de copia. */
function emptyState() {
  return { v: 2, settings: { margenPropio: 0.05, lastBackup: null }, proveedores: [], productos: [], clientes: [], compras: [], pedidos: [], cobros: [], comisiones: [], mxPend: [] };
}
/* v1 → v2: enlace con los maestros (mid en clientes y productos, cola de altas). No cambia ningún dato existente. */
function migrar(s) {
  if (!Array.isArray(s.mxPend)) s.mxPend = [];
  if (!s.v || s.v < 2) s.v = 2;
  return s;
}
const appVacia = () => !state.pedidos.length && !state.compras.length && !state.productos.length;

const prodById = (id, st = state) => st.productos.find((p) => p.id === id);
const cliById = (id, st = state) => st.clientes.find((c) => c.id === id);
const provById = (id, st = state) => st.proveedores.find((p) => p.id === id);
const prodName = (id, st = state) => prodById(id, st)?.nombre ?? '(producto borrado)';
const cliName = (id, st = state) => cliById(id, st)?.nombre ?? '(cliente borrado)';
const provName = (id, st = state) => provById(id, st)?.nombre ?? '';
const lineImp = (l) => round(l.cant * l.precio, 2);
const lineName = (l, st = state) => (l.prod ? prodName(l.prod, st) : l.txt);
function pedidoImp(p) { return p.lineas.reduce((t, l) => t + lineImp(l), 0); }

/* ---------- Cálculos derivados (se recalculan solo cuando cambia el estado) ---------- */
const memo = new WeakMap();
function D(st = state) {
  let d = memo.get(st);
  if (d) return d;
  const stock = new Map();
  const get = (id) => { let s = stock.get(id); if (!s) { s = { qty: 0, valor: 0, last: 0, lastF: '' }; stock.set(id, s); } return s; };
  for (const c of st.compras) {
    const s = get(c.prod); s.qty += c.cant; s.valor += c.cant * c.precio;
    if (c.cant > 0 && c.fecha >= s.lastF) { s.last = c.precio; s.lastF = c.fecha; }
  }
  const tot = new Map();
  for (const p of st.pedidos) {
    let imp = 0, coste = 0;
    for (const l of p.lineas) {
      imp += lineImp(l); coste += l.cant * l.coste;
      if (l.prod) { const s = get(l.prod); s.qty -= l.cant; s.valor -= l.cant * l.coste; }
    }
    tot.set(p.id, { imp: round(imp, 2), coste: round(coste, 4), ben: round(imp - coste, 4) });
  }
  for (const s of stock.values()) {
    s.qty = round(s.qty, 6); s.valor = round(s.valor, 6);
    s.avg = s.qty > 1e-9 ? s.valor / s.qty : s.last;
    if (Math.abs(s.qty) < 1e-9) s.valor = 0;
  }
  const pag = new Map();
  for (const c of st.cobros) for (const [pid, v] of Object.entries(c.aplic)) pag.set(pid, (pag.get(pid) || 0) + v);
  d = { stock, tot, pag };
  memo.set(st, d);
  return d;
}
const stockOf = (prod, st = state) => D(st).stock.get(prod) || { qty: 0, valor: 0, avg: 0, last: 0 };
const totOf = (p, st = state) => D(st).tot.get(p.id) || { imp: 0, coste: 0, ben: 0 };
const pagadoOf = (p, st = state) => round(D(st).pag.get(p.id) || 0, 2);
const pendOf = (p, st = state) => round(Math.max(0, totOf(p, st).imp - pagadoOf(p, st)), 2);
function estadoOf(p, st = state) {
  const t = totOf(p, st), pg = pagadoOf(p, st);
  if (t.imp - pg <= EPS) return 'cob';
  return pg > EPS ? 'par' : 'pen';
}
const ESTADO = { cob: ['cob', 'Cobrado'], par: ['par', 'Parcial'], pen: ['pen', 'Pendiente'] };
const cobroImp = (c) => round(Object.values(c.aplic).reduce((t, v) => t + v, 0), 2);

/* Stock de un producto sin contar un pedido concreto (para editarlo). */
function stockSin(prod, pedido, st = state) {
  const s = { ...stockOf(prod, st) };
  if (pedido) for (const l of pedido.lineas) if (l.prod === prod) { s.qty += l.cant; s.valor += l.cant * l.coste; }
  s.qty = round(s.qty, 6);
  s.avg = s.qty > 1e-9 ? s.valor / s.qty : stockOf(prod, st).last;
  return s;
}
const margenPropio = () => state.settings.margenPropio ?? 0.05;
function precioPropuesto(prod, cli, pedido) {
  const p = prodById(prod); const c = cliById(cli);
  if (!p) return '';
  if (c && c.propio) return round(stockSin(prod, pedido).avg * (1 + margenPropio()), 2);
  return round(p.tarifa || 0, 4);
}

/* Pedidos pendientes de un cliente, del más antiguo al más reciente (orden de saldado). */
function pendientesCli(cli, st = state) {
  return st.pedidos.filter((p) => p.cli === cli && pendOf(p, st) > EPS).sort((a, b) => a.fecha.localeCompare(b.fecha) || a.ts - b.ts);
}
function fifo(cli, importe, st = state) {
  const aplic = {}; let resto = round(importe, 2);
  for (const p of pendientesCli(cli, st)) {
    if (resto <= EPS) break;
    const v = round(Math.min(resto, pendOf(p, st)), 2);
    aplic[p.id] = v; resto = round(resto - v, 2);
  }
  return { aplic, resto };
}
function deudaCli(cli, st = state) { return round(pendientesCli(cli, st).reduce((t, p) => t + pendOf(p, st), 0), 2); }

/* Ajusta los cobros tras cualquier cambio: quita lo aplicado a pedidos borrados y lo que exceda
   el importe de un pedido (empezando por el cobro más reciente). Devuelve lo que se haya quitado. */
function normalizeCobros(c) {
  const ped = new Map(c.pedidos.map((p) => [p.id, p]));
  let quitado = 0;
  const orden = [...c.cobros].sort((a, b) => b.fecha.localeCompare(a.fecha) || b.ts - a.ts);
  const usado = new Map();
  // Primero se respeta lo más antiguo: se recorre de antiguo a reciente y se recorta el exceso.
  const sobra = new Map();
  for (const cb of [...orden].reverse()) {
    for (const pid of Object.keys(cb.aplic)) {
      const p = ped.get(pid);
      if (!p || p.cli !== cb.cli) { quitado += cb.aplic[pid]; delete cb.aplic[pid]; continue; }
      const imp = round(pedidoImp(p), 2);
      const ya = usado.get(pid) || 0;
      const v = round(Math.min(cb.aplic[pid], Math.max(0, imp - ya)), 2);
      if (v < cb.aplic[pid] - 1e-9) {
        // El pedido ha bajado de importe: lo cobrado de más pasa a las demás deudas del cliente (si es un cobro hecho en la app).
        if (cb.hist) quitado += cb.aplic[pid] - v; else sobra.set(cb, round((sobra.get(cb) || 0) + cb.aplic[pid] - v, 2));
      }
      if (v <= 0) delete cb.aplic[pid]; else { cb.aplic[pid] = v; usado.set(pid, ya + v); }
    }
  }
  for (const [cb, extra] of sobra) {
    let resto = extra;
    const pend = c.pedidos.filter((p) => p.cli === cb.cli).sort((a, b) => a.fecha.localeCompare(b.fecha) || a.ts - b.ts);
    for (const p of pend) {
      if (resto <= EPS) break;
      const libre = round(pedidoImp(p) - (usado.get(p.id) || 0), 2);
      if (libre <= EPS) continue;
      const v = round(Math.min(libre, resto), 2);
      cb.aplic[p.id] = round((cb.aplic[p.id] || 0) + v, 2); usado.set(p.id, (usado.get(p.id) || 0) + v); resto = round(resto - v, 2);
    }
    quitado += resto;
  }
  c.cobros = c.cobros.filter((cb) => Object.keys(cb.aplic).length);
  return round(quitado, 2);
}

function validate(st) {
  const d = D(st);
  for (const [id, s] of d.stock) if (s.qty < -1e-6) return `El stock de «${prodName(id, st)}» quedaría en ${qf(s.qty)}. No se puede vender ni retirar más de lo que hay.`;
  for (const p of st.productos) if (!p.nombre) return 'Hay un producto sin nombre';
  for (const c of st.clientes) if (!c.nombre) return 'Hay un cliente sin nombre';
  return null;
}
let lastTrim = 0;
function commit(mutator) {
  const c = structuredClone(state);
  try { mutator(c); } catch (e) { toast(e.message, true); return false; }
  lastTrim = normalizeCobros(c);
  const err = validate(c);
  if (err) { toast(err, true); return false; }
  state = c; persist(); renderAll();
  return true;
}

/* ---------- Agregados ---------- */
function years() {
  const ys = new Set([thisYear()]);
  state.pedidos.forEach((p) => ys.add(yearOf(p.fecha)));
  state.compras.forEach((p) => ys.add(yearOf(p.fecha)));
  state.comisiones.forEach((p) => ys.add(yearOf(p.fecha)));
  return [...ys].sort((a, b) => b - a);
}
const comImp = (m) => round(m.modo === 'fijo' ? m.fijo : m.cant * m.precio * m.pct, 2);
function resumenAnio(y) {
  const r = { y, imp: 0, coste: 0, ben: 0, cli: { imp: 0, ben: 0 }, own: { imp: 0, ben: 0 }, n: 0, mes: Array.from({ length: 12 }, () => ({ imp: 0, ben: 0, compras: 0, salidas: 0 })), prods: new Map(), clis: new Map() };
  for (const p of state.pedidos) {
    if (yearOf(p.fecha) !== y) continue;
    const t = totOf(p); const own = !!cliById(p.cli)?.propio; const m = r.mes[Number(p.fecha.slice(5, 7)) - 1];
    r.n++; r.imp += t.imp; r.coste += t.coste; r.ben += t.ben;
    const g = own ? r.own : r.cli; g.imp += t.imp; g.ben += t.ben;
    m.imp += t.imp; m.ben += t.ben; m.salidas += t.coste;
    for (const l of p.lineas) {
      if (!l.prod) continue;
      const x = r.prods.get(l.prod) || { imp: 0, uds: 0, ben: 0 };
      x.imp += lineImp(l); x.uds += l.cant; x.ben += lineImp(l) - l.cant * l.coste; r.prods.set(l.prod, x);
    }
    const c = r.clis.get(p.cli) || { imp: 0, ben: 0 }; c.imp += t.imp; c.ben += t.ben; r.clis.set(p.cli, c);
  }
  for (const c of state.compras) if (yearOf(c.fecha) === y) r.mes[Number(c.fecha.slice(5, 7)) - 1].compras += c.cant * c.precio;
  const coms = state.comisiones.filter((m) => yearOf(m.fecha) === y);
  r.com = coms.reduce((t, m) => t + comImp(m), 0);
  r.comCob = coms.filter((m) => m.cobrado).reduce((t, m) => t + comImp(m), 0);
  r.margen = r.imp > 0 ? r.ben / r.imp : 0;
  r.cli.margen = r.cli.imp > 0 ? r.cli.ben / r.cli.imp : 0;
  r.own.margen = r.own.imp > 0 ? r.own.ben / r.own.imp : 0;
  return r;
}
function valorStock() { let v = 0, n = 0; for (const s of D().stock.values()) { if (s.qty > 1e-9) { v += s.valor; n++; } } return { v, n }; }
function deudas() {
  const m = new Map();
  for (const p of state.pedidos) { const pe = pendOf(p); if (pe > EPS) m.set(p.cli, round((m.get(p.cli) || 0) + pe, 2)); }
  const xs = [...m].map(([cli, imp]) => ({ cli, imp, own: !!cliById(cli)?.propio, peds: pendientesCli(cli) }));
  xs.sort((a, b) => b.imp - a.imp);
  const cli = xs.filter((x) => !x.own), own = xs.filter((x) => x.own);
  return { cli, own, totCli: round(cli.reduce((t, x) => t + x.imp, 0), 2), totOwn: round(own.reduce((t, x) => t + x.imp, 0), 2) };
}

/* ---------- UI general ---------- */
const ui = { tab: 'inicio', dashY: thisYear(), rank: 'imp', rankWho: 'prod', ventY: thisYear(), ventCli: '', ventQ: '', compY: thisYear(), compQ: '', stockSeg: 'stock', stockQ: '', stockTipo: '', stockAll: false, comY: thisYear() };
let toastTimer;
function toast(msg, err = false) {
  const t = $('#toast'); t.textContent = msg; t.className = 'show' + (err ? ' err' : '');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.className = ''; }, err ? 4500 : 2200);
}
const sheetRoot = $('#sheetRoot');
let sheetOpen = false;
function openSheet(title, bodyHTML) {
  if (!sheetOpen) history.pushState({ sheet: true }, '');
  sheetOpen = true;
  sheetRoot.innerHTML = `<div class="scrim"></div><section class="sheet" role="dialog" aria-modal="true" aria-label="${esc(title)}"><header><h2>${esc(title)}</h2><button class="x" aria-label="Cerrar">✕</button></header><div class="sheet-body">${bodyHTML}</div></section>`;
  $('.scrim', sheetRoot).onclick = closeSheet;
  $('.x', sheetRoot).onclick = closeSheet;
  return $('.sheet-body', sheetRoot);
}
function closeSheet() {
  if (!sheetOpen) return;
  sheetOpen = false; sheetRoot.innerHTML = '';
  if (history.state && history.state.sheet) history.back();
}
const reopen = (fn) => { closeSheet(); setTimeout(fn, 40); };
window.addEventListener('popstate', () => { if (sheetOpen) { sheetOpen = false; sheetRoot.innerHTML = ''; } });
function armDelete(btn, action, label = 'Borrar') {
  let armed = false, timer;
  btn.onclick = () => {
    if (!armed) { armed = true; btn.classList.add('armed'); btn.textContent = 'Pulsa otra vez para confirmar'; timer = setTimeout(() => { armed = false; btn.classList.remove('armed'); btn.textContent = label; }, 3500); }
    else { clearTimeout(timer); action(); }
  };
}
const field = (id, label, value, { mode = 'decimal', ph = '', type = 'text' } = {}) =>
  `<label class="fld"><span>${label}</span><input id="${id}" type="${type}" ${type === 'text' ? `inputmode="${mode}"` : ''} value="${esc(value)}" placeholder="${esc(ph)}" autocomplete="off"></label>`;
const yearChips = (sel, id, withAll = false) => `<div class="chips" id="${id}">${withAll ? `<button class="chip" data-y="0" aria-pressed="${sel === 0}">Todos</button>` : ''}${years().map((y) => `<button class="chip" data-y="${y}" aria-pressed="${sel === y}">${y}</button>`).join('')}</div>`;
const bindYears = (id, key, render) => { const el = $('#' + id); if (el) el.onclick = (e) => { const b = e.target.closest('[data-y]'); if (b) { ui[key] = Number(b.dataset.y); render ? render() : renderAll(); } }; };
const tipos = () => [...new Set(state.productos.map((p) => p.tipo).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'es'));

/* ---------- Gráficas (SVG, barras agrupadas, un solo eje) ---------- */
function niceStep(v) { if (v <= 0) return 1; const e = 10 ** Math.floor(Math.log10(v)); const f = v / e; return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * e; }
function niceMax(v) { const st = niceStep(v / 4); return Math.max(st, Math.ceil(v / st) * st); }
const kfmt = (v) => (v >= 1000 ? nf(v / 1000, 0, 1) + ' k' : nf(v, 0, 0));
function barChart(id, series, labels) {
  const W = 340, H = 170, L = 34, R = 4, T = 8, B = 20;
  const max = niceMax(Math.max(0, ...series.flatMap((s) => s.values)));
  const n = labels.length, gw = (W - L - R) / n, bw = Math.max(3, Math.min(10, (gw - 6) / series.length - 2));
  const y = (v) => T + (H - T - B) * (1 - Math.max(0, v) / max);
  let g = '<g class="grid">';
  const step = niceStep(max / 4) >= max / 4 - 1e-9 && max / niceStep(max / 4) <= 5 ? max / Math.round(max / niceStep(max / 4)) : max / 4;
  for (let v = 0; v <= max + 1e-9; v += step) { g += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text class="ax" x="${L - 4}" y="${y(v) + 3}" text-anchor="end">${kfmt(v)}</text>`; }
  g += '</g>';
  let bars = '', hits = '';
  labels.forEach((lb, i) => {
    const x0 = L + gw * i, inner = series.length * bw + (series.length - 1) * 2, xs = x0 + (gw - inner) / 2;
    series.forEach((s, j) => {
      const v = s.values[i]; if (v <= 0) return;
      const x = xs + j * (bw + 2), top = y(v), h = Math.max(1, y(0) - top), r = Math.min(4, bw / 2, h);
      bars += `<path fill="${s.color}" d="M${x},${y(0)} V${top + r} Q${x},${top} ${x + r},${top} H${x + bw - r} Q${x + bw},${top} ${x + bw},${top + r} V${y(0)} Z"/>`;
    });
    bars += `<text class="ax" x="${x0 + gw / 2}" y="${H - 6}" text-anchor="middle">${lb}</text>`;
    hits += `<rect class="hit" data-i="${i}" x="${x0}" y="${T}" width="${gw}" height="${H - T - B}" rx="4"/>`;
  });
  return `<div class="legend">${series.map((s) => `<span><i style="background:${s.color}"></i>${s.name}</span>`).join('')}</div>
    <div class="chart" id="${id}"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(series.map((s) => s.name).join(' y '))} por mes">${g}${hits}${bars}</svg></div>`;
}
function bindChart(id, series, full) {
  const el = $('#' + id); if (!el) return;
  const show = (i) => {
    el.querySelectorAll('.hit').forEach((h) => h.classList.toggle('on', Number(h.dataset.i) === i));
    let tip = $('.tip', el); if (!tip) { tip = document.createElement('div'); tip.className = 'tip'; el.appendChild(tip); }
    tip.innerHTML = `<b>${full[i]}</b>${series.map((s) => `<div><i style="background:${s.color}"></i>${s.name}: ${eur(s.values[i])}</div>`).join('')}`;
    const hit = el.querySelector(`.hit[data-i="${i}"]`); const box = el.getBoundingClientRect(), hb = hit.getBoundingClientRect();
    const cx = hb.left - box.left + hb.width / 2; tip.style.left = Math.min(box.width - 80, Math.max(80, cx)) + 'px'; tip.style.top = '-6px';
  };
  const hide = () => { const t = $('.tip', el); if (t) t.remove(); el.querySelectorAll('.hit').forEach((h) => h.classList.remove('on')); };
  el.addEventListener('pointerover', (e) => { const h = e.target.closest('.hit'); if (h) show(Number(h.dataset.i)); });
  el.addEventListener('click', (e) => { const h = e.target.closest('.hit'); if (h) show(Number(h.dataset.i)); });
  el.addEventListener('pointerleave', hide);
}
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

/* ---------- Pestaña: Inicio (dashboard) ---------- */
function headInicio() {
  const r = resumenAnio(ui.dashY);
  return `<div class="kpis">
    <div class="k hero"><span>Ventas ${r.y}</span><strong>${eur0(r.imp)}</strong></div>
    <div class="k"><span>Beneficio</span><strong>${eur0(r.ben)}</strong></div>
    <div class="k"><span>Margen</span><strong>${pctf(r.margen)}</strong></div>
    <div class="k sub3">
      <div><span>Solo clientes</span><b>${eur0(r.cli.imp)}</b></div>
      <div><span>Benef. clientes</span><b>${eur0(r.cli.ben)}</b></div>
      <div><span>Margen clientes</span><b>${pctf(r.cli.margen)}</b></div>
    </div>
  </div>`;
}
function renderInicio() {
  const r = resumenAnio(ui.dashY), vs = valorStock(), dd = deudas();
  const s1 = css('--s1'), s2 = css('--s2');
  const ser1 = [{ name: 'Ventas', color: s1, values: r.mes.map((m) => round(m.imp, 2)) }, { name: 'Beneficio', color: s2, values: r.mes.map((m) => round(m.ben, 2)) }];
  const ser2 = [{ name: 'Compras', color: s1, values: r.mes.map((m) => round(m.compras, 2)) }, { name: 'Salidas a coste', color: s2, values: r.mes.map((m) => round(m.salidas, 2)) }];
  const full = MESES.map((m) => m.charAt(0).toUpperCase() + m.slice(1) + ' ' + r.y);
  const src = ui.rankWho === 'prod' ? [...r.prods].map(([id, x]) => ({ name: prodName(id), ...x })) : [...r.clis].map(([id, x]) => ({ name: cliName(id) + (cliById(id)?.propio ? ' (tus fincas)' : ''), uds: 0, ...x }));
  const key = ui.rankWho === 'cli' ? 'imp' : ui.rank;
  const top = src.sort((a, b) => b[key] - a[key]).slice(0, 8), maxv = top.length ? top[0][key] : 1;
  $('#view').innerHTML = `
    ${appVacia() ? `<div class="card"><h3>Este móvil todavía no tiene datos</h3><p class="small" style="margin-top:0">La app ya no lleva el histórico dentro. Restáuralo una vez desde Ajustes: «Copia automática en Google Sheets» → «Restaurar desde la hoja», o «Restaurar desde fichero» con la copia guardada en Drive (Apps › Copia de seguridad).</p><div class="actions"><button class="btn primary" id="goAj">Abrir Ajustes</button></div></div>` : ''}
    ${yearChips(ui.dashY, 'dY')}
    <div class="tiles">
      <div class="tile"><span>Tus fincas</span><strong>${eur0(r.own.imp)}</strong><small>benef. ${eur0(r.own.ben)} · ${pctf(r.own.margen)}</small></div>
      <div class="tile"><span>Valor del stock</span><strong>${eur0(vs.v)}</strong><small>${vs.n} productos</small></div>
      <div class="tile"><span>Comisiones ${r.y}</span><strong>${eur0(r.com)}</strong><small>cobradas ${eur0(r.comCob)}</small></div>
      <div class="tile"><span>Beneficio + comisiones</span><strong>${eur0(r.ben + r.com)}</strong><small>${r.n} pedidos</small></div>
      <button class="tile wide" id="goDeudas" style="border:0;text-align:left"><span>Sin cobrar (clientes)</span><strong class="${dd.totCli > 0 ? 'neg' : ''}">${eur(dd.totCli)}</strong></button>
    </div>
    <div class="card"><h3>Ventas y beneficio por mes <small>${r.y}</small></h3>${barChart('ch1', ser1, MES_C)}</div>
    <div class="card"><h3>Compras y salidas de stock <small>a coste</small></h3>${barChart('ch2', ser2, MES_C)}</div>
    <div class="card">
      <h3>${ui.rankWho === 'prod' ? 'Productos más vendidos' : 'Mejores clientes'} <small>${r.y}</small></h3>
      <div class="seg small" id="rkWho"><button data-v="prod" aria-pressed="${ui.rankWho === 'prod'}">Productos</button><button data-v="cli" aria-pressed="${ui.rankWho === 'cli'}">Clientes</button></div>
      ${ui.rankWho === 'prod' ? `<div class="seg small" id="rkBy"><button data-v="imp" aria-pressed="${ui.rank === 'imp'}">Por importe</button><button data-v="uds" aria-pressed="${ui.rank === 'uds'}">Por unidades</button></div>` : ''}
      ${top.length ? `<ol class="rank">${top.map((x) => `<li><span class="rn">${esc(x.name)}</span><span class="rv">${key === 'uds' ? qf(x.uds) + ' uds' : eur0(x.imp)}</span><span class="rb"><i style="width:${Math.max(2, (x[key] / maxv) * 100).toFixed(1)}%"></i></span></li>`).join('')}</ol>` : '<div class="empty">Sin ventas este año</div>'}
    </div>`;
  bindYears('dY', 'dashY');
  bindChart('ch1', ser1, full); bindChart('ch2', ser2, full);
  $('#rkWho').onclick = (e) => { const b = e.target.closest('[data-v]'); if (b) { ui.rankWho = b.dataset.v; renderInicio(); } };
  const rb = $('#rkBy'); if (rb) rb.onclick = (e) => { const b = e.target.closest('[data-v]'); if (b) { ui.rank = b.dataset.v; renderInicio(); } };
  $('#goDeudas').onclick = () => { ui.tab = 'deudas'; window.scrollTo(0, 0); renderAll(); };
  const ga = $('#goAj'); if (ga) ga.onclick = openSettings;
}

/* ---------- Pestaña: Ventas ---------- */
function ventasFiltradas() {
  const q = ui.ventQ.trim().toLowerCase();
  return state.pedidos.filter((p) => (!ui.ventY || yearOf(p.fecha) === ui.ventY) && (!ui.ventCli || p.cli === ui.ventCli) && (!q || p.lineas.some((l) => lineName(l).toLowerCase().includes(q)) || cliName(p.cli).toLowerCase().includes(q)))
    .sort((a, b) => b.fecha.localeCompare(a.fecha) || b.ts - a.ts);
}
function headVentas() {
  const ps = ventasFiltradas();
  const imp = ps.reduce((t, p) => t + totOf(p).imp, 0), ben = ps.reduce((t, p) => t + totOf(p).ben, 0);
  return `<div class="kpis">
    <div class="k"><span>Ventas ${ui.ventY || 'todas'}${ui.ventCli || ui.ventQ ? ' (filtro)' : ''}</span><strong>${eur0(imp)}</strong></div>
    <div class="k"><span>Beneficio</span><strong>${eur0(ben)} <small>${imp > 0 ? pctf(ben / imp) : ''}</small></strong></div>
  </div>`;
}
function renderVentas() {
  const ps = ventasFiltradas();
  const clis = [...state.clientes].sort(byName);
  let html = '', lastM = '';
  for (const p of ps) {
    const mm = monthOf(p.fecha);
    if (mm !== lastM) {
      const ms = ps.filter((o) => monthOf(o.fecha) === mm);
      html += `<li class="day" style="display:flex;justify-content:space-between;gap:8px;text-transform:none"><span>${monthLabel(mm)}</span><span>${eur0(ms.reduce((t, o) => t + totOf(o).imp, 0))} · benef. ${eur0(ms.reduce((t, o) => t + totOf(o).ben, 0))}</span></li>`;
      lastM = mm;
    }
    const t = totOf(p), es = ESTADO[estadoOf(p)], own = cliById(p.cli)?.propio;
    html += `<li><button class="row" data-id="${p.id}" style="display:block">
      <div style="display:flex;justify-content:space-between;gap:12px">
        <div class="main"><div class="name">${esc(cliName(p.cli))}</div><div class="sub"><span class="pill ${es[0]}">${es[1]}</span>${own ? '<span class="pill own">Tus fincas</span>' : ''}${fmtDate(p.fecha)}</div></div>
        <div class="side"><div class="big">${eur(t.imp)}</div><div class="sub">benef. ${eur(t.ben)}</div></div>
      </div>
      <div class="plines">${p.lineas.slice(0, 4).map((l) => `<div><span>${esc(lineName(l))}</span><span>${l.prod ? qf(l.cant) + ' × ' + nf(l.precio, 2, 4) : ''}</span></div>`).join('')}${p.lineas.length > 4 ? `<div><span>y ${p.lineas.length - 4} más…</span><span></span></div>` : ''}</div>
    </button></li>`;
  }
  $('#view').innerHTML = `
    ${yearChips(ui.ventY, 'vY', true)}
    <div class="toolbar">
      <select id="vCli" class="grow" aria-label="Cliente"><option value="">Todos los clientes</option>${clis.map((c) => `<option value="${c.id}" ${ui.ventCli === c.id ? 'selected' : ''}>${esc(c.nombre)}</option>`).join('')}</select>
      <input id="vQ" class="grow" type="search" placeholder="Buscar producto" value="${esc(ui.ventQ)}">
    </div>
    <div class="summary"><span><b>${ps.length}</b> pedidos</span></div>
    ${ps.length ? `<ul class="list" id="vList">${html}</ul>` : '<div class="empty">No hay ventas con este filtro.<br>Pulsa «Nueva venta».</div>'}`;
  bindYears('vY', 'ventY');
  $('#vCli').onchange = (e) => { ui.ventCli = e.target.value; renderAll(); };
  let qt; $('#vQ').oninput = (e) => { clearTimeout(qt); qt = setTimeout(() => { ui.ventQ = e.target.value; renderAll(); const i = $('#vQ'); i.focus(); i.setSelectionRange(i.value.length, i.value.length); }, 350); };
  const ul = $('#vList'); if (ul) ul.onclick = (e) => { const b = e.target.closest('[data-id]'); if (b) openPedido(state.pedidos.find((p) => p.id === b.dataset.id)); };
}

/* Formulario de pedido (varias líneas por cliente y fecha) */
function openPedido(orig, preCli) {
  const isNew = !orig;
  let n = 0; const nk = () => 'n' + Date.now().toString(36) + (n++);
  const f = orig
    ? { fecha: orig.fecha, cli: orig.cli, nota: orig.nota || '', cobrado: false, lineas: orig.lineas.map((l) => ({ k: l.k, prod: l.prod, txt: l.txt || '', cant: fmtIn(l.cant, 3), precio: fmtIn(l.precio), auto: false, concepto: !l.prod })) }
    : { fecha: todayISO(), cli: preCli || '', nota: '', cobrado: false, lineas: [] };
  if (isNew) f.lineas.push({ k: nk(), prod: '', txt: '', cant: '', precio: '', auto: true, concepto: false });
  const newCli = { on: false, nombre: '', propio: false };
  const prods = state.productos.filter((p) => p.activo || f.lineas.some((l) => l.prod === p.id)).sort(byName);
  const body = openSheet(isNew ? 'Nueva venta' : 'Editar venta', '<div id="pf"></div>');
  const box = $('#pf', body);
  const isOwn = () => !newCli.on && !!cliById(f.cli)?.propio || (newCli.on && newCli.propio);
  const disp = (prod) => stockSin(prod, orig);
  const usado = (prod, exceptK) => f.lineas.filter((l) => l.prod === prod && l.k !== exceptK).reduce((t, l) => t + (parseNum(l.cant) || 0), 0);
  const costeLinea = (l) => { const o = orig && orig.lineas.find((x) => x.k === l.k && x.prod === l.prod); return o ? o.coste : disp(l.prod).avg; };
  const propuesto = (prod) => { if (newCli.on && newCli.propio) return round(disp(prod).avg * (1 + margenPropio()), 2); return precioPropuesto(prod, newCli.on ? '' : f.cli, orig); };

  const lineHTML = (l) => {
    if (l.concepto) return `<div class="line" data-k="${l.k}">
      <div class="lt"><input type="text" data-f="txt" value="${esc(l.txt)}" placeholder="Concepto (portes, abono, rappel…)" autocomplete="off"><button type="button" class="lx" data-x="${l.k}" aria-label="Quitar">✕</button></div>
      <div class="g3"><span class="lh">No mueve stock</span><label><span>Importe €</span><input type="text" inputmode="decimal" data-f="precio" value="${esc(l.precio)}" placeholder="0"></label><div class="imp" data-imp></div></div></div>`;
    const opts = prods.map((p) => {
      const s = disp(p.id); const left = round(s.qty - usado(p.id, l.k), 3);
      const off = left <= 1e-9 && p.id !== l.prod;
      return `<option value="${p.id}" ${l.prod === p.id ? 'selected' : ''} ${off ? 'disabled' : ''}>${esc(p.nombre)} · ${off ? 'sin stock' : qf(Math.max(0, s.qty))}</option>`;
    }).join('');
    return `<div class="line" data-k="${l.k}">
      <div class="lt"><select data-f="prod" aria-label="Producto"><option value="">Elige producto…</option>${opts}</select><button type="button" class="lx" data-x="${l.k}" aria-label="Quitar">✕</button></div>
      <div class="g3">
        <label><span>Cantidad</span><input type="text" inputmode="decimal" data-f="cant" value="${esc(l.cant)}" placeholder="0"></label>
        <label><span>Precio €</span><input type="text" inputmode="decimal" data-f="precio" value="${esc(l.precio)}" placeholder="0"></label>
        <div class="imp" data-imp></div>
      </div>
      <div class="lh" data-h></div></div>`;
  };
  const draw = () => {
    const cliOpts = cliOptions(newCli.on ? '' : f.cli);
    const t = orig ? { pg: pagadoOf(orig), es: ESTADO[estadoOf(orig)] } : null;
    box.innerHTML = `
      ${orig ? `<div class="box"><div><span>Estado</span><b><span class="pill ${t.es[0]}">${t.es[1]}</span></b></div>${t.pg > EPS ? `<div><span>Cobrado</span><b>${eur(t.pg)}</b></div><div><span>Pendiente</span><b>${eur(pendOf(orig))}</b></div>` : ''}</div>` : ''}
      <div class="grid2">
        <label class="fld"><span>Fecha</span><input id="pF" type="date" value="${f.fecha}"></label>
        <label class="fld"><span>Cliente</span><select id="pC"><option value="">Elige cliente…</option>${cliOpts}<option value="__new" ${newCli.on ? 'selected' : ''}>+ Cliente nuevo…</option></select></label>
      </div>
      ${newCli.on ? `<div class="grid2" style="align-items:end"><label class="fld"><span>Nombre del cliente nuevo</span><input id="pCN" type="text" value="${esc(newCli.nombre)}" autocomplete="off"></label>
        <button type="button" class="switch" id="pCP" role="switch" aria-checked="${newCli.propio}"><span>Finca propia</span><i></i></button></div>` : ''}
      ${isOwn() ? `<p class="hint">Finca propia: el precio propuesto es el precio medio + ${pctf(margenPropio())}. Entra sola en Gestión fincas y entonces se marca como pasada.</p>` : ''}
      <div class="lines" id="pL">${f.lineas.map(lineHTML).join('')}</div>
      <div class="addrow"><button type="button" class="btn" id="pAdd">+ Producto</button><button type="button" class="btn" id="pAddC">+ Otro concepto</button></div>
      <div class="box" id="pTot"></div>
      <label class="fld"><span>Nota</span><input id="pN" type="text" value="${esc(f.nota)}" autocomplete="off"></label>
      ${isNew ? `<button type="button" class="switch" id="pCob" role="switch" aria-checked="${f.cobrado}"><span>Cobrado en el momento</span><i></i></button>` : ''}
      <p class="hint">Precios sin IVA. El coste de cada línea se fija con el precio medio al guardar y no cambia aunque luego cambien las compras.</p>
      <div class="actions"><button class="btn primary" id="pSave">Guardar venta</button></div>
      ${orig ? `<div class="sep"></div><div class="actions two">
        <button class="btn" id="pCobT">${estadoOf(orig) === 'cob' ? 'Quitar cobro' : 'Marcar cobrado'}</button>
        <button class="btn danger" id="pDel">Borrar venta</button></div>
        ${t.pg > EPS ? '<p class="hint" style="margin-top:10px">Si bajas su importe, lo cobrado de más se aplica a sus otras deudas. Si la borras, se descuenta del cobro registrado.</p>' : ''}` : ''}`;
    $('#pF', box).onchange = (e) => { f.fecha = e.target.value; };
    $('#pC', box).onchange = (e) => {
      if (e.target.value === '__new') { newCli.on = true; } else { newCli.on = false; f.cli = e.target.value; }
      f.lineas.forEach((l) => { if (l.auto && l.prod) l.precio = fmtIn(propuesto(l.prod)); });
      draw();
    };
    const cn = $('#pCN', box); if (cn) { cn.oninput = (e) => { newCli.nombre = e.target.value; }; if (!newCli.nombre) setTimeout(() => cn.focus(), 30); }
    const cp = $('#pCP', box); if (cp) cp.onclick = () => { newCli.propio = !newCli.propio; f.lineas.forEach((l) => { if (l.auto && l.prod) l.precio = fmtIn(propuesto(l.prod)); }); draw(); };
    $('#pN', box).oninput = (e) => { f.nota = e.target.value; };
    const pc = $('#pCob', box); if (pc) pc.onclick = () => { f.cobrado = !f.cobrado; pc.setAttribute('aria-checked', f.cobrado); };
    $('#pAdd', box).onclick = () => { f.lineas.push({ k: nk(), prod: '', txt: '', cant: '', precio: '', auto: true, concepto: false }); draw(); };
    $('#pAddC', box).onclick = () => { f.lineas.push({ k: nk(), prod: null, txt: '', cant: '1', precio: '', auto: false, concepto: true }); draw(); };
    const L = $('#pL', box);
    L.onclick = (e) => { const x = e.target.closest('[data-x]'); if (x) { f.lineas = f.lineas.filter((l) => l.k !== x.dataset.x); draw(); } };
    L.onchange = (e) => {
      const el = e.target.closest('[data-f="prod"]'); if (!el) return;
      const l = f.lineas.find((o) => o.k === el.closest('[data-k]').dataset.k);
      l.prod = el.value; l.auto = true; l.precio = l.prod ? fmtIn(propuesto(l.prod)) : '';
      draw();
      const ci = box.querySelector(`[data-k="${l.k}"] [data-f="cant"]`); if (ci && !l.cant) ci.focus();
    };
    L.oninput = (e) => {
      const el = e.target.closest('[data-f]'); if (!el || el.dataset.f === 'prod') return;
      const l = f.lineas.find((o) => o.k === el.closest('[data-k]').dataset.k);
      l[el.dataset.f] = el.value; if (el.dataset.f === 'precio') l.auto = false;
      calc();
    };
    $('#pSave', box).onclick = save;
    if (orig) {
      $('#pCobT', box).onclick = () => toggleCobrado(orig.id, () => reopen(() => openPedido(state.pedidos.find((p) => p.id === orig.id))));
      armDelete($('#pDel', box), () => { if (commit((c) => { c.pedidos = c.pedidos.filter((p) => p.id !== orig.id); })) { closeSheet(); toast('Venta borrada' + (lastTrim > 0 ? ` · se quitaron ${eur(lastTrim)} de cobros` : '')); } }, 'Borrar venta');
    }
    calc();
  };
  const calc = () => {
    let imp = 0, coste = 0;
    for (const l of f.lineas) {
      const el = box.querySelector(`[data-k="${l.k}"]`); if (!el) continue;
      const q = l.concepto ? 1 : parseNum(l.cant), p = parseNum(l.precio);
      const li = isFinite(q) && isFinite(p) ? round(q * p, 2) : null;
      $('[data-imp]', el).textContent = li == null ? '—' : eur(li);
      if (li != null) imp += li;
      if (l.concepto || !l.prod) { const h = $('[data-h]', el); if (h) h.textContent = ''; continue; }
      const s = disp(l.prod), left = round(s.qty - usado(l.prod, l.k), 3), cu = costeLinea(l);
      if (isFinite(q)) coste += q * cu;
      const h = $('[data-h]', el);
      const over = isFinite(q) && q > left + 1e-9;
      h.className = 'lh' + (over ? ' warn' : '');
      h.textContent = over ? `Solo hay ${qf(Math.max(0, left))} en stock` : `Stock ${qf(Math.max(0, left))} · coste ${nf(cu, 2, 4)} €${isFinite(p) && p > 0 ? ' · margen ' + pctf((p - cu) / p) : ''}`;
    }
    const ben = imp - coste;
    $('#pTot', box).innerHTML = `<div><span>Importe</span><b>${eur(imp)}</b></div><div><span>Coste</span><b>${eur(coste)}</b></div><div class="tot"><span>Beneficio</span><b class="${ben < 0 ? 'neg' : ''}">${eur(ben)}${imp > 0 ? ' · ' + pctf(ben / imp) : ''}</b></div>`;
  };
  const save = () => {
    if (!f.fecha) return toast('Indica la fecha', true);
    let cliId = f.cli, nuevo = null, alta = null;
    if (newCli.on) {
      const nombre = newCli.nombre.trim(); if (!nombre) return toast('Escribe el nombre del cliente nuevo', true);
      const r = clienteParaNombre(nombre, newCli.propio);
      if (r.id) cliId = r.id; else { nuevo = r.nuevo; alta = r.alta || null; cliId = nuevo.id; }
    }
    if (!cliId) return toast('Elige el cliente', true);
    const ls = f.lineas.filter((l) => l.concepto ? (l.txt.trim() || l.precio.trim()) : (l.prod || l.cant.trim()));
    if (!ls.length) return toast('Añade al menos un producto', true);
    const lineas = [];
    for (const l of ls) {
      const p = parseNum(l.precio);
      if (l.concepto) {
        if (!l.txt.trim()) return toast('Escribe el concepto', true);
        if (!isFinite(p) || p === 0) return toast(`Escribe el importe de «${l.txt.trim()}»`, true);
        lineas.push({ k: l.k, prod: null, txt: l.txt.trim(), cant: 1, precio: round(p, 4), coste: 0 });
        continue;
      }
      if (!l.prod) return toast('Elige el producto de cada línea', true);
      const q = parseNum(l.cant);
      if (!(q > 0)) return toast(`Escribe la cantidad de «${prodName(l.prod)}»`, true);
      if (!(p >= 0)) return toast(`Escribe el precio de «${prodName(l.prod)}»`, true);
      lineas.push({ k: l.k, prod: l.prod, txt: '', cant: round(q, 4), precio: round(p, 4), coste: round(costeLinea(l), 6) });
    }
    for (const prod of new Set(lineas.filter((l) => l.prod).map((l) => l.prod))) {
      const tot = lineas.filter((l) => l.prod === prod).reduce((t, l) => t + l.cant, 0), s = disp(prod);
      if (tot > s.qty + 1e-9) return toast(`No hay stock suficiente de «${prodName(prod)}»: hay ${qf(Math.max(0, s.qty))} y quieres vender ${qf(tot)}. Anota antes la compra.`, true);
    }
    const id = orig ? orig.id : 'o' + uid().slice(0, 8);
    const ok = commit((c) => {
      if (nuevo) { c.clientes.push(nuevo); if (alta) pedirAlta(c, 'cliente', nuevo.id, alta); }
      const data = { fecha: f.fecha, cli: cliId, nota: f.nota.trim(), lineas };
      if (orig) {
        const p = c.pedidos.find((x) => x.id === id);
        if (p.cli !== cliId) c.cobros.forEach((cb) => { delete cb.aplic[id]; });
        Object.assign(p, data);
      } else c.pedidos.push({ id, ts: Date.now(), ...data });
      if (!orig && f.cobrado) {
        const imp = round(lineas.reduce((t, l) => t + lineImp(l), 0), 2);
        if (imp > 0) c.cobros.push({ id: uid(), ts: Date.now(), fecha: f.fecha, cli: cliId, aplic: { [id]: imp }, nota: 'Cobrado al vender', hist: false });
      }
    });
    if (ok) { closeSheet(); toast((orig ? 'Venta actualizada' : 'Venta guardada') + (lastTrim > 0 ? ` · se quitaron ${eur(lastTrim)} de cobros` : '') + (nuevo && nuevo.mid ? ' · cliente del maestro' : '')); if (alta) refreshMx({}); }
  };
  draw();
  if (isNew && !preCli) setTimeout(() => $('#pC', box)?.focus(), 60);
}
function toggleCobrado(pid, after) {
  const p = state.pedidos.find((x) => x.id === pid);
  if (estadoOf(p) === 'cob') {
    if (commit((c) => { c.cobros.forEach((cb) => { delete cb.aplic[pid]; }); })) { toast('Cobro quitado: vuelve a estar pendiente'); after && after(); }
  } else {
    const pe = pendOf(p);
    if (commit((c) => { c.cobros.push({ id: uid(), ts: Date.now(), fecha: todayISO(), cli: p.cli, aplic: { [pid]: pe }, nota: 'Pedido del ' + fmtDate(p.fecha), hist: false }); })) { toast('Marcado como cobrado · ' + eur(pe)); after && after(); }
  }
}

/* ---------- Pestaña: Compras ---------- */
function comprasFiltradas() {
  const q = ui.compQ.trim().toLowerCase();
  return state.compras.filter((c) => (!ui.compY || yearOf(c.fecha) === ui.compY) && (!q || prodName(c.prod).toLowerCase().includes(q) || provName(c.prov).toLowerCase().includes(q)))
    .sort((a, b) => b.fecha.localeCompare(a.fecha) || b.ts - a.ts);
}
function headCompras() {
  const cs = comprasFiltradas(); const vs = valorStock();
  return `<div class="kpis">
    <div class="k"><span>Compras ${ui.compY || 'todas'}</span><strong>${eur0(cs.reduce((t, c) => t + c.cant * c.precio, 0))}</strong></div>
    <div class="k"><span>Valor del stock</span><strong>${eur0(vs.v)}</strong></div>
  </div>`;
}
function renderCompras() {
  const cs = comprasFiltradas();
  let html = '', lastM = '';
  for (const c of cs) {
    const mm = monthOf(c.fecha);
    if (mm !== lastM) { html += `<li class="day" style="display:flex;justify-content:space-between;gap:8px;text-transform:none"><span>${monthLabel(mm)}</span><span>${eur0(cs.filter((o) => monthOf(o.fecha) === mm).reduce((t, o) => t + o.cant * o.precio, 0))}</span></li>`; lastM = mm; }
    html += `<li><button class="row" data-id="${c.id}">
      <div class="main"><div class="name">${esc(prodName(c.prod))}</div><div class="sub">${fmtDate(c.fecha)} · ${esc(provName(c.prov) || 'sin proveedor')}${c.cant < 0 ? ' · <span class="pill par">Ajuste</span>' : ''}${c.nota ? ' · ' + esc(c.nota) : ''}</div></div>
      <div class="side"><div class="big">${eur(c.cant * c.precio)}</div><div class="sub">${qf(c.cant)} × ${nf(c.precio, 2, 4)} €</div></div>
    </button></li>`;
  }
  $('#view').innerHTML = `
    ${yearChips(ui.compY, 'cY', true)}
    <input id="cQ" class="search" type="search" placeholder="Buscar producto o proveedor" value="${esc(ui.compQ)}">
    <div class="summary"><span><b>${cs.length}</b> compras</span></div>
    ${cs.length ? `<ul class="list" id="cList">${html}</ul>` : '<div class="empty">No hay compras con este filtro.<br>Pulsa «Nueva compra».</div>'}`;
  bindYears('cY', 'compY');
  let qt; $('#cQ').oninput = (e) => { clearTimeout(qt); qt = setTimeout(() => { ui.compQ = e.target.value; renderAll(); const i = $('#cQ'); i.focus(); i.setSelectionRange(i.value.length, i.value.length); }, 350); };
  const ul = $('#cList'); if (ul) ul.onclick = (e) => { const b = e.target.closest('[data-id]'); if (b) openCompra(state.compras.find((c) => c.id === b.dataset.id)); };
}
function openCompra(orig, preProd) {
  const isNew = !orig;
  const f = orig ? { fecha: orig.fecha, prod: orig.prod, prov: orig.prov || '', cant: fmtIn(orig.cant, 3), precio: fmtIn(orig.precio), nota: orig.nota || '' }
    : { fecha: todayISO(), prod: preProd || '', prov: preProd ? prodById(preProd).prov || '' : '', cant: '', precio: preProd ? fmtIn(stockOf(preProd).last) : '', nota: '' };
  const np = { on: false, ...npInit() };
  const nv = { on: false, nombre: '' };
  const body = openSheet(isNew ? 'Nueva compra' : 'Editar compra', '<div id="cf"></div>');
  const box = $('#cf', body);
  const draw = () => {
    const prods = state.productos.filter((p) => p.activo || p.id === f.prod).sort(byName);
    const provs = [...state.proveedores].sort(byName);
    box.innerHTML = `
      <label class="fld"><span>Fecha</span><input id="kF" type="date" value="${f.fecha}"></label>
      <label class="fld"><span>Producto</span><select id="kP"><option value="">Elige producto…</option>${prods.map((p) => `<option value="${p.id}" ${!np.on && f.prod === p.id ? 'selected' : ''}>${esc(p.nombre)}</option>`).join('')}<option value="__new" ${np.on ? 'selected' : ''}>+ Producto nuevo…</option></select></label>
      ${np.on ? npHTML(np) : ''}
      <label class="fld"><span>Proveedor</span><select id="kV"><option value="">Sin proveedor</option>${provs.map((p) => `<option value="${p.id}" ${!nv.on && f.prov === p.id ? 'selected' : ''}>${esc(p.nombre)}</option>`).join('')}<option value="__new" ${nv.on ? 'selected' : ''}>+ Proveedor nuevo…</option></select></label>
      ${nv.on ? `<label class="fld"><span>Nombre del proveedor nuevo</span><input id="kVN" type="text" value="${esc(nv.nombre)}" autocomplete="off"></label>` : ''}
      <div class="grid2">${field('kC', 'Cantidad', f.cant, { ph: '0' })}${field('kR', 'Precio unidad €', f.precio, { ph: '0' })}</div>
      <p class="hint">Para corregir el inventario usa una cantidad negativa (por ejemplo −2 si se ha roto algo).</p>
      <div class="box" id="kBox"></div>
      <label class="fld"><span>Nota</span><input id="kN" type="text" value="${esc(f.nota)}" autocomplete="off"></label>
      <div class="actions ${isNew ? '' : 'two'}">${isNew ? '' : '<button class="btn danger" id="kDel">Borrar</button>'}<button class="btn primary" id="kSave">Guardar</button></div>`;
    $('#kF', box).onchange = (e) => { f.fecha = e.target.value; };
    $('#kP', box).onchange = (e) => {
      if (e.target.value === '__new') { Object.assign(np, npInit(), { on: true }); f.prod = ''; }
      else { np.on = false; f.prod = e.target.value; const p = prodById(f.prod); if (p && isNew) { if (p.prov) { f.prov = p.prov; nv.on = false; } if (!f.precio) f.precio = fmtIn(stockOf(p.id).last); } }
      draw();
    };
    if (np.on) npBind(box, np, draw, (mp) => { if (mp && mp.proveedor && !nv.on) { const v = state.proveedores.find((x) => MX.norm(x.nombre) === MX.norm(mp.proveedor)); if (v) f.prov = v.id; } });
    $('#kV', box).onchange = (e) => { if (e.target.value === '__new') nv.on = true; else { nv.on = false; f.prov = e.target.value; } draw(); };
    if (nv.on) $('#kVN', box).oninput = (e) => { nv.nombre = e.target.value; };
    $('#kC', box).oninput = (e) => { f.cant = e.target.value; prev(); };
    $('#kR', box).oninput = (e) => { f.precio = e.target.value; prev(); };
    $('#kN', box).oninput = (e) => { f.nota = e.target.value; };
    $('#kSave', box).onclick = save;
    if (!isNew) armDelete($('#kDel', box), () => { if (commit((c) => { c.compras = c.compras.filter((x) => x.id !== orig.id); })) { closeSheet(); toast('Compra borrada'); } });
    prev();
  };
  const prev = () => {
    const q = parseNum(f.cant), p = parseNum(f.precio), el = $('#kBox', box);
    if (!f.prod || np.on) { el.innerHTML = `<div><span>Importe</span><b>${isFinite(q) && isFinite(p) ? eur(q * p) : '—'}</b></div>`; return; }
    const s0 = stockOf(f.prod);
    const base = orig && orig.prod === f.prod ? { qty: s0.qty - orig.cant, valor: s0.valor - orig.cant * orig.precio } : { qty: s0.qty, valor: s0.valor };
    let after = '—', avg = '—';
    if (isFinite(q) && isFinite(p)) { const nq = base.qty + q, nv2 = base.valor + q * p; after = qf(nq); avg = nq > 1e-9 ? nf(nv2 / nq, 2, 4) + ' €' : '—'; }
    el.innerHTML = `<div><span>Importe</span><b>${isFinite(q) && isFinite(p) ? eur(q * p) : '—'}</b></div><div><span>Stock</span><b>${qf(base.qty)} → ${after}</b></div><div><span>Precio medio</span><b>${base.qty > 1e-9 ? nf(base.valor / base.qty, 2, 4) + ' €' : '—'} → ${avg}</b></div>`;
  };
  const save = () => {
    if (!f.fecha) return toast('Indica la fecha', true);
    let newProd = null, newProv = null, prodId = f.prod, provId = f.prov || null;
    if (nv.on) {
      const nombre = nv.nombre.trim(); if (!nombre) return toast('Escribe el nombre del proveedor', true);
      const ex = state.proveedores.find((p) => p.nombre.toLowerCase() === nombre.toLowerCase());
      if (ex) provId = ex.id; else { newProv = { id: 'v' + uid().slice(0, 8), nombre }; provId = newProv.id; }
    }
    let alta = null, aviso = '';
    if (np.on) {
      try { const r = npBuild(np, provId); newProd = r.prod; alta = r.alta; aviso = r.aviso || ''; } catch (e) { return toast(e.message, true); }
      prodId = newProd.id;
    }
    if (!prodId) return toast('Elige el producto', true);
    const q = parseNum(f.cant), p = parseNum(f.precio);
    if (!isFinite(q) || q === 0) return toast('Escribe la cantidad', true);
    if (!(p >= 0)) return toast('Escribe el precio', true);
    const data = { fecha: f.fecha, prod: prodId, prov: provId, cant: round(q, 4), precio: round(p, 6), nota: f.nota.trim() };
    const ok = commit((c) => {
      if (newProv) c.proveedores.push(newProv);
      if (newProd) { c.productos.push(newProd); if (alta) pedirAlta(c, 'producto', newProd.id, alta); }
      if (isNew) c.compras.push({ id: 'k' + uid().slice(0, 8), ts: Date.now(), ...data });
      else Object.assign(c.compras.find((x) => x.id === orig.id), data);
    });
    if (ok) { closeSheet(); toast((isNew ? 'Compra guardada' : 'Compra actualizada') + (aviso ? ' · ' + aviso : '')); if (alta) refreshMx({}); }
  };
  draw();
}

/* ---------- Pestaña: Stock y tarifa ---------- */
function headStock() {
  const vs = valorStock();
  const conT = state.productos.filter((p) => p.activo && p.tarifa > 0 && stockOf(p.id).qty > 1e-9);
  const tv = conT.reduce((t, p) => t + stockOf(p.id).qty * p.tarifa, 0), cv = conT.reduce((t, p) => t + stockOf(p.id).valor, 0);
  return `<div class="kpis">
    <div class="k hero"><span>Valor del stock (a coste)</span><strong>${eur0(vs.v)}</strong></div>
    <div class="k"><span>Productos con stock</span><strong>${vs.n}</strong></div>
    <div class="k"><span>Margen a tarifa</span><strong>${tv > 0 ? pctf((tv - cv) / tv) : '—'}</strong></div>
  </div>`;
}
function renderStock() {
  const q = ui.stockQ.trim().toLowerCase();
  const ps = state.productos.filter((p) => (!q || p.nombre.toLowerCase().includes(q) || provName(p.prov).toLowerCase().includes(q)) && (!ui.stockTipo || p.tipo === ui.stockTipo))
    .filter((p) => ui.stockAll || (p.activo && (ui.stockSeg === 'tarifa' || stockOf(p.id).qty > 1e-9)))
    .sort(byName);
  const rows = ps.map((p) => {
    const s = stockOf(p.id);
    if (ui.stockSeg === 'stock') return `<li><button class="row ${p.activo ? '' : 'dim'}" data-id="${p.id}">
      <div class="main"><div class="name">${esc(p.nombre)}</div><div class="sub">${esc(p.tipo || 'Sin tipo')} · ${esc(provName(p.prov) || '—')}</div></div>
      <div class="side"><div class="big">${qf(s.qty)}</div><div class="sub">${s.qty > 1e-9 ? nf(s.avg, 2, 4) + ' € · ' + eur0(s.valor) : 'sin stock'}</div></div></button></li>`;
    const m = p.tarifa > 0 && s.avg > 0 ? (p.tarifa - s.avg) / p.tarifa : null;
    return `<li class="mrow ${p.activo ? '' : 'dim'}"><button class="info" data-id="${p.id}"><div class="name">${esc(p.nombre)}</div><div class="sub">Medio ${s.avg > 0 ? nf(s.avg, 2, 4) + ' €' : '—'}${m != null ? ` · margen <b class="${m < 0 ? 'neg' : ''}">${pctf(m)}</b>` : ''}</div></button>
      <input class="tarifa-in" type="text" inputmode="decimal" data-t="${p.id}" value="${fmtIn(p.tarifa)}" aria-label="Tarifa de ${esc(p.nombre)}"></li>`;
  }).join('');
  $('#view').innerHTML = `
    <div class="seg" id="sSeg"><button data-v="stock" aria-pressed="${ui.stockSeg === 'stock'}">Stock</button><button data-v="tarifa" aria-pressed="${ui.stockSeg === 'tarifa'}">Tarifa</button></div>
    <input id="sQ" class="search" type="search" placeholder="Buscar producto o proveedor" value="${esc(ui.stockQ)}">
    <div class="chips" id="sTipo"><button class="chip" data-t="" aria-pressed="${!ui.stockTipo}">Todos</button>${tipos().map((t) => `<button class="chip" data-t="${esc(t)}" aria-pressed="${ui.stockTipo === t}">${esc(t)}</button>`).join('')}</div>
    ${ui.stockSeg === 'tarifa' ? '<p class="hint" style="margin:4px 2px 10px">La tarifa es el precio normal de venta: aparece propuesto en cada venta y puedes cambiarlo allí. Escribe el nuevo precio y sal de la casilla para guardarlo.</p>' : ''}
    <div class="summary"><span><b>${ps.length}</b> productos</span><label style="display:flex;gap:6px;align-items:center"><input type="checkbox" id="sAll" ${ui.stockAll ? 'checked' : ''}> ${ui.stockSeg === 'stock' ? 'ver también sin stock y desactivados' : 'ver desactivados'}</label></div>
    ${ps.length ? `<ul class="list" id="sList">${rows}</ul>` : '<div class="empty">No hay productos con este filtro.</div>'}`;
  $('#sSeg').onclick = (e) => { const b = e.target.closest('[data-v]'); if (b) { ui.stockSeg = b.dataset.v; renderAll(); } };
  $('#sTipo').onclick = (e) => { const b = e.target.closest('[data-t]'); if (b) { ui.stockTipo = b.dataset.t; renderStock(); } };
  $('#sAll').onchange = (e) => { ui.stockAll = e.target.checked; renderStock(); };
  let qt; $('#sQ').oninput = (e) => { clearTimeout(qt); qt = setTimeout(() => { ui.stockQ = e.target.value; renderStock(); const i = $('#sQ'); i.focus(); i.setSelectionRange(i.value.length, i.value.length); }, 300); };
  const ul = $('#sList');
  if (ul) {
    ul.onclick = (e) => { const b = e.target.closest('button[data-id]'); if (b) openProducto(b.dataset.id); };
    ul.onchange = (e) => {
      const i = e.target.closest('[data-t]'); if (!i) return;
      const v = parseNum(i.value), p = prodById(i.dataset.t);
      if (!(v >= 0)) { toast('Escribe un precio válido', true); i.value = fmtIn(p.tarifa); return; }
      if (round(v, 4) === p.tarifa) return;
      if (commit((c) => { prodById(i.dataset.t, c).tarifa = round(v, 4); })) toast(`Tarifa de ${p.nombre}: ${nf(v, 2, 4)} €`);
    };
  }
}
function openProducto(id) {
  const isNew = !id;
  const p = isNew ? { nombre: '', tipo: '', prov: '', tarifa: '', activo: true } : prodById(id);
  const s = isNew ? null : stockOf(id);
  const movs = isNew ? [] : [
    ...state.compras.filter((c) => c.prod === id).map((c) => ({ fecha: c.fecha, ts: c.ts, t: c.cant < 0 ? 'Ajuste' : 'Compra', q: c.cant, pr: c.precio, who: provName(c.prov) })),
    ...state.pedidos.flatMap((o) => o.lineas.filter((l) => l.prod === id).map((l) => ({ fecha: o.fecha, ts: o.ts, t: 'Venta', q: -l.cant, pr: l.precio, who: cliName(o.cli) }))),
  ].sort((a, b) => b.fecha.localeCompare(a.fecha) || b.ts - a.ts);
  const used = movs.length > 0;
  const vendY = isNew ? 0 : state.pedidos.filter((o) => yearOf(o.fecha) === thisYear()).flatMap((o) => o.lineas).filter((l) => l.prod === id).reduce((t, l) => t + l.cant, 0);
  const body = openSheet(isNew ? 'Producto nuevo' : p.nombre, `
    ${isNew ? '' : `<div class="box">
      <div><span>Stock</span><b>${qf(s.qty)}</b></div>
      <div><span>Precio medio</span><b>${s.qty > 1e-9 ? nf(s.avg, 2, 4) + ' €' : '—'}</b></div>
      <div><span>Valor</span><b>${eur(s.valor)}</b></div>
      <div><span>Tarifa</span><b>${nf(p.tarifa, 2, 4)} €${p.tarifa > 0 && s.avg > 0 ? ' · margen ' + pctf((p.tarifa - s.avg) / p.tarifa) : ''}</b></div>
      <div><span>Vendido en ${thisYear()}</span><b>${qf(vendY)}</b></div>
    </div>
    <div class="actions"><button class="btn primary" id="prBuy">Anotar compra de este producto</button></div>`}
    <h3>Datos del producto</h3>
    ${isNew ? '<div id="prNp"></div>' : p.mid ? `<div class="box"><div><span>Ficha del maestro</span><b>${esc(p.mid)} · ${esc(p.tipo || 'sin categoría')}</b></div>${p.pres ? `<div><span>Envase</span><b>${esc(p.pres)}</b></div>` : ''}</div>
      <p class="hint">El nombre y la categoría vienen del maestro de productos de Drive.</p>
      ${field('prR', 'Tarifa venta €', fmtIn(p.tarifa), { ph: '0' })}`
    : `<label class="fld"><span>Nombre</span><input id="prN" type="text" value="${esc(p.nombre)}" autocomplete="off"></label>
    <div class="grid2"><label class="fld"><span>Tipo</span><input id="prT" type="text" list="prTl" value="${esc(p.tipo)}" autocomplete="off"></label>${field('prR', 'Tarifa venta €', fmtIn(p.tarifa), { ph: '0' })}</div>
    <datalist id="prTl">${[...new Set([...CATEGORIAS, ...tipos()])].map((t) => `<option value="${esc(t)}">`).join('')}</datalist>
    ${IX ? `<label class="fld"><span>Enlazar con el maestro</span><select id="prMx"><option value="">Sin enlazar</option>${mxProdOptions()}</select></label>` : ''}`}
    <label class="fld"><span>Proveedor habitual</span><select id="prV"><option value="">Sin proveedor</option>${[...state.proveedores].sort(byName).map((v) => `<option value="${v.id}" ${p.prov === v.id ? 'selected' : ''}>${esc(v.nombre)}</option>`).join('')}</select></label>
    <button type="button" class="switch" id="prA" role="switch" aria-checked="${p.activo}"><span>Activo (aparece al vender y comprar)</span><i></i></button>
    <div class="actions ${isNew ? '' : 'two'}">${isNew ? '' : `<button class="btn danger" id="prDel" ${used ? 'disabled' : ''}>Borrar</button>`}<button class="btn primary" id="prSave">Guardar</button></div>
    ${used ? '<p class="hint" style="margin-top:10px">Solo se pueden borrar productos sin movimientos. Si ya no lo trabajas, desactívalo.</p>' : ''}
    ${movs.length ? `<h3>Últimos movimientos</h3><ul class="list">${movs.slice(0, 10).map((m) => `<li class="row" style="box-shadow:none"><div class="main"><div class="name">${m.t} · ${esc(m.who)}</div><div class="sub">${fmtDate(m.fecha)} · ${nf(m.pr, 2, 4)} €</div></div><div class="side"><b class="${m.q < 0 ? '' : ''}">${m.q > 0 ? '+' : ''}${qf(m.q)}</b></div></li>`).join('')}</ul>` : ''}`);
  let activo = p.activo;
  const np = npInit();
  const drawNp = () => { const b = $('#prNp', body); if (!b) return; b.innerHTML = npHTML(np); npBind(b, np, drawNp, (mp) => { const sel = $('#prV', body); if (mp && mp.proveedor && sel && !sel.value) { const v = state.proveedores.find((x) => MX.norm(x.nombre) === MX.norm(mp.proveedor)); if (v) sel.value = v.id; } }); };
  drawNp();
  $('#prA', body).onclick = (e) => { activo = !activo; e.currentTarget.setAttribute('aria-checked', activo); };
  if (!isNew) $('#prBuy', body).onclick = () => reopen(() => openCompra(null, id));
  $('#prSave', body).onclick = () => {
    const prov = $('#prV', body).value || null;
    if (isNew) {
      let r; try { r = npBuild(np, prov); } catch (e) { return toast(e.message, true); }
      r.prod.activo = activo;
      if (commit((c) => { c.productos.push(r.prod); if (r.alta) pedirAlta(c, 'producto', r.prod.id, r.alta); })) { closeSheet(); toast('Producto creado' + (r.aviso ? ' · ' + r.aviso : '')); if (r.alta) refreshMx({}); }
      return;
    }
    const tr = $('#prR', body).value.trim(); const tarifa = tr ? parseNum(tr) : 0; if (!(tarifa >= 0)) return toast('Revisa la tarifa', true);
    if (p.mid) { if (commit((c) => { Object.assign(prodById(id, c), { prov, tarifa: round(tarifa, 4), activo }); })) { closeSheet(); toast('Producto actualizado'); } return; }
    const nombre = $('#prN', body).value.trim(); if (!nombre) return toast('Escribe el nombre', true);
    if (state.productos.some((o) => o.id !== id && MX.norm(o.nombre) === MX.norm(nombre))) return toast('Ya hay un producto con ese nombre', true);
    const data = { nombre, tipo: $('#prT', body).value.trim(), prov, tarifa: round(tarifa, 4), activo };
    const lk = $('#prMx', body) ? $('#prMx', body).value : '';
    if (lk) {
      const mid = lk.slice(0, lk.indexOf('|')), pres = lk.slice(lk.indexOf('|') + 1);
      Object.assign(data, { mid, pres });
    }
    if (commit((c) => { Object.assign(prodById(id, c), data); })) { closeSheet(); toast('Producto actualizado'); if (lk) aplicarMaestros(true); }
  };
  if (!isNew && !used) armDelete($('#prDel', body), () => { if (commit((c) => { c.productos = c.productos.filter((o) => o.id !== id); })) { closeSheet(); toast('Producto borrado'); } });
}

/* ---------- Pestaña: Deudas ---------- */
function headDeudas() {
  const d = deudas();
  return `<div class="kpis">
    <div class="k hero"><span>Te deben tus clientes</span><strong>${eur(d.totCli)}</strong></div>
    <div class="k"><span>Clientes con deuda</span><strong>${d.cli.length}</strong></div>
    <div class="k"><span>Tus fincas pendiente</span><strong>${eur0(d.totOwn)}</strong></div>
  </div>`;
}
function renderDeudas() {
  const d = deudas();
  const row = (x) => `<li><button class="row debt" data-c="${x.cli}">
    <div class="main"><div class="name">${esc(cliName(x.cli))}</div><div class="sub">${x.peds.length} ${x.peds.length === 1 ? 'pedido' : 'pedidos'} · desde ${fmtDate(x.peds[0].fecha)}</div></div>
    <div class="side"><div class="big">${eur(x.imp)}</div></div></button></li>`;
  $('#view').innerHTML = `
    ${d.cli.length ? `<div class="actions two" style="margin-bottom:12px"><button class="btn small" id="dTxt">Listado en texto</button><button class="btn small" id="dPdf">Listado en PDF</button></div>` : ''}
    <h3 style="margin-top:4px">Clientes</h3>
    ${d.cli.length ? `<ul class="list" id="dList">${d.cli.map(row).join('')}</ul>` : '<div class="okline">✓ Ningún cliente te debe nada</div>'}
    <h3>Tus fincas <span class="mini">(pendiente de entrar en Gestión fincas)</span></h3>
    ${d.own.length ? `<ul class="list" id="dOwn">${d.own.map(row).join('')}</ul>` : '<div class="okline">✓ Todo pasado y marcado</div>'}
    <h3>Últimos cobros</h3>
    ${(() => { const cs = state.cobros.filter((c) => !c.hist).sort((a, b) => b.fecha.localeCompare(a.fecha) || b.ts - a.ts).slice(0, 8); return cs.length ? `<ul class="list" id="dCob">${cs.map((c) => `<li><button class="row" data-c="${c.cli}"><div class="main"><div class="name">${esc(cliName(c.cli))}</div><div class="sub">${fmtDate(c.fecha)} · ${esc(c.nota || '')}</div></div><div class="side"><b>${eur(cobroImp(c))}</b></div></button></li>`).join('')}</ul>` : '<p class="small">Aún no has registrado cobros en la app.</p>'; })()}
    <button class="btn" id="dAny" style="width:100%;margin-top:14px">Ver cuenta de otro cliente…</button>`;
  const open = (e) => { const b = e.target.closest('[data-c]'); if (b) openDeudaCli(b.dataset.c); };
  ['#dList', '#dOwn', '#dCob'].forEach((s) => { const el = $(s); if (el) el.onclick = open; });
  const t = $('#dTxt'); if (t) t.onclick = () => shareText(textoTotal(), 'Pendientes de cobro');
  const p = $('#dPdf'); if (p) p.onclick = () => pdfDeudas(d.cli.map((x) => x.cli), true);
  $('#dAny').onclick = () => {
    const body = openSheet('Cuenta de cliente', `<label class="fld"><span>Cliente</span><select id="dSel"><option value="">Elige cliente…</option>${[...state.clientes].sort(byName).map((c) => `<option value="${c.id}">${esc(c.nombre)}</option>`).join('')}</select></label>`);
    $('#dSel', body).onchange = (e) => { if (e.target.value) { const id = e.target.value; reopen(() => openDeudaCli(id)); } };
  };
}
function openDeudaCli(cid) {
  const c = cliById(cid); const peds = pendientesCli(cid); const tot = deudaCli(cid);
  const cobs = state.cobros.filter((x) => x.cli === cid).sort((a, b) => b.fecha.localeCompare(a.fecha) || b.ts - a.ts);
  const body = openSheet(c.nombre, `
    <div class="box"><div class="tot" style="border:0;margin:0;padding:0"><span>Pendiente</span><b class="${tot > 0 ? 'neg' : ''}">${eur(tot)}</b></div></div>
    ${tot > 0 ? `<div class="actions"><button class="btn primary" id="dcCob">Registrar cobro a cuenta</button></div>
    <div class="actions two" style="margin-top:8px"><button class="btn small" id="dcTxt">Enviar texto</button><button class="btn small" id="dcPdf">PDF</button></div>` : '<div class="okline">✓ No tiene nada pendiente</div>'}
    ${peds.length ? `<h3>Pedidos pendientes</h3>${peds.map((p) => { const pg = pagadoOf(p), pe = pendOf(p); return `<div class="grpbox">
      <div class="gh"><span>${fmtDate(p.fecha)} · ${eur(pe)}${pg > EPS ? ` <span class="pill par">pagado ${eur(pg)}</span>` : ''}</span><button class="btn small" style="height:34px;padding:0 12px" data-pc="${p.id}">Marcar cobrado</button></div>
      <div class="plines">${p.lineas.map((l) => `<div><span>${esc(lineName(l))}${l.prod ? ' · ' + qf(l.cant) + ' × ' + nf(l.precio, 2, 4) : ''}</span><span>${eur(lineImp(l))}</span></div>`).join('')}</div></div>`; }).join('')}` : ''}
    ${cobs.length ? `<h3>Cobros registrados</h3><ul class="list" id="dcCobs">${cobs.slice(0, 12).map((x) => `<li><button class="row" data-cb="${x.id}"><div class="main"><div class="name">${fmtDate(x.fecha)}</div><div class="sub">${esc(x.nota || '')} · ${Object.keys(x.aplic).length} ${Object.keys(x.aplic).length === 1 ? 'pedido' : 'pedidos'}</div></div><div class="side"><b>${eur(cobroImp(x))}</b></div></button></li>`).join('')}</ul><p class="hint" style="margin-top:8px">Pulsa un cobro para verlo o deshacerlo.</p>` : ''}
    <div class="actions" style="margin-top:12px"><button class="btn" id="dcNew">Nueva venta a ${esc(c.nombre)}</button></div>`);
  const again = () => reopen(() => openDeudaCli(cid));
  if (tot > 0) {
    $('#dcCob', body).onclick = () => reopen(() => openCobro(cid));
    $('#dcTxt', body).onclick = () => shareText(textoCliente(cid), 'Pendiente ' + c.nombre);
    $('#dcPdf', body).onclick = () => pdfDeudas([cid], false);
  }
  body.querySelectorAll('[data-pc]').forEach((b) => { b.onclick = () => toggleCobrado(b.dataset.pc, again); });
  const cl = $('#dcCobs', body); if (cl) cl.onclick = (e) => { const b = e.target.closest('[data-cb]'); if (b) reopen(() => openCobroVer(b.dataset.cb)); };
  $('#dcNew', body).onclick = () => reopen(() => openPedido(null, cid));
}
function openCobro(cid) {
  const c = cliById(cid), tot = deudaCli(cid);
  const body = openSheet('Cobro a cuenta', `
    <p class="small" style="margin-top:0">${esc(c.nombre)} debe <b>${eur(tot)}</b>. El cobro salda primero los pedidos más antiguos.</p>
    <div class="grid2"><label class="fld"><span>Fecha</span><input id="cbF" type="date" value="${todayISO()}"></label>${field('cbI', 'Importe cobrado €', fmtIn(tot, 2))}</div>
    <div class="quick" id="cbQ"><button type="button" class="chip" data-v="${tot}">Todo (${eur(tot)})</button></div>
    <div class="box" id="cbPrev"></div>
    <label class="fld"><span>Nota</span><input id="cbN" type="text" placeholder="Efectivo, transferencia…" autocomplete="off"></label>
    <div class="actions"><button class="btn primary" id="cbSave">Registrar cobro</button></div>`);
  const prev = () => {
    const v = parseNum($('#cbI', body).value), el = $('#cbPrev', body);
    if (!(v > 0)) { el.innerHTML = '<div><span>Escribe el importe</span><b></b></div>'; return; }
    if (v > tot + EPS) { el.innerHTML = `<div><span class="neg">Supera lo pendiente (${eur(tot)})</span><b></b></div>`; return; }
    const { aplic } = fifo(cid, v);
    el.innerHTML = Object.entries(aplic).map(([pid, x]) => { const p = state.pedidos.find((o) => o.id === pid); const full = x >= pendOf(p) - EPS; return `<div><span>Pedido ${fmtDate(p.fecha)} ${full ? '· saldado' : `· queda ${eur(pendOf(p) - x)}`}</span><b>${eur(x)}</b></div>`; }).join('') + `<div class="tot"><span>Seguirá debiendo</span><b>${eur(tot - v)}</b></div>`;
  };
  $('#cbI', body).oninput = prev;
  $('#cbQ', body).onclick = (e) => { const b = e.target.closest('[data-v]'); if (b) { $('#cbI', body).value = fmtIn(Number(b.dataset.v), 2); prev(); } };
  $('#cbSave', body).onclick = () => {
    const fecha = $('#cbF', body).value, v = parseNum($('#cbI', body).value);
    if (!fecha) return toast('Indica la fecha', true);
    if (!(v > 0)) return toast('Escribe el importe cobrado', true);
    if (v > tot + EPS) return toast(`El cobro supera lo pendiente (${eur(tot)})`, true);
    const { aplic } = fifo(cid, v);
    if (commit((st) => { st.cobros.push({ id: uid(), ts: Date.now(), fecha, cli: cid, aplic, nota: $('#cbN', body).value.trim() || 'Cobro a cuenta', hist: false }); })) { toast('Cobro registrado · ' + eur(v)); reopen(() => openDeudaCli(cid)); }
  };
  prev();
}
function openCobroVer(id) {
  const cb = state.cobros.find((x) => x.id === id); if (!cb) return;
  const body = openSheet('Cobro', `
    <div class="box"><div><span>Cliente</span><b>${esc(cliName(cb.cli))}</b></div><div><span>Fecha</span><b>${fmtDate(cb.fecha)}</b></div><div><span>Nota</span><b>${esc(cb.nota || '')}</b></div>
      ${Object.entries(cb.aplic).slice(0, 30).map(([pid, v]) => { const p = state.pedidos.find((o) => o.id === pid); return `<div><span>Pedido ${p ? fmtDate(p.fecha) : '?'}</span><b>${eur(v)}</b></div>`; }).join('')}
      ${Object.keys(cb.aplic).length > 30 ? `<div><span>y ${Object.keys(cb.aplic).length - 30} pedidos más</span><b></b></div>` : ''}
      <div class="tot"><span>Total</span><b>${eur(cobroImp(cb))}</b></div></div>
    <div class="actions"><button class="btn danger" id="cvDel">Deshacer cobro</button></div>
    <p class="hint" style="margin-top:10px">Los pedidos que saldaba vuelven a quedar pendientes.</p>`);
  armDelete($('#cvDel', body), () => { const cli = cb.cli; if (commit((c) => { c.cobros = c.cobros.filter((x) => x.id !== id); })) { toast('Cobro deshecho'); reopen(() => openDeudaCli(cli)); } }, 'Deshacer cobro');
}

/* Listados para el cliente: texto (WhatsApp) y PDF */
function textoCliente(cid) {
  const peds = pendientesCli(cid); const tot = deudaCli(cid);
  let t = `*FG Agro*\nPendiente de pago · ${cliName(cid)}\nA fecha ${fmtDate(todayISO())}\n`;
  for (const p of peds) {
    t += `\n${fmtDate(p.fecha)}\n`;
    for (const l of p.lineas) t += l.prod ? `- ${prodName(l.prod)}: ${qf(l.cant)} × ${eur(l.precio)} = ${eur(lineImp(l))}\n` : `- ${l.txt}: ${eur(lineImp(l))}\n`;
    const pg = pagadoOf(p); if (pg > EPS) t += `  Pagado a cuenta: −${eur(pg)}\n`;
  }
  t += `\n*Total pendiente: ${eur(tot)}*\nImportes sin IVA.`;
  return t;
}
function textoTotal() {
  const d = deudas();
  let t = `*FG Agro · Pendientes de cobro*\nA fecha ${fmtDate(todayISO())}\n\n`;
  d.cli.forEach((x) => { t += `- ${cliName(x.cli)}: ${eur(x.imp)}\n`; });
  t += `\n*Total: ${eur(d.totCli)}*`;
  if (d.own.length) t += `\n\nTus fincas (sin pasar): ${eur(d.totOwn)}`;
  return t;
}
async function shareText(text, title) {
  try {
    if (navigator.share) { await navigator.share({ text, title }); return; }
  } catch (e) { if (e && e.name === 'AbortError') return; }
  try { await navigator.clipboard.writeText(text); toast('Texto copiado: pégalo en WhatsApp'); }
  catch (_) { const body = openSheet(title, `<textarea style="width:100%;height:50vh;border-radius:12px;padding:10px">${esc(text)}</textarea>`); $('textarea', body).select(); }
}
let jspdfP;
function loadJsPDF() {
  if (window.jspdf) return Promise.resolve(window.jspdf.jsPDF);
  if (!jspdfP) jspdfP = new Promise((res, rej) => { const s = document.createElement('script'); s.src = 'vendor/jspdf.umd.min.js'; s.onload = () => res(window.jspdf.jsPDF); s.onerror = () => { jspdfP = null; rej(new Error('No se pudo cargar el generador de PDF')); }; document.head.appendChild(s); });
  return jspdfP;
}
async function pdfDeudas(cids, global) {
  let jsPDF; try { jsPDF = await loadJsPDF(); } catch (e) { return toast(e.message, true); }
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const W = 210, M = 16, BRAND = [52, 65, 42], ACC = [192, 138, 62], MUT = [95, 102, 85];
  let y = 0;
  const header = (sub) => {
    doc.setFillColor(...BRAND); doc.rect(0, 0, W, 26, 'F');
    doc.setTextColor(255, 255, 255); doc.setFont('helvetica', 'bold'); doc.setFontSize(18); doc.text('FG Agro', M, 15);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(10); doc.text(sub, W - M, 15, { align: 'right' });
    doc.setFillColor(...ACC); doc.rect(0, 26, W, 1.2, 'F');
    doc.setTextColor(30, 30, 30); y = 38;
  };
  const need = (h, sub) => { if (y + h > 280) { doc.addPage(); header(sub); } };
  const sub = 'Pendiente de pago · ' + fmtDate(todayISO());
  header(sub);
  const tableHead = () => {
    doc.setFontSize(9); doc.setTextColor(...MUT); doc.setFont('helvetica', 'bold');
    doc.text('Fecha', M, y); doc.text('Producto', M + 22, y); doc.text('Cant.', 128, y, { align: 'right' }); doc.text('Precio', 154, y, { align: 'right' }); doc.text('Importe', W - M, y, { align: 'right' });
    doc.setDrawColor(220, 213, 194); doc.line(M, y + 2, W - M, y + 2); y += 7; doc.setFont('helvetica', 'normal'); doc.setTextColor(30, 30, 30); doc.setFontSize(10);
  };
  if (global) {
    const d = deudas();
    doc.setFont('helvetica', 'bold'); doc.setFontSize(14); doc.text('Resumen de pendientes de cobro', M, y); y += 9;
    doc.setFontSize(10); doc.setFont('helvetica', 'normal');
    for (const x of d.cli) { need(7, sub); doc.text(cliName(x.cli), M, y); doc.text(eur(x.imp), W - M, y, { align: 'right' }); y += 6.5; }
    doc.setDrawColor(...BRAND); doc.line(M, y - 2, W - M, y - 2); doc.setFont('helvetica', 'bold'); y += 3; doc.text('Total', M, y); doc.text(eur(d.totCli), W - M, y, { align: 'right' }); y += 12;
    doc.setFont('helvetica', 'normal');
  }
  for (const cid of cids) {
    const peds = pendientesCli(cid); if (!peds.length) continue;
    need(30, sub);
    doc.setFont('helvetica', 'bold'); doc.setFontSize(14); doc.text(cliName(cid), M, y); y += 8;
    tableHead();
    for (const p of peds) {
      p.lineas.forEach((l, i) => {
        need(7, sub);
        const name = doc.splitTextToSize(lineName(l), 70)[0];
        doc.text(i === 0 ? fmtDate(p.fecha) : '', M, y); doc.text(name, M + 22, y);
        if (l.prod) { doc.text(qf(l.cant), 128, y, { align: 'right' }); doc.text(nf(l.precio, 2, 4), 154, y, { align: 'right' }); }
        doc.text(eur(lineImp(l)), W - M, y, { align: 'right' }); y += 6;
      });
      const pg = pagadoOf(p);
      if (pg > EPS) { need(7, sub); doc.setTextColor(...MUT); doc.text('Pagado a cuenta', M + 22, y); doc.text('-' + eur(pg), W - M, y, { align: 'right' }); doc.setTextColor(30, 30, 30); y += 6; }
      y += 1.5;
    }
    need(14, sub);
    doc.setDrawColor(...BRAND); doc.line(M, y - 2, W - M, y - 2); y += 4;
    doc.setFont('helvetica', 'bold'); doc.setFontSize(12); doc.text('Total pendiente', M, y); doc.text(eur(deudaCli(cid)), W - M, y, { align: 'right' }); y += 6;
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(...MUT); doc.text('Importes sin IVA.', M, y); doc.setTextColor(30, 30, 30); y += 12;
  }
  const name = (global ? 'Pendientes_cobro' : 'Pendiente_' + cliName(cids[0]).replace(/[^\wñÑáéíóúÁÉÍÓÚ]+/g, '_')) + '_' + todayISO() + '.pdf';
  const blob = doc.output('blob');
  const file = new File([blob], name, { type: 'application/pdf' });
  try {
    if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: name }); return; }
  } catch (e) { if (e && e.name === 'AbortError') return; }
  const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 3000);
  toast('PDF descargado');
}

/* ---------- Pestaña: Comisiones ---------- */
function headComisiones() {
  const ms = state.comisiones.filter((m) => yearOf(m.fecha) === ui.comY);
  const tot = ms.reduce((t, m) => t + comImp(m), 0), cob = ms.filter((m) => m.cobrado).reduce((t, m) => t + comImp(m), 0);
  const pend = state.comisiones.filter((m) => !m.cobrado).reduce((t, m) => t + comImp(m), 0);
  return `<div class="kpis">
    <div class="k hero"><span>Comisiones ${ui.comY}</span><strong>${eur(tot)}</strong></div>
    <div class="k"><span>Cobradas ${ui.comY}</span><strong>${eur0(cob)}</strong></div>
    <div class="k"><span>Pendiente (todas)</span><strong>${eur0(pend)}</strong></div>
  </div>`;
}
function renderComisiones() {
  const list = state.comisiones.filter((m) => yearOf(m.fecha) === ui.comY).sort((a, b) => b.fecha.localeCompare(a.fecha) || b.ts - a.ts);
  const pendOtros = state.comisiones.filter((m) => !m.cobrado && yearOf(m.fecha) !== ui.comY);
  let html = '', lastM = '';
  for (const m of list) {
    const mm = monthOf(m.fecha);
    if (mm !== lastM) { html += `<li class="day" style="text-transform:none">${monthLabel(mm)}</li>`; lastM = mm; }
    html += `<li class="trow">
      <button class="top2" data-id="${m.id}">
        <div class="main"><div class="name">${esc(m.cliente)}</div><div class="sub">${fmtDate(m.fecha)} · ${esc(m.producto)}${m.prov ? ' · ' + esc(m.prov) : ''}</div></div>
        <div class="side"><div class="big">${eur(comImp(m))}</div><div class="sub">${m.modo === 'fijo' ? 'importe fijo' : pctf(m.pct) + ' de ' + eur0(m.cant * m.precio)}</div></div>
      </button>
      <div class="foot"><span>${qf(m.cant)} × ${nf(m.precio, 2, 4)} €</span><button class="paid ${m.cobrado ? 'on' : ''}" data-paid="${m.id}" aria-pressed="${m.cobrado}">${m.cobrado ? '✓ Cobrada' : 'Pendiente'}</button></div>
    </li>`;
  }
  $('#view').innerHTML = `
    ${yearChips(ui.comY, 'mY')}
    ${list.length ? `<ul class="list" id="mList">${html}</ul>` : '<div class="empty">No hay comisiones este año.<br>Pulsa «Nueva comisión».</div>'}
    ${pendOtros.length ? `<p class="small" style="margin-top:14px">Hay ${pendOtros.length} comisiones pendientes de otros años (${eur(pendOtros.reduce((t, m) => t + comImp(m), 0))}).</p>` : ''}`;
  bindYears('mY', 'comY');
  const ul = $('#mList');
  if (ul) ul.onclick = (e) => {
    const p = e.target.closest('[data-paid]');
    if (p) { const id = p.dataset.paid; let now; if (commit((c) => { const m = c.comisiones.find((o) => o.id === id); m.cobrado = !m.cobrado; now = m.cobrado; })) toast(now ? 'Comisión cobrada' : 'Comisión pendiente'); return; }
    const b = e.target.closest('[data-id]'); if (b) openComision(state.comisiones.find((m) => m.id === b.dataset.id));
  };
}
function openComision(orig) {
  const isNew = !orig;
  const last = [...state.comisiones].sort((a, b) => b.ts - a.ts)[0];
  const f = orig ? { fecha: orig.fecha, producto: orig.producto, prov: orig.prov || '', cliente: orig.cliente, cant: fmtIn(orig.cant, 3), precio: fmtIn(orig.precio), modo: orig.modo, pct: fmtIn(orig.pct * 100, 2), fijo: fmtIn(orig.fijo, 2), cobrado: orig.cobrado }
    : { fecha: todayISO(), producto: '', prov: '', cliente: '', cant: '', precio: '', modo: 'pct', pct: last && last.modo === 'pct' ? fmtIn(last.pct * 100, 2) : '', fijo: '', cobrado: false };
  const uniq = (xs) => [...new Set(xs.filter(Boolean))].sort((a, b) => a.localeCompare(b, 'es'));
  const dl = (id, xs) => `<datalist id="${id}">${xs.map((x) => `<option value="${esc(x)}">`).join('')}</datalist>`;
  const body = openSheet(isNew ? 'Nueva comisión' : 'Editar comisión', `
    <label class="fld"><span>Fecha</span><input id="mF" type="date" value="${f.fecha}"></label>
    <label class="fld"><span>Cliente</span><input id="mC" type="text" list="mCl" value="${esc(f.cliente)}" autocomplete="off"></label>
    <label class="fld"><span>Producto</span><input id="mP" type="text" list="mPl" value="${esc(f.producto)}" autocomplete="off"></label>
    <label class="fld"><span>Proveedor</span><input id="mV" type="text" list="mVl" value="${esc(f.prov)}" autocomplete="off"></label>
    ${dl('mCl', uniq([...state.comisiones.map((m) => m.cliente), ...state.clientes.map((c) => c.nombre)]))}
    ${dl('mPl', uniq([...state.comisiones.map((m) => m.producto), ...state.productos.map((p) => p.nombre), ...(IX ? [...IX.prod.values()].map((p) => p.nombre) : [])]))}
    ${dl('mVl', uniq([...state.comisiones.map((m) => m.prov), ...state.proveedores.map((p) => p.nombre)]))}
    <div class="grid2">${field('mQ', 'Cantidad', f.cant, { ph: '0' })}${field('mR', 'Precio €', f.precio, { ph: '0' })}</div>
    <div class="seg" id="mM"><button type="button" data-v="pct" aria-pressed="${f.modo === 'pct'}">Porcentaje</button><button type="button" data-v="fijo" aria-pressed="${f.modo === 'fijo'}">Importe fijo</button></div>
    <div id="mMv"></div>
    <div class="box" id="mBox"></div>
    <button type="button" class="switch" id="mPaid" role="switch" aria-checked="${f.cobrado}"><span>Cobrada</span><i></i></button>
    <div class="actions ${isNew ? '' : 'two'}">${isNew ? '' : '<button class="btn danger" id="mDel">Borrar</button>'}<button class="btn primary" id="mSave">Guardar</button></div>`);
  const nums = () => ({ q: parseNum(f.cant), p: parseNum(f.precio), pct: parseNum(f.pct) / 100, fijo: parseNum(f.fijo) });
  const drawModo = () => {
    $('#mMv', body).innerHTML = f.modo === 'pct' ? field('mPc', 'Comisión %', f.pct, { ph: 'p. ej. 8' }) : field('mFi', 'Comisión €', f.fijo, { ph: '0' });
    const i = $('#mPc', body) || $('#mFi', body); i.oninput = (e) => { f[f.modo === 'pct' ? 'pct' : 'fijo'] = e.target.value; prev(); };
    prev();
  };
  const prev = () => {
    const n = nums(); const base = isFinite(n.q) && isFinite(n.p) ? n.q * n.p : null;
    const com = f.modo === 'pct' ? (base != null && isFinite(n.pct) ? base * n.pct : null) : (isFinite(n.fijo) ? n.fijo : null);
    $('#mBox', body).innerHTML = `<div><span>Importe de la venta</span><b>${base != null ? eur(base) : '—'}</b></div><div class="tot"><span>Comisión</span><b>${com != null ? eur(com) : '—'}</b></div>`;
  };
  const bind = (sel, k) => { $(sel, body).oninput = (e) => { f[k] = e.target.value; prev(); }; };
  bind('#mC', 'cliente'); bind('#mP', 'producto'); bind('#mV', 'prov'); bind('#mQ', 'cant'); bind('#mR', 'precio');
  $('#mF', body).onchange = (e) => { f.fecha = e.target.value; };
  $('#mM', body).onclick = (e) => { const b = e.target.closest('[data-v]'); if (!b) return; f.modo = b.dataset.v; body.querySelectorAll('#mM button').forEach((x) => x.setAttribute('aria-pressed', x.dataset.v === f.modo)); drawModo(); };
  $('#mPaid', body).onclick = (e) => { f.cobrado = !f.cobrado; e.currentTarget.setAttribute('aria-checked', f.cobrado); };
  $('#mSave', body).onclick = () => {
    if (!f.fecha) return toast('Indica la fecha', true);
    if (!f.cliente.trim()) return toast('Escribe el cliente', true);
    if (!f.producto.trim()) return toast('Escribe el producto', true);
    const n = nums();
    if (!(n.q > 0)) return toast('Escribe la cantidad', true);
    if (!(n.p >= 0)) return toast('Escribe el precio', true);
    if (f.modo === 'pct' && !(n.pct >= 0)) return toast('Escribe el porcentaje', true);
    if (f.modo === 'fijo' && !(n.fijo >= 0)) return toast('Escribe la comisión', true);
    const data = { fecha: f.fecha, producto: f.producto.trim(), prov: f.prov.trim(), cliente: f.cliente.trim(), cant: round(n.q, 4), precio: round(n.p, 4), modo: f.modo, pct: f.modo === 'pct' ? round(n.pct, 6) : 0, fijo: f.modo === 'fijo' ? round(n.fijo, 2) : 0, cobrado: f.cobrado };
    const ok = commit((c) => { if (isNew) c.comisiones.push({ id: uid(), ts: Date.now(), ...data }); else Object.assign(c.comisiones.find((m) => m.id === orig.id), data); });
    if (ok) { closeSheet(); toast(isNew ? 'Comisión guardada' : 'Comisión actualizada'); }
  };
  if (!isNew) armDelete($('#mDel', body), () => { if (commit((c) => { c.comisiones = c.comisiones.filter((m) => m.id !== orig.id); })) { closeSheet(); toast('Comisión borrada'); } });
  drawModo();
}

/* ---------- Clientes y proveedores (desde Ajustes) ---------- */
function openClientes() {
  const cs = [...state.clientes].sort((a, b) => (b.propio - a.propio) || (b.activo - a.activo) || byName(a, b));
  const body = openSheet('Clientes', `
    <div class="actions" style="margin-bottom:12px"><button class="btn primary" id="clNew">+ Cliente nuevo</button></div>
    <ul class="list" id="clList">${cs.map((c) => { const n = state.pedidos.filter((p) => p.cli === c.id).length; return `<li><button class="row ${c.activo ? '' : 'dim'}" data-id="${c.id}"><div class="main"><div class="name">${esc(c.nombre)}</div><div class="sub">${c.propio ? '<span class="pill own">Tus fincas</span>' : ''}${c.activo ? '' : '<span class="pill">Inactivo</span>'}${c.mid ? `<span class="pill">${esc(c.mid)}</span>` : (mxOn() ? '<span class="pill par">Sin enlazar</span>' : '')}${n} ${n === 1 ? 'pedido' : 'pedidos'}</div></div><div class="side"><b>${deudaCli(c.id) > 0 ? eur(deudaCli(c.id)) : ''}</b></div></button></li>`; }).join('')}</ul>`);
  $('#clNew', body).onclick = () => reopen(() => openCliente(null));
  $('#clList', body).onclick = (e) => { const b = e.target.closest('[data-id]'); if (b) reopen(() => openCliente(b.dataset.id)); };
}
function openCliente(id) {
  const isNew = !id; const c = isNew ? { nombre: '', propio: false, activo: true } : cliById(id);
  const n = isNew ? 0 : state.pedidos.filter((p) => p.cli === id).length;
  const m = !isNew && c.mid && IX ? IX.cli.get(c.mid) : null;
  const pend = !isNew && state.mxPend.some((a) => a.ref === id);
  let propio = c.propio, activo = c.activo;
  const body = openSheet(isNew ? 'Cliente nuevo' : c.nombre, `
    ${c.mid ? `<div class="box"><div><span>Ficha del maestro</span><b>${esc(c.mid)}${m ? ' · ' + esc(m.tipo) + ' · ' + esc(m.estado) : ''}</b></div>${m && m.servicios.length ? `<div><span>Servicios</span><b>${esc(m.servicios.join(', '))}</b></div>` : ''}</div>
      <p class="hint">El nombre, si es finca propia y la baja vienen del maestro de clientes de Drive: cámbialos allí y se actualizan solos.</p>`
    : `<label class="fld"><span>Nombre</span><input id="ceN" type="text" value="${esc(c.nombre)}" autocomplete="off"></label>
    <button type="button" class="switch" id="ceP" role="switch" aria-checked="${propio}"><span>Finca propia (precio medio + ${pctf(margenPropio())})</span><i></i></button>
    <button type="button" class="switch" id="ceA" role="switch" aria-checked="${activo}"><span>Activo (aparece al vender)</span><i></i></button>
    ${pend ? '<p class="hint">Alta pedida en el maestro: se enviará en cuanto haya conexión.</p>' : isNew && mxOn() ? '<p class="hint">Si no está en el maestro, se pide el alta y quedará en amarillo para que la revises.</p>' : ''}`}
    <div class="actions ${isNew || c.mid ? '' : 'two'}">${isNew || c.mid ? '' : `<button class="btn danger" id="ceDel" ${n ? 'disabled' : ''}>Borrar</button>`}${c.mid ? '' : '<button class="btn primary" id="ceSave">Guardar</button>'}</div>
    ${n && !c.mid ? `<p class="hint" style="margin-top:10px">Tiene ${n} pedidos: no se puede borrar, pero puedes desactivarlo. Si cambias el nombre, se cambia en todas sus ventas.</p>` : ''}
    ${isNew ? '' : '<div class="actions" style="margin-top:8px"><button class="btn" id="ceDeu">Ver su cuenta</button></div>'}`);
  if (!c.mid) {
    $('#ceP', body).onclick = (e) => { propio = !propio; e.currentTarget.setAttribute('aria-checked', propio); };
    $('#ceA', body).onclick = (e) => { activo = !activo; e.currentTarget.setAttribute('aria-checked', activo); };
    $('#ceSave', body).onclick = () => {
      const nombre = $('#ceN', body).value.trim(); if (!nombre) return toast('Escribe el nombre', true);
      if (state.clientes.some((o) => o.id !== id && MX.norm(o.nombre) === MX.norm(nombre))) return toast('Ya hay un cliente con ese nombre', true);
      if (isNew) {
        const r = clienteParaNombre(nombre, propio);
        if (r.id) return toast(`Ya existe: ${cliName(r.id)}`, true);
        const nuevo = { ...r.nuevo, activo: r.nuevo.mid ? r.nuevo.activo : activo };
        if (commit((st) => { st.clientes.push(nuevo); if (r.alta) pedirAlta(st, 'cliente', nuevo.id, r.alta); })) { toast(nuevo.mid ? 'Estaba en el maestro: queda enlazado' : 'Cliente creado'); if (r.alta) refreshMx({}); reopen(openClientes); }
      } else if (commit((st) => { Object.assign(cliById(id, st), { nombre, propio, activo }); })) { toast('Cliente actualizado'); reopen(openClientes); }
    };
  }
  if (!isNew) {
    $('#ceDeu', body).onclick = () => reopen(() => openDeudaCli(id));
    if (!n && !c.mid) armDelete($('#ceDel', body), () => { if (commit((st) => { st.clientes = st.clientes.filter((o) => o.id !== id); st.cobros = st.cobros.filter((x) => x.cli !== id); st.mxPend = st.mxPend.filter((a) => a.ref !== id); })) { toast('Cliente borrado'); reopen(openClientes); } });
  }
}
function openProveedores() {
  const ps = [...state.proveedores].sort(byName);
  const body = openSheet('Proveedores', `
    <div class="grid2" style="align-items:end"><label class="fld"><span>Proveedor nuevo</span><input id="pvN" type="text" autocomplete="off"></label><button class="btn primary" id="pvAdd" style="margin-bottom:14px">Añadir</button></div>
    <p class="hint">Pulsa un proveedor para cambiarle el nombre.</p>
    <ul class="list" id="pvList">${ps.map((p) => { const n = state.productos.filter((x) => x.prov === p.id).length; return `<li><button class="row" data-id="${p.id}"><div class="main"><div class="name">${esc(p.nombre)}</div><div class="sub">${n} productos</div></div></button></li>`; }).join('')}</ul>`);
  $('#pvAdd', body).onclick = () => {
    const nombre = $('#pvN', body).value.trim(); if (!nombre) return toast('Escribe el nombre', true);
    if (state.proveedores.some((p) => p.nombre.toLowerCase() === nombre.toLowerCase())) return toast('Ya existe', true);
    if (commit((st) => { st.proveedores.push({ id: 'v' + uid().slice(0, 8), nombre }); })) { toast('Proveedor añadido'); reopen(openProveedores); }
  };
  $('#pvList', body).onclick = (e) => {
    const b = e.target.closest('[data-id]'); if (!b) return; const p = provById(b.dataset.id);
    const nombre = prompt('Nuevo nombre del proveedor', p.nombre); if (nombre == null) return;
    const v = nombre.trim(); if (!v) return;
    if (commit((st) => { provById(p.id, st).nombre = v; })) { toast('Proveedor actualizado'); reopen(openProveedores); }
  };
}

/* ---------- Copia automática en Google Sheets ----------
   La app envía el estado completo al receptor (Apps Script). La hoja es un espejo de un solo sentido:
   sin conexión queda "pendiente" y se envía al volver la conexión. */
let sync = { url: '', clave: '', enabled: false, dirty: false, lastOk: null, lastError: '' };
let syncRev = 0, syncTimer = null, syncRetry = null, syncRunning = false;
const syncOn = () => !!(sync.enabled && sync.url && sync.clave);
async function loadSync() { try { const s = await dbGet('sync'); if (s) sync = { ...sync, ...s }; } catch (_) { /* nada */ } }
function saveSync() { dbSet('sync', sync).catch(() => {}); }
function markDirty() {
  if (!syncOn()) return;
  sync.dirty = true; syncRev++; saveSync(); renderSyncStatus();
  clearTimeout(syncTimer); syncTimer = setTimeout(() => runSync(), 2500);
}
const callScript = (accion, extra = {}) => postScript(sync.url, sync.clave, accion, extra);
async function postScript(url, clave, accion, extra = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 45000);
  try {
    // Sin cabeceras propias: así es una petición simple (text/plain) y Google no exige comprobación previa.
    const res = await fetch(url, { method: 'POST', body: JSON.stringify({ accion, clave, ...extra }), signal: ctrl.signal });
    const txt = await res.text();
    try { return JSON.parse(txt); } catch (_) { throw new Error('La dirección no responde como el script (revisa que esté publicado para «Cualquier usuario»)'); }
  } catch (e) {
    if (e && e.name === 'AbortError') throw new Error('Tiempo de espera agotado');
    if (e instanceof TypeError) throw new Error('Sin conexión con Google');
    throw e;
  } finally { clearTimeout(t); }
}
function syncPayload() {
  const EUR = '#,##0.00', E4 = '#,##0.0000', Q = '#,##0.##', P = '0.0%', F = 'dd/mm/yyyy';
  const ventas = [];
  [...state.pedidos].sort((a, b) => a.fecha.localeCompare(b.fecha) || a.ts - b.ts).forEach((p) => {
    const es = ESTADO[estadoOf(p)][1]; const c = cliById(p.cli);
    p.lineas.forEach((l) => {
      const imp = lineImp(l), ic = round(l.cant * l.coste, 4), ben = round(imp - ic, 4); const pr = l.prod ? prodById(l.prod) : null;
      ventas.push([p.fecha, MESES[Number(p.fecha.slice(5, 7)) - 1], yearOf(p.fecha), lineName(l), cliName(p.cli), l.cant, l.precio, imp, es, l.coste, ic, ben, imp ? round(ben / imp, 4) : 0, pr ? provName(pr.prov) : '', pr ? pr.tipo : 'Otro concepto', c && c.propio ? 'Tus fincas' : 'Cliente', p.nota || '', (c && c.mid) || '', (pr && pr.mid) || '']);
    });
  });
  const compras = [...state.compras].sort((a, b) => a.fecha.localeCompare(b.fecha) || a.ts - b.ts).map((c) => [c.fecha, MESES[Number(c.fecha.slice(5, 7)) - 1], yearOf(c.fecha), prodName(c.prod), prodById(c.prod)?.tipo || '', provName(c.prov), c.cant, c.precio, round(c.cant * c.precio, 2), c.nota || '', prodById(c.prod)?.mid || '']);
  const prods = [...state.productos].sort(byName);
  const stock = prods.map((p) => { const s = stockOf(p.id); return [p.nombre, p.tipo, provName(p.prov), round(s.qty, 3), round(s.avg, 4), round(s.valor, 2), p.tarifa, p.tarifa > 0 && s.avg > 0 ? round((p.tarifa - s.avg) / p.tarifa, 4) : '', p.activo ? 'Sí' : 'No', p.mid || '']; });
  const cobros = [...state.cobros].sort((a, b) => a.fecha.localeCompare(b.fecha) || a.ts - b.ts).map((c) => [c.fecha, cliName(c.cli), cobroImp(c), Object.keys(c.aplic).length, c.nota || '']);
  const pend = [];
  [...state.pedidos].filter((p) => pendOf(p) > EPS).sort((a, b) => cliName(a.cli).localeCompare(cliName(b.cli), 'es') || a.fecha.localeCompare(b.fecha)).forEach((p) => {
    pend.push([cliName(p.cli), p.fecha, totOf(p).imp, pagadoOf(p), pendOf(p), cliById(p.cli)?.propio ? 'Tus fincas' : 'Cliente', p.lineas.map((l) => lineName(l) + (l.prod ? ' ' + qf(l.cant) : '')).join(', '), cliById(p.cli)?.mid || '']);
  });
  const coms = [...state.comisiones].sort((a, b) => a.fecha.localeCompare(b.fecha) || a.ts - b.ts).map((m) => [m.fecha, yearOf(m.fecha), m.producto, m.prov, m.cliente, m.cant, m.precio, round(m.cant * m.precio, 2), m.modo === 'pct' ? m.pct : '', comImp(m), m.cobrado ? 'Sí' : 'No']);
  const res = [];
  const vs = valorStock(), dd = deudas();
  years().slice().reverse().forEach((y) => { const r = resumenAnio(y); res.push([y, round(r.imp, 2), round(r.ben, 2), round(r.margen, 4), round(r.cli.imp, 2), round(r.cli.ben, 2), round(r.own.imp, 2), round(r.own.ben, 2), round(r.com, 2), round(r.ben + r.com, 2)]); });
  const res2 = [['Valor del stock', round(vs.v, 2)], ['Pendiente de cobro clientes', dd.totCli], ['Pendiente tus fincas', dd.totOwn], ['Comisiones pendientes', round(state.comisiones.filter((m) => !m.cobrado).reduce((t, m) => t + comImp(m), 0), 2)]];
  const tablas = [
    { nombre: 'Resumen', cabecera: ['Año', 'Ventas (€)', 'Beneficio (€)', 'Margen', 'Ventas clientes (€)', 'Benef. clientes (€)', 'Ventas tus fincas (€)', 'Benef. tus fincas (€)', 'Comisiones (€)', 'Beneficio + comisiones (€)'], filas: res.concat([['', '', '', '', '', '', '', '', '', '']]).concat(res2.map((r) => [r[0], r[1], '', '', '', '', '', '', '', ''])), formatos: ['0', EUR, EUR, P, EUR, EUR, EUR, EUR, EUR, EUR], fechas: [] },
    { nombre: 'Ventas', cabecera: ['Fecha', 'Mes', 'Año', 'Producto', 'Cliente', 'Cantidad', 'Precio (€)', 'Importe (€)', 'Cobro', 'Coste (€)', 'Importe coste (€)', 'Beneficio (€)', 'Margen', 'Proveedor', 'Tipo', 'Cliente / fincas', 'Nota', 'ID cliente', 'ID producto'], filas: ventas, formatos: [F, null, '0', null, null, Q, E4, EUR, null, E4, EUR, EUR, P, null, null, null, null, null, null], fechas: [0] },
    { nombre: 'Compras', cabecera: ['Fecha', 'Mes', 'Año', 'Producto', 'Tipo', 'Proveedor', 'Cantidad', 'Precio (€)', 'Importe (€)', 'Nota', 'ID producto'], filas: compras, formatos: [F, null, '0', null, null, null, Q, E4, EUR, null, null], fechas: [0] },
    { nombre: 'Stock', cabecera: ['Producto', 'Tipo', 'Proveedor', 'Stock', 'Precio medio (€)', 'Valor (€)', 'Tarifa (€)', 'Margen tarifa', 'Activo', 'ID producto'], filas: stock, formatos: [null, null, null, Q, E4, EUR, E4, P, null, null], fechas: [] },
    { nombre: 'Pendientes', cabecera: ['Cliente', 'Fecha pedido', 'Importe (€)', 'Pagado (€)', 'Pendiente (€)', 'Cliente / fincas', 'Productos', 'ID cliente'], filas: pend, formatos: [null, F, EUR, EUR, EUR, null, null, null], fechas: [1] },
    { nombre: 'Cobros', cabecera: ['Fecha', 'Cliente', 'Importe (€)', 'Nº pedidos', 'Nota'], filas: cobros, formatos: [F, null, EUR, '0', null], fechas: [0] },
    { nombre: 'Comisiones', cabecera: ['Fecha', 'Año', 'Producto', 'Proveedor', 'Cliente', 'Cantidad', 'Precio (€)', 'Importe venta (€)', '% Comisión', 'Comisión (€)', 'Cobrada'], filas: coms, formatos: [F, '0', null, null, null, Q, E4, EUR, P, EUR, null], fechas: [0] },
  ];
  return { tablas, estado: JSON.stringify(state), version: APP_VERSION };
}
async function runSync() {
  if (!syncOn() || syncRunning) return;
  if (!navigator.onLine) { renderSyncStatus(); return; }
  syncRunning = true; const rev = syncRev; renderSyncStatus();
  try {
    const r = await callScript('sincronizar', syncPayload());
    if (!r.ok) throw new Error(r.error === 'clave' ? 'La clave no coincide con la del script' : (r.error || 'Error del receptor'));
    sync.lastOk = new Date().toISOString(); sync.lastError = '';
    if (syncRev === rev) sync.dirty = false;
  } catch (e) {
    sync.lastError = e.message || String(e); sync.dirty = true;
    clearTimeout(syncRetry); syncRetry = setTimeout(() => runSync(), 60000);
  } finally {
    syncRunning = false; saveSync(); renderSyncStatus();
    if (sync.dirty && !sync.lastError) { clearTimeout(syncTimer); syncTimer = setTimeout(() => runSync(), 800); }
  }
}
function ago(iso) {
  if (!iso) return 'nunca';
  const min = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (min < 1) return 'ahora mismo';
  if (min < 60) return `hace ${min} min`;
  if (min < 1440) return `hace ${Math.round(min / 60)} h`;
  return new Date(iso).toLocaleDateString('es-ES');
}
function syncStatusText() {
  if (!syncOn()) return '';
  if (syncRunning) return '☁ Enviando a Google Sheets…';
  if (sync.lastError) return '☁ No se pudo enviar: ' + sync.lastError;
  if (sync.dirty) return navigator.onLine ? '☁ Pendiente de enviar…' : '☁ Pendiente de enviar (sin conexión)';
  return '☁ Hoja al día · ' + ago(sync.lastOk);
}
function renderSyncStatus() {
  const el = $('#syncStatus'); if (el) { el.textContent = syncStatusText(); el.hidden = !syncOn(); }
  const box = $('#syncLine'); if (box) box.textContent = syncStatusText();
}
function validState(s) { return s && ['productos', 'clientes', 'proveedores', 'compras', 'pedidos', 'cobros', 'comisiones'].every((k) => Array.isArray(s[k])) && s.settings; }
const stateInfo = (s) => `${s.pedidos.length} ventas, ${s.compras.length} compras y ${s.comisiones.length} comisiones`;
function drawSync(box) {
  if (syncOn()) {
    box.innerHTML = `
      <p class="small" id="syncLine">${esc(syncStatusText())}</p>
      <p class="small">Cada cambio se envía solo a tu hoja de Google (pestañas Resumen, Ventas, Compras, Stock, Pendientes, Cobros y Comisiones). Sin conexión se queda pendiente y se envía al volver.</p>
      <div class="actions">
        <button class="btn primary" id="syNow">Sincronizar ahora</button>
        <button class="btn" id="syRes">Restaurar desde la hoja</button>
        <button class="btn danger" id="syOff">Desactivar</button>
      </div>`;
    $('#syNow', box).onclick = () => { if (!navigator.onLine) return toast('Sin conexión: se enviará al volver', true); sync.lastError = ''; markDirty(); clearTimeout(syncTimer); runSync(); };
    $('#syRes', box).onclick = async () => {
      try {
        const est = await callScript('estado');
        if (!est.ok || !est.estado) throw new Error(est.error === 'sin copia' ? 'La hoja todavía no tiene copia' : (est.error || 'No se pudo leer la copia'));
        const s = JSON.parse(est.estado);
        if (!validState(s)) throw new Error('La copia de la hoja no es válida');
        if (!confirm(`Se reemplazarán los datos de este móvil por los de la hoja (${stateInfo(s)}, copia ${ago(est.fecha)}). ¿Continuar?`)) return;
        state = migrar(s); await persist(); closeSheet(); renderAll(); toast('Restaurado desde la hoja'); if (mxOn()) refreshMx({});
      } catch (e) { toast(e.message || 'No se pudo restaurar', true); }
    };
    $('#syOff', box).onclick = () => { sync.enabled = false; sync.dirty = false; sync.lastError = ''; saveSync(); renderSyncStatus(); drawSync(box); toast('Copia automática desactivada'); };
  } else {
    box.innerHTML = `
      <p class="small">Envía automáticamente todo a una hoja de Google Sheets de tu Drive (copia de seguridad y datos para consultar). Necesita configurar una vez el script de Google que se explica en el README.</p>
      <label class="fld"><span>Dirección del script (termina en /exec)</span><input id="syU" type="url" value="${esc(sync.url)}" placeholder="https://script.google.com/macros/s/…/exec" autocomplete="off"></label>
      <label class="fld"><span>Clave</span><input id="syK" type="password" value="${esc(sync.clave)}" autocomplete="off"></label>
      <div class="actions"><button class="btn primary" id="syOn">Probar y activar</button></div>`;
    $('#syOn', box).onclick = () => activateSync($('#syU', box).value.trim(), $('#syK', box).value.trim(), box);
  }
}
async function activateSync(url, clave, box) {
  if (!/^https:\/\/script\.google\.com\/macros\/s\/[^/\s]+\/exec\/?$/.test(url)) return toast('La dirección debe ser la de la aplicación web del script y terminar en /exec', true);
  if (!clave) return toast('Escribe la clave', true);
  const prev = { ...sync };
  sync.url = url; sync.clave = clave;
  const finish = () => { sync.enabled = true; sync.dirty = true; sync.lastError = ''; syncRev++; saveSync(); renderSyncStatus(); drawSync(box); runSync(); toast('Conectado con Google Sheets'); };
  try {
    const ping = await callScript('ping');
    if (!ping.ok) throw new Error(ping.error === 'clave' ? 'La clave no coincide con la del script' : (ping.error || 'El receptor no responde'));
    const est = await callScript('estado');
    if (est.ok && est.estado) {
      let info = null; try { info = JSON.parse(est.estado); } catch (_) { /* nada */ }
      const okInfo = info && validState(info);
      box.innerHTML = `
        <p><b>La hoja ya contiene una copia</b> (${okInfo ? stateInfo(info) : 'datos'}, ${ago(est.fecha)}).</p>
        <p class="small">Si este móvil es nuevo, usa la copia de la hoja. Si lo de este móvil es lo correcto, sobrescribe la hoja.</p>
        <div class="actions">
          <button class="btn primary" id="syUse" ${okInfo ? '' : 'disabled'}>Usar la copia de la hoja en este móvil</button>
          <button class="btn" id="syOver">Sobrescribir la hoja con los datos de este móvil</button>
          <button class="btn" id="syCan">Cancelar</button>
        </div>`;
      $('#syUse', box).onclick = async () => { state = migrar(info); await persist(); renderAll(); finish(); if (mxOn()) refreshMx({}); };
      $('#syOver', box).onclick = finish;
      $('#syCan', box).onclick = () => { sync = prev; drawSync(box); };
      return;
    }
    finish();
  } catch (e) { sync = prev; toast(e.message || 'No se pudo conectar', true); }
}

/* ---------- Maestros compartidos (clientes y productos) ----------
   Se leen de un servicio privado (el Apps Script de la hoja «Maestro de clientes» en Drive › Apps › Maestros)
   y se guardan en el móvil, así que funcionan sin conexión. Ventas solo lee y pide altas: nunca cambia
   ni borra nada de los maestros. Cada cliente y producto guarda el ID de su ficha (C016, P008…). */
let mx = { url: '', clave: '', data: null, fecha: null, lastFetch: null, lastError: '', avisar: false };
let IX = null, mxRunning = false;
const mxOn = () => !!(mx.url && mx.clave);
const callMx = (accion, extra = {}) => postScript(mx.url, mx.clave, accion, extra);
async function loadMx() { try { const s = await dbGet('mx'); if (s) mx = { ...mx, ...s }; } catch (_) { /* nada */ } IX = mx.data ? MX.indexar(mx.data) : null; }
function saveMx() { dbSet('mx', mx).catch(() => {}); }
const nuevoId = (pre) => pre + uid().slice(0, 8);
const mxErr = (r, def) => (r.error === 'clave' ? 'La clave de los maestros no coincide con la del script' : (r.error || def));

/* Altas: se apuntan en la cola (también sin conexión) y se envían en cuanto hay conexión. */
function pedirAlta(c, tipo, ref, datos) { if (mxOn()) c.mxPend.push({ k: uid(), tipo, ref, datos }); }
async function procesarAltas() {
  for (const a of [...state.mxPend]) {
    const r = await callMx('alta', { tipo: a.tipo, datos: a.datos, app: 'Ventas' });
    if (!r.ok) throw new Error(mxErr(r, 'No se pudo dar de alta en el maestro'));
    commit((c) => {
      c.mxPend = c.mxPend.filter((x) => x.k !== a.k);
      const ent = (a.tipo === 'cliente' ? c.clientes : c.productos).find((x) => x.id === a.ref);
      if (ent && !ent.mid) { ent.mid = r.id; if (a.tipo === 'producto') ent.pres = a.datos.presentacion || ''; }
    });
  }
}
async function refreshMx({ auto = false, manual = false } = {}) {
  if (!mxOn() || mxRunning) return;
  if (!navigator.onLine) { if (manual) toast('Sin conexión: los maestros se actualizarán al volver', true); return; }
  if (auto && !state.mxPend.length && mx.lastFetch && Date.now() - new Date(mx.lastFetch).getTime() < 30 * 60000) return;
  mxRunning = true; renderMxStatus();
  try {
    await procesarAltas();
    const r = await callMx('leer');
    if (!r.ok) throw new Error(mxErr(r, 'No se pudieron leer los maestros'));
    mx.data = { clientes: r.clientes || [], fincas: r.fincas || [], productos: r.productos || [] };
    mx.fecha = r.fecha || null; mx.lastFetch = new Date().toISOString(); mx.lastError = '';
    IX = MX.indexar(mx.data); saveMx();
    aplicarMaestros(manual);
  } catch (e) { mx.lastError = e.message || String(e); saveMx(); if (manual) toast(mx.lastError, true); }
  finally { mxRunning = false; renderMxStatus(); }
}
/* Cambios sin riesgo (nombres, categorías, bajas, clientes nuevos del maestro) se aplican solos.
   El primer enlace y unir fichas repetidas se enseñan antes para que los confirmes. */
function aplicarMaestros(manual) {
  if (!IX) return false;
  const plan = MX.planVentas(state, IX);
  if (!state.settings.mxEnlazado || plan.unirCli.length || plan.unirProd.length) {
    mx.avisar = true; saveMx(); renderMxStatus();
    if (manual) { if (sheetOpen) reopen(openEnlace); else openEnlace(); }
    return manual;
  }
  mx.avisar = false; saveMx();
  const prueba = structuredClone(state);
  MX.aplicarVentas(prueba, plan, IX, { nuevoId });
  if (JSON.stringify(prueba) !== JSON.stringify(state)) {
    if (commit((c) => { MX.aplicarVentas(c, MX.planVentas(c, IX), IX, { nuevoId }); }) && manual) toast('Maestros actualizados');
  } else if (manual) toast('Todo al día con los maestros');
  return false;
}
function openEnlace() {
  if (!IX) return;
  const plan = MX.planVentas(state, IX);
  const prueba = structuredClone(state);
  const r = MX.aplicarVentas(prueba, plan, IX, { unir: true, nuevoId });
  const cambios = [];
  for (const c of state.clientes) { const n = prueba.clientes.find((x) => x.id === c.id); if (n && n.nombre !== c.nombre) cambios.push([c.nombre, n.nombre]); }
  for (const p of state.productos) { const n = prueba.productos.find((x) => x.id === p.id); if (n && n.nombre !== p.nombre) cambios.push([p.nombre, n.nombre]); }
  const cats = state.productos.filter((p) => { const n = prueba.productos.find((x) => x.id === p.id); return n && n.tipo !== p.tipo; }).length;
  const unir = [
    ...plan.unirCli.map((u) => [u.quita.map((q) => `${q.nombre} (${q.n} ${q.n === 1 ? 'venta' : 'ventas'})`).join(', '), IX.cli.get(u.mid).nombre]),
    ...plan.unirProd.map((u) => [u.quita.map((q) => `${q.nombre} (${q.n} mov.)`).join(', '), prodName(u.queda, prueba)]),
  ];
  const sin = [...plan.sinCli.map((id) => cliName(id)), ...plan.sinProd.map((id) => prodName(id))];
  const primera = !state.settings.mxEnlazado;
  const body = openSheet(primera ? 'Enlazar con los maestros' : 'Cambios de los maestros', `
    <p class="small" style="margin-top:0">Cada cliente y producto de Ventas queda unido a su ficha del maestro. Las ventas, cobros, stock, precios e importes no cambian.</p>
    <div class="box">
      <div><span>Clientes enlazados</span><b>${plan.cli.length}</b></div>
      <div><span>Productos enlazados</span><b>${plan.prod.length}</b></div>
      <div><span>Nombres que se igualan al maestro</span><b>${cambios.length}</b></div>
      <div><span>Productos que pasan a las categorías de Stock fincas</span><b>${cats}</b></div>
      <div><span>Clientes del maestro que se añaden</span><b>${r.nuevos}</b></div>
      ${unir.length ? `<div><span>Fichas repetidas que se unen</span><b>${unir.length}</b></div>` : ''}
      <div><span>Sin enlazar (los revisas tú)</span><b>${sin.length}</b></div>
    </div>
    ${unir.length ? `<h3>Se unen en una sola ficha</h3><div class="box">${unir.map(([a, b]) => `<div><span>${esc(a)}</span><b>→ ${esc(b)}</b></div>`).join('')}</div><p class="hint">Sus ventas y cobros pasan a la ficha que queda; no se borra ninguna venta.</p>` : ''}
    ${cambios.length ? `<details class="more"><summary>${cambios.length === 1 ? 'Ver el nombre que cambia' : `Ver los ${cambios.length} nombres que cambian`}</summary><div class="box">${cambios.map(([a, b]) => `<div><span>${esc(a)}</span><b>→ ${esc(b)}</b></div>`).join('')}</div></details>` : ''}
    ${sin.length ? `<details class="more" open><summary>Sin enlazar (${sin.length})</summary><div class="box">${sin.map((n) => `<div><span>${esc(n)}</span></div>`).join('')}</div><p class="hint">Después los enlazas o los das de alta en Ajustes → Maestros → Revisar sin enlazar.</p></details>` : ''}
    <div class="actions" style="margin-top:16px">
      <button class="btn" id="enBk">Guardar copia antes (recomendado)</button>
      <button class="btn primary" id="enOk">Aplicar</button>
      <button class="btn" id="enNo">Ahora no</button>
    </div>`);
  $('#enBk', body).onclick = shareOrDownloadBackup;
  $('#enNo', body).onclick = closeSheet;
  $('#enOk', body).onclick = () => {
    if (commit((c) => { MX.aplicarVentas(c, MX.planVentas(c, IX), IX, { unir: true, nuevoId }); c.settings.mxEnlazado = true; })) {
      mx.avisar = false; saveMx(); renderMxStatus(); closeSheet(); toast('Enlazado con los maestros');
    }
  };
}

/* Buscar o preparar un cliente a partir de un nombre escrito (evita duplicados con el maestro). */
function clienteParaNombre(nombre, propio) {
  const n = MX.norm(nombre);
  const ex = state.clientes.find((c) => MX.norm(c.nombre) === n);
  if (ex) return { id: ex.id };
  const m = IX && MX.buscarCliente(IX, nombre);
  if (m) {
    const ex2 = state.clientes.find((c) => c.mid === m.id);
    if (ex2) return { id: ex2.id };
    return { nuevo: { id: nuevoId('c'), mid: m.id, nombre: m.nombre, propio: MX.esPropio(m), activo: !MX.deBaja(m) } };
  }
  return { nuevo: { id: nuevoId('c'), nombre: nombre.trim(), propio: !!propio, activo: true }, alta: { nombre: nombre.trim(), tipo: propio ? 'Propio' : 'Cliente', servicios: ['Productos'] } };
}
/* Opciones del desplegable de clientes: tus fincas, clientes de productos y el resto del maestro. */
function cliOptions(sel, { soloActivos = true } = {}) {
  const tiene = new Set(state.pedidos.map((p) => p.cli));
  const vende = (c) => tiene.has(c.id) || !c.mid || !IX || (IX.cli.get(c.mid)?.servicios || []).some((s) => MX.norm(s) === 'productos');
  const cs = state.clientes.filter((c) => !soloActivos || c.activo || c.id === sel).sort(byName);
  const opt = (c) => `<option value="${c.id}" ${sel === c.id ? 'selected' : ''}>${esc(c.nombre)}${c.activo ? '' : ' (baja)'}</option>`;
  const own = cs.filter((c) => c.propio), cli = cs.filter((c) => !c.propio && vende(c)), otros = cs.filter((c) => !c.propio && !vende(c));
  return [['Tus fincas', own], ['Clientes', cli], ['Otros clientes del maestro', otros]].filter(([, xs]) => xs.length)
    .map(([g, xs]) => `<optgroup label="${g}">${xs.map(opt).join('')}</optgroup>`).join('');
}
/* Opciones «producto del maestro + envase» para enlazar a mano. */
function mxProdOptions(selMid, selPres) {
  if (!IX) return '';
  const ps = [...IX.prod.values()].sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
  return ps.map((p) => {
    const pres = p.presentaciones && p.presentaciones.length ? p.presentaciones : [''];
    return pres.map((pr) => { const v = p.id + '|' + pr; return `<option value="${esc(v)}" ${selMid === p.id && (selPres || '') === pr ? 'selected' : ''}>${esc(MX.nombreProducto(p, pr))} · ${p.id}</option>`; }).join('');
  }).join('');
}

/* Formulario común de producto nuevo (en Compras y en Stock). Con maestros: eliges producto y envase.
   Si no está en el maestro, lo escribes y se pide el alta (queda en amarillo para que lo revises). */
function npInit() { return { modo: IX ? 'mx' : 'libre', mid: '', pres: '', presOtra: '', nombre: '', cat: '', tipo: '', tarifa: '' }; }
function npHTML(np) {
  const tarifa = field('npR', 'Tarifa venta €', np.tarifa, { ph: 'precio normal' });
  if (np.modo === 'mx') {
    const m = np.mid ? IX.prod.get(np.mid) : null;
    const grupos = [...CATEGORIAS, ...new Set([...IX.prod.values()].map((p) => p.categoria).filter((c) => !CATEGORIAS.includes(c)))];
    const opts = grupos.map((g) => { const xs = [...IX.prod.values()].filter((p) => (p.categoria || '') === g && p.activo !== false).sort((a, b) => a.nombre.localeCompare(b.nombre, 'es')); return xs.length ? `<optgroup label="${esc(g || 'Sin categoría')}">${xs.map((p) => `<option value="${p.id}" ${np.mid === p.id ? 'selected' : ''}>${esc(p.nombre)}</option>`).join('')}</optgroup>` : ''; }).join('');
    const pres = m ? (m.presentaciones || []) : [];
    const otra = m && (!pres.length || np.pres === '__otra');
    const nombre = m ? MX.nombreProducto(m, otra ? np.presOtra.trim() : np.pres) : '';
    return `<label class="fld"><span>Producto del maestro</span><select id="npM"><option value="">Elige producto…</option>${opts}<option value="__libre">— No está en el maestro —</option></select></label>
      ${m ? `<div class="grid2">${pres.length ? `<label class="fld"><span>Envase</span><select id="npP">${pres.map((x) => `<option value="${esc(x)}" ${np.pres === x ? 'selected' : ''}>${esc(x)}</option>`).join('')}<option value="__otra" ${np.pres === '__otra' ? 'selected' : ''}>Otro envase…</option></select></label>` : ''}
        ${otra ? field('npO', pres.length ? 'Envase nuevo' : 'Envase', np.presOtra, { mode: 'text', ph: 'p. ej. E/20 L' }) : ''}${tarifa}</div>
        <p class="hint" id="npH">Se llamará «${esc(nombre)}» · ${esc(m.categoria || 'sin categoría')}${otra && np.presOtra.trim() ? '. El envase nuevo se añade a su ficha del maestro.' : ''}</p>` : ''}`;
  }
  if (!IX) return `<label class="fld"><span>Nombre del producto nuevo</span><input id="npN" type="text" value="${esc(np.nombre)}" placeholder="Por ejemplo: Ironfeed 48 E/5 Kg" autocomplete="off"></label>
    <div class="grid2"><label class="fld"><span>Tipo</span><select id="npC"><option value="">Elige…</option>${CATEGORIAS.map((c) => `<option ${np.cat === c ? 'selected' : ''}>${c}</option>`).join('')}</select></label>${tarifa}</div>`;
  return `${IX ? '<button type="button" class="btn small" id="npVolver" style="margin-bottom:12px">← Elegir del maestro</button>' : ''}
    <div class="grid2"><label class="fld"><span>Nombre (sin envase)</span><input id="npN" type="text" value="${esc(np.nombre)}" placeholder="Por ejemplo: Tarafol Gold" autocomplete="off"></label>${field('npO', 'Envase', np.presOtra, { mode: 'text', ph: 'p. ej. E/5 Kg' })}</div>
    <div class="grid2"><label class="fld"><span>Categoría</span><select id="npC"><option value="">Elige…</option>${CATEGORIAS.map((c) => `<option ${np.cat === c ? 'selected' : ''}>${c}</option>`).join('')}</select></label>${tarifa}</div>
    <p class="hint">${mxOn() ? 'Se pedirá el alta en el maestro de productos y quedará en amarillo para que la revises.' : ''}</p>`;
}
function npBind(box, np, redraw, onPick) {
  const m = $('#npM', box);
  if (m) m.onchange = (e) => { if (e.target.value === '__libre') { np.modo = 'libre'; np.mid = ''; } else { np.mid = e.target.value; const p = IX.prod.get(np.mid); np.pres = p && p.presentaciones && p.presentaciones.length ? p.presentaciones[0] : ''; np.presOtra = ''; onPick && onPick(p); } redraw(); };
  const pp = $('#npP', box); if (pp) pp.onchange = (e) => { np.pres = e.target.value; redraw(); };
  const v = $('#npVolver', box); if (v) v.onclick = () => { np.modo = 'mx'; redraw(); };
  const bind = (sel, k) => { const el = $(sel, box); if (el) el.oninput = (e) => { np[k] = e.target.value; const h = $('#npH', box); if (h && k === 'presOtra' && np.mid) { const p = IX.prod.get(np.mid); h.textContent = `Se llamará «${MX.nombreProducto(p, np.presOtra.trim())}» · ${p.categoria || 'sin categoría'}${np.presOtra.trim() ? '. El envase nuevo se añade a su ficha del maestro.' : ''}`; } }; };
  bind('#npN', 'nombre'); bind('#npO', 'presOtra'); bind('#npR', 'tarifa');
  const c = $('#npC', box); if (c) c.onchange = (e) => { np.cat = e.target.value; };
}
/* Devuelve { prod, alta } o lanza un error con el motivo. */
function npBuild(np, provId) {
  const tarifa = String(np.tarifa).trim() ? parseNum(np.tarifa) : 0;
  if (!(tarifa >= 0)) throw new Error('Revisa la tarifa');
  const dup = (nombre) => state.productos.find((p) => MX.norm(p.nombre) === MX.norm(nombre));
  if (np.modo === 'mx') {
    const m = np.mid && IX.prod.get(np.mid); if (!m) throw new Error('Elige el producto del maestro');
    const pres = (!m.presentaciones.length || np.pres === '__otra') ? np.presOtra.trim() : np.pres;
    if ((!m.presentaciones.length || np.pres === '__otra') && !pres && m.presentaciones.length) throw new Error('Escribe el envase');
    const ex = state.productos.find((p) => p.mid === m.id && MX.compacto(p.pres || '') === MX.compacto(pres));
    if (ex) throw new Error(`«${ex.nombre}» ya existe: elígelo de la lista`);
    const nombre = MX.nombreProducto(m, pres);
    if (dup(nombre)) throw new Error('Ese producto ya existe: elígelo de la lista');
    const nuevoEnvase = pres && !m.presentaciones.some((x) => MX.compacto(x) === MX.compacto(pres));
    return { prod: { id: nuevoId('p'), mid: m.id, pres, nombre, tipo: m.categoria || '', subtipo: m.subtipo || '', prov: provId, tarifa: round(tarifa, 4), activo: true }, alta: nuevoEnvase ? { nombre: m.nombre, presentacion: pres } : null };
  }
  const base = np.nombre.trim(); if (!base) throw new Error('Escribe el nombre del producto');
  const pres = IX ? np.presOtra.trim() : '';
  const nombre = pres ? base + ' ' + pres : base;
  if (dup(nombre)) throw new Error('Ese producto ya existe: elígelo de la lista');
  if (!np.cat) throw new Error('Elige la categoría');
  const r = IX && MX.buscarProducto(IX, nombre);
  if (r) return { prod: { id: nuevoId('p'), mid: r.p.id, pres: r.pres, nombre: MX.nombreProducto(r.p, r.pres), tipo: r.p.categoria || np.cat, subtipo: r.p.subtipo || '', prov: provId, tarifa: round(tarifa, 4), activo: true }, alta: null, aviso: 'Ya estaba en el maestro: queda enlazado' };
  return { prod: { id: nuevoId('p'), nombre, pres, tipo: np.cat, prov: provId, tarifa: round(tarifa, 4), activo: true }, alta: { nombre: base, presentacion: pres, categoria: np.cat, proveedor: provName(provId) } };
}

/* Revisión de lo que no se ha podido enlazar solo */
function openSinEnlazar() {
  if (!IX) return toast('Primero conecta los maestros', true);
  const plan = MX.planVentas(state, IX);
  const pend = new Set(state.mxPend.map((a) => a.ref));
  const cliOpts = [...IX.cli.values()].sort((a, b) => a.nombre.localeCompare(b.nombre, 'es')).map((m) => `<option value="${m.id}">${esc(m.nombre)} · ${m.id}</option>`).join('');
  const rowC = (c) => `<div class="grpbox"><div class="gh"><span><b>${esc(c.nombre)}</b> · cliente</span>${pend.has(c.id) ? '<span class="pill par">Alta pedida</span>' : ''}</div>
    ${pend.has(c.id) ? '' : `<label class="fld"><span>Es esta ficha del maestro</span><select data-sc="${c.id}"><option value="">Elige…</option>${cliOpts}</select></label>
    <div class="actions two"><button class="btn small" data-ec="${c.id}">Enlazar</button><button class="btn small" data-ac="${c.id}">Dar de alta en el maestro</button></div>`}</div>`;
  const rowP = (p) => `<div class="grpbox"><div class="gh"><span><b>${esc(p.nombre)}</b> · producto</span>${pend.has(p.id) ? '<span class="pill par">Alta pedida</span>' : ''}</div>
    ${pend.has(p.id) ? '' : `<label class="fld"><span>Es esta ficha del maestro</span><select data-sp="${p.id}"><option value="">Elige…</option>${mxProdOptions()}</select></label>
    <div class="actions"><button class="btn small" data-ep="${p.id}">Enlazar</button></div>
    <div class="grid2" style="margin-top:10px"><label class="fld"><span>Nombre (sin envase)</span><input data-pn="${p.id}" type="text" value="${esc(p.nombre)}" autocomplete="off"></label><label class="fld"><span>Envase</span><input data-pe="${p.id}" type="text" value="" placeholder="E/5 L" autocomplete="off"></label></div>
    <div class="grid2" style="align-items:end"><label class="fld"><span>Categoría</span><select data-pc="${p.id}"><option value="">Elige…</option>${CATEGORIAS.map((c) => `<option ${p.tipo === c ? 'selected' : ''}>${c}</option>`).join('')}</select></label><button class="btn small" data-ap="${p.id}" style="margin-bottom:14px">Dar de alta</button></div>`}</div>`;
  const cs = plan.sinCli.map((id) => cliById(id)).filter(Boolean), ps = plan.sinProd.map((id) => prodById(id)).filter(Boolean);
  const body = openSheet('Sin enlazar', cs.length + ps.length
    ? `<p class="small" style="margin-top:0">No se han reconocido por nombre ni alias. Enlázalos a su ficha o pide el alta (quedará en amarillo en el maestro).</p>${cs.map(rowC).join('')}${ps.map(rowP).join('')}`
    : '<div class="okline">✓ Todo está enlazado con los maestros</div>');
  const again = () => reopen(openSinEnlazar);
  body.onclick = (e) => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.ec) {
      const mid = body.querySelector(`[data-sc="${b.dataset.ec}"]`).value; if (!mid) return toast('Elige la ficha del maestro', true);
      if (commit((c) => { cliById(b.dataset.ec, c).mid = mid; })) { if (!aplicarMaestros(true)) again(); }
    } else if (b.dataset.ac) {
      const c0 = cliById(b.dataset.ac);
      if (commit((c) => pedirAlta(c, 'cliente', c0.id, { nombre: c0.nombre, tipo: c0.propio ? 'Propio' : 'Cliente', servicios: ['Productos'] }))) { toast('Alta pedida'); refreshMx({ manual: false }); again(); }
    } else if (b.dataset.ep) {
      const v = body.querySelector(`[data-sp="${b.dataset.ep}"]`).value; if (!v) return toast('Elige la ficha del maestro', true);
      const [mid, pres] = [v.slice(0, v.indexOf('|')), v.slice(v.indexOf('|') + 1)];
      if (commit((c) => { const p = prodById(b.dataset.ep, c); p.mid = mid; p.pres = pres; })) { if (!aplicarMaestros(true)) again(); }
    } else if (b.dataset.ap) {
      const id = b.dataset.ap;
      const nombre = body.querySelector(`[data-pn="${id}"]`).value.trim(), pres = body.querySelector(`[data-pe="${id}"]`).value.trim(), cat = body.querySelector(`[data-pc="${id}"]`).value;
      if (!nombre) return toast('Escribe el nombre', true);
      if (!cat) return toast('Elige la categoría', true);
      const p0 = prodById(id);
      if (commit((c) => { prodById(id, c).tipo = cat; pedirAlta(c, 'producto', id, { nombre, presentacion: pres, categoria: cat, proveedor: provName(p0.prov) }); })) { toast('Alta pedida'); refreshMx({}); again(); }
    }
  };
}

function mxStatusText() {
  if (!mxOn()) return '';
  if (mxRunning) return 'Leyendo los maestros…';
  const pend = state && state.mxPend.length ? ` · ${state.mxPend.length} ${state.mxPend.length === 1 ? 'alta pendiente' : 'altas pendientes'} de enviar` : '';
  if (mx.lastError) return 'Maestros: ' + mx.lastError + pend;
  if (!mx.data) return 'Maestros: todavía sin leer' + pend;
  return `Maestros: ${mx.data.clientes.length} clientes · ${mx.data.fincas.length} fincas · ${mx.data.productos.length} productos · leídos ${ago(mx.lastFetch)}${pend}`;
}
function renderMxStatus() {
  const el = $('#mxStatus');
  if (el) { el.hidden = !(mxOn() && mx.avisar && IX); el.textContent = '⚠ Maestros: hay cambios para revisar · pulsa aquí'; }
  const l = $('#mxLine'); if (l) l.textContent = mxStatusText();
}
function drawMx(box) {
  if (mxOn()) {
    const sin = IX ? (() => { const p = MX.planVentas(state, IX); return p.sinCli.length + p.sinProd.length; })() : 0;
    box.innerHTML = `
      <p class="small" id="mxLine">${esc(mxStatusText())}</p>
      <p class="small">Clientes y productos salen de los maestros de Drive (Apps › Maestros). Se guardan en el móvil y funcionan sin conexión. Lo nuevo que des de alta aquí entra en el maestro en amarillo para que lo revises.</p>
      <div class="actions">
        <button class="btn primary" id="mxNow">Actualizar ahora</button>
        ${IX ? `<button class="btn" id="mxRev">Revisar sin enlazar${sin ? ` (${sin})` : ''}</button>` : ''}
        ${mx.avisar && IX ? '<button class="btn" id="mxEnl">Ver cambios pendientes</button>' : ''}
        <button class="btn danger" id="mxOff">Desconectar</button>
      </div>`;
    $('#mxNow', box).onclick = () => refreshMx({ manual: true });
    const rv = $('#mxRev', box); if (rv) rv.onclick = () => reopen(openSinEnlazar);
    const en = $('#mxEnl', box); if (en) en.onclick = () => reopen(openEnlace);
    $('#mxOff', box).onclick = () => { mx = { ...mx, url: '', clave: '', lastError: '', avisar: false }; saveMx(); renderMxStatus(); drawMx(box); toast('Maestros desconectados (lo enlazado se mantiene)'); };
  } else {
    box.innerHTML = `
      <p class="small">Conecta la app con los maestros de clientes y productos de tu Drive. Necesita configurar una vez el script de los maestros (pasos en el README).</p>
      <label class="fld"><span>Dirección del script de maestros (termina en /exec)</span><input id="mxU" type="url" value="${esc(mx.url)}" placeholder="https://script.google.com/macros/s/…/exec" autocomplete="off"></label>
      <label class="fld"><span>Clave</span><input id="mxK" type="password" value="${esc(mx.clave)}" autocomplete="off"></label>
      <div class="actions"><button class="btn primary" id="mxOn">Probar y conectar</button></div>`;
    $('#mxOn', box).onclick = async () => {
      const url = $('#mxU', box).value.trim(), clave = $('#mxK', box).value.trim();
      if (!/^https:\/\/script\.google\.com\/macros\/s\/[^/\s]+\/exec\/?$/.test(url)) return toast('La dirección debe ser la de la aplicación web del script y terminar en /exec', true);
      if (!clave) return toast('Escribe la clave', true);
      if (url === sync.url) return toast('Esa es la dirección de la copia de Ventas: aquí va la del script de maestros', true);
      try {
        const r = await postScript(url, clave, 'ping');
        if (!r.ok) throw new Error(mxErr(r, 'El script no responde'));
        mx.url = url; mx.clave = clave; mx.lastError = ''; saveMx();
        toast('Conectado. Leyendo los maestros…');
        drawMx(box);
        refreshMx({ manual: true });
      } catch (e) { toast(e.message || 'No se pudo conectar', true); }
    };
  }
}

/* ---------- Gestión fincas: confirma las ventas a tus fincas ----------
   Gestión fincas recoge sola las ventas a tus fincas como entradas. Aquí se lee su copia (su script de
   Google, acción «estado») y, cuando todas las líneas de un pedido ya han entrado allí, el pedido se
   marca como pasado (cobrado). Así «Tus fincas pendiente» solo muestra lo que aún no ha llegado. */
let gf = { url: '', clave: '', lastFetch: null, lastError: '' };
let gfRunning = false;
const gfOn = () => !!(gf.url && gf.clave);
async function loadGf() { try { const s = await dbGet('gf'); if (s) gf = { ...gf, ...s }; } catch (_) { /* nada */ } }
function saveGf() { dbSet('gf', gf).catch(() => {}); }
async function refreshGf({ auto = false, manual = false } = {}) {
  if (!gfOn() || gfRunning) return;
  if (!navigator.onLine) { if (manual) toast('Sin conexión: se comprobará al volver', true); return; }
  if (auto && gf.lastFetch && Date.now() - new Date(gf.lastFetch).getTime() < 15 * 60000) return;
  gfRunning = true; renderGfLine();
  try {
    const r = await postScript(gf.url, gf.clave, 'estado');
    if (!r.ok) throw new Error(r.error === 'clave' ? 'La clave no coincide con la del script de Gestión fincas' : r.error === 'sin copia' ? 'La hoja de Gestión fincas aún no tiene copia' : (r.error || 'No se pudo leer Gestión fincas'));
    const gs = JSON.parse(r.estado);
    const vks = new Set((gs.entradas || []).filter((e) => e.vk).map((e) => e.vk));
    const listos = state.pedidos.filter((p) => cliById(p.cli)?.propio && pendOf(p) > EPS && p.lineas.some((l) => l.prod) && p.lineas.filter((l) => l.prod).every((l) => vks.has(p.id + '|' + l.k)));
    gf.lastFetch = new Date().toISOString(); gf.lastError = '';
    if (listos.length) {
      const imp = listos.map((p) => [p.id, p.cli, pendOf(p)]);
      if (commit((c) => { imp.forEach(([pid, cli, v]) => c.cobros.push({ id: uid(), ts: Date.now(), fecha: todayISO(), cli, aplic: { [pid]: v }, nota: 'Pasado a Gestión fincas', hist: false })); })) toast(`${listos.length} ${listos.length === 1 ? 'venta a tus fincas pasada' : 'ventas a tus fincas pasadas'} a Gestión fincas`);
    } else if (manual) toast('Nada nuevo: lo pendiente aún no ha entrado en Gestión fincas');
  } catch (e) { gf.lastError = e.message || String(e); if (manual) toast(gf.lastError, true); }
  finally { gfRunning = false; saveGf(); renderGfLine(); }
}
function gfText() {
  if (!gfOn()) return '';
  if (gfRunning) return 'Comprobando Gestión fincas…';
  if (gf.lastError) return 'Gestión fincas: ' + gf.lastError;
  return 'Gestión fincas conectada · comprobado ' + ago(gf.lastFetch);
}
function renderGfLine() { const l = $('#gfLine'); if (l) l.textContent = gfText(); }
function drawGf(box) {
  if (gfOn()) {
    box.innerHTML = `
      <p class="small" id="gfLine">${esc(gfText())}</p>
      <p class="small">Las ventas a tus fincas entran solas en Gestión fincas. Cuando han entrado, aquí se marcan como pasadas y salen de «Tus fincas pendiente».</p>
      <div class="actions"><button class="btn primary" id="gfNow">Comprobar ahora</button><button class="btn danger" id="gfOff">Desconectar</button></div>`;
    $('#gfNow', box).onclick = () => refreshGf({ manual: true });
    $('#gfOff', box).onclick = () => { gf = { ...gf, url: '', clave: '', lastError: '' }; saveGf(); drawGf(box); toast('Gestión fincas desconectada'); };
  } else {
    box.innerHTML = `
      <p class="small">Para que las ventas a tus fincas se marquen solas como pasadas. Usa la dirección y la clave del script de la hoja de Gestión fincas (las de su copia automática en Google Sheets).</p>
      <label class="fld"><span>Dirección del script de Gestión fincas (termina en /exec)</span><input id="gfU" type="url" value="${esc(gf.url)}" placeholder="https://script.google.com/macros/s/…/exec" autocomplete="off"></label>
      <label class="fld"><span>Clave</span><input id="gfK" type="password" value="${esc(gf.clave)}" autocomplete="off"></label>
      <div class="actions"><button class="btn primary" id="gfOn">Probar y conectar</button></div>`;
    $('#gfOn', box).onclick = async () => {
      const url = $('#gfU', box).value.trim(), clave = $('#gfK', box).value.trim();
      if (!/^https:\/\/script\.google\.com\/macros\/s\/[^/\s]+\/exec\/?$/.test(url)) return toast('La dirección debe terminar en /exec', true);
      if (!clave) return toast('Escribe la clave', true);
      if (url === sync.url || url === mx.url) return toast('Esa dirección es de otro script: aquí va la de la hoja de Gestión fincas', true);
      try {
        const r = await postScript(url, clave, 'ping');
        if (!r.ok) throw new Error(r.error === 'clave' ? 'La clave no coincide con la del script de Gestión fincas' : (r.error || 'El script no responde'));
        gf.url = url; gf.clave = clave; gf.lastError = ''; saveGf(); drawGf(box); toast('Gestión fincas conectada'); refreshGf({ manual: true });
      } catch (e) { toast(e.message || 'No se pudo conectar', true); }
    };
  }
}

/* ---------- Ajustes y copia de seguridad ---------- */
function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
async function shareOrDownloadBackup() {
  const name = `ventas-copia-${todayISO()}.json`;
  const text = JSON.stringify({ app: 'ventas-fgagro', version: APP_VERSION, exportedAt: new Date().toISOString(), state }, null, 1);
  const file = new File([text], name, { type: 'application/json' });
  try {
    if (navigator.canShare && navigator.canShare({ files: [file] })) await navigator.share({ files: [file], title: 'Copia Ventas' });
    else download(name, text, 'application/json');
  } catch (e) { if (e && e.name === 'AbortError') return; download(name, text, 'application/json'); }
  state.settings.lastBackup = new Date().toISOString(); persist(); toast('Copia generada');
}
function openSettings() {
  const body = openSheet('Ajustes', `
    <h3 style="margin-top:4px">Clientes, productos y proveedores</h3>
    <div class="actions three"><button class="btn small" id="aCli">Clientes</button><button class="btn small" id="aPro">Productos</button><button class="btn small" id="aPrv">Proveedores</button></div>
    <h3>Maestros de clientes y productos</h3>
    <div id="mxBox"></div>
    <div class="sep"></div>
    <h3>Margen en las ventas a tus fincas</h3>
    <div class="inline-set"><span>Precio medio +</span><input id="aMg" type="text" inputmode="decimal" value="${fmtIn(margenPropio() * 100, 2)}"><span>%</span></div>
    <h3 style="margin-top:16px">Ventas a tus fincas → Gestión fincas</h3>
    <div id="gfBox"></div>
    <div class="sep"></div>
    <h3>Copia automática en Google Sheets</h3>
    <div id="syncBox"></div>
    <div class="sep"></div>
    <h3>Copia de seguridad en fichero</h3>
    <p class="small">Los datos viven en este móvil. Puedes guardar un fichero con todo (por ejemplo en Drive o WhatsApp).${state.settings.lastBackup ? ` Última copia: ${new Date(state.settings.lastBackup).toLocaleString('es-ES')}.` : ' Aún no has hecho ninguna.'}</p>
    <div class="actions">
      <button class="btn primary" id="sBk">Guardar copia / compartir</button>
      <label class="btn" style="display:grid;place-items:center;cursor:pointer">Restaurar desde fichero<input id="sRs" type="file" accept="application/json,.json" hidden></label>
    </div>
    <div class="sep"></div>
    <p class="small">Ventas · FG Agro v${APP_VERSION}. La app no lleva datos dentro: en un móvil nuevo se restaura desde la hoja de Google o desde un fichero de copia.</p>`);
  $('#aCli', body).onclick = () => reopen(openClientes);
  $('#aPro', body).onclick = () => { closeSheet(); ui.tab = 'stock'; ui.stockSeg = 'stock'; ui.stockAll = true; renderAll(); };
  $('#aPrv', body).onclick = () => reopen(openProveedores);
  $('#aMg', body).onchange = (e) => {
    const n = parseNum(e.target.value);
    if (!(n >= 0 && n < 100)) { toast('Escribe un porcentaje válido', true); e.target.value = fmtIn(margenPropio() * 100, 2); return; }
    commit((c) => { c.settings.margenPropio = round(n / 100, 4); }); toast(`Tus fincas: precio medio + ${nf(n, 0, 2)} %`);
  };
  drawSync($('#syncBox', body));
  drawMx($('#mxBox', body));
  drawGf($('#gfBox', body));
  $('#sBk', body).onclick = shareOrDownloadBackup;
  $('#sRs', body).onchange = async (e) => {
    const file = e.target.files[0]; if (!file) return;
    try {
      const j = JSON.parse(await file.text());
      const s = j && j.state;
      if (!validState(s)) throw new Error('El fichero no es una copia de la app de Ventas');
      if (!confirm(`Se reemplazarán todos los datos actuales por los de la copia (${stateInfo(s)}). ¿Continuar?`)) return;
      state = migrar(s); await persist(); closeSheet(); renderAll(); toast('Copia restaurada'); if (mxOn()) refreshMx({});
    } catch (err) { toast(err.message || 'No se pudo leer la copia', true); }
    e.target.value = '';
  };
}

/* ---------- Render general ---------- */
const TABS = {
  inicio: { title: 'Ventas · FG Agro', fab: 'Nueva venta', head: headInicio, render: renderInicio },
  ventas: { title: 'Ventas', fab: 'Nueva venta', head: headVentas, render: renderVentas },
  compras: { title: 'Compras', fab: 'Nueva compra', head: headCompras, render: renderCompras },
  stock: { title: 'Stock y tarifa', fab: 'Nuevo producto', head: headStock, render: renderStock },
  deudas: { title: 'Deudas', fab: 'Nueva venta', head: headDeudas, render: renderDeudas },
  comisiones: { title: 'Comisiones', fab: 'Nueva comisión', head: headComisiones, render: renderComisiones },
};
function renderAll() {
  const t = TABS[ui.tab];
  $('#topTitle').textContent = t.title;
  $('#head').innerHTML = t.head ? t.head() : '';
  document.querySelectorAll('.tab').forEach((b) => { if (b.dataset.tab === ui.tab) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
  const nd = deudas().cli.length, badge = $('#deudaBadge');
  badge.hidden = !nd; badge.textContent = nd;
  $('#fab').hidden = !t.fab; if (t.fab) $('#fabLabel').textContent = t.fab;
  renderSyncStatus(); renderMxStatus();
  t.render();
}

async function init() {
  document.querySelectorAll('.tab').forEach((b) => b.onclick = () => { ui.tab = b.dataset.tab; window.scrollTo(0, 0); renderAll(); });
  $('#btnSettings').onclick = openSettings;
  $('#fab').onclick = () => {
    if (ui.tab === 'compras') openCompra(null);
    else if (ui.tab === 'stock') openProducto(null);
    else if (ui.tab === 'comisiones') openComision(null);
    else openPedido(null, ui.tab === 'ventas' && ui.ventCli ? ui.ventCli : '');
  };
  await loadSync();
  $('#syncStatus').onclick = openSettings;
  $('#mxStatus').onclick = () => openEnlace();
  window.addEventListener('online', () => { if (sync.dirty) runSync(); else renderSyncStatus(); if (mxOn() && state && state.mxPend.length) refreshMx({ auto: true }); });
  window.addEventListener('offline', renderSyncStatus);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { if (sync.dirty) runSync(); if (state && !sheetOpen) renderAll(); if (mxOn()) refreshMx({ auto: true }); if (gfOn()) refreshGf({ auto: true }); } });
  setInterval(renderSyncStatus, 60000);
  try {
    let s = await dbGet('state');
    if (!s) { s = emptyState(); await dbSet('state', s); }
    else if (!s.v || s.v < 2) { migrar(s); await dbSet('state', s); }
    state = migrar(s);
  } catch (e) {
    state = emptyState();
    toast('Este navegador no permite guardar datos: lo que anotes se perderá al cerrar', true);
  }
  await loadMx(); await loadGf();
  renderAll();
  if (syncOn() && sync.dirty) setTimeout(runSync, 1500);
  if (mxOn() || gfOn()) setTimeout(async () => { if (mxOn()) await refreshMx({ auto: true }); if (gfOn()) refreshGf({ auto: true }); }, 2500);
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}
init();
