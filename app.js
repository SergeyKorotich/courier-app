const API_URL = 'https://script.google.com/macros/s/AKfycbw79XBmJF5UBjHPr5KathKLgc1Q7FOT6V4CA2zU1BaOCkCN-quRO3snYWLOWVzatY2S/exec'; // ← свой URL!

const $ = id => document.getElementById(id);
const msg = t => { $('msg').textContent = t; };
const uid = () => Date.now() + '-' + Math.floor(Math.random() * 1e6);
// Локальная дата (не UTC) — иначе вечером дата уезжает на день назад
const todayISO = () => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0'); };
const hhmmToMin = t => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(t || '')); return m ? Number(m[1]) * 60 + Number(m[2]) : NaN; };
const minToHHMM = m => String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
// Русская сортировка: А–Я, с правильной позицией «ё»
const ruCmp = (a, b) => String(a || '').localeCompare(String(b || ''), 'ru');

let shift = null;          // текущая открытая смена
let segments = [];         // отрезки этой смены
let doctorVisits = [];     // перевозки врачей этой смены
let points = ['ОФИС'];     // кэш городских точек
let interPoints = [];      // кэш междугородних точек
let medPoints = [];        // кэш мед-точек
let docNames = [];         // кэш справочника ФИО врачей
let drivers = [];          // водители с их автомобилями (сгруппированы)
let carEditMode = null;    // 'new' | 'edit' | null

// Данные для отчётов и справочника
let shiftsData = [];       // смены с сервера (или из кэша)
let reportDetail = null;   // ФИО выбранного водителя (детализация) или null
let doctorsContact = [];   // контакты врачей с листа «Врачи»
let clinics = [];          // клиники с листа «Клиники»

const NEW_DRIVER = '__new';
const QUEUE_KEY = 'sendQueue';
const REF_KEY = 'refCache';
const STATE_KEY = 'appState_v1';
const SHIFTS_KEY = 'shiftsCache';
const carLabel = c => ((c.name || '') + ' ' + (c.plate || '')).trim();

// ================= СОХРАНЕНИЕ СОСТОЯНИЯ СМЕНЫ =================
// Автосохранение после каждого действия: закрыл приложение —
// при следующем открытии смена вернётся как была
function saveState() {
  try {
    localStorage.setItem(STATE_KEY, JSON.stringify({
      shift: shift,
      segments: segments,
      doctorVisits: doctorVisits
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

async function postRecords(records) {
  // text/plain — иначе Apps Script не пройдёт CORS
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

// Отправка с фолбэком: сеть недоступна → пакет в очередь
async function sendOrQueue(records) {
  try {
    const r = await postRecords(records);
    if (r.ok) return { sent: true, out: r.out };
    return { sent: false, error: r.error };
  } catch (e) {
    const q = loadQueue();
    q.push({ ts: new Date().toISOString(), records: records });
    saveQueue(q);
    return { sent: false, queued: true };
  }
}

async function flushQueue() {
  const q = loadQueue();
  if (!q.length) return;
  let sent = 0;
  while (q.length) {
    try {
      const r = await postRecords(q[0].records);
      if (r.ok) { q.shift(); saveQueue(q); sent++; }
      else break; // сервер отверг пакет — оставляем, не теряем данные
    } catch (e) {
      break;      // сеть недоступна — попробуем позже
    }
  }
  if (sent) {
    const left = loadQueue().length;
    msg(left ? `Очередь отправлена: ${sent} пакет(ов). В очереди осталось: ${left}`
             : `Очередь отправлена: ${sent} пакет(ов). Всё синхронизировано.`);
  }
}

window.addEventListener('online', flushQueue);
setInterval(flushQueue, 60000);

// ================= ДАННЫЕ =================
function currentDriver() {
  const v = $('driverSel').value;
  if (v === NEW_DRIVER) return null;
  return drivers[Number(v)] || null;
}

function applyRefs(data) {
  drivers = Array.isArray(data.drivers) ? data.drivers : [];
  // Список водителей по алфавиту (А–Я)
  drivers.sort((a, b) => ruCmp(a.fio, b.fio));
  if (Array.isArray(data.points) && data.points.length) {
    points = Array.from(new Set(['ОФИС'].concat(data.points)));
  }
  if (Array.isArray(data.interPoints)) interPoints = Array.from(new Set(data.interPoints));
  if (Array.isArray(data.medPoints)) medPoints = Array.from(new Set(data.medPoints));
  if (Array.isArray(data.docNames)) docNames = Array.from(new Set(data.docNames));
  if (Array.isArray(data.doctorsContact)) doctorsContact = data.doctorsContact;
  if (Array.isArray(data.clinics)) clinics = data.clinics;
  // ФИО врачей для подсказок: справочник + лист «Врачи» (без дублей)
  docNames = Array.from(new Set(docNames.concat(doctorsContact.map(d => d.fio).filter(Boolean))));
  renderPoints(); renderMedPoints(); renderDocNames();
  // Восстанавливаем выбор водителя и машины с прошлого раза
  renderDriverSelect(localStorage.getItem('lastDriver'));
  selectCarByLabel(localStorage.getItem('lastCar'));
}

async function loadDrivers() {
  try {
    const out = await (await fetch(API_URL)).json();
    // Сохраняем снапшот для работы без сети
    localStorage.setItem(REF_KEY, JSON.stringify(out));
    if (Array.isArray(out.shifts)) {
      shiftsData = out.shifts;
      localStorage.setItem(SHIFTS_KEY, JSON.stringify(shiftsData));
    }
    applyRefs(out);
  } catch (e) {
    // Нет сети (или API недоступен) — работаем на сохранённом снапшоте
    let cached = null;
    try { cached = JSON.parse(localStorage.getItem(REF_KEY) || 'null'); } catch (err) {}
    if (cached) {
      applyRefs(cached);
      msg('Нет сети: работаем на сохранённых справочниках.\nСмены сохранятся в очереди и уйдут автоматически.');
    } else {
      msg('Не удалось загрузить данные: ' + e.message);
    }
  }
  flushQueue();
}

function renderDriverSelect(fioToSelect) {
  $('driverSel').innerHTML = (drivers.length
    ? drivers.map((d, i) => `<option value="${i}">${d.fio}</option>`).join('')
    : '<option value="">— нет водителей —</option>')
    + `<option value="${NEW_DRIVER}">➕ Добавить водителя…</option>`;
  if (fioToSelect) {
    const idx = drivers.findIndex(d => d.fio.toLowerCase() === String(fioToSelect).toLowerCase());
    if (idx >= 0) $('driverSel').value = String(idx);
  }
  renderCars();
}

function renderCars() {
  const d = currentDriver();
  // Автомобили водителя по алфавиту (марка + номер)
  const cars = ((d && d.cars) || []).slice().sort((a, b) => ruCmp(carLabel(a), carLabel(b)));
  $('carSel').innerHTML = cars.length
    ? cars.map(c => `<option value="${carLabel(c)}">${carLabel(c)}</option>`).join('')
    : '<option value="">— нет автомобилей —</option>';
  $('carSel').innerHTML += '<option value="' + NEW_DRIVER + '">➕ Добавить автомобиль…</option>';
  $('carPanel').style.display = 'none';
}

function selectCarByLabel(label) {
  if (!label) return;
  const opt = Array.from($('carSel').options).find(o => o.value === label);
  if (opt) $('carSel').value = label;
}

// Подсказки точек: городские + междугородние, уникальные, по алфавиту
function renderPoints() {
  const all = Array.from(new Set(points.concat(interPoints)));
  $('pointsList').innerHTML = all
    .sort(ruCmp)
    .map(p => `<option value="${p}">`).join('');
}
// Мед-точки + названия клиник (из листа «Клиники») — по алфавиту
function renderMedPoints() {
  const all = Array.from(new Set(medPoints.concat(clinics.map(c => c.name).filter(Boolean))));
  $('medPointsList').innerHTML = all
    .sort(ruCmp)
    .map(p => `<option value="${p}">`).join('');
}
function renderDocNames() {
  $('docNamesList').innerHTML = docNames
    .slice()
    .sort(ruCmp)
    .map(p => `<option value="${p}">`).join('');
}

function onDriverChange() {
  if ($('driverSel').value === NEW_DRIVER) {
    $('driverPanel').style.display = 'block';
    $('newDriverFio').value = ''; $('newDriverCar').value = ''; $('newDriverPlate').value = '';
    $('carPanel').style.display = 'none';
    $('driverEditPanel').style.display = 'none';
  } else {
    $('driverPanel').style.display = 'none';
    renderCars();
  }
}

// Новый водитель: ФИО обязательно, машина — первая в его списке
async function saveDriver() {
  const fio = $('newDriverFio').value.trim().replace(/\s+/g, ' ');
  const car = $('newDriverCar').value.trim();
  const plate = $('newDriverPlate').value.trim();
  if (!fio) { msg('Укажи ФИО водителя'); return; }
  if (!car && !plate) { msg('Укажи хотя бы автомобиль или госномер'); return; }
  msg('Сохраняю водителя…');
  const r = await sendOrQueue([{ id: 'drv-' + uid(), type: 'driver', fio: fio, car: car, plate: plate }]);
  const existing = drivers.find(d => d.fio.toLowerCase() === fio.toLowerCase());
  const carObj = { name: car, plate: plate, row: null };
  if (existing) existing.cars.push(carObj);
  else drivers.push({ fio: fio, cars: [carObj] });
  // Сортируем заново и возвращаем выбор
  drivers.sort((a, b) => ruCmp(a.fio, b.fio));
  localStorage.setItem('lastDriver', fio);
  localStorage.setItem('lastCar', carLabel(carObj));
  $('driverPanel').style.display = 'none';
  renderDriverSelect(fio);
  selectCarByLabel(carLabel(carObj));
  msg(r.sent ? 'Водитель сохранён: ' + fio
             : 'Нет сети: водитель записан в очередь и появится в таблице при синхронизации');
}

function onCarChange() {
  if ($('carSel').value === NEW_DRIVER) openCarPanel('new');
  else $('carPanel').style.display = 'none';
}

function openCarPanel(mode) {
  const d = currentDriver();
  if (!d) { msg('Сначала выбери водителя'); return; }
  carEditMode = mode;
  if (mode === 'edit') {
    const c = d.cars.find(x => carLabel(x) === $('carSel').value) || d.cars[0];
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

// Сохранение машины: новая строка у водителя либо правка существующей
async function saveCar() {
  const d = currentDriver();
  if (!d) { msg('Сначала выбери водителя'); return; }
  const car = $('carNameInput').value.trim();
  const plate = $('carPlateInput').value.trim();
  if (!car || !plate) { msg('Укажи марку и госномер'); return; }
  const label = car + ' ' + plate;
  msg('Сохраняю автомобиль…');
  let r;
  if (carEditMode === 'edit') {
    const c = d.cars.find(x => carLabel(x) === $('carSel').value) || d.cars[0];
    r = await sendOrQueue([{ id: 'care-' + uid(), type: 'driveredit', row: c.row, fio: d.fio, car: car, plate: plate }]);
    c.name = car; c.plate = plate;
  } else {
    r = await sendOrQueue([{ id: 'car-' + uid(), type: 'driver', fio: d.fio, car: car, plate: plate }]);
    d.cars.push({ name: car, plate: plate, row: null });
  }
  localStorage.setItem('lastDriver', d.fio);
  localStorage.setItem('lastCar', label);
  renderCars();
  selectCarByLabel(label);
  $('carPanel').style.display = 'none';
  msg(r.sent ? 'Автомобиль сохранён: ' + label
             : 'Нет сети: автомобиль записан в очередь и попадёт в таблицу при синхронизации');
}

// ================= ПРАВКА ФИО ВОДИТЕЛЯ =================
function openDriverEdit() {
  const d = currentDriver();
  if (!d) { msg('Сначала выбери водителя'); return; }
  $('editDriverFio').value = d.fio;
  $('driverEditPanel').style.display = 'block';
  $('carPanel').style.display = 'none';
}

// Правка ФИО: переименовываются все строки водителя на листе Drivers
async function saveDriverEdit() {
  const d = currentDriver();
  if (!d) { msg('Сначала выбери водителя'); return; }
  const fio = $('editDriverFio').value.trim().replace(/\s+/g, ' ');
  if (!fio) { msg('Укажи новое ФИО'); return; }
  if (fio.toLowerCase() === d.fio.toLowerCase()) { msg('ФИО не изменилось'); return; }
  msg('Сохраняю ФИО…');
  const r = await sendOrQueue([{ id: 'drvr-' + uid(), type: 'driverrename', fioOld: d.fio, fio: fio }]);
  // Обновляем локальный список сразу: ФИО и его машины
  d.fio = fio;
  drivers.sort((a, b) => ruCmp(a.fio, b.fio));
  localStorage.setItem('lastDriver', fio);
  $('driverEditPanel').style.display = 'none';
  renderDriverSelect(fio);
  selectCarByLabel(localStorage.getItem('lastCar'));
  msg(r.sent ? 'ФИО обновлено: ' + fio
             : 'Нет сети: правка записана в очередь и применится при синхронизации');
}

// Канонизация с учётом справочника: совпадение без учёта регистра
// возвращается в написании справочника, новое имя — «Можга».
// ОФИС и Ижевск — равнозначные точки, обе пишутся как ОФИС.
function canonName(s, list) {
  s = (s || '').trim().replace(/\s+/g, ' ');
  if (!s) return '';
  const lower = s.toLowerCase();
  if (lower === 'офис' || lower === 'ижевск') return 'ОФИС';
  const found = (list || []).find(p => p.toLowerCase() === lower);
  if (found) return found;
  return lower.split(' ')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

// Подстраховка: на случай, если «Ижевск» пришёл из справочника как есть
function areEquivalentPoints(p1, p2) {
  const a = String(p1 || '').trim().toUpperCase();
  const b = String(p2 || '').trim().toUpperCase();
  return (a === 'ОФИС' && b === 'ИЖЕВСК') || (a === 'ИЖЕВСК' && b === 'ОФИС');
}

// Сжатие маршрута: подряд идущие одинаковые точки схлопываются,
// ОФИС/Ижевск считаются одним пунктом
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
  if (result.length && result[result.length - 1] === 'ИЖЕВСК') result[result.length - 1] = 'ОФИС';
  return result.join(', ');
}

// Сводка по врачам: пункт — при первом упоминании, врачи одного пункта
// через запятую, отклонение от назначенного времени в скобках.
// Учитываются только перевозки в пункты, где машина реально была.
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

// Продолжительность смены; смена через полночь считается корректно
function durationMin(tStart, tEnd) {
  const a = hhmmToMin(tStart), b = hhmmToMin(tEnd);
  if (isNaN(a) || isNaN(b)) return 0;
  let d = b - a;
  if (d < 0) d += 24 * 60;
  return d;
}

// Новая запись в справочник: в локальный кэш сразу, на сервер — с очередью
function rememberRef(list, render, prefix, type, name) {
  if (!name || list.includes(name)) return;
  list.push(name);
  render();
  sendOrQueue([{ id: prefix + uid(), type: type, name: name }]);
}

// ================= ЭКРАНЫ =================
const SCREENS = ['menuScreen', 'workScreen', 'reportScreen', 'refsScreen'];
function showScreen(name) {
  SCREENS.forEach(id => { $(id).style.display = 'none'; });
  $(name).style.display = 'block';
}

function showWork() {
  showScreen('workScreen');
  $('startCard').style.display = 'none';
  $('shiftCard').style.display = 'block';
  $('docCard').style.display = 'block';
  $('finishCard').style.display = 'block';
  $('driverSel').disabled = true;
  $('carSel').disabled = true;
}

function showStart() {
  showScreen('workScreen');
  $('startCard').style.display = 'block';
  $('shiftCard').style.display = 'none';
  $('docCard').style.display = 'none';
  $('finishCard').style.display = 'none';
  $('driverSel').disabled = false;
  $('carSel').disabled = false;
}

// Пункт меню «Запись смены»: зависит от того, открыта ли смена
function openWork() {
  if (shift) showWork(); else showStart();
}

// ================= ОТЧЁТЫ =================
async function openReport() {
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
    // Нет сети — показываем сохранённые данные
    try { shiftsData = JSON.parse(localStorage.getItem(SHIFTS_KEY) || '[]'); }
    catch (e2) { shiftsData = []; }
    msg('Нет сети: отчёт по сохранённым данным.');
  }
  renderReport();
}

// Сводный дашборд по всем водителям за месяц
function renderReport() {
  const month = $('reportMonth').value || todayISO().slice(0, 7);
  const rows = shiftsData.filter(s => String(s.date || '').startsWith(month));
  $('backBtn').style.display = reportDetail ? 'block' : 'none';

  if (reportDetail) { renderDriverDetail(rows); return; }

  const byDriver = {};
  rows.forEach(s => {
    const k = s.driverId || '—';
    if (!byDriver[k]) byDriver[k] = { n: 0, total: 0, city: 0, hw: 0, refuel: 0, minutes: 0 };
    const t = byDriver[k];
    t.n++;
    t.total += parseFloat(s.totalKm) || 0;
    t.city += parseFloat(s.cityKm) || 0;
    t.hw += parseFloat(s.highwayKm) || 0;
    t.refuel += parseFloat(s.refuel) || 0;
    const dMin = hhmmToMin(s.duration);
    if (!isNaN(dMin)) t.minutes += dMin;
  });
  const names = Object.keys(byDriver).sort(ruCmp);
  if (!names.length) {
    $('reportBody').innerHTML = '<div class="card">За ' + month + ' смен нет.</div>';
    return;
  }
  const sum = names.reduce((acc, k) => {
    const t = byDriver[k];
    acc.n += t.n; acc.total += t.total; acc.city += t.city;
    acc.hw += t.hw; acc.refuel += t.refuel; acc.minutes += t.minutes;
    return acc;
  }, { n: 0, total: 0, city: 0, hw: 0, refuel: 0, minutes: 0 });

  const rowsHtml = names.map(k => {
    const t = byDriver[k];
    return `<tr>
      <td><a href="#" onclick="openDriverDetail('${k.replace(/'/g, "\\'")}')">${k}</a></td>
      <td>${t.n}</td>
      <td>${t.total.toFixed(1)}</td>
      <td>${t.city.toFixed(1)}</td>
      <td>${t.hw.toFixed(1)}</td>
      <td>${t.refuel ? t.refuel.toFixed(1) : ''}</td>
    </tr>`;
  }).join('');

  $('reportBody').innerHTML = `
    <div class="card"><h3>Общий отчёт по всем водителям</h3>
      <table>
        <tr><th>Водитель</th><th>Смен</th><th>Км</th><th>Город</th><th>Трасса</th><th>Топл., л</th></tr>
        ${rowsHtml}
        <tr class="tot">
          <td>Итого</td>
          <td>${sum.n}</td>
          <td>${sum.total.toFixed(1)}</td>
          <td>${sum.city.toFixed(1)}</td>
          <td>${sum.hw.toFixed(1)}</td>
          <td>${sum.refuel ? sum.refuel.toFixed(1) : ''}</td>
        </tr>
      </table>
    </div>
    <div class="card">Время в сменах (всего): <b>${minToHHMM(sum.minutes)}</b></div>`;
}

// Детализация по водителю: все его смены за выбранный месяц
function renderDriverDetail(rows) {
  const rows2 = rows.filter(s => (s.driverId || '—') === reportDetail);
  if (!rows2.length) {
    $('reportBody').innerHTML = `<div class="card">У водителя «${reportDetail}» за месяц смен нет.</div>`;
    return;
  }
  const list = rows2.map(s => `
    <div class="card">
      <b>${s.date}</b> — ${s.carLabel || ''}
      <div>${s.timeStart || ''}–${s.timeEnd || ''} (${s.duration || ''}), км: ${s.totalKm || 0} (город ${s.cityKm || 0}, трасса ${s.highwayKm || 0})${s.refuel ? `, заправка ${s.refuel} л` : ''}</div>
      <div style="font-size:13px;color:#555">Маршрут: ${s.route || '—'}</div>
      ${s.doctor ? `<div style="font-size:13px;color:#555">Врачи: ${s.doctor}</div>` : ''}
    </div>`).join('');
  $('reportBody').innerHTML = `<div class="card"><h3>${reportDetail}</h3>Смен за месяц: ${rows2.length}</div>` + list;
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
  $('refSearch').value = '';
  renderRefs();
}

// Экранирование спецсимволов в выводе
function esc(s) {
  return String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// 89127609788 → tel:+79127609788
function telHref(tel) {
  const digits = String(tel || '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.length === 11 && digits[0] === '8') return 'tel:+7' + digits.slice(1);
  if (digits.length === 11 && digits[0] === '7') return 'tel:+' + digits;
  return 'tel:' + digits;
}

// Информационное окно: контакты врачей и клиник (по кэшу, работает без сети)
function renderRefs() {
  const q = ($('refSearch').value || '').trim().toLowerCase();
  const match = fields => !q || fields.some(f => String(f || '').toLowerCase().indexOf(q) !== -1);

  const docs = doctorsContact
    .filter(d => match([d.fio, d.fam, d.addr, d.tel]))
    .sort((a, b) => ruCmp(a.fio || a.fam, b.fio || b.fam));
  const cls = clinics
    .filter(c => match([c.name, c.city, c.addr, c.tel, c.day]))
    .sort((a, b) => ruCmp(a.city + a.name, b.city + b.name));

  const docsHtml = docs.length ? docs.map(d => `
    <div class="ref-item">
      <b>${esc(d.fio || d.fam)}</b><br>
      ${d.addr ? '📍 ' + esc(d.addr) + '<br>' : ''}
      ${d.tel ? `<a class="tel" href="${telHref(d.tel)}">📞 ${esc(d.tel)}</a>` : ''}
      ${d.route ? `<a class="lnk" target="_blank" rel="noopener" href="${esc(d.route)}">🧭 маршрут</a>` : ''}
    </div>`).join('')
    : '<div class="ref-item empty">Врач не найден.</div>';

  const clsHtml = cls.length ? cls.map(c => `
    <div class="ref-item">
      <b>${esc(c.name)}</b>${c.city ? ' — ' + esc(c.city) : ''}<br>
      ${c.addr ? '📍 ' + esc(c.addr) + '<br>' : ''}
      ${c.day ? '🗓 ' + esc(c.day) + '<br>' : ''}
      ${c.tel ? `<a class="tel" href="${telHref(c.tel)}">📞 ${esc(c.tel)}</a>` : ''}
      ${c.route ? `<a class="lnk" target="_blank" rel="noopener" href="${esc(c.route)}">🧭 маршрут</a>` : ''}
      ${c.extra ? `<div class="extra">${esc(c.extra)}</div>` : ''}
    </div>`).join('')
    : '<div class="ref-item empty">Клиника не найдена.</div>';

  $('refsBody').innerHTML = `
    <div class="card">
      <h3>Врачи (${docs.length})</h3>${docsHtml}
    </div>
    <div class="card">
      <h3>Клиники (${cls.length})</h3>${clsHtml}
    </div>`;
}

// ================= СМЕНА =================
function startShift() {
  const dateStr = $('shiftDate').value;
  const tStart = $('timeStart').value;
  const odo = parseFloat($('odoStart').value.replace(',', '.'));
  const d = currentDriver();
  if (!dateStr || !tStart) { msg('Укажи дату и время начала смены'); return; }
  if (!d) { msg('Выбери водителя'); return; }
  const carLabelVal = $('carSel').value;
  if (carLabelVal === NEW_DRIVER || !carLabelVal) { msg('Выбери автомобиль'); return; }
  const carObj = d.cars.find(c => carLabel(c) === carLabelVal);
  if (!carObj) { msg('Выбери автомобиль'); return; }
  if (isNaN(odo) || odo < 0) { msg('Укажи одометр на начало'); return; }
  shift = {
    id: uid(),
    driverId: d.fio,
    carId: d.fio + '|' + carLabelVal,
    carLabel: carLabelVal,
    date: dateStr, timeStart: tStart, odoStart: odo
  };
  segments = [];
  doctorVisits = [];
  // Запоминаем выбор — он переживёт перезагрузку страницы
  localStorage.setItem('lastDriver', d.fio);
  localStorage.setItem('lastCar', carLabelVal);
  saveState();
  showWork();
  $('segFrom').value = 'ОФИС';
  $('segTo').value = ''; $('segKm').value = '';
  msg(`Смена открыта: ${d.fio}, ${carLabelVal}.`);
}

function addSegment() {
  const segType = $('segType').value; // 'city' | 'inter'
  const allPts = points.concat(interPoints);
  const from = canonName($('segFrom').value, allPts);
  const to = canonName($('segTo').value, allPts);
  const km = parseFloat(String($('segKm').value).replace(',', '.'));
  if (!from || !to || isNaN(km) || km < 0) { msg('Заполни «Откуда», «Куда» и пробег'); return; }
  // Вводится показание одометра с начала смены: должно быть строго
  // больше предыдущего, иначе это ошибка ввода (километраж вместо одометра)
  const prevKm = segments.length ? segments[segments.length - 1].kmAtB : 0;
  if (km <= prevKm) {
    msg(`Ошибка: показание одометра (${km}) должно быть больше предыдущего: ${prevKm} км.\nЕсли нужно записать километраж отрезка — считай показание сам: ${prevKm} + километраж.`);
    return;
  }
  const segmentKm = km - prevKm;
  // Городской отрезок — весь в «Город».
  // Междугородний делится как раньше: касание ОФИС/Ижевск — «Город», иначе «Трасса».
  const routeType = segType === 'city'
    ? 'Город'
    : ((from === 'ОФИС' || to === 'ОФИС' || from === to) ? 'Город' : 'Трасса');
  segments.push({ id: uid(), shiftId: shift.id, from, to, kmAtB: km, segmentKm, routeType, segType, ts: new Date().toISOString() });
  rememberRef(points, renderPoints, 'p-', 'point', from);
  rememberRef(points, renderPoints, 'p-', 'point', to);
  saveState();
  $('segFrom').value = to; $('segTo').value = ''; $('segKm').value = '';
  const cityKm = segments.filter(s => s.routeType === 'Город').reduce((a, s) => a + s.segmentKm, 0);
  const hwKm = segments.filter(s => s.routeType === 'Трасса').reduce((a, s) => a + s.segmentKm, 0);
  msg(`Отрезок: ${segmentKm} км (${routeType}).\nВсего: ${segments.length} отрезк., город ${cityKm} км, трасса ${hwKm} км.`);
}

function addDoctorVisit() {
  const doctor = canonName($('docName').value, docNames);
  const place = canonName($('docPlace').value, medPoints);
  const tApp = $('docTimeApp').value;
  const tBoard = $('docTimeBoard').value;
  // Как в старой системе: оба времени обязательны
  if (!doctor || !place || !tApp || !tBoard) { msg('Укажи врача, куда везём и оба времени'); return; }
  const rid = 'r-' + uid();
  doctorVisits.push({
    id: rid, type: 'doctor', date: shift.date,
    doctor: doctor, place: place,
    timeAppointed: tApp, timeBoarding: tBoard,
    recordId: rid, shiftId: shift.id
  });
  rememberRef(medPoints, renderMedPoints, 'm-', 'medpoint', place);
  rememberRef(docNames, renderDocNames, 'd-', 'docname', doctor);
  saveState();
  $('docName').value = ''; $('docPlace').value = '';
  $('docTimeApp').value = ''; $('docTimeBoard').value = '';
  msg(`Перевозка врача записана (всего: ${doctorVisits.length}). Уйдёт вместе со сменой.`);
}

async function finishShift() {
  if (!segments.length) { msg('Добавь хотя бы один отрезок'); return; }
  const tEnd = $('timeEnd').value;
  if (!tEnd) { msg('Укажи время окончания смены'); return; }
  // Заправка — по факту, перед завершением смены; может быть пустой
  const refuel = $('refuel').value ? parseFloat($('refuel').value.replace(',', '.')) : '';
  const totalKm = segments.reduce((s, x) => s + x.segmentKm, 0);
  const cityKm = segments.filter(s => s.routeType === 'Город').reduce((a, s) => a + s.segmentKm, 0);
  const highwayKm = segments.filter(s => s.routeType === 'Трасса').reduce((a, s) => a + s.segmentKm, 0);
  const odoEnd = Number(shift.odoStart) + totalKm;

  // Маршрут: точки отрезков, петли X→X не добавляют точку;
  // Ижевск уже нормализован в ОФИС, так что «в хвосте» его не будет
  const visitedPoints = [];
  const routePoints = [];
  segments.forEach(s => {
    visitedPoints.push(s.from, s.to);
    if (s.from !== s.to) {           // петля X→X не добавляет точки маршрута
      if (!routePoints.length) routePoints.push(s.from);
      routePoints.push(s.to);
    }
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
  // Перенос одометра в следующую смену — как старая clearForm.
  // Ставим в обоих случаях: смена уже зафиксирована на телефоне.
  localStorage.setItem('lastOdoEnd', String(odoEnd));
  clearState();
  shift = null; segments = []; doctorVisits = [];
  msg(r.sent
    ? `Отправлено: ${r.out.processed.length} записей.\nМаршрут: ${route}` + (doctorInfo ? `\nВрачи: ${doctorInfo}` : '')
    : (r.queued
        ? `Нет сети: смена сохранена в телефоне и отправится автоматически.\nМаршрут: ${route}`
        : 'Не отправилось: ' + r.error + '\nСмена сохранена в очереди.'));
  showStart();
  // Выбор водителя и автомобиля сохраняем — пользователь может
  // сразу открыть следующую смену без повторного выбора
  $('odoStart').value = odoEnd;
  $('refuel').value = '';
  $('timeStart').value = '';
  $('timeEnd').value = '';
}

// ================= ВОССТАНОВЛЕНИЕ ПРИ ЗАПУСКЕ =================
// Если приложение закрыли до завершения смены — смена вернётся как была
function restoreState() {
  const saved = loadState();
  if (!saved || !saved.shift) return false;
  shift = saved.shift;
  segments = saved.segments || [];
  doctorVisits = saved.doctorVisits || [];
  // Продолжаем с того места, где остановились:
  // «Откуда» = «Куда» последнего отрезка
  if (segments.length) {
    const last = segments[segments.length - 1];
    $('segFrom').value = last.to;
  }
  return true;
}

// ================= PWA =================
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}

// ================= ЗАПУСК =================
loadDrivers().then(() => {
  const restored = restoreState();
  showScreen('menuScreen');
  if (restored) {
    const totalKm = segments.reduce((s, x) => s + x.segmentKm, 0);
    const last = segments.length ? segments[segments.length - 1] : null;
    const lastInfo = last
      ? `\nПоследний отрезок: ${last.from} → ${last.to} (${last.segmentKm} км).\nПродолжай с «${last.to}».`
      : '\nОтрезков пока нет.';
    msg(`Смена ещё открыта: ${shift.driverId}, ${shift.carLabel}.\nОтрезков: ${segments.length}, пробег: ${totalKm} км.${lastInfo}\nОткрой «Запись смены», чтобы продолжить.`);
  } else {
    const saved = parseFloat(localStorage.getItem('lastOdoEnd'));
    if (!isNaN(saved) && saved > 0) $('odoStart').value = saved;
    $('shiftDate').value = todayISO();
  }
});
