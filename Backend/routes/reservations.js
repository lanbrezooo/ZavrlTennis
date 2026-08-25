const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const pool = require('../db');

const JWT_SECRET = process.env.JWT_SECRET || 'tvoja_tajna_beseda';

// Pridobi rezervacije po datumu
router.get('/', async (req, res) => {
    const date = req.query.date;
    try {
        const [reservations] = await pool.query(
            `SELECT r.*, u.ime, u.priimek 
             FROM rezervacije r 
             JOIN uporabniki u ON r.user_id = u.id 
             WHERE r.datum = ?`,
            [date]
        );
        res.json({ reservations });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Napaka pri pridobivanju rezervacij' });
    }
});

// Ustvari novo rezervacijo
router.post('/', async (req, res) => {
    const { igrisce, datum, ura_zacetka, trajanje } = req.body;
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ message: 'Niste prijavljeni' });

    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        const userId = decoded.id;

        // Preveri, ali termin že obstaja (konflikt)
        const [conflicts] = await pool.query(
            `SELECT * FROM rezervacije 
             WHERE igrisce = ? AND datum = ? 
             AND ura_zacetka < ? AND ura_zacetka + trajanje > ?`,
            [igrisce, datum, ura_zacetka + trajanje, ura_zacetka]
        );

        if (conflicts.length > 0) {
            return res.status(400).json({ message: 'Termin je že zaseden' });
        }

        const [result] = await pool.query(
            `INSERT INTO rezervacije (user_id, igrisce, datum, ura_zacetka, trajanje) 
             VALUES (?, ?, ?, ?, ?)`,
            [userId, igrisce, datum, ura_zacetka, trajanje]
        );

        const [reservation] = await pool.query('SELECT * FROM rezervacije WHERE id = ?', [result.insertId]);
        res.json({ reservation: reservation[0] });

    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Napaka pri ustvarjanju rezervacije' });
    }
});

// Izbriši rezervacijo
router.delete('/:id', async (req, res) => {
    const id = parseInt(req.params.id);
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ message: 'Niste prijavljeni' });

    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        const userId = decoded.id;

        // Preveri lastništvo ali admin pravice
        const [userRows] = await pool.query('SELECT admin FROM uporabniki WHERE id = ?', [userId]);
        const isAdmin = userRows[0]?.admin === 1;

        const [reservationRows] = await pool.query('SELECT * FROM rezervacije WHERE id = ?', [id]);
        if (reservationRows.length === 0) {
            return res.status(404).json({ message: 'Rezervacija ne obstaja' });
        }

        if (reservationRows[0].user_id !== userId && !isAdmin) {
            return res.status(403).json({ message: 'Nimate dovoljenja' });
        }

        await pool.query('DELETE FROM rezervacije WHERE id = ?', [id]);
        res.json({ message: 'Rezervacija izbrisana' });

    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Napaka pri brisanju rezervacije' });
    }
});

module.exports = router;