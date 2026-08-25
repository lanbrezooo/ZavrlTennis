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
        req.isAdmin = decoded.admin || false;
        next();
    } catch (error) {
        res.status(401).json({ message: 'Neveljaven token' });
    }
}

// Admin middleware (preveri, ali je admin)
function requireAdmin(req, res, next) {
    if (!req.isAdmin) {
        return res.status(403).json({ message: 'Potrebna so administratorska dovoljenja' });
    }
    next();
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

// Izbriši rezervacijo (lastnik ali admin)
router.delete('/:id', authenticate, async (req, res) => {
    const id = Number(req.params.id);
    if (isNaN(id)) return res.status(400).json({ message: 'Neveljaven ID' });
    try {
        const [reservation] = await pool.query(`SELECT user_id FROM rezervacije WHERE id = ?`, [id]);
        if (reservation.length === 0) return res.status(404).json({ message: 'Rezervacija ne obstaja' });

        if (!req.isAdmin && reservation[0].user_id !== req.userId) {
            return res.status(403).json({ message: 'Nimate dovoljenja za brisanje te rezervacije' });
        }

        await pool.query(`DELETE FROM rezervacije WHERE id = ?`, [id]);
        res.json({ message: 'Rezervacija izbrisana' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Napaka pri brisanju' });
    }
});

// Admin: pridobi vse uporabnike
router.get('/', async (req, res) => {
    const date = req.query.date;
    if (!date) return res.status(400).json({ message: 'Manjka parameter date' });
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

// Admin: izbriši uporabnika
router.delete('/admin/reservations/all', requireAdmin, async (req, res) => {
    try {
        await pool.query(`DELETE FROM rezervacije`);
        res.json({ message: 'Vse rezervacije izbrisane' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Napaka pri brisanju rezervacij' });
    }
});

// Admin: posodobi letno karto, kredite in admin status uporabnika
router.put('/admin/users/:id', authenticate, requireAdmin, async (req, res) => {
    const id = Number(req.params.id);
    if (isNaN(id)) return res.status(400).json({ message: 'Neveljaven ID' });
    const { letna_karta, krediti, admin } = req.body;
    try {
        await pool.query(
            `UPDATE uporabniki SET letna_karta=?, krediti=?, admin=? WHERE id=?`,
            [letna_karta ? 1 : 0, krediti || 0, admin ? 1 : 0, id]
        );
        const [rows] = await pool.query(
            `SELECT id, ime, priimek, email, leto_rojstva, opis, nivo, letna_karta, krediti, telefon, admin FROM uporabniki WHERE id=?`, [id]
        );
        res.json({ user: rows[0] });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Napaka pri posodabljanju uporabnika' });
    }
});

// Admin: izbriši vse rezervacije
router.delete('/admin/reservations/all', authenticate, requireAdmin, async (req, res) => {
    try {
        await pool.query(`DELETE FROM rezervacije`);
        res.json({ message: 'Vse rezervacije izbrisane' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Napaka pri brisanju rezervacij' });
    }
});

function requireAdmin(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) return res.status(401).json({ message: 'Ni avtorizacije' });
    const token = authHeader.split(' ')[1];
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        if (!decoded.admin) return res.status(403).json({ message: 'Potrebna so administratorska dovoljenja' });
        req.userId = decoded.userId;
        next();
    } catch (error) {
        res.status(401).json({ message: 'Neveljaven token' });
    }
}

module.exports = router;