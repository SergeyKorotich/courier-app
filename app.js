const API_URL = 'https://script.google.com/macros/s/AKfycbzTPwKpo1S8XlKC4liDipa2Cqi7SqqwKzJBzGMyOXBAT25UZKeO-aQXyzZR6F4Eg_9_/exec'; // ← свой URL!

const $ = id => document.getElementById(id);
const msg = t => { $('msg').textContent = t; };
const uid = () => Date.now() + '-' + Math.floor(Math.random() * 1e6);
const nowHM = () => { const d = new Date(); return String(d.getHours()).padStart(2,'0') + ':' + String(d.getMinutes()).padStart(2,'0'); };
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

async function loadDrivers() {
  try {
    const out = await (await fetch(API_URL)).json();
    $('driverSel').innerHTML = out.drivers.map(d =>
      `<option value="${d.id}">${d.fio} — ${d.car} ${d.plate}</option>`).join('');
    if (Array.isArray(out.points) && out.points.length) {
      points = Array.from(new Set(['ОФИС'].concat(out.points)));
    }
    if (Array.isArray(out.medPoints)) medPoints = Array.from(new Set(out.medPoints));
    if (Array.isArray(out.docNames)) docNames = Array.from(new Set(out.docNames));
    renderPoints(); renderMedPoints(); renderDocNames();
  } catch (e) { msg('Не удалось загрузить данные: ' + e.message); }
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
  fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ records: [{ id: prefix + uid(), type: type, name: name }] })
  });
}

function startShift() {
  const dateStr = $('shiftDate').value;
  const tStart = $('timeStart').value;
  const odo = parseFloat($('odoStart').value.replace(',', '.'));
  if (!dateStr || !tStart) { msg('Укажи дату и время начала смены'); return; }
  if (isNaN(odo) || odo < 0) { msg('Укажи одометр на начало'); return; }
  shift = { id: uid(), driverId: $('driverSel').value, date: dateStr, timeStart: tStart, odoStart: odo };
  segments = [];
  doctorVisits = [];
  $('startCard').style.display = 'none';
  $('shiftCard').style.display = 'block';
  $('docCard').style.display = 'block';
  $('finishCard').style.display = 'block';
  msg('Смена открыта.');
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
    // text/plain — иначе Apps Script не пройдёт CORS
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ records: [
        { ...shift, timeEnd: tEnd, odoEnd, totalKm, cityKm, highwayKm,
          route: route, doctor: doctorInfo,
          duration: minToHHMM(dMin), durationMin: dMin,
          refuel: refuel, status: 'Завершено', type: 'shift' },
        ...segments.map(s => ({ ...s, type: 'segment' })),
        ...doctorVisits
      ] })
    });
    const out = await res.json();
    if (!out.ok) throw new Error(out.error || 'ошибка сервера');
    // Перенос одометра в следующую смену — как старая clearForm
    localStorage.setItem('lastOdoEnd', String(odoEnd));
    msg(`Отправлено: ${out.processed.length} записей.\nМаршрут: ${route}` + (doctorInfo ? `\nВрачи: ${doctorInfo}` : ''));
    shift = null; segments = []; doctorVisits = [];
    $('shiftCard').style.display = 'none';
    $('docCard').style.display = 'none';
    $('finishCard').style.display = 'none';
    $('startCard').style.display = 'block';
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
