const express = require('express');
const pool = require('../db');
const { requireAuth } = require('../middleware');
const {
  getEndHour,
  validateReservation,
  calculateCredits
} = require('./reservationRules');
const {
  withReservationLock,
  reservationLockName
} = require('./reservationLock');

const router = express.Router();

router.get('/', async (req, res) => {
  const date = String(req.query.date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ message: 'Neveljaven datum' });
  }

  try {
    await pool.query(
      `UPDATE rezervacije
       SET preklicano = 1, placilo_status = 'preklicano', hold_expires_at = NULL
       WHERE placilo_status = 'pending'
         AND hold_expires_at < NOW()
         AND preklicano = 0`
    );

    const [rows] = await pool.query(
      `SELECT r.id, r.user_id, r.igrisce,
              DATE_FORMAT(r.datum, '%Y-%m-%d') AS datum,
              r.ura_zacetka, r.trajanje, r.oznaka, r.blokada,
              u.ime, u.priimek, u.prikazi_telefon
       FROM rezervacije r
       JOIN uporabniki u ON u.id = r.user_id
       WHERE r.datum = ?
         AND r.preklicano = 0
         AND (r.placilo_status IS NULL OR r.placilo_status IN ('pending','placano'))
         AND (r.hold_expires_at IS NULL OR r.hold_expires_at > NOW())
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
  const oznaka = req.body.oznaka
    ? String(req.body.oznaka).trim().slice(0, 100)
    : null;

  const endHour = await getEndHour();
  const validationError = validateReservation({
    igrisce,
    ura,
    trajanje,
    datum,
    endHour,
    isAdmin: !!req.user.admin
  });

  if (validationError) {
    return res.status(400).json({ message: validationError });
  }

  const finalOznaka = req.user.admin ? oznaka : null;
  const lockName = reservationLockName(igrisce, datum);

  try {
    const result = await withReservationLock(lockName, async (conn) => {
      await conn.beginTransaction();

      await conn.query(
        `UPDATE rezervacije
         SET preklicano = 1, placilo_status = 'preklicano', hold_expires_at = NULL
         WHERE placilo_status = 'pending'
           AND hold_expires_at < NOW()
           AND preklicano = 0`
      );

      const [users] = await conn.query(
        'SELECT id, krediti, letna_karta FROM uporabniki WHERE id=? FOR UPDATE',
        [req.user.id]
      );

      if (!users.length) {
        const err = new Error('Uporabnik ne obstaja');
        err.status = 401;
        throw err;
      }

      const user = users[0];

      if (useAnnualCard && !user.letna_karta) {
        const err = new Error('Sezonska karta za vaš račun ni aktivna');
        err.status = 403;
        throw err;
      }

      const [conflicts] = await conn.query(
        `SELECT id FROM rezervacije
         WHERE igrisce = ?
           AND datum = ?
           AND ura_zacetka < ?
           AND ura_zacetka + trajanje > ?
           AND preklicano = 0
           AND (placilo_status IS NULL OR placilo_status IN ('pending','placano'))
           AND (hold_expires_at IS NULL OR hold_expires_at > NOW())
         FOR UPDATE`,
        [igrisce, datum, ura + trajanje, ura]
      );

      if (conflicts.length) {
        const err = new Error('Termin je že zaseden');
        err.status = 409;
        throw err;
      }

      const [sezRows] = await conn.query(
        'SELECT vrednost FROM nastavitve WHERE kljuc = "sezona"'
      );
      const sezona = sezRows.length ? sezRows[0].vrednost : 'poletje';

      if (
        useAnnualCard &&
        String(sezona).toLowerCase().trim() === 'zima' &&
        !req.user.admin
      ) {
        const err = new Error('V zimski sezoni sezonska karta ni na voljo!');
        err.status = 403;
        throw err;
      }

      const creditsRequired = useAnnualCard
        ? 0
        : calculateCredits(ura, trajanje, igrisce, sezona);

      if (!useAnnualCard && Number(user.krediti) < creditsRequired) {
        const err = new Error(
          `Nimate dovolj kreditov. Potrebujete ${creditsRequired}, na voljo imate ${user.krediti}.`
        );
        err.status = 400;
        throw err;
      }

      const [ins] = await conn.query(
        `INSERT INTO rezervacije
         (user_id, igrisce, datum, ura_zacetka, trajanje,
          krediti_porabili, letna_karta_uporabljena, oznaka, placilo_status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'placano')`,
        [
          req.user.id,
          igrisce,
          datum,
          ura,
          trajanje,
          creditsRequired,
          useAnnualCard ? 1 : 0,
          finalOznaka
        ]
      );

      if (creditsRequired > 0) {
        await conn.query(
          'UPDATE uporabniki SET krediti = krediti - ? WHERE id=?',
          [creditsRequired, req.user.id]
        );
      }

      const remainingCredits = Number(user.krediti) - creditsRequired;
      await conn.commit();

      return {
        reservation: {
          id: ins.insertId,
          user_id: req.user.id,
          igrisce,
          datum,
          ura_zacetka: ura,
          trajanje,
          krediti_porabili: creditsRequired,
          letna_karta_uporabljena: useAnnualCard ? 1 : 0,
          oznaka: finalOznaka
        },
        creditsCharged: creditsRequired,
        remainingCredits
      };
    });

    res.status(201).json(result);
  } catch (err) {
    console.error('create reservation', err.message);
    res.status(err.status || 500).json({
      message: err.message || 'Napaka pri ustvarjanju rezervacije'
    });
  }
});

router.delete('/:id', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ message: 'Neveljaven ID' });
  }

  const conn = await pool.getConnection();

  try {
    await conn.beginTransaction();

    const [rows] = await conn.query(
      'SELECT * FROM rezervacije WHERE id=? AND preklicano = 0 FOR UPDATE',
      [id]
    );

    if (!rows.length) {
      await conn.rollback();
      return res.status(404).json({ message: 'Rezervacija ne obstaja' });
    }

    const reservation = rows[0];
    const isOwner = reservation.user_id === req.user.id;
    const isAdmin = req.user.admin === 1;

    if (!isOwner && !isAdmin) {
      await conn.rollback();
      return res.status(403).json({ message: 'Nimate dovoljenja' });
    }

    if (isOwner && !isAdmin) {
      const now = new Date();
      const rezervacijaDate = new Date(reservation.datum + 'T00:00:00');

      if (now >= rezervacijaDate) {
        await conn.rollback();
        return res.status(403).json({
          message:
            'Rezervacijo lahko prekličete le do polnoči dan pred rezervacijo.'
        });
      }
    }

    const refund = Number(reservation.krediti_porabili || 0);

    if (refund > 0) {
      await conn.query(
        'UPDATE uporabniki SET krediti = krediti + ? WHERE id=?',
        [refund, reservation.user_id]
      );
    }

    await conn.query(
      `UPDATE rezervacije
       SET preklicano = 1,
           datum_preklica = NOW(),
           placilo_status = 'preklicano',
           hold_expires_at = NULL
       WHERE id=?`,
      [id]
    );

    await conn.commit();

    res.json({
      message: refund
        ? `Rezervacija preklicana. Vrnjeno: ${refund} kreditov.`
        : 'Rezervacija preklicana',
      refundedCredits: refund
    });
  } catch (err) {
    await conn.rollback();
    console.error('delete reservation', err.message);
    res.status(500).json({ message: 'Napaka pri preklicu rezervacije' });
  } finally {
    conn.release();
  }
});

module.exports = router;