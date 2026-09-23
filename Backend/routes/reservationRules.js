const pool = require('../db');

const COURTS = 9;
const START_HOUR = 8;
const DEFAULT_END_HOUR = 22;
const MAX_DAYS = 365;
const MAX_DAYS_BACK = 3;
const MORNING_END_HOUR = 12;
const MORNING_CREDITS_PER_HOUR = 1;
const AFTERNOON_CREDITS_PER_HOUR = 1;

async function getEndHour(conn = pool) {
  try {
    const [rows] = await conn.query(
      'SELECT vrednost FROM nastavitve WHERE kljuc = "zapiralna_ura"'
    );
    const val = rows.length ? Number(rows[0].vrednost) : DEFAULT_END_HOUR;
    return Number.isInteger(val) && val >= 10 && val <= 24 ? val : DEFAULT_END_HOUR;
  } catch {
    return DEFAULT_END_HOUR;
  }
}

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return false;
  const [y, m, d] = value.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  return (
    date.getFullYear() === y &&
    date.getMonth() === m - 1 &&
    date.getDate() === d
  );
}

function withinWindow(date) {
  if (!validDate(date)) return false;
  const d = new Date(`${date}T00:00:00`);
  const now = new Date();
  now.setHours(0, 0, 0, 0);

  const max = new Date(now);
  max.setDate(max.getDate() + MAX_DAYS);

  const min = new Date(now);
  min.setDate(min.getDate() - MAX_DAYS_BACK);

  return d >= min && d <= max;
}

function calculateCredits(startHour, duration, igrisce, sezona) {
  const isWinter = String(sezona || '').toLowerCase().trim() === 'zima';
  if (isWinter && (Number(igrisce) === 7 || Number(igrisce) === 8)) {
    return 2.5 * duration;
  }
  // 1 kredit/uro = 0,5 / 30 min
  const steps = Math.round(duration * 2);
  let total = 0;
  for (let i = 0; i < steps; i++) {
    const h = startHour + i * 0.5;
    total += h < MORNING_END_HOUR
      ? MORNING_CREDITS_PER_HOUR / 2
      : AFTERNOON_CREDITS_PER_HOUR / 2;
  }
  return total;
}

function validateReservation({ igrisce, ura, trajanje, datum, endHour, isAdmin }) {
  if (!Number.isInteger(igrisce) || igrisce < 1 || igrisce > COURTS) return 'Neveljavno igrišče';
  if (!validDate(datum) || !withinWindow(datum)) return 'Neveljaven datum';
  if (typeof ura !== 'number' || !Number.isFinite(ura)) return 'Neveljavna ura';
  if (!Number.isInteger(ura * 2)) return 'Ura mora biti v korakih po 30 minut';
  if (ura < START_HOUR || ura >= endHour) return 'Neveljavna ura';
  if (typeof trajanje !== 'number' || !Number.isFinite(trajanje)) return 'Neveljavno trajanje';
  if (!Number.isInteger(trajanje * 2) || trajanje < 1) return 'Trajanje mora biti vsaj 1 ura';

  const maxDuration = isAdmin ? endHour - ura : Math.min(2, endHour - ura);
  if (trajanje > maxDuration + 1e-9) return `Neveljavno trajanje (največ ${maxDuration} ur)`;
  if (ura + trajanje > endHour + 1e-9) return 'Termin presega zapiralno uro';
  return null;
}

module.exports = {
  COURTS,
  START_HOUR,
  DEFAULT_END_HOUR,
  MAX_DAYS,
  MAX_DAYS_BACK,
  MORNING_END_HOUR,
  MORNING_CREDITS_PER_HOUR,
  AFTERNOON_CREDITS_PER_HOUR,
  getEndHour,
  validDate,
  withinWindow,
  calculateCredits,
  validateReservation
};