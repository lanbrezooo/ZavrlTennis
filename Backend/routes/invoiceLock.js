const pool = require('../db');

/**
 * Zaklene proces izdaje računa po Stripe session ID.
 * Če dva webhooka prideta hkrati, se drugi počaka, nato pa vidi,
 * da je račun že izdan, in preskoči.
 */
async function withInvoiceLock(stripeSessionId, fn) {
  const conn = await pool.getConnection();
  const lockName = `minimax_inv_${String(stripeSessionId).slice(0, 50)}`;

  try {
    const [rows] = await conn.query('SELECT GET_LOCK(?, 15) AS locked', [lockName]);
    if (!rows[0]?.locked) {
      throw new Error('Sistem je zaseden, poskusite znova.');
    }
    return await fn();
  } finally {
    try {
      await conn.query('SELECT RELEASE_LOCK(?)', [lockName]);
    } catch {}
    conn.release();
  }
}

module.exports = { withInvoiceLock };