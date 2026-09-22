const pool = require('../db');

async function withReservationLock(lockName, fn) {
  const conn = await pool.getConnection();

  try {
    const [rows] = await conn.query('SELECT GET_LOCK(?, 10) AS locked', [lockName]);
    if (!rows[0]?.locked) {
      throw new Error('Sistema je zaseden, poskusite znova.');
    }

    return await fn(conn);
  } finally {
    try {
      await conn.rollback();
    } catch {}

    try {
      await conn.query('SELECT RELEASE_LOCK(?)', [lockName]);
    } catch {}

    conn.release();
  }
}

function reservationLockName(igrisce, datum) {
  return `res:${igrisce}:${datum}`;
}

module.exports = {
  withReservationLock,
  reservationLockName
};