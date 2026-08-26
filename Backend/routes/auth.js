const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const pool = require('../db');
const { requireAuth } = require('../middleware');
const router = express.Router();

const JWT_SECRET = process.env.JWT_SECRET;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const levels = new Set(['Začetnik','Rekreativec','Srednji nivo','Napreden','Tekmovalec']);

function cleanString(value, max = 255) { return typeof value === 'string' ? value.trim().slice(0, max) : ''; }
function publicUser(user) {
  const { geslo_hash, ...safe } = user;
  return safe;
}
function signToken(id) { return jwt.sign({ id }, JWT_SECRET, { expiresIn: '7d' }); }
function validateRegistration(body) {
  const ime = cleanString(body.ime, 50), priimek = cleanString(body.priimek, 50);
  const email = cleanString(body.email, 100).toLowerCase(), geslo = String(body.geslo || '');
  if (!ime || !priimek || !EMAIL_RE.test(email)) return 'Preverite ime, priimek in email.';
  if (geslo.length < 8 || geslo.length > 128) return 'Geslo mora imeti najmanj 8 in največ 128 znakov.';
  return null;
}

router.post('/register', async (req, res) => {
  const error = validateRegistration(req.body);
  if (error) return res.status(400).json({ message: error });
  const { ime, priimek, email, geslo, telefon, leto_rojstva, opis, nivo } = req.body;
  try {
    const normalizedEmail = cleanString(email, 100).toLowerCase();
    const [existing] = await pool.query('SELECT id FROM uporabniki WHERE email = ?', [normalizedEmail]);
    if (existing.length) return res.status(409).json({ message: 'Email že obstaja' });
    const hash = await bcrypt.hash(String(geslo), 12);
    const birthYear = leto_rojstva ? Number(leto_rojstva) : null;
    if (birthYear && (!Number.isInteger(birthYear) || birthYear < 1900 || birthYear > new Date().getFullYear())) return res.status(400).json({ message: 'Neveljavno leto rojstva.' });
    const safeLevel = levels.has(nivo) ? nivo : 'Rekreativec';
    const [result] = await pool.query(
      `INSERT INTO uporabniki (ime, priimek, email, geslo_hash, telefon, leto_rojstva, opis, nivo, letna_karta, krediti, admin)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0)`,
      [cleanString(ime,50), cleanString(priimek,50), normalizedEmail, hash, cleanString(telefon,30) || null, birthYear, cleanString(opis,1000), safeLevel]
    );
    const [rows] = await pool.query('SELECT id, ime, priimek, email, telefon, leto_rojstva, opis, nivo, letna_karta, krediti, admin FROM uporabniki WHERE id = ?', [result.insertId]);
    res.status(201).json({ token: signToken(result.insertId), user: rows[0] });
  } catch (err) {
    console.error('register', err.code || err.message);
    res.status(500).json({ message: 'Napaka pri registraciji' });
  }
});

router.post('/login', async (req, res) => {
  const email = cleanString(req.body.email,100).toLowerCase();
  const geslo = String(req.body.geslo || '');
  if (!EMAIL_RE.test(email) || !geslo) return res.status(400).json({ message: 'Vnesite email in geslo.' });
  try {
    const [rows] = await pool.query('SELECT * FROM uporabniki WHERE email = ?', [email]);
    if (!rows.length || !(await bcrypt.compare(geslo, rows[0].geslo_hash))) return res.status(401).json({ message: 'Napačen email ali geslo' });
    res.json({ token: signToken(rows[0].id), user: publicUser(rows[0]) });
  } catch (err) {
    console.error('login', err.message);
    res.status(500).json({ message: 'Napaka pri prijavi' });
  }
});

router.get('/me', requireAuth, (req, res) => res.json({ user: req.user }));

router.put('/profile', requireAuth, async (req, res) => {
  const ime = cleanString(req.body.ime,50), priimek = cleanString(req.body.priimek,50), email = cleanString(req.body.email,100).toLowerCase();
  const leto = req.body.leto_rojstva ? Number(req.body.leto_rojstva) : null;
  if (!ime || !priimek || !EMAIL_RE.test(email)) return res.status(400).json({ message: 'Preverite ime, priimek in email.' });
  if (leto && (!Number.isInteger(leto) || leto < 1900 || leto > new Date().getFullYear())) return res.status(400).json({ message: 'Neveljavno leto rojstva.' });
  try {
    const [exists] = await pool.query('SELECT id FROM uporabniki WHERE email = ? AND id <> ?', [email, req.user.id]);
    if (exists.length) return res.status(409).json({ message: 'Ta email že uporablja drug uporabnik.' });
    const nivo = levels.has(req.body.nivo) ? req.body.nivo : 'Rekreativec';
    await pool.query(`UPDATE uporabniki SET ime=?, priimek=?, email=?, telefon=?, leto_rojstva=?, nivo=?, opis=? WHERE id=?`, [ime, priimek, email, cleanString(req.body.telefon,30)||null, leto, nivo, cleanString(req.body.opis,1000), req.user.id]);
    const [rows] = await pool.query('SELECT id, ime, priimek, email, telefon, leto_rojstva, opis, nivo, letna_karta, krediti, admin FROM uporabniki WHERE id=?', [req.user.id]);
    res.json({ user: rows[0] });
  } catch (err) { console.error('profile', err.message); res.status(500).json({ message: 'Napaka pri posodabljanju profila' }); }
});
module.exports = router;
