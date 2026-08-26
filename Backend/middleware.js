const jwt = require('jsonwebtoken');
const pool = require('./db');

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) throw new Error('JWT_SECRET mora biti nastavljen v okolju.');

function getToken(req) {
  const value = req.headers.authorization || '';
  return value.startsWith('Bearer ') ? value.slice(7) : null;
}

async function requireAuth(req, res, next) {
  const token = getToken(req);
  if (!token) return res.status(401).json({ message: 'Niste prijavljeni' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const [rows] = await pool.query(
      'SELECT id, ime, priimek, email, telefon, leto_rojstva, opis, nivo, letna_karta, krediti, admin FROM uporabniki WHERE id = ?',
      [decoded.id]
    );
    if (!rows.length) return res.status(401).json({ message: 'Uporabnik ne obstaja' });
    req.user = rows[0];
    next();
  } catch (_) {
    return res.status(401).json({ message: 'Neveljavna ali potekla prijava' });
  }
}

function requireAdmin(req, res, next) {
  if (!req.user?.admin) return res.status(403).json({ message: 'Admin dostop je potreben' });
  next();
}

module.exports = { requireAuth, requireAdmin };
