/* =====================================================================
   Dashboard de telemetría — TP05 Desarrollo de Aplicaciones II
   Consume el backend FastAPI de la cátedra (contrato en API.md):
     GET /telemetria · GET /info · WS /ws
   Sólo lectura: este archivo no envía ninguna orden al robot.
   ===================================================================== */
'use strict';

/* ---------------------------------------------------------------------
   1. Configuración
   --------------------------------------------------------------------- */
const HIST_SIZE = 300;        // búfer circular: 30 s a 10 Hz (igual que electroSim)
const POLL_MS = 500;          // intervalo máximo del modo polling
const STALE_MS = 2500;        // sin datos por este tiempo => "sin conexión"
const ARRANQUE_MS = 4000;     // tiempo de gracia antes de declarar "sin conexión" al inicio
const MAX_SELECCION = 6;      // motores graficables a la vez
const UMBRAL_ATENCION = 40;   // °C
const UMBRAL_CRITICA = 60;    // °C

const METRICAS = {
  temperatura: { etiqueta: 'Temperatura', unidad: '°C',    dec: 1 },
  angulo:      { etiqueta: 'Ángulo',      unidad: '°',     dec: 2 },
  velocidad:   { etiqueta: 'Velocidad',   unidad: 'rad/s', dec: 3 },
  torque:      { etiqueta: 'Torque',      unidad: 'N·m',   dec: 2 },
};

/* ---------------------------------------------------------------------
   2. Utilidades
   --------------------------------------------------------------------- */
const $ = (id) => document.getElementById(id);
const cssVar = (nombre) => getComputedStyle(document.documentElement).getPropertyValue(nombre).trim();
const fmt = (n, dec = 1) => (Number.isFinite(n) ? n.toFixed(dec) : '—');
const pad = (n, l = 2) => String(n).padStart(l, '0');

function fechaLocal(d = new Date(), conMs = true) {
  const base = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
               `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  return conMs ? `${base}.${pad(d.getMilliseconds(), 3)}` : base;
}

/** Agrega al búfer circular: al llenarse, descarta la muestra más antigua. */
function empujar(buffer, valor) {
  buffer.push(valor);
  if (buffer.length > HIST_SIZE) buffer.shift();
}

/* Colores del semáforo: se leen del CSS para tener una única fuente. */
const COLOR_NIVEL = { ok: cssVar('--ok'), warn: cssVar('--warn'), hot: cssVar('--hot') };
const PALETA = ['--s1', '--s2', '--s3', '--s4', '--s5', '--s6'].map(cssVar);

/**
 * Semáforo de temperatura (igual a electroSim):
 *   verde < 40 °C · amarillo 40–60 °C · rojo > 60 °C
 */
function nivelTemp(t) {
  if (t < UMBRAL_ATENCION) return 'ok';
  if (t <= UMBRAL_CRITICA) return 'warn';
  return 'hot';
}
const colorTemp = (t) => COLOR_NIVEL[nivelTemp(t)];

/* ---------------------------------------------------------------------
   3. Estado de la aplicación
   --------------------------------------------------------------------- */
function resolverApi() {
  const param = new URLSearchParams(location.search).get('api');
  if (param) return normalizarApi(param);
  try {
    const guardada = localStorage.getItem('tp05.api');
    if (guardada) return guardada;
  } catch { /* almacenamiento bloqueado: se sigue con el valor por defecto */ }
  if (location.protocol.startsWith('http') && location.hostname) {
    return `http://${location.hostname}:8001`;
  }
  return 'http://localhost:8001';
}

function normalizarApi(texto) {
  let url = texto.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(url)) url = 'http://' + url;
  return url;
}

const estado = {
  api: resolverApi(),
  transporte: 'ws',            // 'ws' | 'poll'
  info: null,                  // respuesta de /info
  ultimo: null,                // último JSON válido de /telemetria
  ultimoMs: 0,                 // performance.now() de la última recepción
  inicioMs: performance.now(), // cuándo empezó el intento de conexión actual
  llegadas: [],                // marcas de tiempo recientes (para calcular Hz)
  firma: '',                   // modelo|n_motores: detecta cambio de robot
  muestras: [],                // capturas manuales para exportar
  metrica: 'temperatura',
  seleccion: [],               // ids de motor graficados
  colores: new Map(),          // id de motor -> color de su curva
  hist: nuevoHistorial(),
};

function nuevoHistorial() {
  return { ts: [], imu: { roll: [], pitch: [], yaw: [] }, motores: {} };
}

/* ---------------------------------------------------------------------
   4. Panel de motores
   --------------------------------------------------------------------- */
const filas = [];   // filas[id] = referencias a las celdas (se actualizan en el lugar)

function construirTablaMotores(motores) {
  const tbody = $('tbodyMotores');
  tbody.replaceChildren();
  filas.length = 0;

  motores.forEach((m) => {
    const nombre = m.nombre || `motor_${m.id}`;
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="c-sel"><input type="checkbox"></td>
      <th scope="row" class="c-motor"><span class="id"></span><span class="nombre"></span></th>
      <td class="c-temp"><span class="celda-temp"></span></td>
      <td class="num c-ang"></td>
      <td class="num c-vel"></td>
      <td class="num c-tau"></td>`;
    tr.querySelector('.id').textContent = m.id;
    tr.querySelector('.nombre').textContent = nombre;
    const chk = tr.querySelector('input');
    chk.setAttribute('aria-label', `Graficar ${nombre}`);
    chk.addEventListener('change', () => alternarMotor(m.id));
    tr.addEventListener('click', (e) => { if (e.target !== chk) chk.click(); });
    tbody.appendChild(tr);

    filas[m.id] = {
      tr, chk,
      tdTemp: tr.querySelector('.c-temp'),
      temp: tr.querySelector('.celda-temp'),
      ang: tr.querySelector('.c-ang'),
      vel: tr.querySelector('.c-vel'),
      tau: tr.querySelector('.c-tau'),
    };
  });
}

function actualizarMotores(motores) {
  const cuentas = { ok: 0, warn: 0, hot: 0 };
  let maximo = null;

  motores.forEach((m) => {
    const f = filas[m.id];
    if (!f) return;
    const nivel = nivelTemp(m.temperatura);
    cuentas[nivel]++;
    if (!maximo || m.temperatura > maximo.temperatura) maximo = m;

    f.temp.textContent = `${fmt(m.temperatura, 1)} °C`;
    f.temp.style.setProperty('--c', colorTemp(m.temperatura));
    f.tdTemp.dataset.nivel = nivel;
    f.tdTemp.title = { ok: 'Normal', warn: 'Atención', hot: 'Crítica' }[nivel];
    f.ang.textContent = `${fmt(m.angulo, 2)} °`;
    f.vel.textContent = `${fmt(m.velocidad, 3)} rad/s`;
    f.tau.textContent = `${fmt(m.torque, 2)} N·m`;
  });

  $('cntOk').textContent = cuentas.ok;
  $('cntWarn').textContent = cuentas.warn;
  $('cntHot').textContent = cuentas.hot;
  $('motoresResumen').textContent = maximo
    ? `${motores.length} motores · más caliente: ${maximo.nombre || 'motor ' + maximo.id} (${fmt(maximo.temperatura, 1)} °C)`
    : '';
}

/* --- Selección de motores para el gráfico --- */
function alternarMotor(id) {
  const i = estado.seleccion.indexOf(id);
  if (i >= 0) {
    estado.seleccion.splice(i, 1);
    estado.colores.delete(id);
  } else {
    if (estado.seleccion.length >= MAX_SELECCION) {
      const viejo = estado.seleccion.shift();
      estado.colores.delete(viejo);
    }
    const usados = new Set(estado.colores.values());
    estado.colores.set(id, PALETA.find((c) => !usados.has(c)) || PALETA[0]);
    estado.seleccion.push(id);
  }
  marcarFilasSeleccionadas();
  sincronizarChartMotores();
}

function marcarFilasSeleccionadas() {
  filas.forEach((f, id) => {
    const on = estado.seleccion.includes(id);
    f.chk.checked = on;
    f.tr.classList.toggle('sel', on);
    if (on) f.tr.style.setProperty('--fila-color', estado.colores.get(id));
    else f.tr.style.removeProperty('--fila-color');
  });
}

/* ---------------------------------------------------------------------
   5. Panel IMU
   --------------------------------------------------------------------- */
const PX_POR_GRADO = 2.2;   // escala vertical del horizonte artificial

function construirHorizonte() {
  const svg = $('horizonte');
  let marcas = '';
  for (const p of [-30, -20, -10, 10, 20, 30]) {
    const y = -p * PX_POR_GRADO;          // pitch positivo: por encima del horizonte
    const largo = Math.abs(p) % 20 === 0 ? 26 : 14;
    marcas += `<line class="marca-p" x1="${-largo}" x2="${largo}" y1="${y}" y2="${y}"/>`;
    if (largo === 26) marcas += `<text class="marca-t" x="${largo + 4}" y="${y + 3}">${Math.abs(p)}</text>`;
  }
  svg.innerHTML = `
    <defs><clipPath id="clipHorizonte"><circle r="92"/></clipPath></defs>
    <g clip-path="url(#clipHorizonte)">
      <g id="horizonteMov">
        <rect class="cielo"  x="-400" y="-400" width="800" height="400"/>
        <rect class="tierra" x="-400" y="0"    width="800" height="400"/>
        <line class="linea-h" x1="-400" x2="400" y1="0" y2="0"/>
        ${marcas}
      </g>
    </g>
    <circle class="marco" r="94"/>
    <path class="avion" d="M-46 0 H-14 M14 0 H46"/>
    <circle class="avion-c" r="3.5"/>`;
}

function actualizarIMU(imu) {
  $('roll').textContent = fmt(imu.roll, 2);
  $('pitch').textContent = fmt(imu.pitch, 2);
  $('yaw').textContent = fmt(imu.yaw, 2);
  $('ax').textContent = fmt(imu.ax, 3);
  $('ay').textContent = fmt(imu.ay, 3);
  $('az').textContent = fmt(imu.az, 3);

  const roll = Number.isFinite(imu.roll) ? imu.roll : 0;
  const pitch = Math.max(-35, Math.min(35, Number.isFinite(imu.pitch) ? imu.pitch : 0));
  const mov = $('horizonteMov');
  if (mov) mov.setAttribute('transform', `rotate(${-roll}) translate(0 ${pitch * PX_POR_GRADO})`);
}

/* ---------------------------------------------------------------------
   6. Panel BMS
   --------------------------------------------------------------------- */
const V_MIN_CELDA = 3.0, V_MAX_CELDA = 4.2;
let celdasRefs = [];

function construirCeldas(n) {
  const cont = $('celdas');
  cont.replaceChildren();
  celdasRefs = [];
  for (let i = 0; i < n; i++) {
    const div = document.createElement('div');
    div.className = 'celda';
    div.innerHTML = '<span class="n"></span><span class="barra"><i></i></span><span class="v"></span>';
    div.querySelector('.n').textContent = `C${i + 1}`;
    cont.appendChild(div);
    celdasRefs.push({ barra: div.querySelector('i'), v: div.querySelector('.v') });
  }
}

function actualizarBMS(bms) {
  const soc = Number(bms.soc);
  $('soc').textContent = fmt(soc, 0);
  const barra = $('socRelleno');
  barra.style.width = `${Math.max(0, Math.min(100, soc || 0))}%`;
  barra.style.background = soc > 50 ? COLOR_NIVEL.ok : soc > 20 ? COLOR_NIVEL.warn : COLOR_NIVEL.hot;
  barra.parentElement.setAttribute('aria-valuenow', Number.isFinite(soc) ? soc : 0);

  $('bmsI').textContent = `${fmt(bms.corriente, 0)} mA`;
  $('bmsT').textContent = `${fmt(bms.temperatura, 1)} °C`;

  const celdas = Array.isArray(bms.celdas) ? bms.celdas : [];
  $('celdasVacio').hidden = celdas.length > 0;
  $('celdasResumen').textContent = '';
  if (celdas.length !== celdasRefs.length) construirCeldas(celdas.length);
  if (!celdas.length) return;

  celdas.forEach((v, i) => {
    const pct = ((v - V_MIN_CELDA) / (V_MAX_CELDA - V_MIN_CELDA)) * 100;
    celdasRefs[i].barra.style.width = `${Math.max(0, Math.min(100, pct))}%`;
    celdasRefs[i].v.textContent = `${fmt(v, 3)} V`;
  });
  const min = Math.min(...celdas), max = Math.max(...celdas);
  const total = celdas.reduce((a, b) => a + b, 0);
  $('celdasResumen').textContent =
    `Total ${fmt(total, 2)} V · diferencia entre celdas ${fmt((max - min) * 1000, 0)} mV`;
}

/* ---------------------------------------------------------------------
   7. Panel de fuerzas por pata
   --------------------------------------------------------------------- */
const PATAS = ['FR', 'FL', 'RR', 'RL'];

function actualizarFuerzas(f) {
  const soportado = PATAS.every((p) => p in f);
  $('fuerzasDiagrama').hidden = !soportado;
  $('fuerzasSinDatos').hidden = soportado;
  if (!soportado) { $('fuerzasResumen').textContent = ''; return; }

  let apoyadas = 0;
  PATAS.forEach((p) => {
    const on = Boolean(f[p]);
    if (on) apoyadas++;
    $('pata-' + p).classList.toggle('apoyada', on);
    const li = $('lp-' + p);
    li.classList.toggle('apoyada', on);
    li.querySelector('b').textContent = on ? 'apoyada' : 'en el aire';
  });
  $('fuerzasResumen').textContent = `${apoyadas} de ${PATAS.length} apoyadas`;
}

/* ---------------------------------------------------------------------
   8. Historial y gráficos (Chart.js)
   --------------------------------------------------------------------- */
let chartMotores = null;
let chartIMU = null;

/** Registra la muestra actual en los búferes circulares. */
function registrarHistorial(d) {
  const h = estado.hist;
  empujar(h.ts, d.ts);
  empujar(h.imu.roll, d.imu?.roll);
  empujar(h.imu.pitch, d.imu?.pitch);
  empujar(h.imu.yaw, d.imu?.yaw);
  d.motores.forEach((m) => {
    const hm = h.motores[m.id] ||= { temperatura: [], angulo: [], velocidad: [], torque: [] };
    for (const k of Object.keys(METRICAS)) empujar(hm[k], m[k]);
  });
}

/** Eje X: segundos relativos al dato más reciente (…, -2 s, -1 s, 0 s). */
function etiquetasTiempo() {
  const ts = estado.hist.ts;
  const ultimo = ts[ts.length - 1];
  return ts.map((t) => +(t - ultimo).toFixed(1));
}

/** Dibuja líneas horizontales de umbral (sólo en el gráfico de temperatura). */
const pluginUmbrales = {
  id: 'umbrales',
  beforeDatasetsDraw(chart, _args, opts) {
    if (!opts || !opts.lineas || !opts.lineas.length) return;
    const { ctx, chartArea, scales } = chart;
    ctx.save();
    ctx.setLineDash([6, 4]);
    ctx.lineWidth = 1;
    opts.lineas.forEach(({ valor, color }) => {
      const y = scales.y.getPixelForValue(valor);
      if (y < chartArea.top || y > chartArea.bottom) return;
      ctx.strokeStyle = color;
      ctx.beginPath();
      ctx.moveTo(chartArea.left, y);
      ctx.lineTo(chartArea.right, y);
      ctx.stroke();
    });
    ctx.restore();
  },
};

function opcionesGrafico(unidad, decimales) {
  const grilla = 'rgba(255,255,255,0.07)';
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { position: 'top', align: 'start', labels: { boxWidth: 10, boxHeight: 10, usePointStyle: true } },
      tooltip: {
        callbacks: {
          title: (items) => `${items[0].label} s`,
          label: (it) => ` ${it.dataset.label}: ${fmt(it.parsed.y, decimales)} ${unidad}`,
        },
      },
      umbrales: { lineas: [] },
    },
    scales: {
      x: {
        grid: { color: grilla },
        ticks: {
          maxTicksLimit: 7, maxRotation: 0,
          callback(valor) {
            // Ventana corta (recién arrancado): un decimal, para no repetir "-1 s, -1 s".
            const primera = Math.abs(Number(this.chart.data.labels[0]) || 0);
            return `${Number(this.getLabelForValue(valor)).toFixed(primera < 10 ? 1 : 0)} s`;
          },
        },
      },
      y: { grid: { color: grilla }, title: { display: true, text: unidad } },
    },
  };
}

function crearGraficos() {
  const mostrarError = (canvasId) => {
    const p = document.createElement('p');
    p.className = 'chart-error';
    p.textContent = 'No se pudo cargar Chart.js (¿sin internet?). El resto del dashboard sigue funcionando.';
    $(canvasId).replaceWith(p);
  };
  if (typeof Chart === 'undefined') {
    mostrarError('chartMotores');
    mostrarError('chartIMU');
    return;
  }

  Chart.defaults.font.family = cssVar('--font');
  Chart.defaults.color = cssVar('--muted');
  Chart.register(pluginUmbrales);

  chartMotores = new Chart($('chartMotores'), {
    type: 'line',
    data: { labels: [], datasets: [] },
    options: opcionesGrafico('°C', 1),
  });

  const serie = (etiqueta, color) => ({
    label: etiqueta, data: [], borderColor: color, backgroundColor: color,
    borderWidth: 1.6, pointRadius: 0, tension: 0.2,
  });
  chartIMU = new Chart($('chartIMU'), {
    type: 'line',
    data: {
      labels: [],
      datasets: [serie('Roll', PALETA[0]), serie('Pitch', PALETA[1]), serie('Yaw', PALETA[2])],
    },
    options: opcionesGrafico('grados', 2),
  });
}

/** Reconstruye las curvas cuando cambia la selección o la magnitud (no recrea el gráfico). */
function sincronizarChartMotores() {
  const met = METRICAS[estado.metrica];
  $('chartMotoresVacio').hidden = estado.seleccion.length > 0;
  if (!chartMotores) return;

  chartMotores.data.datasets = estado.seleccion.map((id) => ({
    motorId: id,
    label: estado.info?.motores_nombres?.[id] ?? filas[id]?.tr.querySelector('.nombre').textContent ?? `motor_${id}`,
    data: [],
    borderColor: estado.colores.get(id),
    backgroundColor: estado.colores.get(id),
    borderWidth: 1.8, pointRadius: 0, tension: 0.2,
  }));
  chartMotores.options.scales.y.title.text = met.unidad;
  chartMotores.options.plugins.tooltip.callbacks.label =
    (it) => ` ${it.dataset.label}: ${fmt(it.parsed.y, met.dec)} ${met.unidad}`;
  chartMotores.options.plugins.umbrales.lineas = estado.metrica === 'temperatura'
    ? [{ valor: UMBRAL_ATENCION, color: COLOR_NIVEL.warn }, { valor: UMBRAL_CRITICA, color: COLOR_NIVEL.hot }]
    : [];
  chartMotores.options.scales.y.suggestedMin = estado.metrica === 'temperatura' ? 25 : undefined;
  chartMotores.options.scales.y.suggestedMax = estado.metrica === 'temperatura' ? 65 : undefined;
  refrescarGraficos();
}

/** Copia los búferes a los gráficos y redibuja sin animación. */
function refrescarGraficos() {
  const etiquetas = etiquetasTiempo();
  const h = estado.hist;

  if (chartMotores) {
    chartMotores.data.labels = etiquetas;
    chartMotores.data.datasets.forEach((ds) => {
      ds.data = (h.motores[ds.motorId]?.[estado.metrica] || []).slice();
    });
    chartMotores.update('none');
  }
  if (chartIMU) {
    chartIMU.data.labels = etiquetas;
    chartIMU.data.datasets[0].data = h.imu.roll.slice();
    chartIMU.data.datasets[1].data = h.imu.pitch.slice();
    chartIMU.data.datasets[2].data = h.imu.yaw.slice();
    chartIMU.update('none');
  }
  $('imuMuestras').textContent = h.ts.length;
}

/* ---------------------------------------------------------------------
   9. Captura de muestras y exportación CSV (todo en el navegador)
   --------------------------------------------------------------------- */
function filaMuestra(d) {
  const fila = {
    fecha_hora: fechaLocal(),
    ts_robot_s: d.ts,
    modelo: d.modelo,
    // IMU
    roll_deg: d.imu?.roll, pitch_deg: d.imu?.pitch, yaw_deg: d.imu?.yaw,
    ax_ms2: d.imu?.ax, ay_ms2: d.imu?.ay, az_ms2: d.imu?.az,
    // BMS
    soc_pct: d.bms?.soc, corriente_ma: d.bms?.corriente, temp_bms_c: d.bms?.temperatura,
  };
  (d.bms?.celdas || []).forEach((v, i) => { fila[`celda_${i + 1}_v`] = v; });
  Object.entries(d.fuerzas || {}).forEach(([pata, v]) => { fila[`contacto_${pata}`] = v; });
  fila.temp_motor_max_c = Math.max(...d.motores.map((m) => m.temperatura));
  d.motores.forEach((m) => {
    const n = m.nombre || `motor_${m.id}`;
    fila[`${n}_temp_c`] = m.temperatura;
    fila[`${n}_angulo_deg`] = m.angulo;
    fila[`${n}_vel_rads`] = m.velocidad;
    fila[`${n}_torque_nm`] = m.torque;
  });
  return fila;
}

function capturarMuestra() {
  if (!estado.ultimo) return;
  estado.muestras.push(filaMuestra(estado.ultimo));
  actualizarContadorCaptura();
}

function limpiarMuestras() {
  if (!estado.muestras.length) return;
  if (!confirm(`¿Descartar las ${estado.muestras.length} muestras capturadas?`)) return;
  estado.muestras = [];
  actualizarContadorCaptura();
}

function actualizarContadorCaptura() {
  const n = estado.muestras.length;
  $('capturaEstado').textContent = `${n} ${n === 1 ? 'muestra capturada' : 'muestras capturadas'}`;
  $('btnExportar').disabled = n === 0;
  $('btnLimpiar').disabled = n === 0;
}

function celdaCSV(valor, sep) {
  if (valor === undefined || valor === null) return '';
  const s = String(valor);
  return s.includes(sep) || /["\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function exportarCSV() {
  if (!estado.muestras.length) return;
  const sep = $('separador').value;
  // Unión de columnas en orden de aparición (por si cambió el robot durante la sesión).
  const cols = [];
  const vistas = new Set();
  estado.muestras.forEach((r) => Object.keys(r).forEach((c) => {
    if (!vistas.has(c)) { vistas.add(c); cols.push(c); }
  }));
  const lineas = [
    cols.join(sep),
    ...estado.muestras.map((r) => cols.map((c) => celdaCSV(r[c], sep)).join(sep)),
  ];
  // BOM UTF-8 para que Excel respete los acentos.
  const blob = new Blob(['\ufeff' + lineas.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const ahora = new Date();
  const nombre = `telemetria_${ahora.getFullYear()}${pad(ahora.getMonth() + 1)}${pad(ahora.getDate())}` +
                 `_${pad(ahora.getHours())}${pad(ahora.getMinutes())}${pad(ahora.getSeconds())}.csv`;
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: nombre });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/* ---------------------------------------------------------------------
   10. Recepción de datos (punto único de entrada, sea WebSocket o polling)
   --------------------------------------------------------------------- */
let infoPendiente = true;

async function cargarInfo() {
  try {
    const r = await fetch(`${estado.api}/info`, { cache: 'no-store' });
    if (!r.ok) throw new Error(r.status);
    estado.info = await r.json();
    const i = estado.info;
    $('robotNombre').textContent = `${i.nombre} · ${i.tipo} · ${i.n_motores} motores · modo ${i.modo}`;
    document.title = `Telemetría ${i.nombre} — TP05`;
    $('notaDatos').textContent = notaSegunModo(i.modo);
  } catch {
    infoPendiente = true;    // se reintenta en la próxima recepción
  }
}

function notaSegunModo(modo) {
  if (modo === 'simulador') {
    return 'Modo simulador: ángulo, velocidad y yaw son reales; torque, temperatura, roll, pitch, ' +
           'contacto de patas y batería se derivan del movimiento. Con el robot real serán otros valores.';
  }
  if (modo === 'demo') {
    return 'Modo demo: todos los valores son inventados por el servidor para probar el dashboard.';
  }
  return '';
}

function prepararModelo(d) {
  estado.hist = nuevoHistorial();
  estado.seleccion = [];
  estado.colores.clear();
  construirTablaMotores(d.motores);
  d.motores.slice(0, 3).forEach((m) => alternarMotor(m.id));
  if (!d.motores.length) sincronizarChartMotores();
}

function procesar(d) {
  if (!d || !Array.isArray(d.motores)) return;   // JSON inesperado: se ignora sin romper nada
  const ahora = performance.now();
  estado.ultimo = d;
  estado.ultimoMs = ahora;
  estado.llegadas.push(ahora);

  if (infoPendiente) { infoPendiente = false; cargarInfo(); }

  const firma = `${d.modelo}|${d.motores.length}`;
  if (firma !== estado.firma) { estado.firma = firma; prepararModelo(d); }

  registrarHistorial(d);
  actualizarMotores(d.motores);
  actualizarIMU(d.imu || {});
  actualizarBMS(d.bms || {});
  actualizarFuerzas(d.fuerzas || {});
  refrescarGraficos();
  $('mTs').textContent = `${fmt(d.ts, 1)} s`;
}

/* ---------------------------------------------------------------------
   11. Transportes: WebSocket (push) y polling (REST)
   --------------------------------------------------------------------- */
let generacion = 0;      // invalida bucles/sockets viejos al cambiar de transporte o servidor
let socket = null;
let temporizador = null;

const urlWS = () => estado.api.replace(/^http/i, 'ws') + '/ws';

function detenerTransporte() {
  generacion++;
  clearTimeout(temporizador);
  if (socket) { socket.onclose = socket.onerror = socket.onmessage = null; socket.close(); socket = null; }
}

function iniciarTransporte() {
  detenerTransporte();
  estado.ultimoMs = 0;
  estado.inicioMs = performance.now();
  estado.llegadas = [];
  infoPendiente = true;
  const g = generacion;
  if (estado.transporte === 'ws') conectarWS(g, 0);
  else bucleSondeo(g);
  actualizarControlesTransporte();
}

/* --- WebSocket con reconexión exponencial (0,5 s → 5 s) --- */
function conectarWS(g, intento) {
  if (g !== generacion) return;
  const reintentar = () => {
    if (g !== generacion) return;
    temporizador = setTimeout(() => conectarWS(g, intento + 1), Math.min(500 * 2 ** intento, 5000));
  };
  let ws;
  try { ws = new WebSocket(urlWS()); } catch { reintentar(); return; }
  socket = ws;
  ws.onmessage = (e) => {
    if (g !== generacion) return;
    try { procesar(JSON.parse(e.data)); } catch (err) { console.warn('Mensaje inválido', err); }
  };
  ws.onopen = () => { intento = 0; };
  ws.onerror = () => ws.close();
  ws.onclose = () => { if (socket === ws) socket = null; reintentar(); };
}

/* --- Polling: una solicitud a la vez, a lo sumo cada POLL_MS --- */
async function bucleSondeo(g) {
  while (g === generacion) {
    const t0 = performance.now();
    try {
      const ctrl = new AbortController();
      const corte = setTimeout(() => ctrl.abort(), 2000);
      const r = await fetch(`${estado.api}/telemetria`, { signal: ctrl.signal, cache: 'no-store' });
      clearTimeout(corte);
      if (!r.ok) throw new Error(r.status);
      const datos = await r.json();
      if (g === generacion) procesar(datos);
    } catch { /* sin conexión: se mantienen los últimos valores y se reintenta */ }
    const resto = Math.max(0, POLL_MS - (performance.now() - t0));
    await new Promise((ok) => { temporizador = setTimeout(ok, resto); });
  }
}

/* ---------------------------------------------------------------------
   12. Indicador de conexión (se evalúa 4 veces por segundo)
   --------------------------------------------------------------------- */
function evaluarConexion() {
  const ahora = performance.now();
  const edad = estado.ultimoMs ? ahora - estado.ultimoMs : Infinity;

  let modo;
  if (!estado.ultimoMs) modo = ahora - estado.inicioMs > ARRANQUE_MS ? 'offline' : 'conectando';
  else modo = edad > STALE_MS ? 'offline' : 'live';

  const pill = $('pillConexion');
  if (pill.dataset.estado !== modo) {
    pill.dataset.estado = modo;
    $('pillTexto').textContent = { live: 'En vivo', conectando: 'Conectando…', offline: 'Sin conexión' }[modo];
    document.body.classList.toggle('offline', modo === 'offline');
    $('banner').hidden = modo !== 'offline';
    if (modo === 'offline') {
      infoPendiente = true;   // al volver, se vuelve a leer /info (puede haber cambiado de robot)
      $('bannerDetalle').textContent =
        `Se muestran los últimos valores recibidos. Reintentando con ${estado.api}. ` +
        'Verificá que el backend siga abierto.';
    }
  }

  // Frecuencia real de llegada (ventana de 3 s)
  estado.llegadas = estado.llegadas.filter((t) => ahora - t < 3000);
  const n = estado.llegadas.length;
  const span = n > 1 ? (estado.llegadas[n - 1] - estado.llegadas[0]) / 1000 : 0;
  $('mHz').textContent = modo === 'live' && span > 0 ? `${fmt((n - 1) / span, 1)} Hz` : '—';
  $('mEdad').textContent = Number.isFinite(edad) ? `${fmt(edad / 1000, 1)} s` : '—';

  $('btnCapturar').disabled = modo !== 'live';
}

function actualizarControlesTransporte() {
  document.querySelectorAll('[data-transporte]').forEach((b) =>
    b.setAttribute('aria-pressed', String(b.dataset.transporte === estado.transporte)));
  document.querySelectorAll('[data-metrica]').forEach((b) =>
    b.setAttribute('aria-pressed', String(b.dataset.metrica === estado.metrica)));
}

/* ---------------------------------------------------------------------
   13. Arranque
   --------------------------------------------------------------------- */
function conectarEventos() {
  $('btnCapturar').addEventListener('click', capturarMuestra);
  $('btnExportar').addEventListener('click', exportarCSV);
  $('btnLimpiar').addEventListener('click', limpiarMuestras);

  document.querySelectorAll('[data-transporte]').forEach((b) =>
    b.addEventListener('click', () => {
      if (estado.transporte === b.dataset.transporte) return;
      estado.transporte = b.dataset.transporte;
      iniciarTransporte();
    }));

  document.querySelectorAll('[data-metrica]').forEach((b) =>
    b.addEventListener('click', () => {
      estado.metrica = b.dataset.metrica;
      actualizarControlesTransporte();
      sincronizarChartMotores();
    }));

  $('formServidor').addEventListener('submit', (e) => {
    e.preventDefault();
    estado.api = normalizarApi($('inputApi').value);
    $('inputApi').value = estado.api;
    try { localStorage.setItem('tp05.api', estado.api); } catch { /* opcional */ }
    estado.firma = '';       // fuerza reconstruir la tabla si el otro servidor es otro robot
    iniciarTransporte();
  });
}

construirHorizonte();
crearGraficos();
conectarEventos();
$('inputApi').value = estado.api;
actualizarContadorCaptura();
iniciarTransporte();
setInterval(evaluarConexion, 250);
evaluarConexion();
