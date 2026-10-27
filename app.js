const API_URL = 'https://github.com/SergeyKorotich/courier-app.git';

const $ = id => document.getElementById(id);
const msg = t => { $('msg').textContent = t; };
const uid = () => Date.now() + '-' + Math.floor(Math.random() * 1e6);
const nowHM = () => { const d = new Date(); return String(d.getHours()).padStart(2,'0') + ':' + String(d.getMinutes()).padStart(2,'0'); };
// Локальная дата (не UTC) — иначе вечером дата уезжает на день назад
const todayISO = () => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0'); };

let shift = null;          // текущая открытая смена
let segments = [];         // отрезки этой смены

async function loadDrivers() {
  try {
    const out = await (await fetch(API_URL)).json();
    const sel = $('driverSel');
    sel.innerHTML = out.drivers.map(d =>
      `<option value="${d.id}">${d.fio} — ${d.car} ${d.plate}</option>`).join('');
  } catch (e) { msg('Не удалось загрузить водителей: ' + e.message); }
}

function startShift() {
  const odo = parseFloat($('odoStart').value.replace(',', '.'));
  if (isNaN(odo) || odo < 0) { msg('Укажи одометр на начало'); return; }
  shift = { id: uid(), driverId: $('driverSel').value, date: todayISO(), timeStart: nowHM(), odoStart: odo };
  segments = [];
  $('startCard').style.display = 'none';
  $('shiftCard').style.display = 'block';
  $('shiftTitle').textContent = `Смена ${shift.date} · ${shift.timeStart} · одометр ${odo}`;
  msg('Смена открыта.');
}

function addSegment() {
  const from = $('segFrom').value.trim().toUpperCase();
  const to = $('segTo').value.trim().toUpperCase();
  const km = parseFloat(String($('segKm').value).replace(',', '.'));
  if (!from || !to || isNaN(km) || km < 0) { msg('Заполни «Откуда», «Куда» и пробег'); return; }
  const prevKm = segments.length ? segments[segments.length - 1].kmAtB : shift.odoStart;
  const segmentKm = Math.max(0, km - prevKm);
  const routeType = (from === 'ОФИС' || to === 'ОФИС' || from === to) ? 'Город' : 'Трасса';
  segments.push({ id: uid(), shiftId: shift.id, from, to, kmAtB: km, segmentKm, routeType, ts: new Date().toISOString() });
  $('segFrom').value = to; $('segTo').value = ''; $('segKm').value = '';
  msg(`Отрезок: ${segmentKm} км (${routeType}). Всего отрезков: ${segments.length}`);
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
      body: JSON.stringify({ records: [{ ...shift, timeEnd: nowHM(), odoEnd, totalKm, cityKm: 0, highwayKm: 0, route: '', type: 'shift' },
                                       ...segments.map(s => ({ ...s, type: 'segment' }))] })
    });
    const out = await res.json();
    if (!out.ok) throw new Error(out.error || 'ошибка сервера');
    msg(`Отправлено: ${out.processed.length} записей. Проверь листы Shifts и SegmentsAPI в таблице.`);
    shift = null; segments = [];
    $('shiftCard').style.display = 'none';
    $('startCard').style.display = 'block';
  } catch (e) {
    msg('Не отправилось: ' + e.message);
  }
}

loadDrivers();
