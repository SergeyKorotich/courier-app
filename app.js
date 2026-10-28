const API_URL = 'https://script.google.com/macros/s/AKfycbw79XBmJF5UBjHPr5KathKLgc1Q7FOT6V4CA2zU1BaOCkCN-quRO3snYWLOWVzatY2S/exec'; // ← свой URL!

const $ = id => document.getElementById(id);
const msg = t => { $('msg').textContent = t; };
const uid = () => Date.now() + '-' + Math.floor(Math.random() * 1e6);
// Локальная дата (не UTC) — иначе вечером дата уезжает на день назад
const todayISO = () => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0'); };
const hhmmToMin = t => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(t || '')); return m ? Number(m[1]) * 60 + Number(m[2]) : NaN; };
const minToHHMM = m => String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');

let shift = null;          // текущая открытая смена
let segments = [];         // отрезки этой смены
let doctorVisits = [];     // перевозки врачей этой смены
let points = ['ОФИС'];     // кэш справочника точек
let medPoints = [];        // кэш мед-точек
let docNames = [];         // кэш справочника ФИО врачей
let drivers = [];          // водители с их автомобилями (сгруппированы)
let carEditMode = null;    // 'new' | 'edit' | null

const NEW_DRIVER = '__new';
const QUEUE_KEY = 'sendQueue';
const REF_KEY = 'refCache';
const STATE_KEY = 'appState_v1'; // ключ для сохранения состояния смены
const carLabel = c => ((c.name || '') + ' ' + (c.plate || '')).trim();

// ================= СОХРАНЕНИЕ СОСТОЯНИЯ СМЕНЫ =================
function saveState() {
  try {
    localStorage.setItem(STATE_KEY, JSON.stringify({
      shift,
      segments,
      doctorVisits
    }));
  } catch (e) {
    console.warn('Не удалось сохранить состояние:', e);
  }
}

function loadState() {
  const raw = localStorage.getItem(STATE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (e) {
    console.warn('Ошибка парсинга состояния:', e);
    return null;
  }
}

function clearState() {
  localStorage.removeItem(STATE_KEY);
}

// При каждом изменении данных — сохраняем состояние
function onDataChange() {
  saveState();
}

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
  if (Array.isArray(data.points) && data.points.length) {
    points = Array.from(new Set(['ОФИС'].concat(data.points)));
  }
  if (Array.isArray(data.medPoints)) medPoints = Array.from(new Set(data.medPoints));
  if (Array.isArray(data.docNames)) docNames = Array.from(new Set(data.docNames));
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
  const cars = (d && d.cars) || [];
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

function renderPoints() {
  $('pointsList').innerHTML = points.slice().sort().map(p => `<option value="${p}">`).join('');
}
function renderMedPoints() {
  $('medPointsList').innerHTML = medPoints.slice().sort().map(p => `<option value="${p}">`).join('');
}
function renderDocNames() {
  $('docNamesList').innerHTML = docNames.slice().sort().map(p => `<option value="${p}">`).join('');
}

function onDriverChange() {
  if ($('driverSel').value === NEW_DRIVER) {
    $('driverPanel').style.display = 'block';
    $('newDriverFio').value = ''; $('newDriverCar').value = ''; $('newDriverPlate').value = '';
  } else {
    $('driverPanel').style.display = 'none';
    renderCars();
  }
}

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
  localStorage.setItem('lastDriver', fio);
  localStorage.setItem('lastCar', carLabel(carObj));
  $('driverPanel').style.display = 'none';
  renderDriverSelect(fio);
  selectCarByLabel(carLabel(carObj));
  msg(r.sent ? 'Водитель сохранён: ' + fio
             : 'Нет сети: водитель записан в очередь и появится в таблице при синхронизации');
  onDataChange(); // сохраняем состояние (на случай, если открыта смена)
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
    const c = d.cars[Number($('carSel').value)] || d.cars[0];
    if (!c) { msg('Нет автомобиля для правки'); return; }
    $('carNameInput').value = c.name || '';
    $('carPlateInput').value = c.plate || '';
  } else {
    $('carNameInput').value = '';
    $('carPlateInput').value = '';
  }
  $('carPanel').style.display = 'block';
}

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
    const c = d.cars[Number($('carSel').value)] || d.cars[0];
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
             : 'Нет сети: автомобиль записан в очередь и попадёт в таблице при синхронизации');
  onDataChange();
}

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

// ================= ВОССТАНОВЛЕНИЕ И УПРАВЛЕНИЕ СМЕНОЙ =================

function restoreState() {
  const saved = loadState();
  if (!saved) return;

  // Если есть активная смена — восстанавливаем её
  if (saved.shift) {
    shift = saved.shift;
    segments = saved.segments || [];
    doctorVisits = saved.doctorVisits || [];

    // Блокируем выбор водителя, показываем карточки работы
    $('driverSel').disabled = true;
    $('newShiftForm').style.display = 'none';
    $('workCards').style.display = 'block';

    renderShiftHeader();
    renderSegments();
    renderDoctorVisits();

    msg('Смена восстановлена из памяти: продолжай работу.');
    return true;
  }

  return false;
}

// При старте пытаемся восстановить смену
document.addEventListener('DOMContentLoaded', async () => {
  await loadDrivers();
  const restored = restoreState();

  if (!restored) {
    // Если смены нет — показываем форму старта, и можно подставить одометр из прошлой
    $('driverSel').disabled = false;
    $('newShiftForm').style.display = 'block';
    $('workCards').style.display = 'none';

    const lastShift = localStorage.getItem('lastShiftEnd');
    if (lastShift) {
      try {
        const prev = JSON.parse(lastShift);
        if (prev && prev.odometerEnd) {
          $('odometerStart').value = prev.odometerEnd;
          msg(`Одометр подставлен из прошлой смены: ${prev.odometerEnd} км`);
        }
      } catch (e) { /* игнорируем, если формат битый */ }
    }
  }
});

function startShift() {
  const driver = currentDriver();
  const carLabelVal = $('carSel').value;
  const odometer = parseInt($('odometerStart').value, 10);
  const timeStart = $('timeStart').value;

  if (!driver) { msg('Выбери водителя'); return; }
  if (!carLabelVal || carLabelVal === NEW_DRIVER) { msg('Выбери автомобиль'); return; }
  if (isNaN(odometer)) { msg('Укажи корректный одометр (число)'); return; }
  if (!timeStart) { msg('Укажи время начала'); return; }

  shift = {
    id: 'sh-' + uid(),
    driverFio: driver.fio,
    carLabel: carLabelVal,
    date: todayISO(),
    timeStart: timeStart,
    odometerStart: odometer,
    timeEnd: null,
    odometerEnd: null
  };

  segments = [];
  doctorVisits = [];

  $('driverSel').disabled = true;
  $('newShiftForm').style.display = 'none';
  $('workCards').style.display = 'block';

  renderShiftHeader();
  msg('Смена открыта. Теперь добавляй отрезки и визиты.');
  onDataChange(); // сохраняем состояние
}

function renderShiftHeader() {
  if (!shift) return;
  $('#shiftHeader').innerHTML = `
    <div class="card">
      <h2>Смена: ${shift.driverFio}</h2>
      <p>Авто: ${shift.carLabel}</p>
      <p>Дата: ${shift.date}, начало: ${shift.timeStart}</p>
      <p>Одометр старт: ${shift.odometerStart} км</p>
    </div>
  `;
}

function addSegment() {
  const from = canonName($('fromPoint').value, points);
  const to = canonName($('toPoint').value, points);
  const km = parseInt($('kmSegment').value, 10);
  const timeFrom = $('timeFromSegment').value;
  const timeTo = $('timeToSegment').value;

  if (!from || !to) { msg('Укажи пункты отправления и назначения'); return; }
  if (isNaN(km) || km <= 0) { msg('Укажи корректное расстояние (число > 0)'); return; }
  if (!timeFrom || !timeTo) { msg('Укажи время начала и конца отрезка'); return; }

  const seg = {
    id: 'seg-' + uid(),
    from, to, km, timeFrom, timeTo
  };
  segments.push(seg);
  onDataChange();
  renderSegments();
  $('fromPoint').value = ''; $('toPoint').value = '';
  $('kmSegment').value = ''; $('timeFromSegment').value = ''; $('timeToSegment').value = '';
}

function renderSegments() {
  const list = $('#segmentsList');
  if (!segments.length) {
    list.innerHTML = '<p style="color:#888">Отрезков пока нет</p>';
    return;
  }
  list.innerHTML = segments.map((s, i) => `
    <div class="card" style="border-left:4px solid #2f6fed">
      <strong>${s.from} → ${s.to}</strong>
      <div>${s.km} км, ${s.timeFrom}–${s.timeTo}</div>
      <button onclick="removeSegment(${i})" style="margin-top:6px;width:100%">Удалить</button>
    </div>
  `).join('');
}

window.removeSegment = function(i) {
  segments.splice(i, 1);
  onDataChange();
  renderSegments();
};

function addDoctorVisit() {
  const place = canonName($('docPlace').value, medPoints);
  const doctor = canonName($('docName').value, docNames);
  const timeAppointed = $('docTimeAppointed').value;
  const timeBoarding = $('docTimeBoarding').value;

  if (!place || !doctor) { msg('Укажи пункт и врача'); return; }
  if (!timeAppointed || !timeBoarding) { msg('Укажи время приёма и посадки'); return; }

  const visit = {
    id: 'doc-' + uid(),
    place, doctor, timeAppointed, timeBoarding
  };
  doctorVisits.push(visit);
  onDataChange();
  renderDoctorVisits();
  $('docPlace').value = ''; $('docName').value = '';
  $('docTimeAppointed').value = ''; $('docTimeBoarding').value = '';
}

function renderDoctorVisits() {
  const list = $('#doctorVisitsList');
  if (!doctorVisits.length) {
    list.innerHTML = '<p style="color:#888">Визитов пока нет</p>';
    return;
  }
  list.innerHTML = doctorVisits.map((v, i) => `
    <div class="card" style="border-left:4px solid #1a9a5f">
      <strong>${v.doctor} — ${v.place}</strong>
      <div>Приём: ${v.timeAppointed}, посадка: ${v.timeBoarding}</div>
      <button onclick="removeDoctorVisit(${i})" style="margin-top:6px;width:100%">Удалить</button>
    </div>
  `).join('');
}

window.removeDoctorVisit = function(i) {
  doctorVisits.splice(i, 1);
  onDataChange();
  renderDoctorVisits();
};

function finishShift() {
  const timeEnd = $('timeEnd').value;
  const odometerEnd = parseInt($('odometerEnd').value, 10);

  if (!timeEnd) { msg('Укажи время окончания'); return; }
  if (isNaN(odometerEnd)) { msg('Укажи корректный одометр окончания (число)'); return; }

  shift.timeEnd = timeEnd;
  shift.odometerEnd = odometerEnd;

  // Сохраняем «прошлую смену» для автозаполнения одометра в следующей
  localStorage.setItem('lastShiftEnd', JSON.stringify(shift));

  // Отправляем все данные на сервер
  const records = [
    {
      id: shift.id,
      type: 'shift',
      driverFio: shift.driverFio,
      carLabel: shift.carLabel,
      date: shift.date,
      timeStart: shift.timeStart,
      timeEnd: shift.timeEnd,
      odometerStart: shift.odometerStart,
      odometerEnd: shift.odometerEnd
    }
  ];

  segments.forEach(s => records.push({
    id: s.id, type: 'segment', shiftId: shift.id, from: s.from, to: s.to,
    km: s.km, timeFrom: s.timeFrom, timeTo: s.timeTo
  }));

  doctorVisits.forEach(v => records.push({
    id: v.id, type: 'doctor', shiftId: shift.id, place: v.place,
    doctor: v.doctor, timeAppointed: v.timeAppointed, timeBoarding: v.timeBoarding
  }));

  sendOrQueue(records).then(r => {
    if (r.sent) {
      msg('Смена завершена и отправлена на сервер.');
    } else if (r.queued) {
      msg('Смена сохранена в очередь и уйдёт при появлении сети.');
    } else {
      msg('Ошибка отправки: ' + (r.error || 'неизвестная ошибка'));
    }
  });

  // Очищаем состояние
  clearState();
  shift = null;
  segments = [];
  doctorVisits = [];

  $('driverSel').disabled = false;
  $('newShiftForm').style.display = 'block';
  $('workCards').style.display = 'none';
  renderShiftHeader(); // очистит заголовок
  renderSegments();
  renderDoctorVisits();
}
