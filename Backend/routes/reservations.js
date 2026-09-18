const express = require('express');
const pool = require('../db');
const { requireAuth, requireAdmin } = require('../middleware');
const router = express.Router();

const START_HOUR = 8;
const MORNING_END_HOUR = 12;
const END_HOUR = 22;
const COURTS = 9; // ✅ 9 igrišč
const MAX_DAYS = 365;
const MAX_DAYS_BACK = 3; // ✅ POPRAVLJENO: 3 dni nazaj (ne 30)
const MORNING_CREDITS_PER_HOUR = 1;
const AFTERNOON_CREDITS_PER_HOUR = 2;

function validDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value || '') && !Number.isNaN(new Date(`${value}T00:00:00`).getTime());
}
function withinWindow(date) {
  const d = new Date(`${date}T00:00:00`), now = new Date();
  now.setHours(0,0,0,0);
  const max = new Date(now); max.setDate(max.getDate() + MAX_DAYS);
  const min = new Date(now); min.setDate(min.getDate() - MAX_DAYS_BACK);
  return d >= min && d <= max;
}
function calculateCredits(startHour, duration, igrisce, sezona) {
  // Neobčutljivo na velike/male črke in presledke
  const isWinter = String(sezona || '').toLowerCase().trim() === 'zima';
  if (isWinter && (Number(igrisce) === 7 || Number(igrisce) === 8)) {
    return 2.5 * duration;
  }
  let total = 0;
  for (let hour = startHour; hour < startHour + duration; hour++) {
    total += hour < MORNING_END_HOUR ? MORNING_CREDITS_PER_HOUR : AFTERNOON_CREDITS_PER_HOUR;
  }
  return total;
}

async function deleteOldReservations() {
  try {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - MAX_DAYS_BACK);
    const cutoffStr = cutoffDate.toISOString().split('T')[0];
    await pool.query('DELETE FROM rezervacije WHERE datum < ?', [cutoffStr]);
  } catch (err) {
    console.error('delete old reservations', err.message);
  }
}

router.get('/', async (req, res) => {
  const date = String(req.query.date || '');
  if (!validDate(date)) return res.status(400).json({ message: 'Neveljaven datum' });
  try {
    const [rows] = await pool.query(
      `SELECT r.id, r.user_id, r.igrisce, DATE_FORMAT(r.datum, '%Y-%m-%d') AS datum, r.ura_zacetka, r.trajanje, r.oznaka, r.blokada, u.ime, u.priimek, u.prikazi_telefon
       FROM rezervacije r
       JOIN uporabniki u ON u.id = r.user_id
       WHERE r.datum = ? AND r.preklicano = 0
       ORDER BY r.igrisce, r.ura_zacetka`,
      [date]
    );
    res.json({ reservations: rows });
  } catch (err) {
    console.error('list reservations', err.message);
    res.status(500).json({ message: 'Napaka pri pridobivanju rezervacij' });
  }
});
router.post('/', requireAuth, async (req, res) => {
  const igrisce = Number(req.body.igrisce);
  const ura = Number(req.body.ura_zacetka);
  const trajanje = Number(req.body.trajanje);
  const datum = String(req.body.datum || '');
  const useAnnualCard = req.body.useAnnualCard === true;
  const oznaka = req.body.oznaka ? String(req.body.oznaka).trim().slice(0, 100) : null;

  const maxDuration = req.user.admin ? (END_HOUR - ura) : 3;

  if (!Number.isInteger(igrisce) || igrisce < 1 || igrisce > COURTS ||
      !validDate(datum) || !withinWindow(datum) ||
      !Number.isInteger(ura) || !Number.isInteger(trajanje) ||
      ura < START_HOUR || ura >= END_HOUR || trajanje < 1 || trajanje > maxDuration ||
      ura + trajanje > END_HOUR) {
    return res.status(400).json({ message: 'Neveljaven termin rezervacije' });
  }

  const finalOznaka = req.user.admin ? oznaka : null;

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [users] = await conn.query('SELECT id, krediti, letna_karta FROM uporabniki WHERE id=? FOR UPDATE', [req.user.id]);
    if (!users.length) { await conn.rollback(); return res.status(401).json({ message: 'Uporabnik ne obstaja' }); }
    const user = users[0];
    if (useAnnualCard && !user.letna_karta) { await conn.rollback(); return res.status(403).json({ message: 'Letna karta za vaš račun ni aktivna' }); }

        const [conflicts] = await conn.query(
      `SELECT id FROM rezervacije
       WHERE igrisce=? AND datum=? AND ura_zacetka < ? AND ura_zacetka + trajanje > ?
       AND preklicano = 0
       FOR UPDATE`,
      [igrisce, datum, ura + trajanje, ura]
    );
    if (conflicts.length) { await conn.rollback(); return res.status(409).json({ message: 'Termin je že zaseden' }); }

        // Preberi sezono
    const [sezRows] = await conn.query('SELECT vrednost FROM nastavitve WHERE kljuc = "sezona"');
    const sezona = sezRows.length ? sezRows[0].vrednost : 'poletje';

    // V zimski sezoni navadni uporabniki ne morejo uporabiti letne karte
    if (useAnnualCard && sezona === 'zima' && !req.user.admin) {
      await conn.rollback();
      return res.status(403).json({ message: 'V zimski sezoni sezonska karta ni na voljo!' });
    }

    const creditsRequired = useAnnualCard ? 0 : calculateCredits(ura, trajanje, igrisce, sezona);

    const [result] = await conn.query(
      `INSERT INTO rezervacije
       (user_id, igrisce, datum, ura_zacetka, trajanje, krediti_porabili, letna_karta_uporabljena, oznaka)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [req.user.id, igrisce, datum, ura, trajanje, creditsRequired, useAnnualCard ? 1 : 0, finalOznaka]
    );

    if (creditsRequired > 0) await conn.query('UPDATE uporabniki SET krediti = krediti - ? WHERE id=?', [creditsRequired, req.user.id]);
    const remainingCredits = Number(user.krediti) - creditsRequired;

    await conn.commit();
    res.status(201).json({ reservation: { id: result.insertId, user_id: req.user.id, igrisce, datum, ura_zacetka: ura, trajanje, krediti_porabili: creditsRequired, letna_karta_uporabljena: useAnnualCard ? 1 : 0, oznaka: finalOznaka }, creditsCharged: creditsRequired, remainingCredits });
  } catch (err) {
    await conn.rollback();
    console.error('create reservation', err.message);
    res.status(500).json({ message: 'Napaka pri ustvarjanju rezervacije' });
  } finally {
    conn.release();
  }
});

router.delete('/:id', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ message: 'Neveljaven ID' });
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.query('SELECT * FROM rezervacije WHERE id=? AND preklicano = 0 FOR UPDATE', [id]);
    if (!rows.length) { await conn.rollback(); return res.status(404).json({ message: 'Rezervacija ne obstaja' }); }
    const reservation = rows[0];

    const isOwner = reservation.user_id === req.user.id;
    const isAdmin = req.user.admin === 1;

    if (!isOwner && !isAdmin) {
      await conn.rollback();
      return res.status(403).json({ message: 'Nimate dovoljenja' });
    }

    // Pravilo: navadni uporabnik do polnoči dan pred rezervacijo
    if (isOwner && !isAdmin) {
      const now = new Date();
      const rezervacijaDate = new Date(reservation.datum + 'T00:00:00');
      if (now >= rezervacijaDate) {
        await conn.rollback();
        return res.status(403).json({
          message: 'Rezervacijo lahko prekličete le do polnoči dan pred rezervacijo.'
        });
      }
    }

    // ⬇️ MEHKO BRISANJE: namesto DELETE, samo označimo preklicano = 1
    const refund = Number(reservation.krediti_porabili || 0);
    if (refund > 0) await conn.query('UPDATE uporabniki SET krediti = krediti + ? WHERE id=?', [refund, reservation.user_id]);
    await conn.query('UPDATE rezervacije SET preklicano = 1, datum_preklica = NOW() WHERE id=?', [id]);
    await conn.commit();
    res.json({ message: refund ? `Rezervacija preklicana. Vrnjeno: ${refund} kreditov.` : 'Rezervacija preklicana', refundedCredits: refund });
  } catch (err) {
    await conn.rollback();
    console.error('delete reservation', err.message);
    res.status(500).json({ message: 'Napaka pri preklicu rezervacije' });
  } finally {
    conn.release();
  }
});

module.exports = router;