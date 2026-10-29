const API_URL = 'https://script.google.com/macros/s/AKfycbzq-ZwU9rCSy3mYpfjJfjs6YNnfqgY7STKJgNJgFzmuG4UFQvoDHKqD7sSLHBwysYKX/exec'; // TODO: сменить после переразвёртывания веб-приложения

const $ = id => document.getElementById(id);
const msg = t => { $('msg').textContent = t; };
const uid = () => Date.now() + '-' + Math.floor(Math.random() * 1e6);
const todayISO = () => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0'); };
const hhmmToMin = t => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(t || '')); return m ? Number(m[1]) * 60 + Number(m[2]) : NaN; };
const minToHHMM = m => String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
const ruCmp = (a, b) => String(a || '').localeCompare(String(b || ''), 'ru');
const normFio = s => String(s || '').trim().toLowerCase();

let me = null;
let shift = null;
let segments = [];
let doctorVisits = [];
let points = ['ОФИС'];
let interPoints = [];
let medPoints = []; // «Куда везём врача» — лист MedPoints
let docNames = [];
let drivers = [];
let carEditMode = null;
let shiftsData = [];
let reportDetail = null;
let doctorsContact = [];
let clinics = [];
// Формы справочника: null = добавление, ключ = правка
let docEditKey = null;
let clinicEditKey = null;

const QUEUE_KEY = 'sendQueue';
const REF_KEY = 'refCache';
const STATE_KEY = 'appState_v1';
const SHIFTS_KEY = 'shiftsCache';
const AUTH_KEY = 'authCreds';
const MAX_TRIES = 3; // попыток на пакет до пропуска
const carLabel = c => ((c.name || '') + ' ' + (c.plate || '')).trim();

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

function renderLoginHints() {
  $('loginFioList').innerHTML = drivers
    .map(d => `<option value="${esc(d.fio)}">`).join('');
}

async function doLogin() {
  const fio = $('loginFio').value.trim();
  const pin = $('loginPin').value.trim();
  if (!fio || !pin) { msg('Укажи ФИО и PIN'); return; }
  msg('Вхожу…');
  try {
    const out = await serverAuth('login', { fio: fio, pin: pin });
    if (out.ok) {
      setAuth(out.fio, pin);
      enterApp(out.fio, out.role || '');
      // Инфо о восстановленной смене показал enterApp — не затираем её
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
  if (Array.isArray(data.points) && data.points.length) {
    points = Array.from(new Set(['ОФИС'].concat(data.points)));
  }
  if (Array.isArray(data.interPoints)) interPoints = Array.from(new Set(data.interPoints));
  if (Array.isArray(data.medPoints)) medPoints = Array.from(new Set(data.medPoints));
  if (Array.isArray(data.docNames)) docNames = Array.from(new Set(data.docNames));
  if (Array.isArray(data.doctorsContact)) doctorsContact = data.doctorsContact;
  if (Array.isArray(data.clinics)) clinics = data.clinics;
  // Подсказки врача — только из DoctorsRef (лист «Врачи» не подмешивается)
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
  // Авто из открытой смены обязано быть в списке, даже если справочник ещё не доехал
  if (shift && shift.carLabel && !cars.find(c => carLabel(c) === shift.carLabel)) {
    cars.unshift({ name: shift.carLabel, plate: '', row: null });
  }
  $('carSel').innerHTML = cars.length
    ? cars.map(c => `<option value="${esc(carLabel(c))}">${esc(carLabel(c))}</option>`).join('')
    : '<option value="">— нет автомобилей —</option>';
  $('carSel').innerHTML += '<option value="__new">➕ Добавить автомобиль…</option>';
  $('carPanel').style.display = 'none';
  updateCarButtons();
  $('meName').textContent = me.fio;
  $('editDriverBtn').style.display = 'block';
  // Восстанавливаем выбор: авто открытой смены, иначе последнее использованное
  if (shift && shift.carLabel) selectCarByLabel(shift.carLabel);
  else selectCarByLabel(localStorage.getItem('lastCar'));
}

function currentCarLabel() {
  const v = $('carSel').value;
  return (v === '__new' || !v) ? null : v;
}

function updateCarButtons() {
  const has = !!currentCarLabel() && (me.cars || []).length > 0;
  $('editCarBtn').style.display = has ? 'block' : 'none';
}

function selectCarByLabel(label) {
  if (!label) return;
  const opt = Array.from($('carSel').options).find(o => o.value === label);
  if (opt) $('carSel').value = label;
  updateCarButtons();
}

// Подсказки «Откуда/Куда» переключаются по типу маршрута:
// городской — Points, междугородний — InterPoints
function renderSegPoints() {
  if (!$('segType') || !$('segPointsList')) return;
  const src = $('segType').value === 'inter' ? interPoints : points;
  $('segPointsList').innerHTML = src.slice().sort(ruCmp).map(p => `<option value="${esc(p)}">`).join('');
}
// Подсказки «Куда везём» — только MedPoints
function renderDocPlaceList() {
  if (!$('docPlaceList')) return;
  $('docPlaceList').innerHTML = medPoints.slice().sort(ruCmp).map(p => `<option value="${esc(p)}">`).join('');
}
function renderDocNames() {
  if (!$('docNamesList')) return;
  $('docNamesList').innerHTML = docNames.slice().sort(ruCmp).map(p => `<option value="${esc(p)}">`).join('');
}

function onSegTypeChange() {
  renderSegPoints();
  saveState();
}

function onCarChange() {
  if ($('carSel').value === '__new') openCarPanel('new');
  else {
    $('carPanel').style.display = 'none';
    updateCarButtons();
    if (me) localStorage.setItem('lastCar', $('carSel').value);
  }
}

function openCarPanel(mode) {
  if (!me) { msg('Сначала войди'); return; }
  carEditMode = mode;
  if (mode === 'edit') {
    const c = me.cars.find(x => carLabel(x) === $('carSel').value) || me.cars[0];
    if (!c) { msg('Нет автомобиля для правки'); return; }
    $('carNameInput').value = c.name || '';
    $('carPlateInput').value = c.plate || '';
  } else {
    $('carNameInput').value = '';
    $('carPlateInput').value = '';
  }
  $('carPanel').style.display = 'block';
  $('driverEditPanel').style.display = 'none';
}

async function saveCar() {
  if (!me) { msg('Сначала войди'); return; }
  const car = $('carNameInput').value.trim();
  const plate = $('carPlateInput').value.trim();
  if (!car || !plate) { msg('Укажи марку и госномер'); return; }
  const label = car + ' ' + plate;
  msg('Сохраняю автомобиль…');
  // В смене с отрезками сменить авто нельзя: одометр начала привязан к конкретной машине
  if (shift && segments.length > 0) {
    msg('В смене уже есть отрезки — сменить автомобиль нельзя.\nЗавершите смену и откройте новую с нужным авто.');
    $('carPanel').style.display = 'none';
    return;
  }
  let r;
  const c = carEditMode === 'edit'
    ? (me.cars.find(x => carLabel(x) === $('carSel').value) || me.cars[0])
    : null;
  if (carEditMode === 'edit' && c && c.row) {
    // Правка известна серверу по номеру строки
    r = await sendOrQueue([{ id: 'care-' + uid(), type: 'driveredit', row: c.row, fio: me.fio, car: car, plate: plate }]);
    c.name = car; c.plate = plate;
  } else {
    // Автомобиль добавлен офлайн (row отсутствует) — отправляем как новый,
    // иначе сервер отклонит «driveredit» без строки и правка потеряется
    r = await sendOrQueue([{ id: 'car-' + uid(), type: 'driver', fio: me.fio, car: car, plate: plate }]);
    me.cars.push({ name: car, plate: plate, row: null });
  }
  // Если смена открыта без отрезков — привязываем её к новому авто
  if (shift) {
    shift.carLabel = label;
    shift.carId = shift.driverId + '|' + label;
    saveState();
  }
  localStorage.setItem('lastCar', label);
  renderCars();
  selectCarByLabel(label);
  $('carPanel').style.display = 'none';
  msg(r.sent ? 'Автомобиль сохранён: ' + label
             : 'Нет сети: автомобиль записан в очередь и попадёт в таблицу при синхронизации');
}

function openDriverEdit() {
  if (!me) { msg('Сначала войди'); return; }
  $('editDriverFio').value = me.fio;
  $('driverEditPanel').style.display = 'block';
  $('carPanel').style.display = 'none';
}

async function saveDriverEdit() {
  if (!me) { msg('Сначала войди'); return; }
  const fio = $('editDriverFio').value.trim().replace(/\s+/g, ' ');
  if (!fio) { msg('Укажи новое ФИО'); return; }
  if (normFio(fio) === normFio(me.fio)) { msg('ФИО не изменилось'); return; }
  msg('Сохраняю ФИО…');
  const r = await sendOrQueue([{ id: 'drvr-' + uid(), type: 'driverrename', fioOld: me.fio, fio: fio }]);
  me.fio = fio;
  const auth = getAuth();
  if (auth) setAuth(fio, auth.pin);
  $('driverEditPanel').style.display = 'none';
  renderCars();
  renderDashboard();
  msg(r.sent ? 'ФИО обновлено: ' + fio
             : 'Нет сети: правка записана в очередь и применится при синхронизации');
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
// смена всегда стартует и финиширует в ОФИС
function compressRoute(pointsList) {
  if (!pointsList || !pointsList.length) return '';
  const result = [pointsList[0]];
  for (let i = 1; i < pointsList.length; i++) {
    const last = result[result.length - 1];
    const cur = pointsList[i];
    if (cur === last) continue;
    if (areEquivalentPoints(last, cur)) continue;
    result.push(cur);
  }
  if (result.length) {
    if (result[0] === 'ИЖЕВСК') result[0] = 'ОФИС'; // страховка для старых смен
    if (result.length > 1 && result[result.length - 1] === 'ИЖЕВСК') result[result.length - 1] = 'ОФИС';
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
// refRender может быть null-safe функцией — она вызывается только при новом имени.
function rememberRef(list, refType, name) {
  if (!name || list.includes(name)) return;
  list.push(name);
  renderSegPoints();
  renderDocPlaceList();
  sendOrQueue([{ id: (refType === 'interpoint' ? 'i-' : refType === 'medpoint' ? 'm-' : 'p-') + uid(), type: refType, name: name }]);
}

// ================= ЭКРАНЫ =================
const SCREENS = ['loginScreen', 'menuScreen', 'workScreen', 'reportScreen', 'refsScreen'];
function showScreen(name) {
  SCREENS.forEach(id => { $(id).style.display = 'none'; });
  $(name).style.display = 'block';
}

function goMenu() {
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
  // после первого одометр начала смены привязан к конкретному авто
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
}

// ================= ДАШБОРД =================
function renderDashboard() {
  if (!me) return;
  const month = todayISO().slice(0, 7);
  const rows = shiftsData.filter(s => normFio(s.driverId) === normFio(me.fio) && String(s.date || '').startsWith(month));
  let total = 0, refuel = 0, minutes = 0;
  rows.forEach(s => {
    total += parseFloat(s.totalKm) || 0;
    refuel += parseFloat(s.refuel) || 0;
    minutes += shiftMinutes(s);
  });
  // Видимый счётчик неотправленного — главный ответ на жалобу «я ввёл, а оно пропало»
  const queued = loadQueue().length;
  $('dashCard').style.display = 'block';
  $('dashTitle').textContent = `📊 ${me.fio} — ${month}`;
  $('dashBody').innerHTML = `
    <div class="dash-row"><span>Смен</span><span>${rows.length}</span></div>
    <div class="dash-row"><span>Пробег, км</span><span>${total.toFixed(1)}</span></div>
    <div class="dash-row"><span>Заправка, л</span><span>${refuel ? refuel.toFixed(1) : '—'}</span></div>
    <div class="dash-row"><span>Продолжительность смен</span><span>${minToHHMM(minutes)}</span></div>` +
    (queued ? `<div class="dash-row"><span>⚠ Не отправлено записей</span><span>${queued}</span></div>` : '');
  $('supBtn').style.display = isSupervisor(me) ? 'block' : 'none';
}

// ================= СТАТИСТИКА (СТАРШИЙ) =================
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
  const rows = shiftsData.filter(s => String(s.date || '').startsWith(month));
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
      <b>${esc(s.date)}</b> — ${esc(s.carLabel || '')}
      <div>${s.timeStart || ''}–${s.timeEnd || ''} (${s.duration || minToHHMM(shiftMinutes(s))}), км: ${s.totalKm || 0}${s.refuel ? `, заправка ${s.refuel} л` : ''}</div>
      <div style="font-size:13px;color:#555">Маршрут: ${esc(s.route || '—')}</div>
      ${s.doctor ? `<div style="font-size:13px;color:#555">Врачи: ${esc(s.doctor)}</div>` : ''}
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
  $('docsCard').style.display = 'none';
  $('clsCard').style.display = 'none';
  closeDocForm();
  closeClinicForm();
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
  if (digits.length === 11 && digits[0] === '7') return 'tel:+' + digits;
  return 'tel:' + digits;
}

// --- Врачи: поиск, карточки с правкой (ФИО — единственный ключ) ---
function renderRefsDoc() {
  const q = ($('refSearchDoc').value || '').trim().toLowerCase();
  if (!q) { $('docsCard').style.display = 'none'; return; }
  const docs = doctorsContact
    .filter(d => String(d.fio || '').toLowerCase().indexOf(q) !== -1)
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
}

// --- Форма врача: добавление и правка ---
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
  if (!q) { $('clsCard').style.display = 'none'; return; }
  const cls = clinics
    .filter(c => String(c.city || '').toLowerCase().indexOf(q) !== -1)
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

// ================= СМЕНА =================
function startShift() {
  const dateStr = $('shiftDate').value;
  const tStart = $('timeStart').value;
  const odo = parseFloat($('odoStart').value.replace(',', '.'));
  if (!me) { msg('Сначала войди'); return; }
  if (!dateStr || !tStart) { msg('Укажи дату и время начала смены'); return; }
  const carLabelVal = currentCarLabel();
  if (!carLabelVal) { msg('Выбери автомобиль'); return; }
  const carObj = (me.cars || []).find(c => carLabel(c) === carLabelVal);
  if (!carObj) { msg('Выбери автомобиль'); return; }
  if (isNaN(odo) || odo < 0) { msg('Укажи одометр на начало'); return; }
  shift = {
    id: uid(),
    driverId: me.fio,
    carId: me.fio + '|' + carLabelVal,
    carLabel: carLabelVal,
    date: dateStr, timeStart: tStart, odoStart: odo
  };
  segments = [];
  doctorVisits = [];
  $('segType').value = 'city';
  localStorage.setItem('lastCar', carLabelVal);
  saveState();
  showWork();
  $('segFrom').value = 'ОФИС';
  $('segTo').value = ''; $('segKm').value = '';
  msg(`Смена открыта: ${me.fio}, ${carLabelVal}.`);
}

function addSegment() {
  const segType = $('segType').value;
  // Городской — список Points, междугородний — InterPoints
  const refList = segType === 'inter' ? interPoints : points;
  const refType = segType === 'inter' ? 'interpoint' : 'point';
  const from = canonName($('segFrom').value, refList);
  const to = canonName($('segTo').value, refList);
  const km = parseFloat(String($('segKm').value).replace(',', '.'));
  if (!from || !to || isNaN(km) || km < 0) { msg('Заполни «Откуда», «Куда» и пробег'); return; }
  const prevKm = segments.length ? segments[segments.length - 1].kmAtB : 0;
  if (km <= prevKm) {
    msg(`Ошибка: показание одометра (${km}) должно быть больше предыдущего: ${prevKm} км.\nЕсли нужно записать километраж отрезка — считай показание сам: ${prevKm} + километраж.`);
    return;
  }
  const segmentKm = km - prevKm;
  const routeType = segType === 'city'
    ? 'Город'
    : ((from === 'ОФИС' || to === 'ОФИС' || from === to) ? 'Город' : 'Трасса');
  segments.push({ id: uid(), shiftId: shift.id, from, to, kmAtB: km, segmentKm, routeType, segType, ts: new Date().toISOString() });
  // Новые точки уходят в свой справочник: городской — Points, междугородний — InterPoints
  rememberRef(refList, refType, from);
  rememberRef(refList, refType, to);
  saveState();
  $('segFrom').value = to; $('segTo').value = ''; $('segKm').value = '';
  const totalKm = segments.reduce((s, x) => s + x.segmentKm, 0);
  msg(`Отрезок: ${from} → ${to}, ${segmentKm} км (${routeType}).\nОбщий пробег: ${totalKm} км.`);
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
  const cityKm = segments.filter(s => s.routeType === 'Город').reduce((a, s) => a + s.segmentKm, 0);
  const highwayKm = segments.filter(s => s.routeType === 'Трасса').reduce((a, s) => a + s.segmentKm, 0);
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
    { ...shift, timeEnd: tEnd, odoEnd, totalKm, cityKm, highwayKm,
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
    date: batch[0].date, driverId: batch[0].driverId,
    carLabel: batch[0].carLabel, timeStart: batch[0].timeStart, timeEnd: tEnd,
    totalKm: String(totalKm), cityKm: String(cityKm), highwayKm: String(highwayKm),
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
  $('segType').value = saved.segType === 'inter' ? 'inter' : 'city';
  if (segments.length) {
    const last = segments[segments.length - 1];
    $('segFrom').value = last.to;
  }
  return true;
}

// Информационное окно по восстановленной смене:
// авто, число отрезков, последний отрезок и одометр в точке «куда»
function showRestoredShiftInfo() {
  if (!me) return;
  if (shift.driverId && normFio(shift.driverId) !== normFio(me.fio)) {
    msg('В телефоне есть незавершённая смена другого водителя (' + shift.driverId + ').\nСообщите старшему: её нужно перенести или закрыть.');
    return;
  }
  const totalKm = segments.reduce((s, x) => s + x.segmentKm, 0);
  const last = segments.length ? segments[segments.length - 1] : null;
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

// ================= ЗАПУСК =================
async function init() {
  // Смена восстанавливается сразу, без ожидания сети:
  // офлайн-запуск не должен её терять
  const restored = restoreState();
  await loadDrivers();
  const auth = getAuth();
  if (auth && auth.fio) {
    const d = drivers.find(x => normFio(x.fio) === normFio(auth.fio));
    if (d) {
      enterApp(d.fio, d.role || '');
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
