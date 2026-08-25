const express = require('express');
const jwt = require('jsonwebtoken');
const pool = require('../db');
const router = express.Router();

// Middleware za preverjanje JWT
function authenticate(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ message: 'Ni avtorizacije' });
    }
    const token = authHeader.split(' ')[1];
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        req.userId = decoded.userId;
        next();
    } catch (error) {
        res.status(401).json({ message: 'Neveljaven token' });
    }
}

// Pridobi vse rezervacije za določen datum
router.get('/', async (req, res) => {
    const date = req.query.date;
    if (!date) {
        return res.status(400).json({ message: 'Manjka parameter date' });
    }
    try {
        const [rows] = await pool.query(
            `SELECT r.id, r.igrisce, r.datum, r.ura_zacetka, r.trajanje, r.user_id,
                    u.ime, u.priimek
             FROM rezervacije r
             JOIN uporabniki u ON r.user_id = u.id
             WHERE r.datum = ?
             ORDER BY r.igrisce, r.ura_zacetka`,
            [date]
        );
        res.json({ reservations: rows });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Napaka pri pridobivanju rezervacij' });
    }
});

// Ustvari novo rezervacijo
router.post('/', authenticate, async (req, res) => {
    const { igrisce, datum, ura_zacetka, trajanje } = req.body;
    // Validacija
    if (!igrisce || !datum || !ura_zacetka || !trajanje) {
        return res.status(400).json({ message: 'Manjkajo podatki' });
    }
    const igrisceNum = Number(igrisce);
    const uraNum = Number(ura_zacetka);
    const trajanjeNum = Number(trajanje);
    if (igrisceNum < 1 || igrisceNum > 8) return res.status(400).json({ message: 'Neveljavno igrišče' });
    if (uraNum < 8 || uraNum > 21) return res.status(400).json({ message: 'Neveljavna ura' });
    if (trajanjeNum < 1 || trajanjeNum > 3) return res.status(400).json({ message: 'Neveljavno trajanje' });
    if (uraNum + trajanjeNum > 22) return res.status(400).json({ message: 'Termin presega delovni čas' });

    try {
        const [result] = await pool.query(
            `INSERT INTO rezervacije (user_id, igrisce, datum, ura_zacetka, trajanje)
             VALUES (?, ?, ?, ?, ?)`,
            [req.userId, igrisceNum, datum, uraNum, trajanjeNum]
        );
        res.status(201).json({ id: result.insertId, message: 'Rezervacija ustvarjena' });
    } catch (error) {
        if (error.code === 'ER_DUP_ENTRY') {
            return res.status(409).json({ message: 'Termin je že zaseden' });
        }
        console.error(error);
        res.status(500).json({ message: 'Napaka pri shranjevanju' });
    }
});

// Izbriši rezervacijo (samo lastnik)
router.delete('/:id', authenticate, async (req, res) => {
    const id = Number(req.params.id);
    if (isNaN(id)) return res.status(400).json({ message: 'Neveljaven ID' });
    try {
        const [result] = await pool.query(
            `DELETE FROM rezervacije WHERE id = ? AND user_id = ?`,
            [id, req.userId]
        );
        if (result.affectedRows === 0) {
            return res.status(404).json({ message: 'Rezervacija ne obstaja ali ni vaša' });
        }
        res.json({ message: 'Rezervacija izbrisana' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Napaka pri brisanju' });
    }
});

module.exports = router;