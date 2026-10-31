const API_URL = 'https://script.google.com/macros/s/AKfycbzq-ZwU9rCSy3mYpfjJfjs6YNnfqgY7STKJgNJgFzmuG4UFQvoDHKqD7sSLHBwysYKX/exec'; // TODO: сменить после переразвёртывания веб-приложения

const $ = id => document.getElementById(id);
const msg = (text, type = 'info') => {
  const el = $('msg');
  el.textContent = text;
  el.style.display = 'block';
  el.className = type; // error / success / info
};
const uid = () => Date.now() + '-' + Math.floor(Math.random() * 1e6);
const todayISO = () => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0'); };
const hhmmToMin = t => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(t || '')); return m ? Number(m[1]) * 60 + Number(m[2]) : NaN; };
const minToHHMM = m => String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
const ruCmp = (a, b) => String(a || '').localeCompare(String(b || ''), 'ru');
const normFio = s => String(s || '').trim().toLowerCase();

// ---------------------- УТИЛИТЫ И ЭКРАНЫ ----------------------
function showScreen(id) {
  document.querySelectorAll('div[id$="Screen"]').forEach(el => el.style.display = 'none');
  const target = $(id);
  if (target) target.style.display = 'block';
}

function esc(s) {
  if (!s) return '';
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function ruFmtShort(dateStr) {
  if (!dateStr) return '';
  const parts = dateStr.split('-');
  if (parts.length !== 3) return dateStr;
  return parts[2] + '.' + parts[1] + '.' + parts[0];
}

let me = null;
let shift = null;
let segments = [];
let doctorVisits = [];
let points = ['ОФИС'];
let interPoints = [];
let medPoints = []; 
let docNames = [];
let drivers = [];
let carEditMode = null;
let shiftsData = [];
let reportDetail = null;
let doctorsContact = [];
let clinics = [];

let docEditKey = null;
let clinicEditKey = null;

const QUEUE_KEY = 'sendQueue';
const REF_KEY = 'refCache';
const STATE_KEY = 'appState_v1';
const SHIFTS_KEY = 'shiftsCache';
const AUTH_KEY = 'authCreds';
const LAST_SEG_KEY = 'lastSegType';
const MAX_TRIES = 3;
const carLabel = c => ((c.name || '') + ' ' + (c.plate || '')).trim();

const THEME_KEY = 'theme';

function applyTheme(t) {
  document.documentElement.setAttribute('data-theme', t);
  const btn = $('themeBtn');
  if (btn) btn.textContent = t === 'dark' ? '☀️' : '🌙';
}

function initTheme() {
  const saved = localStorage.getItem(THEME_KEY);
  const system = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  applyTheme(saved === 'dark' || saved === 'light' ? saved : system);
}

function toggleTheme() {
  const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  localStorage.setItem(THEME_KEY, next);
  applyTheme(next);
}

function shiftMinutes(s) {
  const dm = parseFloat(s.durationMin);
  if (!isNaN(dm) && dm > 0) return dm;
  const d = hhmmToMin(s.duration);
  return isNaN(d) ? 0 : d;
}

// ================= АВТОРИЗАЦИЯ =================
function getAuth() {
  try { return JSON.parse(localStorage.getItem(AUTH_KEY) || 'null'); }
  catch (e) { return null; }
}
function setAuth(fio, pin) {
  localStorage.setItem(AUTH_KEY, JSON.stringify({ fio: fio, pin: pin }));
}
function clearAuth() { localStorage.removeItem(AUTH_KEY); }

async function serverAuth(action, payload) {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(Object.assign({ action: action }, payload))
  });
  let out = null;
  try { out = await res.json(); } catch (e) {}
  return out || { ok: false, error: 'некорректный ответ сервера' };
}

function showAuthTab(which) {
  $('tabLogin')?.classList.toggle('active', which === 'login');
  $('tabReg')?.classList.toggle('active', which === 'reg');
  $('loginPanel')?.style.display = which === 'login' ? 'block' : 'none';
  $('regPanel')?.style.display = which === 'reg' ? 'block' : 'none';
}

function renderLoginHints() {
  $('loginFioList')?.innerHTML = drivers
    .map(d => `<option value="${esc(d.fio)}">${esc(d.fio)}</option>`).join('');
}

async function doLogin() {
  const fio = $('loginFio')?.value.trim();
  const pin = $('loginPin')?.value.trim();
  if (!fio || !pin) { msg('Укажи ФИО и PIN'); return; }
  msg('Вхожу…');
  try {
    const out = await serverAuth('login', { fio: fio, pin: pin });
    if (out.ok) {
      setAuth(out.fio, pin);
      enterApp(out.fio, out.role || '');
      if (!shift) msg('Вход выполнен: ' + out.fio);
    } else {
      msg(out.error || 'Неверный ФИО или PIN');
    }
  } catch (e) {
    const d = drivers.find(x => normFio(x.fio) === normFio(fio));
    if (d) {
      setAuth(d.fio, pin);
      enterApp(d.fio, d.role || '');
      if (!shift) msg('Нет сети: вход по сохранённым данным. При появлении сети проверим PIN.');
    } else {
      msg('Нет сети, и это ФИО не найдено в кэше. Подключись и войди.');
    }
  }
}

async function verifyAuthOnline() {
  const auth = getAuth();
  if (!auth || !auth.pin || !me) return;
  try {
    const out = await serverAuth('login', { fio: auth.fio, pin: auth.pin });
    if (out && !out.ok) msg('Внимание: сервер не принял сохранённый PIN. Проверьте вход вручную.');
  } catch (e) { /* нет сети */ }
}

async function doRegister() {
  const fio = $('regFio')?.value.trim().replace(/\s+/g, ' ');
  const pin = $('regPin')?.value.trim();
  const car = $('regCar')?.value.trim();
  const plate = $('regPlate')?.value.trim();
  if (!fio) { msg('Укажи ФИО'); return; }
  if (!/^\d{4,8}$/.test(pin)) { msg('PIN: от 4 до 8 цифр'); return; }
  msg('Регистрирую…');
  try {
    const out = await serverAuth('register', { fio: fio, pin: pin, car: car, plate: plate });
    if (out.ok) {
      setAuth(out.fio, pin);
      if (!drivers.find(x => normFio(x.fio) === normFio(out.fio))) {
        drivers.push({ fio: out.fio, cars: car || plate ? [{ name: car, plate: plate, row: null }] : [], role: '' });
        drivers.sort((a, b) => ruCmp(a.fio, b.fio));
      }
      enterApp(out.fio, '');
      if (!shift) msg('Регистрация готова: ' + out.fio + (car || plate ? '\nАвто появится в таблице при синхронизации' : ''));
    } else {
      msg(out.error || 'Не удалось зарегистрироваться');
    }
  } catch (e) {
    msg('Нет сети: регистрация требует интернета. Подключись и повтори.');
  }
}

function enterApp(fio, role) {
  const found = drivers.find(x => normFio(x.fio) === normFio(fio));
  me = {
    fio: found ? found.fio : fio,
    role: role || (found ? found.role : ''),
    cars: found ? (found.cars || []) : []
  };
  renderCars();
  showScreen('menuScreen');
  renderDashboard();
  if (shift) showRestoredShiftInfo();
}

function doLogout() {
  clearAuth();
  me = null;
  showScreen('loginScreen');
  $('loginFio')?.value = ''; $('loginPin')?.value = '';
  msg('');
}

// ================= СОСТОЯНИЕ СМЕНЫ =================
function saveState() {
  try {
    localStorage.setItem(STATE_KEY, JSON.stringify({
      shift: shift, segments: segments, doctorVisits: doctorVisits,
      segType: $('segType') ? $('segType').value : 'city'
    }));
  } catch (e) { console.warn('Не удалось сохранить состояние:', e); }
}
function loadState() {
  const raw = localStorage.getItem(STATE_KEY);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}
function clearState() { localStorage.removeItem(STATE_KEY); }

function showRestoredShiftInfo() {
  msg(`⚠️ Восстановлена незавершённая смена от ${ruFmtShort(shift.date)}`);
}

// ================= ОФЛАЙН-ОЧЕРЕДЬ =================
function loadQueue() {
  try { return JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]'); }
  catch (e) { return []; }
}
function saveQueue(q) { localStorage.setItem(QUEUE_KEY, JSON.stringify(q)); }
function enqueue(records) {
  const q = loadQueue();
  q.push({ ts: new Date().toISOString(), tries: 0, records: records });
  saveQueue(q);
}

async function postRecords(records) {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ records: records })
  });
  let out = null;
  try { out = await res.json(); } catch (e) {}
  if (out && out.ok) return { ok: true, out: out };
  return { ok: false, error: out ? (out.error || 'ошибка сервера') : 'некорректный ответ' };
}

async function sendOrQueue(records) {
  try {
    const r = await postRecords(records);
    if (r.ok) return { sent: true, out: r.out };
    enqueue(records);
    return { sent: false, error: r.error, queued: true };
  } catch (e) {
    enqueue(records);
    return { sent: false, queued: true };
  }
}

let flushing = false;
async function flushQueue() {
  if (flushing) return;
  flushing = true;
  try {
    const q = loadQueue();
    if (!q.length) return;
    let sent = 0;
    while (q.length) {
      const item = q[0];
      try {
        const r = await postRecords(item.records);
        if (r.ok) { q.shift(); saveQueue(q); sent++; continue; }
        item.tries = (item.tries || 0) + 1;
        if (item.tries >= MAX_TRIES) {
          msg('Сервер отклонил пакет после ' + MAX_TRIES + ' попыток (' + (r.error || 'ошибка') + '). Пакет пропущен — сообщите старшему.');
          q.shift();
        }
        saveQueue(q);
        break;
      } catch (e) {
        saveQueue(q);
        break;
      }
    }
    if (sent) {
      const left = loadQueue().length;
      msg(left ? `Очередь отправлена: ${sent} пакет(ов). В очереди осталось: ${left}`
               : `Очередь отправлена: ${sent} пакет(ов). Всё синхронизировано.`);
    }
  } finally {
    flushing = false;
  }
}
window.addEventListener('online', flushQueue);
setInterval(flushQueue, 60000);

// ================= ДАННЫЕ =================
function isSupervisor(d) {
  return String((d && d.role) || '').toLowerCase().indexOf('старший') !== -1;
}

function applyRefs(data) {
  drivers = Array.isArray(data.drivers) ? data.drivers : [];
  drivers.sort((a, b) => ruCmp(a.fio, b.fio));
  if (Array.isArray(data.points) && data.points.length) {
    points = Array.from(new Set(['ОФИС'].concat(data.points)));
  }
  if (Array.isArray(data.interPoints)) interPoints = Array.from(new Set(data.interPoints));
  if (Array.isArray(data.medPoints)) medPoints = Array.from(new Set(data.medPoints));
  if (Array.isArray(data.docNames)) docNames = Array.from(new Set(data.docNames));
  if (Array.isArray(data.doctorsContact)) doctorsContact = data.doctorsContact;
  if (Array.isArray(data.clinics)) clinics = data.clinics;
  
  renderSegPoints();
  renderDocPlaceList();
  renderDocNames();
  renderLoginHints();
  
  if (me) {
    const found = drivers.find(x => normFio(x.fio) === normFio(me.fio));
    if (found) { me.cars = found.cars || []; me.role = found.role || me.role; }
    renderCars();
  }
}

async function loadDrivers() {
  try {
    const out = await (await fetch(API_URL)).json();
    localStorage.setItem(REF_KEY, JSON.stringify(out));
    if (Array.isArray(out.shifts)) {
      shiftsData = out.shifts;
      localStorage.setItem(SHIFTS_KEY, JSON.stringify(shiftsData));
    }
    applyRefs(out);
    verifyAuthOnline();
  } catch (e) {
    let cached = null;
    try { cached = JSON.parse(localStorage.getItem(REF_KEY) || 'null'); } catch (err) {}
    if (cached) {
      applyRefs(cached);
      if (!me) msg('Нет сети: работаем на сохранённых справочниках.\nСмены и правки сохранятся в очереди и уйдут автоматически.');
    } else if (!me) {
      msg('Нет сети и нет сохранённых данных. Подключись и открой снова.');
    }
  }
  flushQueue();
}

function renderCars() {
  if (!me) return;
  const cars = (me.cars || []).slice().sort((a, b) => ruCmp(carLabel(a), carLabel(b)));
  if (shift && shift.carLabel && !cars.find(c => carLabel(c) === shift.carLabel)) {
    cars.unshift({ name: shift.carLabel, plate: '', row: null });
  }
  const sel = $('carSel');
  if (!sel) return;
  sel.innerHTML = '';
  cars.forEach(c => {
    const opt = document.createElement('option');
    opt.value = carLabel(c);
    opt.textContent = carLabel(c);
    sel.appendChild(opt);
  });
  if (shift && shift.carLabel) {
    sel.value = shift.carLabel;
  } else if (cars.length) {
    sel.selectedIndex = 0;
  }
}

function onCarChange() {
  const val = $('carSel').value;
  if (!val) return;
  $('carPanel').style.display = 'none';
  if (shift) shift.carLabel = val;
  saveState();
}

function openCarEdit() {
  $('carPanel').style.display = 'block';
  const c = $('carSel').value ? me.cars.find(x => carLabel(x) === $('carSel').value) : null;
  $('carNameInput').value = c ? c.name : '';
  $('carPlateInput').value = c ? c.plate : '';
}

function saveCar() {
  const name = $('carNameInput').value.trim();
  const plate = $('carPlateInput').value.trim();
  if (!name && !plate) { msg('Укажи марку или госномер'); return; }
  const label = (name + ' ' + plate).trim();
  let found = me.cars.find(x => carLabel(x) === label);
  if (!found) {
    me.cars.push({ name: name, plate: plate, row: null });
    me.cars.sort((a, b) => ruCmp(carLabel(a), carLabel(b)));
    msg('Авто добавлено');
  } else {
    found.name = name;
    found.plate = plate;
    msg('Данные авто обновлены');
  }
  renderCars();
  $('carPanel').style.display = 'none';
}

// ---------------------- СМЕНЫ И СЕГМЕНТЫ ----------------------
function openWork() {
  showScreen('workScreen');
  const state = loadState();
  if (state) {
    shift = state.shift;
    segments = state.segments || [];
    doctorVisits = state.doctorVisits || [];
    if (shift) {
      $('startCard').style.display = 'none';
      $('shiftCard').style.display = 'block';
      showRestoredShiftInfo();
      renderSegPoints();
      renderDocPlaceList();
      renderDocNames();
      updateShiftDisplay();
    } else {
      $('startCard').style.display = 'block';
      $('shiftCard').style.display = 'none';
    }
  } else {
    $('startCard').style.display = 'block';
    $('shiftCard').style.display = 'none';
  }
}

function startShift() {
  const date = $('shiftDate').value;
  const time = $('timeStart').value;
  const odo = parseFloat($('odoStart').value);
  const car = $('carSel').value;
  if (!date || !time) { msg('Выбери дату и время'); return; }
  shift = {
    id: uid(),
    date: date,
    timeStart: time,
    odoStart: odo || 0,
    carLabel: car,
    status: 'active'
  };
  segments = [];
  doctorVisits = [];
  saveState();
  $('startCard').style.display = 'none';
  $('shiftCard').style.display = 'block';
  updateShiftDisplay();
  msg('Смена начата');
}

function updateShiftDisplay() {
  if (!shift) return;
  $('#curCarLabel').textContent = shift.carLabel || 'Авто не выбрано';
  $('#curDriverName').textContent = me ? me.fio : 'Неизвестен';
  $('#curShiftDate').textContent = ruFmtShort(shift.date);
  $('#curTimeStart').textContent = shift.timeStart;
}

function onSegTypeChange() {
  localStorage.setItem(LAST_SEG_KEY, $('segType').value);
}

function renderSegPoints() {
  const list = $('segPointsList');
  if (!list) return;
  list.innerHTML = '';
  const all = Array.from(new Set(['ОФИС'].concat(points, interPoints)));
  all.sort(ruCmp);
  all.forEach(p => {
    const opt = document.createElement('option');
    opt.value = p;
    opt.textContent = p;
    list.appendChild(opt);
  });
}

function addSegment() {
  const type = $('segType').value;
  const from = $('segFrom').value.trim();
  const to = $('segTo').value.trim();
  const km = parseFloat($('segKm').value);
  if (!from || !to) { msg('Укажи откуда и куда'); return; }
  const seg = {
    id: uid(),
    type: type,
    from: from,
    to: to,
    km: km || 0
  };
  segments.push(seg);
  saveState();
  $('segFrom').value = ''; $('segTo').value = ''; $('segKm').value = '';
  msg('Отрезок добавлен');
}

function addDoctorVisit() {
  const doc = $('docName').value.trim();
  const place = $('docPlace').value.trim();
  const tApp = $('docTimeApp').value;
  const tBoard = $('docTimeBoard').value;
  if (!doc || !place) { msg('Укажи врача и место'); return; }
  const visit = {
    id: uid(),
    doc: doc,
    place: place,
    timeApp: tApp,
    timeBoard: tBoard
  };
  doctorVisits.push(visit);
  saveState();
  $('docName').value = ''; $('docPlace').value = ''; $('docTimeApp').value = ''; $('docTimeBoard').value = '';
  msg('Перевозка врача добавлена');
}

function finishShift() {
  const timeEnd = $('timeEnd').value;
  const refuel = parseFloat($('refuel').value) || 0;
  if (!timeEnd) { msg('Укажи время окончания'); return; }
  shift.timeEnd = timeEnd;
  shift.refuel = refuel;
  shift.status = 'closed';
  
  // Формируем пакет для отправки
  const payload = {
    action: 'saveShift',
    shift: shift,
    segments: segments,
    doctorVisits: doctorVisits
  };
  
  sendOrQueue([payload]).then(r => {
    if (r.sent) {
      msg('Смена завершена и отправлена');
      clearState();
      shift = null; segments = []; doctorVisits = [];
      showScreen('menuScreen');
      renderDashboard();
    } else {
      msg(r.queued ? 'Смена завершена, но отправлена в очередь (нет сети)' : 'Ошибка отправки');
    }
  });
}

// ---------------------- СПРАВОЧНИКИ ----------------------
function renderDocPlaceList() {
  const list = $('docPlaceList');
  if (!list) return;
  list.innerHTML = '';
  const all = Array.from(new Set(medPoints.concat(points)));
  all.sort(ruCmp);
  all.forEach(p => {
    const opt = document.createElement('option');
    opt.value = p;
    opt.textContent = p;
    list.appendChild(opt);
  });
}

function renderDocNames() {
  const list = $('docNamesList');
  if (!list) return;
  list.innerHTML = '';
  docNames.sort(ruCmp).forEach(d => {
    const opt = document.createElement('option');
    opt.value = d;
    opt.textContent = d;
    list.appendChild(opt);
  });
}

function openRefs() {
  showScreen('refsScreen');
  renderRefsDoc();
  renderRefsCls();
}

function renderRefsDoc() {
  const q = ($('refSearchDoc')?.value || '').toLowerCase();
  const container = $('#docsCard');
  container.innerHTML = '<h4>Врачи</h4>';
  const filtered = doctorsContact.filter(x => normFio(x.fio).includes(q));
  filtered.forEach(d => {
    const div = document.createElement('div');
    div.className = 'ref-item';
    div.innerHTML = `
      <b>${esc(d.fio)}</b>
      ${d.addr ? '<br><small>' + esc(d.addr) + '</small>' : ''}
      ${d.tel ? '<br><small>Тел: ' + esc(d.tel) + '</small>' : ''}
      <br><small>${d.route ? '<a href="' + esc(d.route) + '" target="_blank">Маршрут</a>' : ''}</small>
      <button style="margin-top:6px; padding:4px 8px; font-size:12px;" onclick="editDoc(' + JSON.stringify(d).replace(/"/g, '\\"') + ')">✏️</button>
    `;
    container.appendChild(div);
  });
}

function editDoc(data) {
  docEditKey = data.id;
  $('#docFormTitle').textContent = 'Редактировать врача';
  $('#docFio').value = data.fio || '';
  $('#docAddr').value = data.addr || '';
  $('#docTel').value = data.tel || '';
  $('#docRoute').value = data.route || '';
  $('#docFormCard').style.display = 'block';
}

function closeDocForm() {
  $('#docFormCard').style.display = 'none';
  docEditKey = null;
}

function saveDocForm() {
  const fio = $('#docFio').value.trim();
  const addr = $('#docAddr').value.trim();
  const tel = $('#docTel').value.trim();
  const route = $('#docRoute').value.trim();
  if (!fio) { msg('ФИО обязательно'); return; }
  const payload = {
    action: docEditKey ? 'updateDoc' : 'addDoc',
    doc: { id: docEditKey, fio, addr, tel, route }
  };
  sendOrQueue([payload]).then(r => {
    if (r.sent) {
      loadDrivers(); // обновить справочники
      closeDocForm();
      msg('Врач сохранён');
    } else {
      msg('Сохранено в очередь');
      closeDocForm();
    }
  });
}

function renderRefsCls() {
  const q = ($('refSearchCls')?.value || '').toLowerCase();
  const container = $('#clsCard');
  container.innerHTML = '<h4>Клиники</h4>';
  const filtered = clinics.filter(x => (normFio(x.city) || '').includes(q) || (normFio(x.name) || '').includes(q));
  filtered.forEach(c => {
    const div = document.createElement('div');
    div.className = 'ref-item';
    div.innerHTML = `
      <b>${esc(c.name)}</b><br>
      ${c.city ? esc(c.city) + ', ' : ''}${c.addr ? esc(c.addr) : ''}<br>
      ${c.tel ? 'Тел: ' + esc(c.tel) : ''} ${c.day ? ' | День: ' + esc(c.day) : ''}
      ${c.route ? '<br><a href="' + esc(c.route) + '" target="_blank">Маршрут</a>' : ''}
      <button style="margin-top:6px; padding:4px 8px; font-size:12px;" onclick="editClinic(' + JSON.stringify(c).replace(/"/g, '\\"') + ')">✏️</button>
    `;
    container.appendChild(div);
  });
}

function editClinic(data) {
  clinicEditKey = data.id;
  $('#clinicFormTitle').textContent = 'Редактировать клинику';
  $('#clinicCity').value = data.city || '';
  $('#clinicName').value = data.name || '';
  $('#clinicAddr').value = data.addr || '';
  $('#clinicTel').value = data.tel || '';
  $('#clinicExtra').value = data.extra || '';
  $('#clinicRoute').value = data.route || '';
  $('#clinicDay').value = data.day || '';
  $('#clinicFormCard').style.display = 'block';
}

function closeClinicForm() {
  $('#clinicFormCard').style.display = 'none';
  clinicEditKey = null;
}

function saveClinicForm() {
  const city = $('#clinicCity').value.trim();
  const name = $('#clinicName').value.trim();
  const addr = $('#clinicAddr').value.trim();
  const tel = $('#clinicTel').value.trim();
  const extra = $('#clinicExtra').value.trim();
  const route = $('#clinicRoute').value.trim();
  const day = $('#clinicDay').value.trim();
  if (!city || !name) { msg('Город и название обязательны'); return; }
  const payload = {
    action: clinicEditKey ? 'updateClinic' : 'addClinic',
    clinic: { id: clinicEditKey, city, name, addr, tel, extra, route, day }
  };
  sendOrQueue([payload]).then(r => {
    if (r.sent) {
      loadDrivers();
      closeClinicForm();
      msg('Клиника сохранена');
    } else {
      msg('Сохранено в очередь');
      closeClinicForm();
    }
  });
}

// ---------------------- ОТЧЁТЫ И ПУТЕВЫЕ ЛИСТЫ ----------------------
function isSupervisor(d) {
  return String((d && d.role) || '').toLowerCase().indexOf('старший') !== -1;
}

function openReport() {
  if (!isSupervisor(me)) { msg('Доступ только для старшего'); return; }
  showScreen('reportScreen');
  $('#reportMonth').value = todayISO().substring(0, 7);
  $('#reportBody').innerHTML = '<p>Нажмите «Показать отчёт»</p>';
  $('#backBtn').style.display = 'none';
}

async function renderReport() {
  const month = $('#reportMonth').value;
  msg('Загружаю отчёт…');
  try {
    const out = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action: 'report', month: month })
    }).then(r => r.json());
    if (!out.ok) throw new Error(out.error || 'Ошибка сервера');
    
    const container = $('#reportBody');
    container.innerHTML = `<h3>Отчёт за ${month.replace('-', '.')}</h3>`;
    
    // Общий по водителям
    const tbl = document.createElement('table');
    tbl.innerHTML = `
      <thead><tr><th>Водитель</th><th>Смен</th><th>Км</th><th>Топливо (л)</th></tr></thead>
      <tbody></tbody>
    `;
    out.drivers.forEach(d => {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${esc(d.fio)}</td><td>${d.shifts}</td><td>${d.km}</td><td>${d.fuel}</td>`;
      tbl.querySelector('tbody').appendChild(tr);
    });
    container.appendChild(tbl);
    
    // Детализация по клику
    out.details.forEach(row => {
      const btn = document.createElement('button');
      btn.textContent = `Детали: ${row.fio} (${row.shifts})`;
      btn.onclick = () => showReportDetail(row);
      container.appendChild(btn);
      container.appendChild(document.createElement('br'));
    });
    msg('');
  } catch (e) {
    msg(e.message || 'Ошибка загрузки отчёта');
  }
}

function showReportDetail(row) {
  reportDetail = row;
  $('#reportBody').innerHTML = `<h3>Детали: ${esc(row.fio)}</h3>`;
  
  const container = $('#reportBody');
  
  // Таблица смен
  const tbl = document.createElement('table');
  tbl.innerHTML = `
    <thead>
      <tr>
        <th>Дата</th>
        <th>Старт</th><th>Конец</th>
        <th>Авто</th>
        <th>Км</th>
        <th>Топливо (л)</th>
      </tr>
    </thead>
    <tbody></tbody>
  `;
  
  row.shifts.forEach(s => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${ruFmtShort(s.date)}</td>
      <td>${s.timeStart || '-'}</td>
      <td>${s.timeEnd || '-'}</td>
      <td>${esc(s.carLabel || '-')}</td>
      <td>${s.km || 0}</td>
      <td>${s.fuel || 0}</td>
    `;
    tbl.querySelector('tbody').appendChild(tr);
  });
  container.appendChild(tbl);
  
  // Кнопка скачивания путевых листов
  const btn = document.createElement('button');
  btn.textContent = '📄 Скачать объединённый путевой лист (PDF)';
  btn.style.marginTop = '16px';
  btn.onclick = () => downloadCombinedWaybills(row);
  container.appendChild(btn);
  
  const back = document.createElement('button');
  back.textContent = '← Назад к отчёту';
  back.style.marginTop = '8px';
  back.onclick = openReport;
  container.appendChild(back);
}

function downloadCombinedWaybills(driverRow) {
  msg('Формирую PDF… (это может занять несколько секунд)');
  
  // Собираем все смены водителя для путевого листа
  const shifts = driverRow.shifts || [];
  if (!shifts.length) {
    msg('Нет смен для формирования листа');
    return;
  }
  
  // Для генерации PDF в браузере без сторонних библиотек используем простой HTML → blob
  // В реальном проекте лучше подключить html2pdf.js, но здесь делаем нативно.
  
  let html = `
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="utf-8">
        <style>
          body { font-family: Arial, sans-serif; padding: 20px; }
          h1, h2 { margin: 0; }
          table { width: 100%; border-collapse: collapse; margin-top: 12px; }
          th, td { border: 1px solid #ccc; padding: 6px 8px; text-align: left; }
          .header { margin-bottom: 16px; }
          .row-group { margin-bottom: 24px; }
        </style>
      </head>
      <body>
        <div class="header">
          <h1>Путевой лист (объединённый)</h1>
          <p>Водитель: ${esc(driverRow.fio)}</p>
          <p>Период: ${driverRow.month || 'не указан'}</p>
        </div>
  `;
  
  shifts.forEach((s, idx) => {
    html += `
      <div class="row-group">
        <h2>Смена №${idx + 1} — ${ruFmtShort(s.date)}</h2>
        <table>
          <tr><th>Авто</th><th>Старт</th><th>Конец</th><th>Пробег (км)</th><th>Топливо (л)</th></tr>
          <tr>
            <td>${esc(s.carLabel || '-')}</td>
            <td>${s.timeStart || '-'}</td>
            <td>${s.timeEnd || '-'}</td>
            <td>${s.km || 0}</td>
            <td>${s.fuel || 0}</td>
          </tr>
        </table>
        ${s.segments && s.segments.length ? `
          <p><b>Отрезки маршрута:</b></p>
          <table>
            <tr><th>Тип</th><th>Откуда</th><th>Куда</th><th>Км</th></tr>
            ${s.segments.map(seg => `
              <tr>
                <td>${seg.type || '-'}</td>
                <td>${esc(seg.from || '-')}</td>
                <td>${esc(seg.to || '-')}</td>
                <td>${seg.km || 0}</td>
              </tr>
            `).join('')}
          </table>
        ` : ''}
        ${s.doctorVisits && s.doctorVisits.length ? `
          <p><b>Перевозки врачей:</b></p>
          <table>
            <tr><th>Врач</th><th>Место</th><th>Время записи</th><th>Время посадки</th></tr>
            ${s.doctorVisits.map(v => `
              <tr>
                <td>${esc(v.doc || '-')}</td>
                <td>${esc(v.place || '-')}</td>
                <td>${v.timeApp || '-'}</td>
                <td>${v.timeBoard || '-'}</td>
              </tr>
            `).join('')}
          </table>
        ` : ''}
      </div>
    `;
  });
  
  html += `
      </body>
    </html>
  `;
  
  const blob = new Blob([html], { type: 'text/html' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `waybill_${driverRow.fio.replace(/\s+/g, '_')}_${driverRow.month}.html`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  msg('Файл скачан как HTML. Для PDF можно распечатать в браузере (Ctrl+P → Сохранить как PDF).');
}

// ---------------------- ДАШБОРД ----------------------
function renderDashboard() {
  const cont = $('#dashBody');
  cont.innerHTML = '';
  
  const row = document.createElement('div');
  row.className = 'dash-row';
  row.innerHTML = `
    <b>Текущий водитель:</b>
    <span>${me ? me.fio : 'Не авторизован'}</span>
  `;
  cont.appendChild(row);
  
  if (me) {
    row.innerHTML += `
      <b>Роль:</b>
      <span>${me.role || 'обычный'}</span>
    `;
  }
  
  const stats = { shifts: 0, km: 0, fuel: 0 };
  shiftsData.forEach(s => {
    if (normFio(s.driver) === normFio(me ? me.fio : '')) {
      stats.shifts++;
      stats.km += (s.km || 0);
      stats.fuel += (s.fuel || 0);
    }
  });
  
  const statRow = document.createElement('div');
  statRow.className = 'dash-row';
  statRow.innerHTML = `
    <b>Всего смен (текущий месяц):</b> <span>${stats.shifts}</span>
    <b>Пробег:</b> <span>${stats.km} км</span>
    <b>Топливо:</b> <span>${stats.fuel} л</span>
  `;
  cont.appendChild(statRow);
  
  const last = shiftsData
    .filter(s => normFio(s.driver) === normFio(me ? me.fio : ''))
    .sort((a, b) => new Date(b.date) - new Date(a.date))[0];
  
  if (last) {
    const lastRow = document.createElement('div');
    lastRow.className = 'dash-row extra';
    lastRow.innerHTML = `
      Последняя смена: ${ruFmtShort(last.date)} — авто: ${esc(last.carLabel || '-')}
    `;
    cont.appendChild(lastRow);
  } else {
    const noLast = document.createElement('div');
    noLast.className = 'extra';
    noLast.textContent = 'Нет завершённых смен в базе';
    cont.appendChild(noLast);
  }
}

// ---------------------- ИНИЦИАЛИЗАЦИЯ ----------------------
async function initApp() {
  initTheme();
  await loadDrivers();
  const auth = getAuth();
  if (auth) {
    // Попытка проверить онлайн-авторизацию
    verifyAuthOnline();
  } else {
    showScreen('loginScreen');
  }
}

document.addEventListener('DOMContentLoaded', initApp);
