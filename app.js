const API_URL = 'https://script.google.com/macros/s/AKfycbzTPwKpo1S8XlKC4liDipa2Cqi7SqqwKzJBzGMyOXBAT25UZKeO-aQXyzZR6F4Eg_9_/exec'; // ← верни свой URL!

const $ = id => document.getElementById(id);
const msg = t => { $('msg').textContent = t; };
const uid = () => Date.now() + '-' + Math.floor(Math.random() * 1e6);
const nowHM = () => { const d = new Date(); return String(d.getHours()).padStart(2,'0') + ':' + String(d.getMinutes()).padStart(2,'0'); };
// Локальная дата (не UTC) — иначе вечером дата уезжает на день назад
const todayISO = () => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0'); };

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

// Каноническая форма: «МОЖГА»/«можга» → «Можга», «офис» → «ОФИС»
function canonName(s) {
  s = (s || '').trim().replace(/\s+/g, ' ');
  if (!s) return '';
  if (s.toLowerCase() === 'офис') return 'ОФИС';
  return s.toLowerCase().split(' ')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
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
  const odo = parseFloat($('odoStart').value.replace(',', '.'));
  if (isNaN(odo) || odo < 0) { msg('Укажи одометр на начало'); return; }
  shift = { id: uid(), driverId: $('driverSel').value, date: todayISO(), timeStart: nowHM(), odoStart: odo };
  segments = [];
  doctorVisits = [];
  $('startCard').style.display = 'none';
  $('shiftCard').style.display = 'block';
  $('docCard').style.display = 'block';
  $('finishCard').style.display = 'block';
  $('shiftTitle').textContent = `Смена ${shift.date} · ${shift.timeStart} · одометр ${odo}`;
  msg('Смена открыта.');
}

function addSegment() {
  const from = canonName($('segFrom').value);
  const to = canonName($('segTo').value);
  const km = parseFloat(String($('segKm').value).replace(',', '.'));
  if (!from || !to || isNaN(km) || km < 0) { msg('Заполни «Откуда», «Куда» и пробег'); return; }
  const prevKm = segments.length ? segments[segments.length - 1].kmAtB : shift.odoStart;
  const segmentKm = Math.max(0, km - prevKm);
  const routeType = (from === 'ОФИС' || to === 'ОФИС' || from === to) ? 'Город' : 'Трасса';
  segments.push({ id: uid(), shiftId: shift.id, from, to, kmAtB: km, segmentKm, routeType, ts: new Date().toISOString() });
  rememberRef(points, renderPoints, 'p-', 'point', from);
  rememberRef(points, renderPoints, 'p-', 'point', to);
  $('segFrom').value = to; $('segTo').value = ''; $('segKm').value = '';
  msg(`Отрезок: ${segmentKm} км (${routeType}). Всего отрезков: ${segments.length}`);
}

function addDoctorVisit() {
  const doctor = $('docName').value.trim();
  const place = canonName($('docPlace').value);
  const tApp = $('docTimeApp').value;
  const tBoard = $('docTimeBoard').value;
  if (!doctor || !place) { msg('Укажи врача и куда везём'); return; }
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
  const totalKm = segments.reduce((s, x) => s + x.segmentKm, 0);
  const odoEnd = Number(shift.odoStart) + totalKm;
  msg('Отправляю…');
  try {
    // text/plain — иначе Apps Script не пройдёт CORS
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ records: [
        { ...shift, timeEnd: nowHM(), odoEnd, totalKm, cityKm: 0, highwayKm: 0, route: '', type: 'shift' },
        ...segments.map(s => ({ ...s, type: 'segment' })),
        ...doctorVisits
      ] })
    });
    const out = await res.json();
    if (!out.ok) throw new Error(out.error || 'ошибка сервера');
    msg(`Отправлено: ${out.processed.length} записей. Проверь Shifts, SegmentsAPI и Doctor.`);
    shift = null; segments = []; doctorVisits = [];
    $('shiftCard').style.display = 'none';
    $('docCard').style.display = 'none';
    $('finishCard').style.display = 'none';
    $('startCard').style.display = 'block';
  } catch (e) {
    msg('Не отправилось: ' + e.message);
  }
}

loadDrivers();
