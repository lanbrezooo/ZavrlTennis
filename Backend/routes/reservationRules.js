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

  let total = 0;
  for (let hour = startHour; hour < startHour + duration; hour++) {
    total += hour < MORNING_END_HOUR
      ? MORNING_CREDITS_PER_HOUR
      : AFTERNOON_CREDITS_PER_HOUR;
  }
  return total;
}

function validateReservation({ igrisce, ura, trajanje, datum, endHour, isAdmin }) {
  if (!Number.isInteger(igrisce) || igrisce < 1 || igrisce > COURTS) {
    return 'Neveljavno igrišče';
  }

  if (!validDate(datum) || !withinWindow(datum)) {
    return 'Neveljaven datum';
  }

  if (!Number.isInteger(ura) || ura < START_HOUR || ura >= endHour) {
    return 'Neveljavna ura';
  }

  const maxDuration = isAdmin
    ? endHour - ura
    : Math.min(3, endHour - ura);

  if (!Number.isInteger(trajanje) || trajanje < 1 || trajanje > maxDuration) {
    return `Neveljavno trajanje (največ ${maxDuration} ur)`;
  }

  if (ura + trajanje > endHour) {
    return 'Termin presega zapiralno uro';
  }

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