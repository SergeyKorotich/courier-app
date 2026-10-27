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
const carLabel = c => ((c.name || '') + ' ' + (c.plate || '')).trim();

// Единая отправка записей на сервер
async function postRecords(records) {
  // text/plain — иначе Apps Script не пройдёт CORS
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ records: records })
  });
  const out = await res.json();
  if (!out.ok) throw new Error(out.error || 'ошибка сервера');
  return out;
}

function currentDriver() {
  const v = $('driverSel').value;
  if (v === NEW_DRIVER) return null;
  return drivers[Number(v)] || null;
}

async function loadDrivers() {
  try {
    const out = await (await fetch(API_URL)).json();
    drivers = Array.isArray(out.drivers) ? out.drivers : [];
    if (Array.isArray(out.points) && out.points.length) {
      points = Array.from(new Set(['ОФИС'].concat(out.points)));
    }
    if (Array.isArray(out.medPoints)) medPoints = Array.from(new Set(out.medPoints));
    if (Array.isArray(out.docNames)) docNames = Array.from(new Set(out.docNames));
    renderPoints(); renderMedPoints(); renderDocNames();
    // Восстанавливаем выбор водителя и машины с прошлого раза
    renderDriverSelect(localStorage.getItem('lastDriver'));
    selectCarByLabel(localStorage.getItem('lastCar'));
  } catch (e) { msg('Не удалось загрузить данные: ' + e.message); }
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

// Список автомобилей меняется при смене водителя;
// по умолчанию — первая машина водителя
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

// Новый водитель: ФИО обязательно, машина — первая в его списке
async function saveDriver() {
  const fio = $('newDriverFio').value.trim().replace(/\s+/g, ' ');
  const car = $('newDriverCar').value.trim();
  const plate = $('newDriverPlate').value.trim();
  if (!fio) { msg('Укажи ФИО водителя'); return; }
  if (!car && !plate) { msg('Укажи хотя бы автомобиль или госномер'); return; }
  msg('Сохраняю водителя…');
  try {
    await postRecords([{ id: 'drv-' + uid(), type: 'driver', fio: fio, car: car, plate: plate }]);
    const existing = drivers.find(d => d.fio.toLowerCase() === fio.toLowerCase());
    const carObj = { name: car, plate: plate, row: null };
    if (existing) existing.cars.push(carObj);
    else drivers.push({ fio: fio, cars: [carObj] });
    localStorage.setItem('lastDriver', fio);
    localStorage.setItem('lastCar', carLabel(carObj));
    $('driverPanel').style.display = 'none';
    renderDriverSelect(fio);
    selectCarByLabel(carLabel(carObj));
    msg('Водитель сохранён: ' + fio);
  } catch (e) { msg('Не сохранилось: ' + e.message); }
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
  $('carSaveBtn');
  $('carPanel').style.display = 'block';
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
  try {
    if (carEditMode === 'edit') {
      const c = d.cars[Number($('carSel').value)] || d.cars[0];
      await postRecords([{ id: 'care-' + uid(), type: 'driveredit', row: c.row, fio: d.fio, car: car, plate: plate }]);
      c.name = car; c.plate = plate;
    } else {
      await postRecords([{ id: 'car-' + uid(), type: 'driver', fio: d.fio, car: car, plate: plate }]);
      d.cars.push({ name: car, plate: plate, row: null });
    }
    localStorage.setItem('lastDriver', d.fio);
    localStorage.setItem('lastCar', label);
    renderCars();
    selectCarByLabel(label);
    $('carPanel').style.display = 'none';
    msg('Автомобиль сохранён: ' + label);
  } catch (e) { msg('Не сохранилось: ' + e.message); }
}

// Канонизация с учётом справочника: совпадение без учёта регистра
// возвращается в написании справочника, новое имя — «Можга», ОФИС — капсом
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

// ОФИС и Ижевск — эквивалентные точки (как в старой системе)
function areEquivalentPoints(p1, p2) {
  const a = String(p1 || '').trim().toUpperCase();
  const b = String(p2 || '').trim().toUpperCase();
  return (a === 'ОФИС' && b === 'ИЖЕВСК') || (a === 'ИЖЕВСК' && b === 'ОФИС');
}

// Сжатие маршрута: подряд идущие одинаковые точки схлопываются,
// ОФИС/Ижевск считаются одним пунктом, Ижевск в конце становится ОФИС
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

// Новая запись в справочник: в локальный кэш сразу, на сервер — в фоне
function rememberRef(list, render, prefix, type, name) {
  if (!name || list.includes(name)) return;
  list.push(name);
  render();
  postRecords([{ id: prefix + uid(), type: type, name: name }]).catch(() => {});
}

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
  $('startCard').style.display = 'none';
  $('shiftCard').style.display = 'block';
  $('docCard').style.display = 'block';
  $('finishCard').style.display = 'block';
  msg(`Смена открыта: ${d.fio}, ${carLabelVal}.`);
}

function addSegment() {
  const from = canonName($('segFrom').value, points);
  const to = canonName($('segTo').value, points);
  const km = parseFloat(String($('segKm').value).replace(',', '.'));
  if (!from || !to || isNaN(km) || km < 0) { msg('Заполни «Откуда», «Куда» и пробег'); return; }
  // Как в старой системе: вводится пробег с начала смены, первый отрезок — от нуля
  const prevKm = segments.length ? segments[segments.length - 1].kmAtB : 0;
  const segmentKm = Math.max(0, km - prevKm);
  const routeType = (from === 'ОФИС' || to === 'ОФИС' || from === to) ? 'Город' : 'Трасса';
  segments.push({ id: uid(), shiftId: shift.id, from, to, kmAtB: km, segmentKm, routeType, ts: new Date().toISOString() });
  rememberRef(points, renderPoints, 'p-', 'point', from);
  rememberRef(points, renderPoints, 'p-', 'point', to);
  $('segFrom').value = to; $('segTo').value = ''; $('segKm').value = '';
  msg(`Отрезок: ${segmentKm} км (${routeType}). Всего отрезков: ${segments.length}`);
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

  // Маршрут и врачи — как в старой системе
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

  msg('Отправляю…');
  try {
    const out = await postRecords([
      { ...shift, timeEnd: tEnd, odoEnd, totalKm, cityKm, highwayKm,
        route: route, doctor: doctorInfo,
        duration: minToHHMM(dMin), durationMin: dMin,
        refuel: refuel, status: 'Завершено', type: 'shift' },
      ...segments.map(s => ({ ...s, type: 'segment' })),
      ...doctorVisits
    ]);
    // Перенос одометра в следующую смену — как старая clearForm
    localStorage.setItem('lastOdoEnd', String(odoEnd));
    msg(`Отправлено: ${out.processed.length} записей.\nМаршрут: ${route}` + (doctorInfo ? `\nВрачи: ${doctorInfo}` : ''));
    shift = null; segments = []; doctorVisits = [];
    $('shiftCard').style.display = 'none';
    $('docCard').style.display = 'none';
    $('finishCard').style.display = 'none';
    $('startCard').style.display = 'block';
    // Выбор водителя и автомобиля сохраняем — пользователь может
    // сразу открыть следующую смену без повторного выбора
    $('odoStart').value = odoEnd;
    $('refuel').value = '';
    $('timeStart').value = '';
    $('timeEnd').value = '';
  } catch (e) {
    msg('Не отправилось: ' + e.message);
  }
}

// Подставляем одометр прошлой смены (аналог переноса B4 из старой формы)
(function prefillOdo() {
  const saved = parseFloat(localStorage.getItem('lastOdoEnd'));
  if (!isNaN(saved) && saved > 0) $('odoStart').value = saved;
})();

// Дата по умолчанию — сегодня (для обычных смен), можно поменять вручную
(function prefillDate() {
  $('shiftDate').value = todayISO();
})();

loadDrivers();
