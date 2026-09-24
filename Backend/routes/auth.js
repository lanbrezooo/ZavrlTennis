const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const pool = require('../db');
const { requireAuth } = require('../middleware');
const router = express.Router();
const crypto = require('crypto');
const { Resend } = require('resend');

const resend = new Resend(process.env.RESEND_API_KEY);
const RESET_TOKEN_TTL_MINUTES = 60;

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
router.post('/logout', (req, res) => {
    res.clearCookie('zt_token', {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'strict'
    });
    res.json({ message: 'Odjava uspešna' });
});

router.post('/register', async (req, res) => {
  const error = validateRegistration(req.body);
  if (error) return res.status(400).json({ message: error });
  const { ime, priimek, email, geslo, telefon, leto_rojstva, opis, nivo, prikazi_telefon } = req.body;
  try {
    const normalizedEmail = cleanString(email, 100).toLowerCase();
    const [existing] = await pool.query('SELECT id FROM uporabniki WHERE email = ?', [normalizedEmail]);
    if (existing.length) return res.status(409).json({ message: 'Email že obstaja' });
    const hash = await bcrypt.hash(String(geslo), 12);
    const birthYear = leto_rojstva ? Number(leto_rojstva) : null;
    if (birthYear && (!Number.isInteger(birthYear) || birthYear < 1900 || birthYear > new Date().getFullYear())) return res.status(400).json({ message: 'Neveljavno leto rojstva.' });
    const safeLevel = levels.has(nivo) ? nivo : 'Rekreativec';
    const [result] = await pool.query(
      `INSERT INTO uporabniki (ime, priimek, email, geslo_hash, telefon, leto_rojstva, opis, nivo, letna_karta, krediti, admin, prikazi_telefon)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, ?)`,
      [cleanString(ime,50), cleanString(priimek,50), normalizedEmail, hash, cleanString(telefon,30) || null, birthYear, cleanString(opis,1000), safeLevel, prikazi_telefon ? 1 : 0]
    );
    const [rows] = await pool.query('SELECT id, ime, priimek, email, telefon, leto_rojstva, opis, nivo, letna_karta, krediti, admin, prikazi_telefon FROM uporabniki WHERE id = ?', [result.insertId]);
        const token = signToken(result.insertId);
    res.cookie('zt_token', token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production', // Na Renderju bo to true, ker je HTTPS
        sameSite: 'strict',
        maxAge: 7 * 24 * 60 * 60 * 1000 // 7 dni v milisekundah
    });
    res.status(201).json({ user: rows[0] });
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
    
    // Ustvari JWT žeton
    const token = signToken(rows[0].id);
    
    // Pošlji žeton kot HttpOnly piškotek
    res.cookie('zt_token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production', // V produkciji (Render) zahteva HTTPS
      sameSite: 'strict', // Zaščita pred CSRF
      maxAge: 7 * 24 * 60 * 60 * 1000 // Veljavnost 7 dni
    });
    
    // Vrni samo podatke o uporabniku (brez žetona!)
    res.json({ user: publicUser(rows[0]) });
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
    const prikaziTelefon = req.body.prikazi_telefon ? 1 : 0;
    await pool.query(`UPDATE uporabniki SET ime=?, priimek=?, email=?, telefon=?, leto_rojstva=?, nivo=?, opis=?, prikazi_telefon=? WHERE id=?`, [ime, priimek, email, cleanString(req.body.telefon,30)||null, leto, nivo, cleanString(req.body.opis,1000), prikaziTelefon, req.user.id]);
    const [rows] = await pool.query('SELECT id, ime, priimek, email, telefon, leto_rojstva, opis, nivo, letna_karta, krediti, admin, prikazi_telefon FROM uporabniki WHERE id=?', [req.user.id]);
    res.json({ user: rows[0] });
  } catch (err) { console.error('profile', err.message); res.status(500).json({ message: 'Napaka pri posodabljanju profila' }); }
});
// ===== ZAHTEVA ZA PONASTAVITEV GESLA =====
router.post('/forgot-password', async (req, res) => {
  const email = cleanString(req.body.email, 100).toLowerCase();
  if (!EMAIL_RE.test(email)) {
    return res.status(400).json({ message: 'Vnesite veljaven email.' });
  }

  try {
    const [rows] = await pool.query(
      'SELECT id, ime FROM uporabniki WHERE email = ?',
      [email]
    );

    // VEDNO vrnemo isto sporočilo (preprečimo ugotavljanje, ali email obstaja)
    const genericMsg = 'Če email obstaja v našem sistemu, smo poslali navodila za ponastavitev.';

    if (!rows.length) {
      return res.json({ message: genericMsg });
    }

    // Generiraj varen žeton
    const token = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const expires = new Date(Date.now() + RESET_TOKEN_TTL_MINUTES * 60 * 1000);

    await pool.query(
      'UPDATE uporabniki SET reset_token_hash = ?, reset_token_expires = ? WHERE id = ?',
      [tokenHash, expires, rows[0].id]
    );

    const resetUrl = `${process.env.FRONTEND_URL}/app?reset=${token}`;

    try {
      await resend.emails.send({
        from: process.env.EMAIL_FROM,
        to: email,
        subject: 'Ponastavitev gesla – Zavrl Tennis Team',
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
            <h2 style="color: #1a5632;">Ponastavitev gesla</h2>
            <p>Pozdravljeni ${rows[0].ime || ''},</p>
            <p>Prejeli smo zahtevo za ponastavitev gesla za vaš račun.</p>
            <p>Kliknite spodnji gumb za nastavitev novega gesla:</p>
            <p style="text-align: center; margin: 30px 0;">
              <a href="${resetUrl}" 
                 style="display: inline-block; background: #fdd835; color: #0e3a20; 
                        padding: 14px 28px; text-decoration: none; border-radius: 50px; 
                        font-weight: bold;">
                Ponastavi geslo
              </a>
            </p>
            <p style="font-size: 13px; color: #666;">
              Povezava velja ${RESET_TOKEN_TTL_MINUTES} minut. Če je niste zahtevali vi, 
              ignorirajte to sporočilo.
            </p>
            <p style="font-size: 12px; color: #999; margin-top: 30px;">
              Če gumb ne deluje, kopirajte to povezavo v brskalnik:<br>
              <a href="${resetUrl}" style="color: #666;">${resetUrl}</a>
            </p>
            <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;">
            <p style="font-size: 12px; color: #999;">
              Zavrl Tennis Team<br>
              Pot v Toplice 10, 2250 Ptuj
            </p>
          </div>
        `
      });
      console.log(`✓ Reset email poslan na ${email}`);
    } catch (mailErr) {
      console.error('Napaka pri pošiljanju emaila:', mailErr.message);
      // Ne razkrijemo napake uporabniku
    }

    res.json({ message: genericMsg });
  } catch (err) {
    console.error('forgot-password', err.message);
    res.status(500).json({ message: 'Napaka pri obdelavi zahteve.' });
  }
});

// ===== PONASTAVITEV GESLA Z ŽETONOM =====
router.post('/reset-password', async (req, res) => {
  const token = String(req.body.token || '').trim();
  const novoGeslo = String(req.body.geslo || '');

  if (!token || token.length !== 64) {
    return res.status(400).json({ message: 'Neveljavna povezava za ponastavitev.' });
  }
  if (novoGeslo.length < 8 || novoGeslo.length > 128) {
    return res.status(400).json({ message: 'Geslo mora imeti najmanj 8 in največ 128 znakov.' });
  }

  try {
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

    const [rows] = await pool.query(
      `SELECT id FROM uporabniki 
       WHERE reset_token_hash = ? 
         AND reset_token_expires > NOW() 
       LIMIT 1`,
      [tokenHash]
    );

    if (!rows.length) {
      return res.status(400).json({ 
        message: 'Povezava je neveljavna ali je potekla. Zahtevajte novo.' 
      });
    }

    const hash = await bcrypt.hash(novoGeslo, 12);

    await pool.query(
      `UPDATE uporabniki 
       SET geslo_hash = ?, 
           reset_token_hash = NULL, 
           reset_token_expires = NULL 
       WHERE id = ?`,
      [hash, rows[0].id]
    );

    console.log(`✓ Geslo ponastavljeno za uporabnika ${rows[0].id}`);
    res.json({ message: 'Geslo je bilo uspešno ponastavljeno. Prijavite se.' });
  } catch (err) {
    console.error('reset-password', err.message);
    res.status(500).json({ message: 'Napaka pri ponastavitvi gesla.' });
  }
});
module.exports = router;