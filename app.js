const API_URL = 'https://script.google.com/macros/s/AKfycbzq-ZwU9rCSy3mYpfjJfjs6YNnfqgY7STKJgNJgFzmuG4UFQvoDHKqD7sSLHBwysYKX/exec'; // URL деплоя сохраняется при «Новая версия»

const $ = id => document.getElementById(id);
const msg = t => { $('msg').textContent = t; };
const uid = () => Date.now() + '-' + Math.floor(Math.random() * 1e6);
const todayISO = () => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0'); };
const hhmmToMin = t => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(t || '')); return m ? Number(m[1]) * 60 + Number(m[2]) : NaN; };
const minToHHMM = m => String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
const ruCmp = (a, b) => String(a || '').localeCompare(String(b || ''), 'ru');
const normFio = s => String(s || '').trim().toLowerCase();

// Даты на сервере храним и отдаём в ДД.ММ.ГГГГ, а сравниваем по ISO:
// «28.10.2026» и «2026-10-28» в строковом сравнении дают неверный порядок
function isoOf(dateStr) {
  const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(String(dateStr || '').trim());
  return m ? m[3] + '-' + m[2] + '-' + m[1] : String(dateStr || '');
}

// ================= ФОРМАТЕРЫ ПОЛЕЙ =================
// СНИЛС: только цифры, максимум 11, вид «073-006-224 14»
function fmtSnils(v) {
  const d = String(v || '').replace(/\D/g, '').slice(0, 11);
  let out = d.slice(0, 3);
  if (d.length > 3) out += '-' + d.slice(3, 6);
  if (d.length > 6) out += '-' + d.slice(6, 9);
  if (d.length > 9) out += ' ' + d.slice(9, 11);
  return out;
}

// ВУ номер: только цифры, максимум 10, вид «18 16 523567»
function fmtVu(v) {
  const d = String(v || '').replace(/\D/g, '').slice(0, 10);
  let out = d.slice(0, 2);
  if (d.length > 2) out += ' ' + d.slice(2, 4);
  if (d.length > 4) out += ' ' + d.slice(4, 10);
  return out;
}

// Телефон собственника: только цифры, максимум 11, вид «+7 (912) 345-67-89».
// «8 …» и 10 цифр без кода страны приводим к +7; пусто — можно
function fmtPhone(v) {
  let d = String(v || '').replace(/\D/g, '');
  if (!d) return '';
  if (d.length === 10) d = '7' + d;        // без кода страны → +7
  if (d[0] === '8') d = '7' + d.slice(1);  // 8 → +7
  if (d.length > 11) d = d.slice(0, 11);
  const rest = d.slice(1);
  let out = '+' + d[0];
  if (rest.length) out += ' (' + rest.slice(0, Math.min(3, rest.length));
  if (rest.length >= 3) out += ')';
  if (rest.length > 3) out += ' ' + rest.slice(3, 6);
  if (rest.length > 6) out += '-' + rest.slice(6, 8);
  if (rest.length > 8) out += '-' + rest.slice(8, 10);
  return out;
}

// Приводит дату любого известного формата к ISO (ГГГГ-ММ-ДД) — для type="date"
// Из любого формата даты в ISO «2020-02-15» — для input type="date"
function isoFromAny(s) {
  s = String(s || '').trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return m[1] + '-' + m[2] + '-' + m[3];
  m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (m) return m[3] + '-' + m[2].padStart(2, '0') + '-' + m[1].padStart(2, '0');
  return '';
}

// ISO (ГГГГ-ММ-ДД) → ДД.ММ.ГГГГ — формат хранения дат на сервере
function ruFromIso(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || '').trim());
  return m ? m[3] + '.' + m[2] + '.' + m[1] : '';
}

let me = null;
let shift = null;
let segments = [];
let doctorVisits = [];
let points = ['ОФИС'];
let interPoints = [];
let medPoints = []; // «Куда везём врача» — лист MedPoints
let docNames = [];
let drivers = [];
let carsRef = [];
let carsByFio = {};
let carEditMode = null;  // 'new' | 'edit'
let carEditId = null;    // id авто на листе Cars (или null)
let shiftsData = [];
let doctorsAll = [];   // все перевозки (для аналитики БигБоса)
let geoPoints = [];   // точки маршрута: база, врачи, клиники (координаты из справочников)
let reportDetail = null;
let myStats = null;      // данные личной статистики: { segs, doctors } по id смен
let doctorsContact = [];
let rolesCluster = [];   // кластер ролей для выбора из списка
let tariffs = [];        // история тарифов: {id, from, type: 'km'|'hour', sum}
let clinics = [];
let docAddresses = [];  // дополнительные адреса врачей с координатами
// Формы справочника: null = добавление, ключ = правка
let docEditKey = null;
let clinicEditKey = null;
let drvEditKey = null; // null = добавление, ключ = ФИО водителя в нижнем регистре

const QUEUE_KEY = 'sendQueue';
const REF_KEY = 'refCache';
const STATE_KEY = 'appState_v2'; // v1 хранил смену с «город/трасса» — новая структура
const SHIFTS_KEY = 'shiftsCache';
const AUTH_KEY = 'authCreds';
const MAX_TRIES = 3; // попыток на пакет до пропуска
const carLabel = c => (((c && c.name) || '') + ' ' + ((c && c.plate) || '')).trim();

// Личное авто видит только владелец (или авто без владельца), рабочее — все
function myCars(m) {
  const seen = {};
  const out = [];
  (carsByFio[normFio(m && m.fio)] || []).forEach(c => {
    // дубли (рабочие авто повторяются у каждого) — по одному разу
    if (c.id) { if (seen[c.id]) return; seen[c.id] = true; }
    out.push(c);
  });
  return out;
}

// ================= ТЕМА =================
const THEME_KEY = 'theme';

function applyTheme(t) {
  document.documentElement.setAttribute('data-theme', t);
  const btn = $('themeBtn');
  if (btn) btn.textContent = t === 'dark' ? '☀️' : '🌙';
}

// По умолчанию — тема системы; ручной выбор сохраняется и приоритетнее
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

// Продолжительность смены в минутах: сначала колонка «в минутах», затем чч:мм
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
  $('tabLogin').classList.toggle('active', which === 'login');
  $('tabReg').classList.toggle('active', which === 'reg');
  $('loginPanel').style.display = which === 'login' ? 'block' : 'none';
  $('regPanel').style.display = which === 'reg' ? 'block' : 'none';
}

// Заполнители <datalist> не нужны: подсказки теперь делает механизм ac
function renderLoginHints() {}

async function doLogin() {
  const fio = $('loginFio').value.trim();
  const pin = $('loginPin').value.trim();
  if (!fio || !pin) { msg('Укажи ФИО и PIN'); return; }
  msg('Вхожу…');
  try {
    const out = await serverAuth('login', { fio: fio, pin: pin });
    if (out.ok) {
      setAuth(out.fio, pin);
      enterApp(out.fio, out.role || '', out.driverId || '');
      // Инфо о восстановленной смене показал enterApp — не затираем её
      if (!shift) msg('Вход выполнен: ' + out.fio);
    } else {
      msg(out.error || 'Неверный ФИО или PIN');
    }
  } catch (e) {
    const d = drivers.find(x => normFio(x.fio) === normFio(fio));
    if (d) {
      setAuth(d.fio, pin);
      enterApp(d.fio, d.role || '', d.id || '');
      if (!shift) msg('Нет сети: вход по сохранённым данным. При появлении сети проверим PIN.');
    } else {
      msg('Нет сети, и это ФИО не найдено в кэше. Подключись и войди.');
    }
  }
}

// Тихая перепроверка сохранённого PIN при появлении сети.
// Не разлогиниваем (чтобы не убить открытую смену), только предупреждаем.
async function verifyAuthOnline() {
  const auth = getAuth();
  if (!auth || !auth.pin || !me) return;
  try {
    const out = await serverAuth('login', { fio: auth.fio, pin: auth.pin });
    if (out && !out.ok) msg('Внимание: сервер не принял сохранённый PIN. Проверьте вход вручную.');
  } catch (e) { /* нет сети — проверим при следующем онлайне */ }
}

async function doRegister() {
  const fio = $('regFio').value.trim().replace(/\s+/g, ' ');
  const pin = $('regPin').value.trim();
  const car = $('regCar').value.trim();
  const plate = $('regPlate').value.trim();
  if (!fio) { msg('Укажи ФИО'); return; }
  if (!/^\d{4,8}$/.test(pin)) { msg('PIN: от 4 до 8 цифр'); return; }
  msg('Регистрирую…');
  try {
    const out = await serverAuth('register', { fio: fio, pin: pin, car: car, plate: plate });
    if (out.ok) {
      setAuth(out.fio, pin);
      if (!drivers.find(x => normFio(x.fio) === normFio(out.fio))) {
        drivers.push({ id: out.driverId || '', fio: out.fio, role: '' });
        drivers.sort((a, b) => ruCmp(a.fio, b.fio));
      }
      // Авто при регистрации — личная машина водителя: отдельная запись
      // type: 'car' уходит на сервер (лист Cars), локально показываем сразу
      let carSent = true;
      if (car || plate) {
        const r2 = await sendOrQueue([{
          id: 'car-' + uid(), type: 'car',
          car: car, plate: plate, own: 'личная', driverId: out.driverId || ''
        }]);
        carSent = r2.sent;
        carsRef.push({ id: '', driverId: out.driverId || '', own: 'личная',
          name: car, plate: plate, row: null });
      }
      enterApp(out.fio, '', out.driverId || '');
      if (!shift) {
        msg('Регистрация готова: ' + out.fio +
          (car || plate
            ? (carSent ? '\nАвтомобиль записан на сервере'
                       : '\nНет сети: автомобиль в очереди, уйдёт при синхронизации')
            : ''));
      }
    } else {
      msg(out.error || 'Не удалось зарегистрироваться');
    }
  } catch (e) {
    msg('Нет сети: регистрация требует интернета. Подключись и повтори.');
  }
}

function enterApp(fio, role, driverId) {
  const found = drivers.find(x => normFio(x.fio) === normFio(fio)) || {};
  me = {
    id: driverId || found.id || '',
    fio: found.fio || fio,
    role: role || found.role || '',
    cars: myCars({ fio: found.fio || fio })   // поиск списка машин по ФИО
  };
  renderCars();
  if (isBigBoss(me)) { openBoss(); return; }
  showScreen('menuScreen');
  renderDashboard();
  // При любом способе входа показываем состояние незавершённой смены
  if (shift) showRestoredShiftInfo();
}

function doLogout() {
  clearAuth();
  me = null;
  showScreen('loginScreen');
  $('loginFio').value = ''; $('loginPin').value = '';
  msg('');
}

// ================= СОСТОЯНИЕ СМЕНЫ =================
function saveState() {
  try {
    localStorage.setItem(STATE_KEY, JSON.stringify({
      shift: shift, segments: segments, doctorVisits: doctorVisits
    }));
  } catch (e) { console.warn('Не удалось сохранить состояние:', e); }
}
function loadState() {
  const raw = localStorage.getItem(STATE_KEY);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}
function clearState() { localStorage.removeItem(STATE_KEY); }

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

// Любой неуспех (сеть или отказ сервера) — пакет в очередь, данные не теряются
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

let flushing = false; // защита от параллельного запуска (online + интервал + loadDrivers)
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
        // Сервер отказал: ретраим до MAX_TRIES раз, потом пропускаем пакет,
        // чтобы один «ядовитый» пакет не заблокировал всю очередь навсегда
        item.tries = (item.tries || 0) + 1;
        if (item.tries >= MAX_TRIES) {
          msg('Сервер отклонил пакет после ' + MAX_TRIES + ' попыток (' + (r.error || 'ошибка') + '). Пакет пропущен — сообщите старшему.');
          q.shift();
        }
        saveQueue(q);
        break;
      } catch (e) {
        // сеть недоступна — пакет остаётся, попробуем позже
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

  // Личные машины лежат в массиве своего владельца (без driverId внутри записи),
  // рабочие (j-) сервер дублирует в список каждого. Храним списки по ФИО водителя
  // + плоский список для совместимости; поле personal (с сервера) приводим к own.
  carsRef = [];
  carsByFio = {};
  drivers.forEach(d => {
    const list = (d.cars || []).map(c =>
      Object.assign({}, c, { own: c.own || (c.personal ? 'личная' : '') }));
    carsByFio[normFio(d.fio)] = list;
    list.forEach(c => carsRef.push(c));
  });

  if (Array.isArray(data.points) && data.points.length) {
    points = Array.from(new Set(['ОФИС'].concat(data.points)));
  }
  if (Array.isArray(data.interPoints)) interPoints = Array.from(new Set(data.interPoints));
  if (Array.isArray(data.medPoints)) medPoints = Array.from(new Set(data.medPoints));
  if (Array.isArray(data.docNames)) docNames = Array.from(new Set(data.docNames));
  if (Array.isArray(data.doctorsContact)) doctorsContact = data.doctorsContact;
  if (Array.isArray(data.clinics)) clinics = data.clinics;
  if (Array.isArray(data.docAddresses)) docAddresses = data.docAddresses;
  if (Array.isArray(data.roles)) rolesCluster = data.roles.slice();
  drivers.forEach(d => {
    const v = String(d.role || '').trim();
    if (v && !rolesCluster.some(r => normFio(r) === normFio(v))) rolesCluster.push(v);
  });
  if (Array.isArray(data.tariffs)) tariffs = data.tariffs;
  if (Array.isArray(data.doctorsAll)) doctorsAll = data.doctorsAll;
  if (Array.isArray(data.geoPoints)) geoPoints = data.geoPoints;

  // Подсказки врача — только из DoctorsRef (лист «Врачи» не подмешивается)
  renderSegPoints();
  renderDocPlaceList();
  renderDocNames();
  renderLoginHints();

  if (me) {
    const found = drivers.find(x => normFio(x.fio) === normFio(me.fio));
    if (found) { me.id = found.id || me.id; me.role = found.role || me.role; }
    me.cars = myCars(me);
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
  // Авто из открытой смены обязано быть в списке, даже если справочник ещё не доехал
  if (shift && shift.carId && !cars.find(c => c.id === shift.carId)) {
    cars.unshift({ id: shift.carId, name: shift.carLabel || '', plate: '', row: null });
  }
  const optVal = c => c.id || carLabel(c);
  $('carSel').innerHTML = cars.length
    ? cars.map(c => `<option value="${esc(optVal(c))}">${esc(carLabel(c))}</option>`).join('')
    : '<option value="">— нет автомобилей —</option>';
  $('carSel').innerHTML += '<option value="__new">➕ Добавить автомобиль…</option>';
  updateCarButtons();
  $('meName').textContent = me.fio;
    // Восстанавливаем выбор: авто открытой смены, иначе последнее использованное,
  // иначе первая личная машина водителя
  if (shift && shift.carId) selectCarById(shift.carId);
  else if (!selectCarById(localStorage.getItem('lastCarId'))) {
    const own = cars.find(c => c.personal);
    if (own) selectCarById(own.id);
  }
}

function currentCar() {
  const v = $('carSel').value;
  if (!v || v === '__new') return null;
  return (me.cars || []).find(c => (c.id || carLabel(c)) === v) || null;
}

function updateCarButtons() {
  // Правка авто — в «Настройках», на экране смены кнопки нет
}

function selectCarById(id) {
  if (!id) return false;
  const opt = Array.from($('carSel').options).find(o => o.value === id);
  if (opt) { $('carSel').value = id; updateCarButtons(); return true; }
  return false;
}// Заполнители <datalist> не нужны: подсказки теперь делает механизм ac
function renderSegPoints() {}

// ============ ПОДСКАЗКИ ПОЛЕЙ: строго по началу названия ============
// Единый механизм для всех полей с подсказками — вместо <datalist>,
// который браузер фильтрует по вхождению в любом месте.
// Пустой ввод — списка нет; свободный текст разрешён везде,
// где он был разрешён раньше (canonName приводит его к канону)
function attachPrefixAc(inputId, listId, getList) {
  const input = $(inputId), box = $(listId);
  if (!input || !box) return;
  const render = () => {
    const items = acFilterPrefixed(getList(), input.value);
    if (!items.length) { box.style.display = 'none'; box.innerHTML = ''; return; }
    box.innerHTML = items.map(p => `<div class="ac-item">${esc(p)}</div>`).join('');
    box.style.display = 'block';
    Array.prototype.forEach.call(box.children, el => {
      // mousedown вместо click: срабатывает раньше blur и не теряет выбор
      el.addEventListener('mousedown', ev => {
        ev.preventDefault();
        input.value = el.textContent;
        box.style.display = 'none';
      });
    });
  };
  input.addEventListener('input', render);
  input.addEventListener('focus', render);
  input.addEventListener('blur', () => setTimeout(() => { box.style.display = 'none'; }, 150));
  input.addEventListener('keydown', e => { if (e.key === 'Escape') box.style.display = 'none'; });
}

// Источники списков — читают живые массивы: новая точка, врач или
// зарегистрированный водитель появляются в подсказках сразу
const acSegPoints  = () => Array.from(new Set(points.concat(interPoints))).sort(ruCmp);
const acDocNames   = () => docNames.slice().sort(ruCmp);
const acMedPoints  = () => medPoints.slice().sort(ruCmp);
const acDriverFios = () => drivers.map(d => d.fio).sort(ruCmp);

// Подключение полей — по одной строке на поле (ссылка на правило выше).
// Элементы есть в DOM сразу: скрипт в конце body, экраны лишь скрыты
attachPrefixAc('loginFio', 'loginFioAc', acDriverFios);
attachPrefixAc('segFrom',  'segFromAc',  acSegPoints);
attachPrefixAc('segTo',    'segToAc',    acSegPoints);
attachPrefixAc('docName',  'docNameAc',  acDocNames);
attachPrefixAc('docPlace', 'docPlaceAc', acMedPoints);

function acFilterPrefixed(list, q) {
  const s = String(q || '').trim().toLowerCase();
  if (!s) return [];
  return list.filter(p => String(p).toLowerCase().indexOf(s) === 0).slice(0, 20);
}

// Заполнители <datalist> не нужны: подсказки теперь делает механизм ac
function renderDocPlaceList() {}

// Заполнители <datalist> не нужны: подсказки теперь делает механизм ac
function renderDocNames() {}

function onCarChange() {
  if ($('carSel').value === '__new') {
    // Добавление/правка авто — в «Настройках»; выбор сбрасываем на прежний
    const restored = selectCarById(localStorage.getItem('lastCarId'));
    if (!restored) {
      const opt = Array.from($('carSel').options).find(o => o.value && o.value !== '__new');
      if (opt) { $('carSel').value = opt.value; updateCarButtons(); }
    }
    openSettings();
    openCarPanel('new');
    return;
  }
  updateCarButtons();
  if (me) localStorage.setItem('lastCarId', $('carSel').value);
}
// ================= НАСТРОЙКИ =================
function openSettings() {
  if (!me) { msg('Сначала войди'); return; }
  showScreen('settingsScreen');
  renderSettings();
}

function renderSettings() {
  if (!me) return;
  const found = drivers.find(x => normFio(x.fio) === normFio(me.fio)) || {};
  $('setFio').value = me.fio;
  $('setSnils').value = found.snils || '';
  $('setVu').value = found.vu || '';
  // type="date" принимает только ISO: хранимое ДД.ММ.ГГГГ конвертируем
  $('setVuDate').value = isoFromAny(found.vuDate) || '';
  $('setKlass').value = found.klass || '';
  // Телефон в профиле водителя больше нет — это реквизит собственника авто (Cars)
  // Роль назначает только старший
  $('setRoleBlock').style.display = isSupervisor(me) ? 'block' : 'none';
  if (isSupervisor(me)) $('setRole').value = found.role || '';
  renderSettingsCars();
  plRenderNumInto('setPlBlock', 'set');
  renderTariffs();
  const panel = $('carPanel');
  if (panel) panel.style.display = 'none';
  const btn = $('setCarBtn');
  if (btn) btn.textContent = 'Добавить автомобиль';
  carEditMode = null;
  carEditId = null;
}

function renderSettingsCars() {
  const list = $('setCarsList');
  if (!list || !me) return;
  const cars = (me.cars || []).slice().sort((a, b) => ruCmp(carLabel(a), carLabel(b)));
  list.innerHTML = cars.length
    ? cars.map(c => `
      <div class="ref-item">
        <b>${esc(carLabel(c))}</b>${c.own ? ' <span class="muted">(' + esc(c.own) + ')</span>' : ''}${c.id ? '' : ' <span class="empty">(ещё не синхронизирован)</span>'}
        <a class="edit" href="#" onclick="openCarPanel('edit','${esc(c.id || carLabel(c))}');return false">✎ править</a>
      </div>`).join('')
    : '<div class="ref-item empty">Автомобилей нет — добавьте первый ниже.</div>';
}

// mode: 'new' — новый автомобиль; 'edit' + id — правка известного серверу авто
function openCarPanel(mode, id) {
  if (!me) { msg('Сначала войди'); return; }
  carEditMode = mode;
  let c = null;
  if (mode === 'edit') {
    c = id ? me.cars.find(x => x.id === id)
            : me.cars.find(x => x.id) || me.cars[0];
    if (!c) { msg('Нет автомобиля для правки'); return; }
    if (!c.id) { msg('Автомобиль ещё не синхронизирован — правка будет доступна после синхронизации'); return; }
    $('carNameInput').value = c.name || '';
    $('carPlateInput').value = c.plate || '';
    $('carOwnInput').value = c.own || 'личная';
    $('carOwnerInput').value = c.owner || '';
    $('carAddrInput').value = c.addr || '';
    // Телефон собственника приводим к маске «+7 (ххх) ххх-хх-хх»
    $('carTelInput').value = c.tel ? fmtPhone(c.tel) : '';
    $('carOgrnInput').value = c.ogrn || '';
  } else {
    $('carNameInput').value = '';
    $('carPlateInput').value = '';
    $('carOwnInput').value = 'личная';
    $('carOwnerInput').value = '';
    $('carAddrInput').value = '';
    $('carTelInput').value = '';
    $('carOgrnInput').value = '';
  }
  carEditId = c ? (c.id || null) : null;
  const btn = $('setCarBtn');
  if (btn) btn.textContent = mode === 'edit' ? 'Сохранить автомобиль' : 'Добавить автомобиль';
  const panel = $('carPanel');
  if (panel) panel.style.display = 'block';
}

async function saveCar() {
  if (!me) { msg('Сначала войди'); return; }
  const car = $('carNameInput').value.trim();
  const plate = $('carPlateInput').value.trim();
  const own = ($('carOwnInput') ? $('carOwnInput').value : 'личная').trim() || 'личная';
  const owner = $('carOwnerInput') ? $('carOwnerInput').value.trim() : '';
  const addr = $('carAddrInput') ? $('carAddrInput').value.trim() : '';
  // Телефон собственника в каноническом виде «+7 (912) 345-67-89»
  const tel = fmtPhone($('carTelInput') ? $('carTelInput').value.trim() : '');
  const ogrn = $('carOgrnInput') ? $('carOgrnInput').value.trim() : '';
  if (!car || !plate) { msg('Укажи марку и госномер'); return; }
  // Пусто — можно; неполный номер — просим дозаполнить (как СНИЛС/ВУ)
  if (tel && tel.replace(/\D/g, '').length !== 11) {
    msg('Телефон: нужно 11 цифр, формат +7 (ххх) ххх-хх-хх');
    return;
  }
  const label = car + ' ' + plate;
  msg('Сохраняю автомобиль…');
  // В смене с отрезками сменить авто нельзя: одометр начала привязан к конкретной машине
  if (shift && segments.length > 0) {
    msg('В смене уже есть отрезки — сменить автомобиль нельзя.\nЗавершите смену и откройте новую с нужным авто.');
    $('carPanel').style.display = 'none';
    return;
  }
  // id водителя: из me.id, а если пуст — из справочника по ФИО
  const drvId = me.id || ((drivers.find(x => normFio(x.fio) === normFio(me.fio)) || {}).id || '');
  let r, saved;
  const editing = (carEditMode === 'edit' && carEditId) ? me.cars.find(x => x.id === carEditId) : null;
  if (editing) {
    // Правка по id авто на Cars: сам автомобиль в carId,
    // id пакета (care-…) — только для лога и очереди
    r = await sendOrQueue([{ id: 'care-' + uid(), type: 'caredit', carId: editing.id, row: editing.row || null,
      driverId: drvId, own: own, car: car, plate: plate,
      owner: owner, addr: addr, tel: tel, ogrn: ogrn }]);
    editing.name = car; editing.plate = plate; editing.own = own;
    editing.owner = owner; editing.addr = addr; editing.tel = tel; editing.ogrn = ogrn;
    saved = editing;
  } else {
    // Новый автомобиль: запись типа car, связь через id водителя.
    // Сервер сам присвоит id (i-…/j-…), поле id пакета в колонку не попадает
    r = await sendOrQueue([{ id: 'car-' + uid(), type: 'car', driverId: drvId,
      own: own, car: car, plate: plate,
      owner: owner, addr: addr, tel: tel, ogrn: ogrn }]);
    saved = { id: '', driverId: drvId, own: own, name: car, plate: plate,
      owner: owner, addr: addr, tel: tel, ogrn: ogrn, row: null };
    me.cars.push(saved);
  }
  // После успешной отправки подтягиваем справочник: сервер присвоил
  // новому авто свой id — клиенту он нужен, чтобы править авто позже
  if (r.sent && !saved.id) {
    try { await loadDrivers(); } catch (e) {}
    const fresh = (me.cars || []).find(c => c.name === car && c.plate === plate);
    if (fresh) saved = fresh;
  }
  // Если смена открыта без отрезков — привязываем её к новому авто
  if (shift) {
    shift.carLabel = label;
    if (saved.id) shift.carId = saved.id;
    saveState();
  }
  localStorage.setItem('lastCarId', saved.id || label);
  $('carPanel').style.display = 'none';
  renderCars();
  renderSettingsCars();
  selectCarById(saved.id || label);
  msg(r.sent ? 'Автомобиль сохранён: ' + label
             : 'Нет сети: автомобиль записан в очередь и попадёт в таблицу при синхронизации');
}

// Профиль: ФИО (через driverrename — переименует все строки), СНИЛС,
// ВУ номер, ВУ дата, класс, роль (только для старшего). Префикс/номер ПЛ —
// отдельная кнопка (plNumSave) со своей проверкой на сервере.
async function saveSettings() {
  if (!me) { msg('Сначала войди'); return; }
  const fio = $('setFio').value.trim().replace(/\s+/g, ' ');
  if (!fio) { msg('Укажи ФИО'); return; }
  // СНИЛС и ВУ приводим к каноническому виду и проверяем полноту:
  // пусто — можно, неполные цифры — просим дозаполнить
  const snilsRaw = $('setSnils').value.trim();
  const vuRaw = $('setVu').value.trim();
  const snils = fmtSnils(snilsRaw);
  const vu = fmtVu(vuRaw);
  if (snilsRaw && snilsRaw.replace(/\D/g, '').length !== 11) {
    msg('СНИЛС: нужно 11 цифр, сейчас ' + snilsRaw.replace(/\D/g, '').length);
    return;
  }
  if (vuRaw && vuRaw.replace(/\D/g, '').length !== 10) {
    msg('ВУ номер: нужно 10 цифр, сейчас ' + vuRaw.replace(/\D/g, '').length);
    return;
  }
  const profile = {
    id: 'dpr-' + uid(), type: 'driverprofile', driverId: me.id, fioOld: me.fio,
    snils: snils,
    vu: vu,
    vuDate: ruFromIso($('setVuDate').value),
    klass: $('setKlass').value.trim()
  };
  if (isSupervisor(me)) profile.role = $('setRole').value.trim();
  const recs = [profile];
  const renamed = normFio(fio) !== normFio(me.fio);
  if (renamed) {
    recs.push({ id: 'drvr-' + uid(), type: 'driverrename', fioOld: me.fio, fio: fio });
  }
  msg('Сохраняю…');
  const r = await sendOrQueue(recs);
  // Локально применяем сразу: профиль и переименование видны без сети
  const dr = drivers.find(x => normFio(x.fio) === normFio(me.fio));
  if (dr) {
    dr.snils = profile.snils; dr.vu = profile.vu;
    dr.vuDate = profile.vuDate; dr.klass = profile.klass;
    if (isSupervisor(me)) dr.role = profile.role || '';
    if (renamed) dr.fio = fio;
  }
  const auth = getAuth();
  if (auth) setAuth(fio, auth.pin);
  me.fio = fio;
  renderCars();
  renderDashboard();
  renderSettings();
  msg(r.sent ? 'Данные сохранены на сервере'
             : 'Нет сети: сохранено в телефоне, уйдёт в таблицу при синхронизации');
}

// Карточка тарифа видна только старшему
function renderTariffs() {
  const card = $('tariffCard');
  if (!card || !me) return;
  card.style.display = isSupervisor(me) ? 'block' : 'none';
  if (!isSupervisor(me)) return;
  const list = tariffs.slice().sort((a, b) => (a.from < b.from ? 1 : -1));
  $('tariffList').innerHTML = list.length
    ? list.map(t => `<div class="ref-item">с ${esc(ruFmtShort(t.from))} — ${t.type === 'km' ? 'за км' : 'за час'}: <b>${esc(t.sum)} ₽</b></div>`).join('')
    : '<div class="ref-item empty">Тарифов нет — добавьте первый.</div>';
}

async function saveTariff() {
  if (!me || !isSupervisor(me)) { msg('Тариф меняет только старший'); return; }
  // type="date" отдаёт ISO «2026-11-07» — оставляем как есть:
  // monthEarnings сравнивает даты смен в ISO, конвертация не нужна
  const from = String($('tariffFrom').value || '').trim();
  const tariffType = $('tariffType').value;
  const sum = parseFloat(String($('tariffSum').value).replace(',', '.'));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !sum || sum <= 0) {
    msg('Укажи дату и сумму тарифа'); return;
  }
  const rec = { id: 'tar-' + uid(), type: 'tariffadd', from: from, tariffType: tariffType, sum: sum };
  msg('Сохраняю тариф…');
  const r = await sendOrQueue([rec]);
  tariffs.push({ id: rec.id, from: from, type: tariffType, sum: sum });
  renderTariffs();
  renderDashboard();
  $('tariffSum').value = '';
  msg(r.sent ? 'Тариф сохранён: с ' + ruFmtShort(from)
             : 'Нет сети: тариф в очереди, уйдёт при синхронизации');
}

// Заработок месяца: смена относится к тарифу по дате смены; итог периода
// умножается на тариф своего периода, периоды складываются в одну строку
function monthEarnings(rows) {
  if (!tariffs.length) return { total: 0, partsText: '' };
  const sorted = tariffs.slice().sort((a, b) => (a.from < b.from ? -1 : 1));
  let total = 0;
  const parts = [];
  sorted.forEach((t, i) => {
    const next = (i + 1 < sorted.length) ? sorted[i + 1].from : '9999-99-99';
    let qty = 0, n = 0;
    rows.forEach(s => {
      const d = isoOf(s.date);
      if (d >= t.from && d < next) {
        n++;
        qty += (t.type === 'km') ? (parseFloat(s.totalKm) || 0) : (shiftMinutes(s) / 60);
      }
    });
    if (!n) return;
    total += qty * (t.sum || 0);
    parts.push(
      (t.type === 'km' ? qty.toFixed(1) + ' км' : qty.toFixed(1) + ' ч')
      + ' × ' + t.sum + ' ₽'
      + (n < rows.length ? ' (с ' + ruFmtShort(t.from) + ')' : '')
    );
  });
  return { total: total, partsText: parts.join(' + ') };
}

// ================= ПОДСЧЁТЫ =================
// Нормализация имени точки. В отрезках «Ижевск» НЕ подменяется «ОФИС» —
// схлопывание ОФИС/Ижевск происходит только в общем маршруте (compressRoute)
function canonName(s, list) {
  s = (s || '').trim().replace(/\s+/g, ' ');
  if (!s) return '';
  const lower = s.toLowerCase();
  if (lower === 'офис') return 'ОФИС';
  const found = (list || []).find(p => p.toLowerCase() === lower);
  if (found) return found;
  return lower.split(' ')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

function areEquivalentPoints(p1, p2) {
  const a = String(p1 || '').trim().toUpperCase();
  const b = String(p2 || '').trim().toUpperCase();
  return (a === 'ОФИС' && b === 'ИЖЕВСК') || (a === 'ИЖЕВСК' && b === 'ОФИС');
}

// Общий маршрут смены: соседние ОФИС/Ижевск схлопываются,
// крайние Ижевск (начало и конец) превращаются в ОФИС —
// смена всегда стартует и финиширует в ОФИС.
// Сравнение регистронезависимое: точки хранятся как «Ижевск», а не «ИЖЕВСК»
function compressRoute(pointsList) {
  if (!pointsList || !pointsList.length) return '';
  const up = s => String(s || '').trim().toUpperCase();
  const result = [pointsList[0]];
  for (let i = 1; i < pointsList.length; i++) {
    const last = result[result.length - 1];
    const cur = pointsList[i];
    if (cur === last) continue;
    if (areEquivalentPoints(last, cur)) continue;
    result.push(cur);
  }
  if (result.length) {
    if (up(result[0]) === 'ИЖЕВСК') result[0] = 'ОФИС'; // страховка для старых смен
    if (result.length > 1 && up(result[result.length - 1]) === 'ИЖЕВСК') result[result.length - 1] = 'ОФИС';
  }
  return result.join(', ');
}

function buildDoctorText(visitedPoints) {
  const pointSet = new Set(visitedPoints.map(p => String(p || '').trim().toUpperCase()));
  const shownPlaces = new Set();
  const entries = [];
  doctorVisits.forEach(v => {
    const place = String(v.place || '').trim().toUpperCase();
    if (!pointSet.has(place)) return;
    const diff = hhmmToMin(v.timeBoarding) - hhmmToMin(v.timeAppointed);
    let suffix = '';
    if (diff > 0) suffix = ` (опоздание ${diff} мин)`;
    else if (diff < 0) suffix = ` (раньше на ${-diff} мин)`;
    const first = !shownPlaces.has(place);
    shownPlaces.add(place);
    entries.push({ place: place, text: (first ? place + ' ' : '') + v.doctor + ' ' + v.timeBoarding, suffix: suffix });
  });
  let text = '';
  entries.forEach((e, i) => {
    const sep = i === 0 ? '' : (e.place === entries[i - 1].place ? ', ' : '\n');
    text += sep + e.text + e.suffix;
  });
  return text;
}

function durationMin(tStart, tEnd) {
  const a = hhmmToMin(tStart), b = hhmmToMin(tEnd);
  if (isNaN(a) || isNaN(b)) return 0;
  let d = b - a;
  if (d < 0) d += 24 * 60;
  return d;
}

// Добавление нового пункта в справочник: локально + запись на сервер.
function rememberRef(list, refType, name) {
  if (!name || list.includes(name)) return;
  list.push(name);
  renderSegPoints();
  renderDocPlaceList();
  sendOrQueue([{ id: (refType === 'interpoint' ? 'i-' : refType === 'medpoint' ? 'm-' : 'p-') + uid(), type: refType, name: name }]);
}

// ================= ЭКРАНЫ =================
const SCREENS = ['loginScreen', 'menuScreen', 'workScreen', 'statsScreen', 'reportScreen', 'refsScreen', 'plScreen', 'settingsScreen', 'bossScreen', 'routeScreen'];
function showScreen(name) {
  SCREENS.forEach(id => { $(id).style.display = 'none'; });
  $(name).style.display = 'block';
}

function goMenu() {
  if (isBigBoss(me)) { openBoss(); return; }
    showScreen('menuScreen');
  renderDashboard();
}

function showWork() {
  showScreen('workScreen');
  $('startCard').style.display = 'none';
  $('shiftCard').style.display = 'block';
  $('docCard').style.display = 'block';
  $('finishCard').style.display = 'block';
  // Смена авто разрешена, пока не записано ни одного отрезка:
  // после первого одометр начала смены привязан к конкретной машине
  $('carSel').disabled = !!(shift && segments.length > 0);
  renderSegPoints();
  renderDocPlaceList();
}

function showStart() {
  showScreen('workScreen');
  $('startCard').style.display = 'block';
  $('shiftCard').style.display = 'none';
  $('docCard').style.display = 'none';
  $('finishCard').style.display = 'none';
  $('carSel').disabled = false;
}

function openWork() {
  if (shift) showWork(); else showStart();
}// ================= ДАШБОРД =================
function renderDashboard() {
  if (!me) return;
  const month = todayISO().slice(0, 7);
  const rows = shiftsData.filter(s => normFio(s.driverId) === normFio(me.fio) && isoOf(s.date).startsWith(month));
  let total = 0, refuel = 0, minutes = 0;
  rows.forEach(s => {
    total += parseFloat(s.totalKm) || 0;
    refuel += parseFloat(s.refuel) || 0;
    minutes += shiftMinutes(s);
  });
  // Видимый счётчик неотправленного — главный ответ на жалобу «я ввёл, а оно пропало»
  const queued = loadQueue().length;
  const earn = monthEarnings(rows);
  $('dashCard').style.display = 'block';
  $('dashTitle').textContent = `📊 ${me.fio} — ${month}`;
  $('dashBody').innerHTML = `
    <div class="dash-row"><span>Смен</span><span>${rows.length}</span></div>
    <div class="dash-row"><span>Пробег, км</span><span>${total.toFixed(1)}</span></div>
    <div class="dash-row"><span>Заправка, л</span><span>${refuel ? refuel.toFixed(1) : '—'}</span></div>
    <div class="dash-row"><span>Продолжительность смен</span><span>${minToHHMM(minutes)}</span></div>` +
    (earn.total > 0 ? `<div class="dash-row"><span>💰 Заработок</span><span>${Math.round(earn.total)} ₽</span></div>` : '') +
    (earn.partsText ? `<div class="muted" style="padding:0 0 6px">Расчёт: ${esc(earn.partsText)}</div>` : '') +
    (queued ? `<div class="dash-row"><span>⚠ Не отправлено записей</span><span>${queued}</span></div>` : '');
  $('supBtn').style.display = isSupervisor(me) ? 'block' : 'none';
}

// ================= СТАТИСТИКА (личная — у всех) =================
// Свои смены месяца; в деталях смены — правка отрезков (segmentedit)
// и перевозимых врачей (doctorsedit). Данные отрезков и перевозок —
// с сервера: ?page=data&ids=<id смены>
function openMyStats() {
  if (!me) { msg('Сначала войди'); return; }
  showScreen('statsScreen');
  if (!$('statsMonth').value) $('statsMonth').value = todayISO().slice(0, 7);
  $('backBtn').style.display = 'none';
  renderMyStats();
}

function renderMyStats() {
  const month = $('statsMonth').value || todayISO().slice(0, 7);
  const rows = shiftsData
    .filter(s => normFio(s.driverId) === normFio(me.fio) && isoOf(s.date).startsWith(month))
    .sort((a, b) => isoOf(a.date) < isoOf(b.date) ? -1 : 1);
  let total = 0, minutes = 0;
  rows.forEach(s => {
    total += parseFloat(s.totalKm) || 0;
    minutes += shiftMinutes(s);
  });
  const list = rows.map(s => `
    <div class="ref-item">
      <b>${esc(ruFmtShort(s.date))}</b> — ${esc(s.carLabel || '')}
      <a class="edit" href="#" onclick="openMyShiftDetail('${escJsName(s.id)}');return false">✎ отрезки и врачи</a><br>
      ${esc(s.timeStart || '')}–${esc(s.timeEnd || '')}, км: ${esc(s.totalKm || 0)},
      ${minToHHMM(shiftMinutes(s))}${s.refuel ? ', заправка ' + esc(s.refuel) + ' л' : ''}
      <div style="font-size:13px;color:var(--muted)">Маршрут: ${esc(s.route || '—')}</div>
    </div>`).join('');
  $('statsBody').innerHTML = `
    <div class="card"><h3>Мои смены — ${esc(month)}</h3>
      Смен: ${rows.length}, пробег: ${total.toFixed(1)} км, время: ${minToHHMM(minutes)}
    </div>` +
    (rows.length ? list : '<div class="ref-item empty">Смен за месяц нет.</div>');
  $('statsDetail').innerHTML = '';
  $('backBtn').style.display = 'none';
}

// Детали смены: правка и удаление отрезков с каскадным пересчётом одометров,
// удаление смены целиком вместе с перевозками врачей
let myShiftDetailId = null;
let mySegs = [];   // отрезки смены, открытой для правки
let myDocs = [];   // перевозки этой же смены

async function openMyShiftDetail(shiftId) {
  if (!shiftId) { msg('У этой смены нет id — обнови данные при сети'); return; }
  myShiftDetailId = shiftId;
  msg('Загружаю отрезки и перевозки…');
  let segs = [], docs = [];
  try {
    const res = await fetch(API_URL + '?page=data&ids=' + encodeURIComponent(shiftId));
    let out = null;
    try { out = await res.json(); }
    catch (e) { msg('Сервер вернул не JSON (HTTP ' + res.status + ')'); return; }
    if (!out.ok) { msg('Ошибка: ' + (out.error || 'сервер')); return; }
    segs = (out.segments && out.segments[shiftId]) || [];
    docs = (out.doctors && out.doctors[shiftId]) || [];
    if (out.segments === undefined) {
      msg('Сервер не вернул segments — проверь обработчик page=data на сервере');
      return;
    }
  } catch (e) {
    msg('Сбой запроса: ' + (e.message || e));
    return;
  }
  mySegs = segs.map(x => ({
    id: x.id, from: x.from, to: x.to,
    kmAtB: parseFloat(x.kmAtB) || 0,
    segmentKm: parseFloat(x.km) || 0,
    ts: x.ts || ''
  }));
  myDocs = docs;
  renderShiftDetail();
}

function renderShiftDetail() {
  const sumKm = mySegs.reduce((a, x) => a + x.segmentKm, 0);
  const segRows = mySegs.map(x => `
    <div class="ref-item">
      <b>${esc(x.from)} → ${esc(x.to)}</b>, одометр от начала смены: ${esc(x.kmAtB)}, пробег отрезка: ${esc(x.segmentKm)} км
      <a class="edit" href="#" onclick="editSegRow('${escJsName(x.id)}');return false">✎</a>
      <a class="edit" href="#" onclick="deleteSegRow('${escJsName(x.id)}');return false">🗑</a>
    </div>`).join('');
  const docRows = myDocs.length ? myDocs.map(x => `
    <div class="ref-item">
      <b>${esc(x.doctor)}</b> → ${esc(x.place || '—')},
      назначено: ${esc(x.timeAppointed || '—')}, посадка: ${esc(x.timeBoarding || '—')}
      <a class="edit" href="#" onclick="editDocRow('${escJsName(x.recordId)}','${escJsName(x.doctor)}','${escJsName(x.place)}','${escJsName(x.timeAppointed)}','${escJsName(x.timeBoarding)}');return false">✎</a>
    </div>`).join('') : '<div class="ref-item empty">Перевозок врачей нет.</div>';
  $('statsBody').innerHTML = '';
  $('backBtn').style.display = 'block';
  $('statsDetail').innerHTML = `
    <div class="card"><h3>Смена ${esc(myShiftDetailId)}</h3>
      Отрезков: ${mySegs.length}, сумма пробега: ${sumKm.toFixed(1)} км
      ${mySegs.length ? '<div class="empty">Правка отрезка пересчитает одометры всех последующих отрезков и маршрут смены.</div>' : ''}
      <button class="danger small" onclick="deleteShiftWhole()">🗑 Удалить смену целиком</button>
    </div>
    <div class="card"><h4>Отрезки</h4>${segRows || '<div class="ref-item empty">Отрезков нет.</div>'}</div>
    <div class="card"><h4>Перевозимые врачи</h4>${docRows}</div>`;
}

// Текст врачей смены из списка перевозок и посещённых точек
// (тот же формат, что buildDoctorText при завершении смены)
function doctorTextFrom(docs, visitedPoints) {
  const pointSet = new Set(visitedPoints.map(p => String(p || '').trim().toUpperCase()));
  const shownPlaces = new Set();
  const entries = [];
  (docs || []).forEach(v => {
    const place = String(v.place || '').trim().toUpperCase();
    if (!pointSet.has(place)) return;
    const diff = hhmmToMin(v.timeBoarding) - hhmmToMin(v.timeAppointed);
    let suffix = '';
    if (diff > 0) suffix = ` (опоздание ${diff} мин)`;
    else if (diff < 0) suffix = ` (раньше на ${-diff} мин)`;
    const first = !shownPlaces.has(place);
    shownPlaces.add(place);
    entries.push({ place: place, text: (first ? place + ' ' : '') + v.doctor + ' ' + v.timeBoarding, suffix: suffix });
  });
  let text = '';
  entries.forEach((e, i) => {
    const sep = i === 0 ? '' : (e.place === entries[i - 1].place ? ', ' : '\n');
    text += sep + e.text + e.suffix;
  });
  return text;
}

// Отправка изменённого набора отрезков: каскад одометров от одометра начала,
// пересчёт маршрута и текста врачей, обновление смены на сервере
async function pushSegsToServer(okText) {
  const s = shiftsData.find(x => x.id === myShiftDetailId);
  let odoStart = parseFloat(s && s.odoStart);
  if (isNaN(odoStart) && mySegs.length) {
    // Резерв: одометр начала = одометр первого отрезка минус его пробег
    const first = mySegs[0];
    odoStart = (parseFloat(first.kmAtB) || 0) - (parseFloat(first.segmentKm) || 0);
  }
  if (isNaN(odoStart)) { msg('Нет одометра начала смены — обнови данные при сети'); return; }
  // Одометр отрезка — накопленный пробег от начала смены (как на листе SegmentsAPI):
  // первый отрезок = его пробег, далее сумма. Показание одометра машины
  // на конец смены считается отдельно: odoStart + totalKm
  let acc = 0;
  mySegs.forEach(x => {
    acc += (parseFloat(x.segmentKm) || 0);
    x.kmAtB = Math.round(acc * 10) / 10;
  });
  const totalKm = mySegs.reduce((a, x) => a + (parseFloat(x.segmentKm) || 0), 0);
  const routePoints = [];
  mySegs.forEach(x => {
    if (!routePoints.length) routePoints.push(x.from);
    if (x.to !== x.from) routePoints.push(x.to);
  });
  const route = compressRoute(routePoints);
  const visited = [];
  mySegs.forEach(x => visited.push(x.from, x.to));
  const doctorText = doctorTextFrom(myDocs, visited);
  const rec = {
    id: 'sgr-' + uid(), type: 'segmentsreplace', shiftId: myShiftDetailId,
    segments: mySegs.map(x => ({
      id: x.id, from: x.from, to: x.to, kmAtB: x.kmAtB, segmentKm: x.segmentKm, ts: x.ts
    })),
    odoEnd: odoStart + totalKm, totalKm: String(totalKm),
    route: route, doctor: doctorText
  };
  msg('Сохраняю…');
  const r = await sendOrQueue([rec]);
  // Локально применяем сразу — дашборд и статистика пересчитаются
  s.odoEnd = String(rec.odoEnd);
  s.totalKm = String(totalKm);
  s.route = route;
  s.doctor = doctorText;
  localStorage.setItem(SHIFTS_KEY, JSON.stringify(shiftsData));
  renderDashboard();
  renderMyStats();
  renderShiftDetail();
  msg(r.sent ? okText + ': одометры и маршрут пересчитаны'
             : 'Нет сети: правка в очереди, уйдёт при синхронизации');
}

// Правка отрезка: меняем только сам отрезок; одометр пересчитается автоматически
let segEditId = null;

function editSegRow(id) {
  const seg = mySegs.find(x => x.id === id);
  if (!seg) { msg('Отрезок не найден'); return; }
  segEditId = id;
  const host = document.createElement('div');
  host.id = 'segEditCard';
  host.className = 'ref-item';
  host.innerHTML = `
    <b>Правка отрезка</b>
    <label>Откуда</label><input id="segEFrom" value="${esc(seg.from)}">
    <label>Куда</label><input id="segETo" value="${esc(seg.to)}">
    <label>Пробег отрезка, км</label><input id="segEKm" inputmode="decimal" value="${esc(seg.segmentKm)}">
    <div class="muted">Одометр этого и последующих отрезков пересчитается автоматически.</div>
    <button class="small" onclick="saveSegEdit()">Сохранить</button>
    <button class="small" onclick="document.getElementById('segEditCard').remove();segEditId=null;">Отмена</button>`;
  const detail = $('statsDetail');
  if (detail) detail.insertBefore(host, detail.children[1]);
  host.scrollIntoView({ block: 'nearest' });
}

async function saveSegEdit() {
  const seg = mySegs.find(x => x.id === segEditId);
  if (!seg) { msg('Нет отрезка для правки'); return; }
  const from = $('segEFrom').value.trim();
  const to = $('segETo').value.trim();
  const km = parseFloat(String($('segEKm').value).replace(',', '.'));
  if (!from || !to || isNaN(km) || km < 0) {
    msg('Заполни «Откуда», «Куда» и пробег; значения — не отрицательные');
    return;
  }
  seg.from = from;
  seg.to = to;
  seg.segmentKm = km;
  await pushSegsToServer('Отрезок сохранён');
}

function deleteSegRow(id) {
  if (mySegs.length <= 1) {
    msg('Последний отрезок удалить нельзя — смена без отрезков не существует.\nЕсли нужно убрать смену целиком — кнопка «Удалить смену целиком» выше.');
    return;
  }
  if (!confirm('Удалить отрезок? Одометры последующих отрезков и маршрут пересчитаются.')) return;
  mySegs = mySegs.filter(x => x.id !== id);
  pushSegsToServer('Отрезок удалён');
}

async function deleteShiftWhole() {
  if (!myShiftDetailId) return;
  if (!confirm('Удалить смену целиком? Будут удалены отрезки и перевозки врачей, статистика пересчитается.')) return;
  msg('Удаляю смену…');
  const r = await sendOrQueue([{ id: 'shd-' + uid(), type: 'shiftdelete', shiftId: myShiftDetailId }]);
  shiftsData = shiftsData.filter(x => x.id !== myShiftDetailId);
  localStorage.setItem(SHIFTS_KEY, JSON.stringify(shiftsData));
  myShiftDetailId = null;
  renderMyStats();
  renderDashboard();
  msg(r.sent ? 'Смена удалена, статистика пересчитана'
             : 'Нет сети: удаление в очереди, выполнится при синхронизации');
}

// Правка перевозки: форма подставляется в карточку строки
let docEditRecId = null;

function editDocRow(recordId, doctor, place, timeApp, timeBoard) {
  docEditRecId = recordId;
  const host = document.createElement('div');
  host.id = 'docEditCard';
  host.className = 'ref-item';
  host.innerHTML = `
    <b>Правка перевозки</b>
    <label>Врач</label><input id="docEDoctor" value="${esc(doctor)}">
    <label>Куда везём</label><input id="docEPlace" value="${esc(place)}">
    <label>Назначенное время</label><input id="docETimeApp" type="time" value="${esc(timeApp)}">
    <label>Время посадки</label><input id="docETimeBoard" type="time" value="${esc(timeBoard)}">
    <button class="small" onclick="saveDocRowEdit()">Сохранить</button>
    <button class="small" onclick="document.getElementById('docEditCard').remove();docEditRecId=null;">Отмена</button>`;
  const detail = $('statsDetail');
  if (detail) detail.appendChild(host);
  host.scrollIntoView({ block: 'nearest' });
}

async function saveDocRowEdit() {
  if (!docEditRecId || !myShiftDetailId) { msg('Нет перевозки для правки'); return; }
  const doctor = $('docEDoctor').value.trim();
  const place = $('docEPlace').value.trim();
  const ta = $('docETimeApp').value;
  const tb = $('docETimeBoard').value;
  if (!doctor || !place || !ta || !tb) { msg('Укажи врача, пункт и оба времени'); return; }
  msg('Сохраняю перевозку…');
  const r = await sendOrQueue([{
    id: 'doce-' + uid(), type: 'doctorsedit', recordId: docEditRecId,
    doctor: doctor, place: place, timeAppointed: ta, timeBoarding: tb
  }]);
  msg(r.sent ? 'Перевозка сохранена' : 'Нет сети: правка в очереди, уйдёт при синхронизации');
  openMyShiftDetail(myShiftDetailId);
}

// ================= СТАТИСТИКА (СТАРШИЙ) =================
// Общий дашборд по всем водителям — остаётся у старшего
async function openReport() {
  if (!me || !isSupervisor(me)) return;
  showScreen('reportScreen');
  reportDetail = null;
  $('backBtn').style.display = 'none';
  if (!$('reportMonth').value) $('reportMonth').value = todayISO().slice(0, 7);
  $('reportBody').innerHTML = '<div class="card">Загружаю…</div>';
  try {
    const out = await (await fetch(API_URL)).json();
    shiftsData = Array.isArray(out.shifts) ? out.shifts : [];
    localStorage.setItem(SHIFTS_KEY, JSON.stringify(shiftsData));
  } catch (e) {
    try { shiftsData = JSON.parse(localStorage.getItem(SHIFTS_KEY) || '[]'); }
    catch (e2) { shiftsData = []; }
    msg('Нет сети: отчёт по сохранённым данным.');
  }
  renderReport();
}

// Имя безопасно и для HTML-метки, и для JS-строки в onclick
function escJsName(s) {
  return esc(String(s || '')
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'"));
}

function renderReport() {
  const month = $('reportMonth').value || todayISO().slice(0, 7);
  const rows = shiftsData.filter(s => isoOf(s.date).startsWith(month));
  $('backBtn').style.display = reportDetail ? 'block' : 'none';

  if (reportDetail) { renderDriverDetail(rows); return; }

  const byDriver = {};
  rows.forEach(s => {
    const k = s.driverId ? normFio(s.driverId) : '— (без водителя)';
    if (!byDriver[k]) byDriver[k] = { name: s.driverId || '— (без водителя)', n: 0, total: 0, refuel: 0, minutes: 0 };
    const t = byDriver[k];
    t.n++;
    t.total += parseFloat(s.totalKm) || 0;
    t.refuel += parseFloat(s.refuel) || 0;
    t.minutes += shiftMinutes(s);
  });
  const keys = Object.keys(byDriver).sort((a, b) => ruCmp(byDriver[a].name, byDriver[b].name));
  if (!keys.length) {
    $('reportBody').innerHTML = '<div class="card">За ' + month + ' смен нет.</div>';
    return;
  }

  // Время = средняя продолжительность смен водителя
  const rowsHtml = keys.map(k => {
    const t = byDriver[k];
    const avg = t.n ? Math.round(t.minutes / t.n) : 0;
    return `<tr>
      <td><a href="#" onclick="openDriverDetail('${escJsName(t.name)}')">${esc(t.name)}</a></td>
      <td>${t.n}</td>
      <td>${t.total.toFixed(1)}</td>
      <td>${t.refuel ? t.refuel.toFixed(1) : ''}</td>
      <td>${minToHHMM(avg)}</td>
    </tr>`;
  }).join('');

  $('reportBody').innerHTML = `
    <div class="card"><h3>Общий отчёт по всем водителям</h3>
      <table>
        <tr><th>Водитель</th><th>Смен</th><th>Км</th><th>Топл., л</th><th>Время</th></tr>
        ${rowsHtml}
      </table>
    </div>`;
}

function renderDriverDetail(rows) {
  const rows2 = rows.filter(s => normFio(s.driverId) === normFio(reportDetail) ||
    (!s.driverId && normFio(reportDetail) === normFio('— (без водителя)')));
  if (!rows2.length) {
    $('reportBody').innerHTML = `<div class="card">У водителя «${esc(reportDetail)}» за месяц смен нет.</div>`;
    return;
  }
  const list = rows2.map(s => `
    <div class="card">
      <b>${esc(ruFmtShort(s.date))}</b> — ${esc(s.carLabel || '')}
      <div>${s.timeStart || ''}–${s.timeEnd || ''} (${s.duration || minToHHMM(shiftMinutes(s))}), км: ${s.totalKm || 0}${s.refuel ? `, заправка ${s.refuel} л` : ''}</div>
      <div style="font-size:13px;color:var(--muted)">Маршрут: ${esc(s.route || '—')}</div>
      ${s.doctor ? `<div style="font-size:13px;color:var(--muted)">Врачи: ${esc(s.doctor)}</div>` : ''}
    </div>`).join('');
  $('reportBody').innerHTML = `<div class="card"><h3>${esc(reportDetail)}</h3>Смен за месяц: ${rows2.length}</div>` + list;
}

function openDriverDetail(fio) {
  reportDetail = fio;
  renderReport();
}

function backToReport() {
  reportDetail = null;
  renderReport();
}

// ================= СПРАВОЧНИК =================
function openRefs() {
  showScreen('refsScreen');
  $('refSearchDoc').value = '';
  $('refSearchCls').value = '';
  $('refSearchDrv').value = '';
  const cd = $('clearDocBtn'); if (cd) cd.style.display = 'none';
  const cc = $('clearClsBtn'); if (cc) cc.style.display = 'none';
  const cdrv = $('clearDrvBtn'); if (cdrv) cdrv.style.display = 'none';
  $('docsCard').style.display = 'none';
  $('clsCard').style.display = 'none';
  $('drvCard').style.display = 'none';
  // Справочник водителей видит только старший
  const drvWrap = $('drvCardWrap');
  if (drvWrap) drvWrap.style.display = isSupervisor(me) ? 'block' : 'none';
  closeDocForm();
  closeClinicForm();
  closeDrvForm();
}


// Сброс поля поиска справочника и перерисовка списка
function clearRefSearch(which) {
  if (which === 'cls') {
    $('refSearchCls').value = '';
    renderRefsCls();
  } else if (which === 'drv') {
    $('refSearchDrv').value = '';
    renderRefsDrv();
  } else {
    $('refSearchDoc').value = '';
    renderRefsDoc();
  }
}

function esc(s) {
  return String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function telHref(tel) {
  const digits = String(tel || '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.length === 11 && digits[0] === '8') return 'tel:+7' + digits.slice(1);
  if (digits.length === 11 && digits[0] === '7') return 'tel:+7' + digits;
  return 'tel:' + digits;
}

// --- Врачи: поиск, карточки с правкой (ФИО — единственный ключ) ---
function renderRefsDoc() {
  const q = ($('refSearchDoc').value || '').trim().toLowerCase();
  const cb = $('clearDocBtn');
  if (cb) cb.style.display = q ? 'block' : 'none';
  if (!q) { $('docsCard').style.display = 'none'; return; }
  // Строгий префикс без учёта регистра: «а» → все на «А», «ал» → все на «Ал»
  const docs = doctorsContact
    .filter(d => String(d.fio || '').trim().toLowerCase().indexOf(q) === 0)
    .sort((a, b) => ruCmp(a.fio, b.fio));
  $('docsCard').style.display = 'block';
  $('refsDocs').innerHTML = docs.length ? docs.map(d => `
    <div class="ref-item">
      <b>${esc(d.fio)}</b>
      <a class="edit" href="#" onclick="openDocForm('edit','${esc(d.key)}');return false">✎</a><br>
      ${d.addr ? '📍 ' + esc(d.addr) + '<br>' : ''}
      ${d.tel ? `<a class="tel" href="${telHref(d.tel)}">📞 ${esc(d.tel)}</a>` : ''}
      ${d.route ? `<a class="lnk" target="_blank" rel="noopener" href="${esc(d.route)}">🧭 маршрут</a>` : ''}
    </div>`).join('')
    : '<div class="ref-item empty">Врач не найден.</div>';
}// --- Форма врача: добавление и правка ---
function openDocForm(mode, key) {
  docEditKey = mode === 'edit' ? key : null;
  const d = docEditKey ? doctorsContact.find(x => x.key === docEditKey) : null;
  if (docEditKey && !d) { msg('Врач не найден'); return; }
  $('docFormTitle').textContent = docEditKey ? 'Правка врача' : 'Новый врач';
  $('docFio').value = d ? (d.fio || '') : '';
  $('docAddr').value = d ? (d.addr || '') : '';
  $('docTel').value = d ? (d.tel || '') : '';
  $('docRoute').value = d ? (d.route || '') : '';
  $('docFormCard').style.display = 'block';
  $('docsCard').style.display = 'none';
  $('clsCard').style.display = 'none';
}

function closeDocForm() {
  $('docFormCard').style.display = 'none';
  docEditKey = null;
}

// Сохранение врача: офлайн — локальная правка + очередь, онлайн — сервер
async function saveDocForm() {
  const fio = $('docFio').value.trim();
  const data = {
    fio: fio,
    addr: $('docAddr').value.trim(),
    tel: $('docTel').value.trim(),
    route: $('docRoute').value.trim()
  };
  if (!fio) { msg('Укажи ФИО врача'); return; }
  let rec;
  if (docEditKey) {
    rec = { id: 'de-' + uid(), type: 'docedit', key: docEditKey, ...data };
  } else {
    rec = { id: 'da-' + uid(), type: 'docadd', ...data };
  }
  // Локально применяем сразу — правка видна даже без сети
  if (docEditKey) {
    const d = doctorsContact.find(x => x.key === docEditKey);
    if (d) {
      Object.assign(d, data);
      d.key = fio.toLowerCase();
    }
  } else {
    doctorsContact.push({ key: fio.toLowerCase(), fio: fio,
      addr: data.addr, tel: data.tel, route: data.route });
  }
  rememberRef(docNames, 'docname', fio);
  closeDocForm();
  renderRefsDoc();
  const r = await sendOrQueue([rec]);
  msg(r.sent ? 'Врач сохранён на сервере'
             : 'Нет сети: врач сохранён в телефоне и уйдёт в таблицу при синхронизации');
}

// --- Клиники: поиск по городу, карточки с правкой ---
function renderRefsCls() {
  const q = ($('refSearchCls').value || '').trim().toLowerCase();
  const cb = $('clearClsBtn');
  if (cb) cb.style.display = q ? 'block' : 'none';
  if (!q) { $('clsCard').style.display = 'none'; return; }
  const cls = clinics
    .filter(c => String(c.city || '').trim().toLowerCase().indexOf(q) === 0)
    .sort((a, b) => ruCmp(a.name, b.name));
  $('clsCard').style.display = 'block';
  $('refsCls').innerHTML = cls.length ? cls.map(c => `
    <div class="ref-item">
      <b>${esc(c.name)}</b>${c.city ? ' — ' + esc(c.city) : ''}
      <a class="edit" href="#" onclick="openClinicForm('edit','${esc(c.key)}');return false">✎</a><br>
      ${c.addr ? '📍 ' + esc(c.addr) + '<br>' : ''}
      ${c.day ? '🗓 ' + esc(c.day) + '<br>' : ''}
      ${c.tel ? `<a class="tel" href="${telHref(c.tel)}">📞 ${esc(c.tel)}</a>` : ''}
      ${c.route ? `<a class="lnk" target="_blank" rel="noopener" href="${esc(c.route)}">🧭 маршрут</a>` : ''}
      ${c.extra ? `<div class="extra">${esc(c.extra)}</div>` : ''}
    </div>`).join('')
    : '<div class="ref-item empty">Клиника не найдена.</div>';
}

// --- Форма клиники: добавление и правка ---
function openClinicForm(mode, key) {
  clinicEditKey = mode === 'edit' ? key : null;
  const c = clinicEditKey ? clinics.find(x => x.key === clinicEditKey) : null;
  if (clinicEditKey && !c) { msg('Клиника не найдена'); return; }
  $('clinicFormTitle').textContent = clinicEditKey ? 'Правка клиники' : 'Новая клиника';
  $('clinicCity').value = c ? (c.city || '') : '';
  $('clinicName').value = c ? (c.name || '') : '';
  $('clinicAddr').value = c ? (c.addr || '') : '';
  $('clinicTel').value = c ? (c.tel || '') : '';
  $('clinicExtra').value = c ? (c.extra || '') : '';
  $('clinicRoute').value = c ? (c.route || '') : '';
  $('clinicDay').value = c ? (c.day || '') : '';
  $('clinicFormCard').style.display = 'block';
  $('docsCard').style.display = 'none';
  $('clsCard').style.display = 'none';
}

function closeClinicForm() {
  $('clinicFormCard').style.display = 'none';
  clinicEditKey = null;
}

async function saveClinicForm() {
  const city = $('clinicCity').value.trim();
  const name = $('clinicName').value.trim();
  const data = {
    city: city, name: name,
    addr: $('clinicAddr').value.trim(),
    tel: $('clinicTel').value.trim(),
    extra: $('clinicExtra').value.trim(),
    route: $('clinicRoute').value.trim(),
    day: $('clinicDay').value.trim()
  };
  if (!name) { msg('Укажи наименование клиники'); return; }
  let rec;
  if (clinicEditKey) {
    rec = { id: 'ce-' + uid(), type: 'clinicedit', key: clinicEditKey, ...data };
  } else {
    rec = { id: 'ca-' + uid(), type: 'clinicadd', ...data };
  }
  if (clinicEditKey) {
    const c = clinics.find(x => x.key === clinicEditKey);
    if (c) {
      Object.assign(c, data);
      c.key = (city + '|' + name).toLowerCase();
    }
  } else {
    clinics.push({ key: (city + '|' + name).toLowerCase(), ...data });
  }
  closeClinicForm();
  renderRefsCls();
  const r = await sendOrQueue([rec]);
  msg(r.sent ? 'Клиника сохранена на сервере'
             : 'Нет сети: клиника сохранена в телефоне и уйдёт в таблицу при синхронизации');
}

// --- Водители: поиск, карточки с правкой (только старший) ---
function renderRefsDrv() {
  if (!me || !isSupervisor(me)) return;
  const q = ($('refSearchDrv').value || '').trim().toLowerCase();
  const cb = $('clearDrvBtn');
  if (cb) cb.style.display = q ? 'block' : 'none';
  if (!q) { $('drvCard').style.display = 'none'; return; }
  const list = drivers
    .filter(d => normFio(d.fio).indexOf(q) === 0)
    .sort((a, b) => ruCmp(a.fio, b.fio));
  $('drvCard').style.display = 'block';
  $('refsDrv').innerHTML = list.length ? list.map(d => `
    <div class="ref-item">
      <b>${esc(d.fio)}</b>${d.role ? ' <span class="muted">(' + esc(d.role) + ')</span>' : ''}
      <a class="edit" href="#" onclick="openDrvForm('edit','${escJsName(normFio(d.fio))}');return false">✎</a><br>
      ${d.snils ? 'СНИЛС: ' + esc(d.snils) + '<br>' : ''}
      ${d.vu ? 'ВУ: ' + esc(d.vu) + (d.vuDate ? ' от ' + esc(ruFmtShort(d.vuDate)) : '') + '<br>' : ''}
      ${d.klass ? 'Класс: ' + esc(d.klass) : ''}
    </div>`).join('')
    : '<div class="ref-item empty">Водитель не найден.</div>';
}

// --- Форма водителя: добавление и правка ---
function openDrvForm(mode, key) {
  if (!me || !isSupervisor(me)) { msg('Справочник водителей — только для старшего'); return; }
  drvEditKey = mode === 'edit' ? key : null;
  const d = drvEditKey ? drivers.find(x => normFio(x.fio) === drvEditKey) : null;
  if (drvEditKey && !d) { msg('Водитель не найден'); return; }
  $('drvFormTitle').textContent = drvEditKey ? 'Правка водителя' : 'Новый водитель';
  $('drvFio').value = d ? (d.fio || '') : '';
  fillRoleSelect(d ? (d.role || '') : '');
  // PIN назначается только при добавлении; при правке не показываем и не меняем
  $('drvPin').value = '';
  $('drvPinBlock').style.display = drvEditKey ? 'none' : 'block';
  // СНИЛС и ВУ приводим к маске сразу, даже если в таблице лежали голыми цифрами
  $('drvSnils').value = d && d.snils ? fmtSnils(d.snils) : '';
  $('drvVu').value = d && d.vu ? fmtVu(d.vu) : '';
  $('drvVuDate').value = d ? (isoFromAny(d.vuDate) || '') : '';
  $('drvKlass').value = d ? (d.klass || '') : '';
  $('drvFormCard').style.display = 'block';
  $('drvCard').style.display = 'none';
  $('docsCard').style.display = 'none';
  $('clsCard').style.display = 'none';
}

function closeDrvForm() {
  $('drvFormCard').style.display = 'none';
  drvEditKey = null;
}

// Кластер ролей: список с сервера + ранее введённые роли
function fillRoleSelect(selected) {
  const sel = $('drvRoleSel');
  if (!sel) return; // разметка не обновлена — работает прежний ввод текстом
  const roles = rolesCluster.slice().sort(ruCmp);
  sel.innerHTML = '<option value="">— без роли —</option>' +
    roles.map(v => `<option value="${esc(v)}"${normFio(v) === normFio(selected) ? ' selected' : ''}>${esc(v)}</option>`).join('') +
    '<option value="__new">➕ Новая роль…</option>';
  $('drvRoleNewBlock').style.display = 'none';
  $('drvRole').value = '';
}

function onDrvRoleChange() {
  const isNew = $('drvRoleSel') && $('drvRoleSel').value === '__new';
  $('drvRoleNewBlock').style.display = isNew ? 'block' : 'none';
  if (isNew) $('drvRole').focus();
}

function currentDrvRole() {
  const sel = $('drvRoleSel');
  if (!sel) return $('drvRole').value.trim();
  return sel.value === '__new' ? $('drvRole').value.trim() : sel.value;
}

// Сохранение водителя: при добавлении — driver + PIN,
// при правке — переименование (если ФИО изменилось), правка строки и профиль.
// Офлайн: локальная правка + очередь, как у врачей и клиник
async function saveDrvForm() {
  if (!me || !isSupervisor(me)) { msg('Только старший правит водителей'); return; }
  const fio = $('drvFio').value.trim().replace(/\s+/g, ' ');
  const role = currentDrvRole();
  if ($('drvRoleSel') && $('drvRoleSel').value === '__new' && !role) {
    msg('Введи название новой роли или выбери из списка');
    return;
  }
  const snils = fmtSnils($('drvSnils').value.trim());
  const vu = fmtVu($('drvVu').value.trim());
  const vuDate = ruFromIso($('drvVuDate').value);
  const klass = $('drvKlass').value.trim();
  if (!fio) { msg('Укажи ФИО'); return; }
    // Единообразие с saveSettings: пусто — можно, неполные цифры — нельзя
  const sn = snils.replace(/\D/g, ''), vv = vu.replace(/\D/g, '');
  if (sn && sn.length !== 11) { msg('СНИЛС: нужно 11 цифр, сейчас ' + sn.length); return; }
  if (vv && vv.length !== 10) { msg('ВУ номер: нужно 10 цифр, сейчас ' + vv.length); return; }
  const old = drvEditKey ? drivers.find(x => normFio(x.fio) === drvEditKey) : null;
  if (drvEditKey && !old) { msg('Водитель не найден'); return; }
  const changedFio = !old || normFio(old.fio) !== normFio(fio);
  const recs = [];
  if (!old) {
    const pin = $('drvPin').value.trim();
    if (!/^\d{4,8}$/.test(pin)) { msg('PIN: от 4 до 8 цифр'); return; }
    // driver создаёт строку (с id из ФИО), driverprofile сразу заполняет профиль:
    // записи в пакете обрабатываются по порядку, к моменту профиля строка уже есть
    recs.push({ id: 'dwa-' + uid(), type: 'driver', fio: fio, pin: pin, role: role });
  } else if (changedFio) {
    recs.push({ id: 'dwr-' + uid(), type: 'driverrename', fioOld: old.fio, fio: fio });
  }
  if (old) {
    recs.push({ id: 'dwe-' + uid(), type: 'driveredit',
      id: old.id || '', fio: fio, role: role });
  }
  recs.push({ id: 'dwp-' + uid(), type: 'driverprofile',
    fioOld: old ? old.fio : fio, fio: fio,
    snils: snils, vu: vu, vuDate: vuDate, klass: klass, role: role });
  // Локально применяем сразу — видно и без сети
  if (old) {
    old.fio = fio; old.role = role;
    old.snils = snils; old.vu = vu; old.vuDate = vuDate; old.klass = klass;
  } else {
    drivers.push({ id: '', fio: fio, role: role,
      snils: snils, vu: vu, vuDate: vuDate, klass: klass });
  }
  drivers.sort((a, b) => ruCmp(a.fio, b.fio));
  if (role && !rolesCluster.some(r => normFio(r) === normFio(role))) rolesCluster.push(role);
  closeDrvForm();
  renderRefsDrv();
  renderLoginHints();
  const r = await sendOrQueue(recs);
  msg(r.sent ? 'Водитель сохранён на сервере'
             : 'Нет сети: водитель сохранён в телефоне и уйдёт в таблицу при синхронизации');
}

// ================= СМЕНА =================
function startShift() {
  const dateStr = $('shiftDate').value;
  const tStart = $('timeStart').value;
  const odo = parseFloat($('odoStart').value.replace(',', '.'));
  if (!me) { msg('Сначала войди'); return; }
  if (!dateStr || !tStart) { msg('Укажи дату и время начала смены'); return; }
  const car = currentCar();
  if (!car) { msg('Выбери автомобиль'); return; }
  if (isNaN(odo) || odo < 0) { msg('Укажи одометр на начало'); return; }
  shift = {
    id: uid(),
    driverId: me.fio,
    // carId — id авто с листа Cars; для несинхронизированного авто — метка
    carId: car.id || (me.id + '|' + carLabel(car)),
    carLabel: carLabel(car),
    date: dateStr, timeStart: tStart, odoStart: odo
  };
  segments = [];
  doctorVisits = [];
  localStorage.setItem('lastCarId', car.id || carLabel(car));
  saveState();
  showWork();
  $('segFrom').value = 'ОФИС';
  $('segTo').value = ''; $('segKm').value = '';
  msg(`Смена открыта: ${me.fio}, ${carLabel(car)}.`);
}

function addSegment() {
  const from = canonName($('segFrom').value, points.concat(interPoints));
  const to = canonName($('segTo').value, points.concat(interPoints));
  const km = parseFloat(String($('segKm').value).replace(',', '.'));
  if (!from || !to || isNaN(km) || km < 0) { msg('Заполни «Откуда», «Куда» и пробег'); return; }
  const prevKm = segments.length ? segments[segments.length - 1].kmAtB : 0;
  if (km <= prevKm) {
    msg(`Ошибка: показание одометра (${km}) должно быть больше предыдущего: ${prevKm} км.\nЕсли нужно записать километраж отрезка — считай показание сам: ${prevKm} + километраж.`);
    return;
  }
  const segmentKm = km - prevKm;
  // Тип маршрута ушли: один пробег, без деления на город/трассу
  segments.push({ id: uid(), shiftId: shift.id, from, to, kmAtB: km, segmentKm, ts: new Date().toISOString() });
  // Новые точки уходят в общий справочник: точку определяем по «интер»-листу,
  // если она там есть, иначе — в Points
  const refType = interPoints.indexOf(from) !== -1 || interPoints.indexOf(to) !== -1
    ? 'interpoint' : 'point';
  const refList = refType === 'interpoint' ? interPoints : points;
  rememberRef(refList, refType, from);
  rememberRef(refList, refType, to);
  saveState();
  $('segFrom').value = to; $('segTo').value = ''; $('segKm').value = '';
  // «Всего» = показание одометра, которое только что ввёл водитель (km)
  msg(`Отрезок: ${from} → ${to}, ${segmentKm} км.\nВсего: ${segments.length} отрезк., всего ${km} км.`);
}

function addDoctorVisit() {
  // Врач — только DoctorsRef (docNames), пункт — только MedPoints
  const doctor = canonName($('docName').value, docNames);
  const place = canonName($('docPlace').value, medPoints);
  const tApp = $('docTimeApp').value;
  const tBoard = $('docTimeBoard').value;
  if (!doctor || !place || !tApp || !tBoard) { msg('Укажи врача, куда везём и оба времени'); return; }
  const rid = 'r-' + uid();
  doctorVisits.push({
    id: rid, type: 'doctor', date: shift.date,
    doctor: doctor, place: place,
    timeAppointed: tApp, timeBoarding: tBoard,
    recordId: rid, shiftId: shift.id
  });
  // Новые пункты уходят в MedPoints, новые врачи — в DoctorsRef
  rememberRef(medPoints, 'medpoint', place);
  rememberRef(docNames, 'docname', doctor);
  saveState();
  $('docName').value = ''; $('docPlace').value = '';
  $('docTimeApp').value = ''; $('docTimeBoard').value = '';
  msg(`Перевозка врача записана (всего: ${doctorVisits.length}). Уйдёт вместе со сменой.`);
}

async function finishShift() {
  if (!segments.length) { msg('Добавь хотя бы один отрезок'); return; }
  const tEnd = $('timeEnd').value;
  if (!tEnd) { msg('Укажи время окончания смены'); return; }
  const refuel = $('refuel').value ? parseFloat($('refuel').value.replace(',', '.')) : '';
  const totalKm = segments.reduce((s, x) => s + x.segmentKm, 0);
  const odoEnd = Number(shift.odoStart) + totalKm;

  const visitedPoints = [];
  const routePoints = [];
  segments.forEach(s => {
    visitedPoints.push(s.from, s.to);
    // Точка старта маршрута — всегда «Откуда» первого отрезка смены,
    // даже если отрезок записан без перемещения (ОФИС → ОФИС)
    if (!routePoints.length) routePoints.push(s.from);
    if (s.to !== s.from) routePoints.push(s.to);
  });
  const route = compressRoute(routePoints);
  const doctorInfo = buildDoctorText(visitedPoints);
  const dMin = durationMin(shift.timeStart, tEnd);

  const batch = [
    { ...shift, timeEnd: tEnd, odoEnd, totalKm,
      route: route, doctor: doctorInfo,
      duration: minToHHMM(dMin), durationMin: dMin,
      refuel: refuel, status: 'Завершено', type: 'shift' },
    ...segments.map(s => ({ ...s, type: 'segment' })),
    ...doctorVisits
  ];

  msg('Отправляю…');
  const r = await sendOrQueue(batch);
  // Конечный одометр становится стартовым для следующей смены
  localStorage.setItem('lastOdoEnd', String(odoEnd));
  clearState();
  shift = null; segments = []; doctorVisits = [];
  msg(r.sent
    ? `Отправлено: ${r.out.processed.length} записей.\nМаршрут: ${route}` + (doctorInfo ? `\nВрачи: ${doctorInfo}` : '')
    : (r.queued
        ? (r.error
            ? `Не отправилось: ${r.error}\nСмена сохранена в очереди и уйдёт автоматически.`
            : `Нет сети: смена сохранена в телефоне и отправится автоматически.\nМаршрут: ${route}`)
        : 'Не отправилось: ' + r.error + '\nСмена сохранена в очереди.'));
  showStart();
  $('odoStart').value = odoEnd;
  $('refuel').value = '';
  $('timeStart').value = '';
  $('timeEnd').value = '';

  shiftsData.push({
    id: batch[0].id, // нужен для скачивания путевого листа сразу после сдачи смены
    date: batch[0].date, driverId: batch[0].driverId,
    carLabel: batch[0].carLabel, timeStart: batch[0].timeStart, timeEnd: tEnd,
    totalKm: String(totalKm),
    refuel: refuel === '' ? '' : String(refuel),
    duration: minToHHMM(dMin), durationMin: dMin,
    doctor: doctorInfo, route: route
  });
  localStorage.setItem(SHIFTS_KEY, JSON.stringify(shiftsData));
  renderDashboard();
}

// ================= ВОССТАНОВЛЕНИЕ СМЕНЫ =================
function restoreState() {
  const saved = loadState();
  if (!saved || !saved.shift) return false;
  shift = saved.shift;
  segments = saved.segments || [];
  doctorVisits = saved.doctorVisits || [];
  if (segments.length) {
    const last = segments[segments.length - 1];
    $('segFrom').value = last.to;
  }
  return true;
}

// Информационное окно по восстановленной смене:
// авто, число отрезков, последний отрезок и общий пробег
// (берём из показания одометра последнего отрезка — kmAtB)
function showRestoredShiftInfo() {
  if (!me) return;
  if (shift.driverId && normFio(shift.driverId) !== normFio(me.fio)) {
    msg('В телефоне есть незавершённая смена другого водителя (' + shift.driverId + ').\nСообщите старшему: её нужно перенести или закрыть.');
    return;
  }
  const last = segments.length ? segments[segments.length - 1] : null;
  const totalKm = last ? last.kmAtB : 0;
  const lastInfo = last
    ? `\nПоследний отрезок: ${last.from} → ${last.to} (${last.segmentKm} км).\nОдометр в «${last.to}»: ${last.kmAtB} км.\nПродолжай с «${last.to}».`
    : '\nОтрезков пока нет.';
  msg(`Смена ещё открыта: ${shift.driverId}, ${shift.carLabel}.\nОтрезков: ${segments.length}, общий пробег: ${totalKm} км.${lastInfo}\nОткрой «Запись смены», чтобы продолжить.`);
}
// ================= PWA =================
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}

// ================= ПУТЕВЫЕ ЛИСТЫ =================
const PL_EMAIL_KEY = 'plEmail';

function plIso(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

// Показ даты: сервер отдаёт ДД.ММ.ГГГГ, старые кэши могут держать ISO —
// приводим к единому виду ДД.ММ.ГГГГ
function ruFmtShort(dateStr) {
  const dmy = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(String(dateStr || '').trim());
  if (dmy) return dateStr;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || '').trim());
  return m ? m[3] + '.' + m[2] + '.' + m[1] : String(dateStr || '');
}

// Границы периода: неделя с понедельника, месяц — календарный
function plPeriodRange(dateStr, kind) {
  // Вход и для «28.10.2026», и для «2026-10-28» — приводим к ISO
  const iso = isoOf(dateStr);
  const d = new Date(iso + 'T00:00:00');
  if (isNaN(d)) return null;
  if (kind === 'week') {
    const off = (d.getDay() + 6) % 7;
    const f = new Date(d); f.setDate(d.getDate() - off);
    const t = new Date(f); t.setDate(f.getDate() + 6);
    return { from: plIso(f), to: plIso(t) };
  }
  if (kind === 'month') {
    const f = new Date(d.getFullYear(), d.getMonth(), 1);
    const t = new Date(d.getFullYear(), d.getMonth() + 1, 0);
    return { from: plIso(f), to: plIso(t) };
  }
  return { from: iso, to: iso };
}

function plShifts() {
  const r = plPeriodRange($('plDate').value || todayISO(), $('plPeriod').value);
  if (!r) return [];
  const scope = $('plScope').value;
  return shiftsData
    .filter(s => isoOf(s.date) >= r.from && isoOf(s.date) <= r.to)
    .filter(s => scope === 'all' || normFio(s.driverId) === normFio(me.fio))
    .sort((a, b) => isoOf(a.date) < isoOf(b.date) ? -1 : 1);
}

function openPl() {
  showScreen('plScreen');
  if (!$('plDate').value) $('plDate').value = todayISO();
  $('plEmail').value = localStorage.getItem(PL_EMAIL_KEY) || '';
  $('plScopeRow').style.display = isSupervisor(me) ? 'block' : 'none';
  plRenderNumInto('plNumBlock', 'pl');
  plRenderList();
}

// Полный номер: префикс + 6 цифр с ведущими нулями
function plFmtNum(prefix, n) {
  return prefix + '-' + String(n).padStart(6, '0');
}

// Блок нумерации путевых листов. Рендерится в двух местах:
// экран «Путевые листы» (plNumBlock) и «Настройки» (setPlBlock).
// ctx отличает input-идентификаторы, чтобы блоки не мешали друг другу
function plRenderNumInto(elId, ctx) {
  ctx = ctx || (elId === 'setPlBlock' ? 'set' : 'pl');
  const el = $(elId);
  if (!el || !me) return;
  const found = drivers.find(x => normFio(x.fio) === normFio(me.fio));
  const cur = found && found.plNum ? parseInt(found.plNum, 10) : NaN;
  const prefix = found && found.plPrefix ? found.plPrefix : '';
  if (prefix && !isNaN(cur)) {
    el.innerHTML = `<div class="ref-item"><b>№ путевого листа:</b> следующий — ${esc(plFmtNum(prefix, cur))}<br>` +
      `<span class="empty">Присваивается автоматически при первом формировании PDF.</span></div>`;
  } else {
    // Префикс обязателен: без него номер не сформируется
    el.innerHTML = `
      <label>Префикс номера (например АТС10; у каждого водителя свой)</label>
      <input id="plPrefixInput_${ctx}" placeholder="АТС10" value="${esc(prefix)}">
      <label>Номер первого путевого листа (задаётся один раз)</label>
      <input id="plNumInput_${ctx}" inputmode="numeric" placeholder="например, 870" value="${isNaN(cur) ? '' : cur}">
      <button class="small" style="background:#2f9e6e" onclick="plNumSave('${ctx}')">Сохранить префикс и №</button>`;
  }
}

async function plNumSave(ctx) {
  if (!me) { msg('Сначала войди'); return; }
  const pIn = $('plPrefixInput_' + ctx), nIn = $('plNumInput_' + ctx);
  if (!pIn || !nIn) return;
  const prefix = String(pIn.value || '').trim().toUpperCase();
  const num = parseInt(String(nIn.value || '').replace(/\D/g, ''), 10);
  if (!prefix) { msg('Укажи префикс (например, АТС10)'); return; }
  if (isNaN(num) || num < 1) { msg('Номер — целое число от 1'); return; }
  msg('Сохраняю номер…');
  const r = await sendOrQueue([{ id: 'pln-' + uid(), type: 'plnumset', driverId: me.id, fio: me.fio, prefix: prefix, num: num }]);
  // Локально обновляем сразу: правка применится и офлайн-очередью
  const found = drivers.find(x => normFio(x.fio) === normFio(me.fio));
  if (found) { found.plPrefix = prefix; found.plNum = String(num); }
  msg(r.sent
    ? 'Сохранено: первый путевой лист получит № ' + plFmtNum(prefix, num) + ', дальше — по возрастанию.'
    : 'Нет сети: сохранено в телефоне и применится при синхронизации.\nФормирование PDF станет доступно после синхронизации.');
  plRenderNumInto('plNumBlock', 'pl');
  plRenderNumInto('setPlBlock', 'set');
}function plRenderList() {
  localStorage.setItem(PL_EMAIL_KEY, $('plEmail').value.trim());
  const r = plPeriodRange($('plDate').value || todayISO(), $('plPeriod').value);
  if (!r) { $('plList').innerHTML = ''; return; }
  const rows = plShifts();
  $('plList').innerHTML = '<h3>Период: ' + ruFmtShort(r.from) + ' — ' + ruFmtShort(r.to) + '</h3>' +
    (rows.length ? rows.map(s => `
      <div class="ref-item">
        <b>${esc(ruFmtShort(s.date))}</b> — ${esc(s.carLabel || '')}${$('plScope').value === 'all' && s.driverId ? ' — ' + esc(s.driverId) : ''}<br>
        ${esc(s.timeStart || '')}–${esc(s.timeEnd || '')}, км: ${esc(s.totalKm || 0)}
        <a class="lnk" href="#" onclick="plDownloadOne('${escJsName(s.id)}');return false">⬇ PDF</a>
      </div>`).join('')
    : '<div class="ref-item empty">Смен за период нет.</div>');
}

function plSavePdf(b64, name) {
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  const url = URL.createObjectURL(new Blob([arr], { type: 'application/pdf' }));
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

async function plDownloadOne(id) {
  if (!id) { msg('У этой смены нет id — открой приложение при сети, чтобы обновить данные'); return; }
  msg('Готовлю путевой лист…');
  try {
    const out = await (await fetch(API_URL + '?page=waybill&id=' + encodeURIComponent(id))).json();
    if (!out.ok) { msg('Ошибка: ' + (out.error || 'сервер')); return; }
    plSavePdf(out.base64, out.filename || ('Путевой лист ' + id + '.pdf'));
    msg('PDF скачан');
  } catch (e) { msg('Нет сети: попробуй позже'); }
}

async function plDownloadAll() {
  const rows = plShifts().filter(s => s.id);
  if (!rows.length) { msg('Смен за период нет'); return; }
  let done = 0; const failed = [];
  for (let i = 0; i < rows.length; i++) {
    msg(`Путевой лист ${i + 1} из ${rows.length}: ${rows[i].driverId || me.fio}…`);
    try {
      const out = await (await fetch(API_URL + '?page=waybill&id=' + encodeURIComponent(rows[i].id))).json();
      if (out.ok) { plSavePdf(out.base64, out.filename || ('Путевой лист ' + rows[i].id + '.pdf')); done++; }
      else failed.push((rows[i].driverId || '') + ' ' + rows[i].date + ': ' + (out.error || 'ошибка'));
    } catch (e) { failed.push((rows[i].driverId || '') + ' ' + rows[i].date + ': нет сети'); }
  }
  msg(failed.length
    ? 'Готово: ' + done + ' из ' + rows.length + '. Ошибки: ' + failed.join('; ')
    : 'Готово: скачано ' + done + ' PDF. Если браузер спросил про «несколько файлов» — разреши.');
}

// Слитый PDF: все путевые листы периода — один файл
async function plDownloadMerged() {
  const rows = plShifts().filter(s => s.id);
  if (!rows.length) { msg('Смен за период нет'); return; }
  const r = plPeriodRange($('plDate').value || todayISO(), $('plPeriod').value);
  msg('Собираю один PDF из ' + rows.length + ' смен…');
  try {
    const ids = rows.map(s => encodeURIComponent(s.id)).join(',');
    const q = '?page=waybill&ids=' + ids + '&merge=1'
      + '&from=' + encodeURIComponent(r.from) + '&to=' + encodeURIComponent(r.to);
    const out = await (await fetch(API_URL + q)).json();
    if (!out.ok) { msg('Ошибка: ' + (out.error || 'сервер')); return; }
    plSavePdf(out.base64, out.filename || 'Путевые листы.pdf');
    msg(out.failed && out.failed.length
      ? 'Готово: в файле ' + out.sent + ' ПЛ. Пропущены: ' + out.failed.join('; ')
      : 'Готово: один PDF с ' + out.sent + ' путевыми листами.');
  } catch (e) { msg('Нет сети: попробуй позже'); }
}

async function plEmailAll() {
  const to = $('plEmail').value.trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) { msg('Укажи корректный email'); return; }
  const ids = plShifts().map(s => s.id).filter(Boolean);
  if (!ids.length) { msg('Смен за период нет'); return; }
  const r = plPeriodRange($('plDate').value || todayISO(), $('plPeriod').value);
  msg('Формирую и отправляю…');
  try {
    const q = '?page=waybill&ids=' + ids.map(encodeURIComponent).join(',')
      + '&email=' + encodeURIComponent(to)
      + '&from=' + encodeURIComponent(r.from) + '&to=' + encodeURIComponent(r.to);
    const out = await (await fetch(API_URL + q)).json();
    msg(out.ok
      ? 'Отправлено путевых листов: ' + out.sent + (out.failed && out.failed.length ? '; ошибки: ' + out.failed.join('; ') : '')
      : 'Ошибка: ' + (out.error || 'сервер'));
  } catch (e) { msg('Нет сети: попробуй позже'); }
}

// ================= ЗАПУСК =================
async function init() {
  // Тема применяется до показа экранов — без вспышки светлого на тёмном телефоне
  initTheme();
  // Смена восстанавливается сразу, без ожидания сети:
  // офлайн-запуск не должен её терять
  const restored = restoreState();
  await loadDrivers();
  const auth = getAuth();
  if (auth && auth.fio) {
    const d = drivers.find(x => normFio(x.fio) === normFio(auth.fio));
    if (d) {
      enterApp(d.fio, d.role || '', d.id || '');
    } else {
      showScreen('loginScreen');
    }
  } else {
    showScreen('loginScreen');
  }
  // Инфо о смене показал enterApp; здесь — только подготовка к новой смене
  if (!restored) {
    const saved = parseFloat(localStorage.getItem('lastOdoEnd'));
    if (!isNaN(saved) && saved > 0) $('odoStart').value = saved;
    $('shiftDate').value = todayISO();
  }
}

init();

// ================= АНАЛИТИКА БИГБОСА =================
// Роль «БигБос»: один экран, никаких меню, только выбор аналитики кнопками
function isBigBoss(u) {
  return !!u && String(u.role || '').trim().toLowerCase() === 'бигбос';
}

let bossKind = 'routes';   // 'routes' | 'doctors' | 'all'
let bossDriver = '';       // '' — все водители
let bossDoc = '';          // '' — все врачи и точки, иначе ФИО врача или имя точки

// Вход БигБоса: сразу на свой экран, минуя обычное меню
function openBoss() {
  showScreen('bossScreen');
  if (!$('bossDate').value) $('bossDate').value = todayISO();
  if (!$('bossPeriod').value) $('bossPeriod').value = 'month';
  renderBoss();
}

// Фильтр врача: ФИО врача либо имя точки (пусто — все)
function bossDocMatches(v) {
  if (!bossDoc) return true;
  return normFio(v.doctor || '') === normFio(bossDoc) ||
         String(v.place || '').trim().toLowerCase() === String(bossDoc).trim().toLowerCase();
}

function renderBoss() {
  if (!me) return;
  // Селекты перестраиваем каждый раз: свежие водители и врачи подхватываются
  const drvFios = drivers.map(d => d.fio).sort(ruCmp);
  if (bossDriver && !drvFios.some(f => normFio(f) === normFio(bossDriver))) bossDriver = '';
  $('bossDriverSel').innerHTML = '<option value="">— все водители —</option>' +
    drvFios.map(f => `<option value="${esc(f)}"${normFio(f) === normFio(bossDriver) ? ' selected' : ''}>${esc(f)}</option>`).join('');

  const docNamesAll = Array.from(new Set(doctorsAll.map(v => v.doctor).filter(Boolean))).sort(ruCmp);
  const placesAll = Array.from(new Set(doctorsAll.map(v => v.place).filter(Boolean))).sort(ruCmp);
  const docKnown = docNamesAll.some(f => normFio(f) === normFio(bossDoc));
  const placeKnown = placesAll.some(p => String(p) === bossDoc);
  if (bossDoc && !docKnown && !placeKnown) bossDoc = '';
  $('bossDocSel').innerHTML = '<option value="">— все врачи и точки —</option>' +
    docNamesAll.map(f => `<option value="${esc(f)}"${normFio(f) === normFio(bossDoc) ? ' selected' : ''}>${esc(f)}</option>`).join('') +
    placesAll.map(p => `<option value="${esc(p)}"${p === bossDoc ? ' selected' : ''}>📍 ${esc(p)}</option>`).join('');

  // Фильтр врача/точки нужен только на вкладках «Врачи» и «Общая»
  $('bossDocRow').style.display = bossKind === 'routes' ? 'none' : 'block';

  const r = plPeriodRange($('bossDate').value || todayISO(), $('bossPeriod').value || 'month');
  $('bossOut').innerHTML = bossKind === 'routes' ? bossRenderRoutes(r)
    : bossKind === 'doctors' ? bossRenderDoctors(r)
    : bossRenderAll(r);
  $('bossTabs').innerHTML = `
    <button class="${bossKind === 'routes' ? 'active' : ''}" onclick="bossSetKind('routes')">🚗 Маршруты</button>
    <button class="${bossKind === 'doctors' ? 'active' : ''}" onclick="bossSetKind('doctors')">👩‍⚕️ Врачи</button>
    <button class="${bossKind === 'all' ? 'active' : ''}" onclick="bossSetKind('all')">🧭 Общая</button>`;
}

function bossSetKind(k) { bossKind = k; renderBoss(); }
function bossDrvChange() { bossDriver = $('bossDriverSel').value; renderBoss(); }
function bossDocChange() { bossDoc = $('bossDocSel').value; renderBoss(); }

// Опоздание в минутах: посадка минус назначенное время; null — если время не разобрать
function bossLateMin(v) {
  const a = hhmmToMin(v.timeAppointed), b = hhmmToMin(v.timeBoarding);
  if (isNaN(a) || isNaN(b)) return null;
  return b - a;
}

// Плитка сводки
function bossTile(num, cap) {
  return `<div class="boss-tile"><div class="num">${num}</div><div class="cap">${cap}</div></div>`;
}

// Полоса мини-графика: подпись + длина по максимуму серии
function bossBars(items) {
  const max = Math.max(1, ...items.map(x => x.v));
  return items.length ? `<div class="boss-bars">` + items.map(x => `
    <div class="boss-bar">
      <div class="lbl">${esc(x.l)}</div>
      <div class="track"><div class="fill" style="width:${Math.round(x.v / max * 100)}%">${x.t}</div></div>
    </div>`).join('') + `</div>` : '';
}

// Вкладка «Маршруты»: дашборд — плитки, полоски по дням, детализация
function bossRenderRoutes(r) {
  const rows = shiftsData
    .filter(s => isoOf(s.date) >= r.from && isoOf(s.date) <= r.to)
    .filter(s => !bossDriver || normFio(s.driverId || '') === normFio(bossDriver))
    .sort((a, b) => isoOf(a.date) < isoOf(b.date) ? -1 : 1);
  const totKm = rows.reduce((a, s) => a + (parseFloat(s.totalKm) || 0), 0);
  const totRef = rows.reduce((a, s) => a + (parseFloat(s.refuel) || 0), 0);
  const totMin = rows.reduce((a, s) => a + shiftMinutes(s), 0);
  // Полоски по дням: км смены на дату
  const byDay = {};
  rows.forEach(s => {
    const k = isoOf(s.date);
    byDay[k] = (byDay[k] || 0) + (parseFloat(s.totalKm) || 0);
  });
  const bars = Object.keys(byDay).sort().map(d =>
    ({ l: ruFmtShort(d), v: byDay[d], t: byDay[d].toFixed(1) + ' км' }));
  const body = rows.map(s => `
    <div class="ref-item">
      <b>${esc(ruFmtShort(s.date))}</b> — ${esc(s.driverId || '—')}<br>
      Куда: ${esc(s.route || '—')}, км: <b>${esc(s.totalKm || '0')}</b>,
      время: ${esc(s.timeStart || '—')}–${esc(s.timeEnd || '—')},
      заправка: ${s.refuel ? esc(s.refuel) + ' л' : '—'},
      продолжительность: ${esc(s.duration || minToHHMM(shiftMinutes(s)))}
    </div>`).join('');
  return `
    <div class="boss-tiles">
      ${bossTile(rows.length, 'смен')}
      ${bossTile(totKm.toFixed(1), 'км всего')}
      ${bossTile(totRef ? totRef.toFixed(1) + ' л' : '—', 'заправка')}
      ${bossTile(minToHHMM(totMin), 'время в пути')}
    </div>
    <div class="card">${bossBars(bars)}</div>
    <div class="card">${body || '<div class="ref-item empty">Смен за период нет.</div>'}</div>`;
}

// Вкладка «Врачи»: плитки + полоски по врачам (перевозки), детализация ниже
function bossRenderDoctors(r) {
  const rows = doctorsAll
    .filter(v => v.date >= r.from && v.date <= r.to)
    .filter(bossDocMatches)
    .sort((a, b) => (a.date < b.date ? -1 : 1) || (hhmmToMin(a.timeAppointed) - hhmmToMin(b.timeAppointed)));
  let lateCount = 0, lateSum = 0;
  const byDoc = {};
  const body = rows.map(v => {
    const diff = bossLateMin(v);
    if (diff !== null && diff > 0) { lateCount++; lateSum += diff; }
    const key = v.doctor || v.place || '—';
    byDoc[key] = (byDoc[key] || 0) + 1;
    const lateTxt = diff === null ? '—'
      : diff > 0 ? `<b>+${diff} мин</b>` : diff < 0 ? `раньше на ${-diff} мин` : 'точно';
    return `
    <div class="ref-item">
      <b>${esc(ruFmtShort(v.date))}</b> — ${esc(v.doctor || '—')} → ${esc(v.place || '—')}<br>
      Назначено: ${esc(v.timeAppointed || '—')}, посадка: ${esc(v.timeBoarding || '—')}, опоздание: ${lateTxt}
    </div>`;
  }).join('');
  const bars = Object.keys(byDoc).sort(ruCmp).map(d =>
    ({ l: d, v: byDoc[d], t: String(byDoc[d]) }));
  return `
    <div class="boss-tiles">
      ${bossTile(rows.length, 'перевозок')}
      ${bossTile(lateCount, 'опозданий')}
      ${bossTile(lateCount ? Math.round(lateSum / lateCount) + ' мин' : '—', 'среднее опоздание')}
    </div>
    <div class="card">${bossBars(bars)}</div>
    <div class="card">${body || '<div class="ref-item empty">Перевозок за период нет.</div>'}</div>`;
}

// Вкладка «Общая»: плитки сводки + смены с вложенными врачами (связка по shiftId)
function bossRenderAll(r) {
  const rows = shiftsData
    .filter(s => isoOf(s.date) >= r.from && isoOf(s.date) <= r.to)
    .filter(s => !bossDriver || normFio(s.driverId || '') === normFio(bossDriver))
    .sort((a, b) => isoOf(a.date) < isoOf(b.date) ? -1 : 1);
  const totKm = rows.reduce((a, s) => a + (parseFloat(s.totalKm) || 0), 0);
  const totMin = rows.reduce((a, s) => a + shiftMinutes(s), 0);
  let lateCount = 0;
  const body = rows.map(s => {
    const docs = doctorsAll
      .filter(v => v.shiftId && v.shiftId === s.id)
      .filter(bossDocMatches)
      .sort((a, b) => (hhmmToMin(a.timeAppointed) || 0) - (hhmmToMin(b.timeAppointed) || 0));
    const docLines = docs.map(v => {
      const diff = bossLateMin(v);
      if (diff !== null && diff > 0) lateCount++;
      const lateTxt = diff === null ? '—'
        : diff > 0 ? `<b>+${diff} мин</b>` : diff < 0 ? `раньше на ${-diff} мин` : 'точно';
      return `
        <div class="ref-item" style="padding-left:14px">
          ${esc(v.doctor || '—')} → ${esc(v.place || '—')},
          назначено: ${esc(v.timeAppointed || '—')}, посадка: ${esc(v.timeBoarding || '—')}, опоздание: ${lateTxt}
        </div>`;
    }).join('');
    return `
    <div class="ref-item">
      <b>${esc(ruFmtShort(s.date))}</b> — ${esc(s.driverId || '—')}<br>
      Куда: ${esc(s.route || '—')}, км: <b>${esc(s.totalKm || '0')}</b>,
      время: ${esc(s.timeStart || '—')}–${esc(s.timeEnd || '—')},
      заправка: ${s.refuel ? esc(s.refuel) + ' л' : '—'},
      продолжительность: ${esc(s.duration || minToHHMM(shiftMinutes(s)))}
      <h4>Врачи</h4>${docLines || '<div class="empty">Перевозок в этой смене нет.</div>'}
    </div>`;
  }).join('');
  return `
    <div class="boss-tiles">
      ${bossTile(rows.length, 'смен')}
      ${bossTile(totKm.toFixed(1), 'км всего')}
      ${bossTile(minToHHMM(totMin), 'время в пути')}
      ${bossTile(lateCount, 'опозданий')}
    </div>
    <div class="card">${body || '<div class="ref-item empty">Смен за период нет.</div>'}</div>`;
}

// ================= МАРШРУТ ДНЯ =================
// Старт и финиш: офис (по умолчанию), клиники, врачи, произвольные точки
// из справочника или новая точка по адресу. Врачи — промежуточные точки;
// у врача с несколькими адресами адрес выбирается списком, новый адрес
// дописывается в справочник на сервере вместе с координатами
function openRoute() {
  showScreen('routeScreen');
  renderRouteInputs();
  $('routeOut').innerHTML = '';
  const form = $('routeForm');
  if (form) form.style.display = 'block';
}

// Выход с экрана маршрута в меню (кнопка «← Меню» в шапке обоих состояний)
function routeExitMenu() { goMenu(); }

// Ключ точки для селектов: у клиник «город|название», у остальных — название
function routePtKey(p) {
  return p.type === 'клиника'
    ? ((p.city || '') + '|' + p.name).toLowerCase()
    : String(p.name || '').toLowerCase().replace(/ё/g, 'е');
}

function fillRoutePointSelect(selId, wrapId, withOffice) {
  let html = '';
  if (withOffice) html += '<option value="__office">🛏 Офис</option>';
  else html += '<option value="">— выбери конечную точку —</option>';
  geoPoints.forEach(p => {
    const l = p.type === 'клиника' ? (p.city ? p.city + ', ' : '') + p.name
      : (p.type === 'врач' ? '👨‍⚕️ ' : '📍 ') + p.name;
    html += `<option value="${esc(routePtKey(p))}">${esc(l)}</option>`;
  });
  html += '<option value="__new">➕ Другая точка (по адресу)…</option>';
  $(selId).innerHTML = html;
  $(wrapId).style.display = 'none';
}

function routePointChange(selId, wrapId) {
  $(wrapId).style.display = $(selId).value === '__new' ? 'block' : 'none';
}

function renderRouteInputs() {
  fillRoutePointSelect('routeStart', 'routeStartNew', true);
  fillRoutePointSelect('routeEnd', 'routeEndNew', false);
  $('routeDocs').innerHTML = '';
  addDocRow();
}

// ===== Врачи маршрута: выбор врача → список его адресов или поле нового =====
let docRowSeq = 0;

// ФИО всех врачей справочника — источник подсказок
const acRouteDocs = () => doctorsContact
  .map(d => (d && typeof d === 'object') ? String(d.fio || '').trim() : String(d || '').trim())
  .filter(Boolean).sort(ruCmp);

// Точное имя врача в справочнике (регистр и «ё» не важны)
function findDocByName(name) {
  const k = String(name || '').trim().toLowerCase().replace(/ё/g, 'е');
  if (!k) return null;
  return doctorsContact.find(d =>
    String((d && d.fio) || '').trim().toLowerCase().replace(/ё/g, 'е') === k) || null;
}

// Есть ли у врача координаты в «Врачи» (основной адрес)
function docHasGeo(name) {
  const k = String(name || '').trim().toLowerCase().replace(/ё/g, 'е');
  if (!k) return false;
  return geoPoints.some(p => p.type === 'врач' &&
    String(p.name || '').trim().toLowerCase().replace(/ё/g, 'е') === k);
}

// Дополнительные адреса врача из «Адреса врачей» (только с координатами)
function docAddrList(name) {
  const k = String(name || '').trim().toLowerCase().replace(/ё/g, 'е');
  if (!k) return [];
  return docAddresses
    .filter(a => String(a.doctor || '').trim().toLowerCase().replace(/ё/g, 'е') === k &&
      a.addr && a.lat !== null && a.lon !== null)
    .map(a => String(a.addr));
}

// Интерфейс адреса врача: список адресов, если они есть, иначе поле ввода
function docAddrUI(n, strict) {
  const inp = $('docNameIn_' + n);
  const selWrap = $('docAddrSelWrap_' + n), sel = $('docAddrSel_' + n);
  const wrap = $('docAddrWrap_' + n);
  if (!inp || !selWrap || !sel || !wrap) return;
  const v = inp.value.trim();
  if (!v) { selWrap.style.display = 'none'; wrap.style.display = 'none'; return; }
  const addrs = docAddrList(v);
  if (addrs.length) {
    sel.innerHTML =
      (docHasGeo(v) ? '<option value="">Основной адрес</option>' : '') +
      addrs.map(a => `<option value="${esc(a)}">${esc(a)}</option>`).join('') +
      '<option value="__new">➕ Новый адрес…</option>';
    selWrap.style.display = 'block';
    wrap.style.display = 'none';
    return;
  }
  selWrap.style.display = 'none';
  if (docHasGeo(v)) { wrap.style.display = 'none'; return; }
  if (findDocByName(v) || strict) wrap.style.display = 'block';
}

function addDocRow() {
  const wrap = $('routeDocs');
  if (!wrap) return;
  const n = docRowSeq++;
  const row = document.createElement('div');
  row.className = 'docRow';
  row.id = 'docRow_' + n;
  row.style.margin = '6px 0';
  row.innerHTML = `
    <input class="docNameIn" id="docNameIn_${n}" placeholder="Фамилия врача…" style="width:calc(100% - 44px)">
    <div class="ac-box" id="docNameAc_${n}"></div>
    <div class="docAddrSelWrap" id="docAddrSelWrap_${n}" style="display:none;margin-top:4px">
      <select class="docAddrSel" id="docAddrSel_${n}" onchange="docAddrNewToggle(${n})" style="width:calc(100% - 44px)"></select>
    </div>
    <div class="docAddrWrap" id="docAddrWrap_${n}" style="display:none;margin-top:4px">
      <input class="routeAddr" id="docAddrIn_${n}" placeholder="Полный адрес: город, улица, дом" style="width:calc(100% - 44px)">
    </div>
    <button class="small" style="width:36px" onclick="removeDocRow(${n})">✕</button>`;
  wrap.appendChild(row);
  attachPrefixAc('docNameIn_' + n, 'docNameAc_' + n, acRouteDocs);
  $('docNameIn_' + n).addEventListener('input', () => docAddrUI(n, false));
  $('docNameIn_' + n).addEventListener('change', () => docAddrUI(n, true));
}

function docAddrNewToggle(n) {
  const sel = $('docAddrSel_' + n), wrap = $('docAddrWrap_' + n);
  if (!sel || !wrap) return;
  wrap.style.display = sel.value === '__new' ? 'block' : 'none';
}

function removeDocRow(n) {
  const row = $('docRow_' + n);
  if (row) row.remove();
}

async function routeBuildGo() {
  const need = ['routeStart', 'routeStartNew', 'routeEnd', 'routeEndNew', 'routeTime', 'routeDocs'];
  const missing = need.filter(id => !$(id));
  if (missing.length) {
    msg('Файлы разсинхронизированы: на странице нет полей ' + missing.join(', ') +
        '. Перезалей index.html и обнови страницу (Ctrl+Shift+R)');
    return;
  }
  const arriveBy = $('routeTime').value;
  if (!arriveBy) { msg('Укажи время прибытия'); return; }

  const payload = { action: 'routeBuild', arriveBy: arriveBy, docs: [] };

  // Старт: офис по умолчанию, точка из справочника или новая по адресу
  const sSel = $('routeStart').value;
  if (sSel === '__new') {
    const addr = $('routeStartAddr').value.trim();
    if (!addr) { msg('У начальной точки укажи адрес'); return; }
    payload.startAddr = addr;
    payload.startName = $('routeStartName').value.trim();
  } else if (sSel && sSel !== '__office') {
    payload.startKey = sSel;
  }

  // Финиш: обязателен
  const eSel = $('routeEnd').value;
  if (eSel === '__new') {
    const addr = $('routeEndAddr').value.trim();
    if (!addr) { msg('У конечной точки укажи адрес'); return; }
    payload.endAddr = addr;
    payload.endName = $('routeEndName').value.trim();
  } else if (eSel) {
    payload.endKey = eSel;
  } else {
    msg('Выбери конечную точку'); return;
  }

  // Врачи: основной адрес без addr, выбранный — с адресом, новый — из поля
  let needAddr = false;
  $('routeDocs').querySelectorAll('.docRow').forEach(row => {
    const inp = row.querySelector('.docNameIn');
    const nm = inp ? inp.value.trim() : '';
    if (!nm) return;
    let addr = '';
    const selWrap = row.querySelector('.docAddrSelWrap');
    const sel = row.querySelector('.docAddrSel');
    const addrWrap = row.querySelector('.docAddrWrap');
    const addrIn = row.querySelector('.routeAddr');
    if (selWrap && sel && selWrap.style.display !== 'none' &&
        sel.value !== '' && sel.value !== '__new') {
      addr = sel.value;
    } else if (addrWrap && addrIn && addrWrap.style.display !== 'none') {
      addr = addrIn.value.trim();
    }
    if (!docHasGeo(nm) && !addr) needAddr = true;
    payload.docs.push({ name: nm, addr: addr });
  });
  if (needAddr) { msg('У врача без координат выбери или впиши адрес'); return; }

  msg('Считаю маршрут…');
  const d = await serverAuth('routeBuild', payload);
  if (!d || !d.ok) { msg('Ошибка: ' + ((d && d.error) || 'сервер')); return; }
  renderRouteResult(d);
  msg('');
}

function renderRouteResult(d) {
  const rows = d.points.map((p, i) => `
    <div class="ref-item">
      <b>${i + 1}. ${esc(p.name)}</b><br>
      Прибытие: <b>${minToHHMM(p.arrival)}</b>
    </div>`).join('');
  const form = $('routeForm');
  if (form) form.style.display = 'none';
  $('routeOut').innerHTML = `
    <div class="boss-tiles">
      ${bossTile(minToHHMM(d.departure), 'выехать')}
      ${bossTile(minToHHMM(d.arriveEnd), 'прибытие в конец')}
      ${bossTile(d.totalKm ? d.totalKm + ' км' : '—', 'протяжённость')}
    </div>
    <div class="card">${rows}</div>
    <div class="card">
      <a class="lnk" target="_blank" rel="noopener" href="${esc(d.url)}">🚕 Открыть маршрут в Навигаторе</a>
      ${d.mode === 'estimate' ? '<div class="empty">Время оценочное</div>' : ''}
      ${d.tooLate ? '<div class="empty">⚠️ К этому времени не успеть — выезд фактически в 00:00.</div>' : ''}
    </div>
    <div class="card">
      <button onclick="openRoute()">Построить новый маршрут</button>
    </div>`;
}
