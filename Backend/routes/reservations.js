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
        req.userAdmin = decoded.admin; // shranimo admin status
        next();
    } catch (error) {
        res.status(401).json({ message: 'Neveljaven token' });
    }
}

// Middleware za admina
function requireAdmin(req, res, next) {
    if (!req.userAdmin) {
        return res.status(403).json({ message: 'Potrebna so administratorska dovoljenja' });
    }
    next();
}

// ... ostale poti (GET /, POST /, DELETE /:id) ...

// ================= ADMIN POTI =================

// Pridobi vse uporabnike
router.get('/admin/users', authenticate, requireAdmin, async (req, res) => {
    try {
        const [rows] = await pool.query(
            `SELECT id, ime, priimek, email, leto_rojstva, opis, nivo, letna_karta, krediti, telefon, admin 
             FROM uporabniki ORDER BY priimek, ime`
        );
        res.json({ users: rows });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Napaka pri pridobivanju uporabnikov' });
    }
});

// Izbriši uporabnika
router.delete('/admin/users/:id', authenticate, requireAdmin, async (req, res) => {
    const id = Number(req.params.id);
    if (isNaN(id)) return res.status(400).json({ message: 'Neveljaven ID' });
    try {
        await pool.query(`DELETE FROM uporabniki WHERE id = ?`, [id]);
        res.json({ message: 'Uporabnik izbrisan' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Napaka pri brisanju uporabnika' });
    }
});

// Posodobi letno karto, kredite in admin status
router.put('/admin/users/:id', authenticate, requireAdmin, async (req, res) => {
    const id = Number(req.params.id);
    const { letna_karta, krediti, admin } = req.body;
    if (isNaN(id)) return res.status(400).json({ message: 'Neveljaven ID' });
    try {
        await pool.query(
            `UPDATE uporabniki SET letna_karta=?, krediti=?, admin=? WHERE id=?`,
            [letna_karta ? 1 : 0, krediti || 0, admin ? 1 : 0, id]
        );
        const [rows] = await pool.query(
            `SELECT id, ime, priimek, email, leto_rojstva, opis, nivo, letna_karta, krediti, telefon, admin FROM uporabniki WHERE id=?`,
            [id]
        );
        res.json({ user: rows[0] });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Napaka pri posodabljanju uporabnika' });
    }
});

// Izbriši vse rezervacije
router.delete('/admin/reservations/all', authenticate, requireAdmin, async (req, res) => {
    try {
        await pool.query(`DELETE FROM rezervacije`);
        res.json({ message: 'Vse rezervacije izbrisane' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Napaka pri brisanju rezervacij' });
    }
});

module.exports = router;