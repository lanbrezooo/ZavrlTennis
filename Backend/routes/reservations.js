const express = require('express');
const pool = require('../db');
const { requireAuth } = require('../middleware');
const router = express.Router();

const START_HOUR = 8;
const MORNING_END_HOUR = 12;
const END_HOUR = 22;
const COURTS = 8;
const MAX_DAYS = 14;
const MORNING_CREDITS_PER_HOUR = 1;   // 08:00–12:00
const AFTERNOON_CREDITS_PER_HOUR = 2; // 12:00–22:00 (UI displays 12:00–21:00 start times)

function validDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value || '') && !Number.isNaN(new Date(`${value}T00:00:00`).getTime());
}
function withinWindow(date) {
  const d = new Date(`${date}T00:00:00`), now = new Date();
  now.setHours(0,0,0,0);
  const max = new Date(now); max.setDate(max.getDate() + MAX_DAYS);
  return d >= now && d <= max;
}
function calculateCredits(startHour, duration) {
  let total = 0;
  for (let hour = startHour; hour < startHour + duration; hour++) {
    total += hour < MORNING_END_HOUR ? MORNING_CREDITS_PER_HOUR : AFTERNOON_CREDITS_PER_HOUR;
  }
  return total;
}

router.get('/', async (req, res) => {
  const date = String(req.query.date || '');
  if (!validDate(date)) return res.status(400).json({ message: 'Neveljaven datum' });
  try {
    const [rows] = await pool.query('SELECT id, user_id, igrisce, datum, ura_zacetka, trajanje FROM rezervacije WHERE datum = ? ORDER BY igrisce, ura_zacetka', [date]);
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

  if (!Number.isInteger(igrisce) || igrisce < 1 || igrisce > COURTS ||
      !validDate(datum) || !withinWindow(datum) ||
      !Number.isInteger(ura) || !Number.isInteger(trajanje) ||
      ura < START_HOUR || ura >= END_HOUR || trajanje < 1 || trajanje > 3 ||
      ura + trajanje > END_HOUR) {
    return res.status(400).json({ message: 'Neveljaven termin rezervacije' });
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // Zaklenemo uporabnika, da se krediti pri hkratnih zahtevkih ne porabijo dvakrat.
    const [users] = await conn.query(
      'SELECT id, krediti, letna_karta FROM uporabniki WHERE id=? FOR UPDATE',
      [req.user.id]
    );
    if (!users.length) {
      await conn.rollback();
      return res.status(401).json({ message: 'Uporabnik ne obstaja' });
    }
    const user = users[0];
    if (useAnnualCard && !user.letna_karta) {
      await conn.rollback();
      return res.status(403).json({ message: 'Letna karta za vaš račun ni aktivna' });
    }

    const [conflicts] = await conn.query(
      `SELECT id FROM rezervacije
       WHERE igrisce=? AND datum=? AND ura_zacetka < ? AND ura_zacetka + trajanje > ?
       FOR UPDATE`,
      [igrisce, datum, ura + trajanje, ura]
    );
    if (conflicts.length) {
      await conn.rollback();
      return res.status(409).json({ message: 'Termin je že zaseden' });
    }

    const creditsRequired = useAnnualCard ? 0 : calculateCredits(ura, trajanje);
    if (!useAnnualCard && Number(user.krediti) < creditsRequired) {
      await conn.rollback();
      return res.status(409).json({
        message: `Za to rezervacijo potrebujete ${creditsRequired} kredit${creditsRequired === 1 ? '' : 'ov'}. Na voljo imate ${user.krediti}.`,
        requiredCredits: creditsRequired,
        availableCredits: Number(user.krediti)
      });
    }

    const [result] = await conn.query(
      `INSERT INTO rezervacije
       (user_id, igrisce, datum, ura_zacetka, trajanje, krediti_porabili, letna_karta_uporabljena)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [req.user.id, igrisce, datum, ura, trajanje, creditsRequired, useAnnualCard ? 1 : 0]
    );

    if (creditsRequired > 0) {
      await conn.query('UPDATE uporabniki SET krediti = krediti - ? WHERE id=?', [creditsRequired, req.user.id]);
    }
    const remainingCredits = Number(user.krediti) - creditsRequired;

    await conn.commit();
    res.status(201).json({
      reservation: {
        id: result.insertId, user_id: req.user.id, igrisce, datum,
        ura_zacetka: ura, trajanje,
        krediti_porabili: creditsRequired,
        letna_karta_uporabljena: useAnnualCard ? 1 : 0
      },
      creditsCharged: creditsRequired,
      remainingCredits
    });
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
    const [rows] = await conn.query('SELECT * FROM rezervacije WHERE id=? FOR UPDATE', [id]);
    if (!rows.length) {
      await conn.rollback();
      return res.status(404).json({ message: 'Rezervacija ne obstaja' });
    }
    const reservation = rows[0];
    if (reservation.user_id !== req.user.id && !req.user.admin) {
      await conn.rollback();
      return res.status(403).json({ message: 'Nimate dovoljenja' });
    }
    const refund = Number(reservation.krediti_porabili || 0);
    if (refund > 0) await conn.query('UPDATE uporabniki SET krediti = krediti + ? WHERE id=?', [refund, reservation.user_id]);
    await conn.query('DELETE FROM rezervacije WHERE id=?', [id]);
    await conn.commit();
    res.json({ message: refund ? `Rezervacija izbrisana. Vrnjeno: ${refund} kreditov.` : 'Rezervacija izbrisana', refundedCredits: refund });
  } catch (err) {
    await conn.rollback();
    console.error('delete reservation', err.message);
    res.status(500).json({ message: 'Napaka pri brisanju rezervacije' });
  } finally {
    conn.release();
  }
});

module.exports = router;
