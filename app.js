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

let me = null;
let shift = null;
let segments = [];
let doctorVisits = [];
let points = ['ОФИС'];
let interPoints = [];
let medPoints = []; // «Куда везём врача» — лист MedPoints
let docNames = [];
let drivers = [];
let carsRef = [];        // все авто с листа Cars: { id, driverId, own, name, plate, row }
let carEditMode = null;  // 'new' | 'edit'
let carEditId = null;    // id авто на листе Cars (или null)
let shiftsData = [];
let reportDetail = null;
let myStats = null;      // данные личной статистики: { segs, doctors } по id смен
let doctorsContact = [];
let clinics = [];
// Формы справочника: null = добавление, ключ = правка
let docEditKey = null;
let clinicEditKey = null;

const QUEUE_KEY = 'sendQueue';
const REF_KEY = 'refCache';
const STATE_KEY = 'appState_v2'; // v1 хранил смену с «город/трасса» — новая структура
const SHIFTS_KEY = 'shiftsCache';
const AUTH_KEY = 'authCreds';
const MAX_TRIES = 3; // попыток на пакет до пропуска
const carLabel = c => (((c && c.name) || '') + ' ' + ((c && c.plate) || '')).trim();

// Личное авто видит только владелец (или авто без владельца), рабочее — все
function myCars(m) {
  const did = (m && m.id) || '';
  return carsRef.filter(c => {
    const own = String(c.own || '').trim().toLowerCase();
    return own !== 'личная' || !c.driverId || c.driverId === did;
  });
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
      // Авто при регистрации — личное; на сервер уедет отдельной записью,
      // локально показываем сразу
      if (car || plate) {
        carsRef.push({ id: '', driverId: out.driverId || '', own: 'личная',
          name: car, plate: plate, row: null });
      }
      enterApp(out.fio, '', out.driverId || '');
      if (!shift) msg('Регистрация готова: ' + out.fio + (car || plate ? '\nАвто появится в таблице при синхронизации' : ''));
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
    cars: myCars({ id: driverId || found.id || '' })
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
  carsRef = Array.isArray(data.cars) ? data.cars : [];
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
  // Восстанавливаем выбор: авто открытой смены, иначе последнее использованное
  if (shift && shift.carId) selectCarById(shift.carId);
  else selectCarById(localStorage.getItem('lastCarId'));
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
}

// Подсказки «Откуда/Куда» — единый список точек:
// деление город/междугородний ушло вместе с типом маршрута
function renderSegPoints() {
  if (!$('segPointsList')) return;
  const src = Array.from(new Set(points.concat(interPoints)));
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
  $('setVuDate').value = found.vuDate || '';
  $('setKlass').value = found.klass || '';
  // Телефон в профиле водителя больше нет — это реквизит собственника авто (Cars)
  // Роль назначает только старший
  $('setRoleBlock').style.display = isSupervisor(me) ? 'block' : 'none';
  if (isSupervisor(me)) $('setRole').value = found.role || '';
  renderSettingsCars();
  $('setPlBlock').innerHTML = plNumBlockHtml('set');
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
    $('carTelInput').value = c.tel || '';
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
  const tel = $('carTelInput') ? $('carTelInput').value.trim() : '';
  const ogrn = $('carOgrnInput') ? $('carOgrnInput').value.trim() : '';
  if (!car || !plate) { msg('Укажи марку и госномер'); return; }
  const label = car + ' ' + plate;
  msg('Сохраняю автомобиль…');
  // В смене с отрезками сменить авто нельзя: одометр начала привязан к конкретной машине
  if (shift && segments.length > 0) {
    msg('В смене уже есть отрезки — сменить автомобиль нельзя.\nЗавершите смену и откройте новую с нужным авто.');
    $('carPanel').style.display = 'none';
    return;
  }
  let r, saved;
  const editing = (carEditMode === 'edit' && carEditId) ? me.cars.find(x => x.id === carEditId) : null;
  if (editing) {
    // Правка по id авто на Cars
    r = await sendOrQueue([{ id: 'care-' + uid(), type: 'caredit', row: editing.row || null,
      driverId: me.id, own: own, car: car, plate: plate,
      owner: owner, addr: addr, tel: tel, ogrn: ogrn }]);
    editing.name = car; editing.plate = plate; editing.own = own;
    editing.owner = owner; editing.addr = addr; editing.tel = tel; editing.ogrn = ogrn;
    saved = editing;
  } else {
    // Новый автомобиль: запись типа car, связь через id водителя
    r = await sendOrQueue([{ id: 'car-' + uid(), type: 'car', driverId: me.id,
      own: own, car: car, plate: plate,
      owner: owner, addr: addr, tel: tel, ogrn: ogrn }]);
    saved = { id: '', driverId: me.id, own: own, name: car, plate: plate,
      owner: owner, addr: addr, tel: tel, ogrn: ogrn, row: null };
    me.cars.push(saved);
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
  const profile = {
    id: 'dpr-' + uid(), type: 'driverprofile', driverId: me.id, fioOld: me.fio,
    snils: $('setSnils').value.trim(),
    vu: $('setVu').value.trim(),
    vuDate: $('setVuDate').value.trim(),
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
const SCREENS = ['loginScreen', 'menuScreen', 'workScreen', 'reportScreen', 'refsScreen', 'plScreen', 'settingsScreen'];
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
}
// ================= ДАШБОРД =================
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
      <b>${esc(s.date)}</b> — ${esc(s.carLabel || '')}
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

// Детали смены: отрезки + перевозки врачей, каждая строка правится
let myShiftDetailId = null;

async function openMyShiftDetail(shiftId) {
  if (!shiftId) { msg('У этой смены нет id — обнови данные при сети'); return; }
  myShiftDetailId = shiftId;
  msg('Загружаю отрезки и перевозки…');
  let segs = [], docs = [];
  try {
    const out = await (await fetch(API_URL + '?page=data&ids=' + encodeURIComponent(shiftId))).json();
    if (!out.ok) { msg('Ошибка: ' + (out.error || 'сервер')); return; }
    segs = out.segments[shiftId] || [];
    docs = (out.doctors && out.doctors[shiftId]) || [];
  } catch (e) {
    msg('Нет сети: попробуй позже');
    return;
  }
  // Пробег пересчитываем по отрезкам — так сразу видно результат правок
  const sumKm = segs.reduce((a, x) => a + (parseFloat(x.km) || 0), 0);
  const segRows = segs.length ? segs.map(x => `
    <div class="ref-item">
      <b>${esc(x.from)} → ${esc(x.to)}</b>, одометр: ${esc(x.kmAtB)}, пробег: ${esc(x.km)} км
      <a class="edit" href="#" onclick="editSegRow('${escJsName(x.id)}','${escJsName(x.from)}','${escJsName(x.to)}','${escJsName(x.kmAtB)}','${escJsName(x.km)}');return false">✎</a>
    </div>`).join('') : '<div class="ref-item empty">Отрезков нет.</div>';
  const docRows = docs.length ? docs.map(x => `
    <div class="ref-item">
      <b>${esc(x.doctor)}</b> → ${esc(x.place || '—')},
      назначено: ${esc(x.timeAppointed || '—')}, посадка: ${esc(x.timeBoarding || '—')}
      <a class="edit" href="#" onclick="editDocRow('${escJsName(x.recordId)}','${escJsName(x.doctor)}','${escJsName(x.place)}','${escJsName(x.timeAppointed)}','${escJsName(x.timeBoarding)}');return false">✎</a>
    </div>`).join('') : '<div class="ref-item empty">Перевозок врачей нет.</div>';
  $('statsBody').innerHTML = '';
  $('backBtn').style.display = 'block';
  $('statsDetail').innerHTML = `
    <div class="card"><h3>Смена ${esc(shiftId)}</h3>
      Отрезков: ${segs.length}, сумма пробега: ${sumKm.toFixed(1)} км
      ${segs.length ? '<div class="empty">Правка отрезка пересчитает сумму; общий пробег смены в таблице обновится при следующей сдаче данных.</div>' : ''}
    </div>
    <div class="card"><h4>Отрезки</h4>${segRows}</div>
    <div class="card"><h4>Перевозимые врачи</h4>${docRows}</div>`;
}

function backToMyStats() {
  myShiftDetailId = null;
  renderMyStats();
}

// Правка отрезка: форма подставляется в карточку строки
let segEditId = null;

function editSegRow(id, from, to, kmAtB, km) {
  segEditId = id;
  const host = document.createElement('div');
  host.id = 'segEditCard';
  host.className = 'ref-item';
  host.innerHTML = `
    <b>Правка отрезка</b>
    <label>Откуда</label><input id="segEFrom" value="${esc(from)}">
    <label>Куда</label><input id="segETo" value="${esc(to)}">
    <label>Одометр, км</label><input id="segEOdo" inputmode="decimal" value="${esc(kmAtB)}">
    <label>Пробег, км</label><input id="segEKm" inputmode="decimal" value="${esc(km)}">
    <button class="small" onclick="saveSegEdit()">Сохранить</button>
    <button class="small" onclick="document.getElementById('segEditCard').remove();segEditId=null;">Отмена</button>`;
  const detail = $('statsDetail');
  if (detail) detail.insertBefore(host, detail.children[1]);
  host.scrollIntoView({ block: 'nearest' });
}

async function saveSegEdit() {
  if (!segEditId || !myShiftDetailId) { msg('Нет отрезка для правки'); return; }
  const from = $('segEFrom').value.trim();
  const to = $('segETo').value.trim();
  const kmAtB = parseFloat(String($('segEOdo').value).replace(',', '.'));
  const km = parseFloat(String($('segEKm').value).replace(',', '.'));
  if (!from || !to || isNaN(kmAtB) || kmAtB < 0 || isNaN(km) || km < 0) {
    msg('Заполни все поля; значения — не отрицательные');
    return;
  }
  msg('Сохраняю отрезок…');
  const r = await sendOrQueue([{
    id: 'sge-' + uid(), type: 'segmentedit', id: segEditId, // id записи — ключ правки
    from: from, to: to, kmAtB: kmAtB, segmentKm: km
  }]);
  msg(r.sent ? 'Отрезок сохранён' : 'Нет сети: правка в очереди, уйдёт при синхронизации');
  openMyShiftDetail(myShiftDetailId);
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
      <b>${esc(s.date)}</b> — ${esc(s.carLabel || '')}
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
  const cd = $('clearDocBtn'); if (cd) cd.style.display = 'none';
  const cc = $('clearClsBtn'); if (cc) cc.style.display = 'none';
  $('docsCard').style.display = 'none';
  $('clsCard').style.display = 'none';
  closeDocForm();
  closeClinicForm();
}

// Сброс поля поиска справочника и перерисовка списка
function clearRefSearch(which) {
  if (which === 'cls') {
    $('refSearchCls').value = '';
    renderRefsCls();
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
}

function plRenderList() {
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
