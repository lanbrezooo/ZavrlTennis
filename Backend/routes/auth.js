const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const pool = require('../db');

const JWT_SECRET = process.env.JWT_SECRET || 'tvoja_tajna_beseda';

// Registracija
router.post('/register', async (req, res) => {
    const { ime, priimek, email, geslo, telefon, leto_rojstva, opis, nivo, letna_karta, krediti } = req.body;

    try {
        // Preveri, ali email že obstaja
        const [existing] = await pool.query('SELECT id FROM uporabniki WHERE email = ?', [email]);
        if (existing.length > 0) {
            return res.status(400).json({ message: 'Email že obstaja' });
        }

        // Hashiraj geslo
        const geslo_hash = await bcrypt.hash(geslo, 10);

        // Vstavi uporabnika
        const [result] = await pool.query(
            `INSERT INTO uporabniki (ime, priimek, email, geslo_hash, telefon, leto_rojstva, opis, nivo, letna_karta, krediti) 
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [ime, priimek, email, geslo_hash, telefon || null, leto_rojstva || null, opis || '', nivo || 'Rekreativec', letna_karta ? 1 : 0, krediti || 0]
        );

        const userId = result.insertId;
        const token = jwt.sign({ id: userId }, JWT_SECRET, { expiresIn: '7d' });

        const [user] = await pool.query('SELECT * FROM uporabniki WHERE id = ?', [userId]);
        res.json({ token, user: user[0] });

    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Napaka pri registraciji' });
    }
});

// Prijava
router.post('/login', async (req, res) => {
    const { email, geslo } = req.body;

    try {
        const [users] = await pool.query('SELECT * FROM uporabniki WHERE email = ?', [email]);
        if (users.length === 0) {
            return res.status(401).json({ message: 'Napačen email ali geslo' });
        }

        const user = users[0];
        const valid = await bcrypt.compare(geslo, user.geslo_hash);
        if (!valid) {
            return res.status(401).json({ message: 'Napačen email ali geslo' });
        }

        const token = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: '7d' });
        res.json({ token, user });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Napaka pri prijavi' });
    }
});

// Trenutni uporabnik
router.get('/me', async (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ message: 'Niste prijavljeni' });

    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        const [users] = await pool.query('SELECT * FROM uporabniki WHERE id = ?', [decoded.id]);
        if (users.length === 0) return res.status(404).json({ message: 'Uporabnik ne obstaja' });
        res.json({ user: users[0] });
    } catch (err) {
        return res.status(401).json({ message: 'Neveljaven token' });
    }
});

// Posodobi profil
router.put('/profile', async (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ message: 'Niste prijavljeni' });

    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        const { ime, priimek, email, telefon, leto_rojstva, nivo, opis } = req.body;

        await pool.query(
            `UPDATE uporabniki SET ime = ?, priimek = ?, email = ?, telefon = ?, leto_rojstva = ?, nivo = ?, opis = ? WHERE id = ?`,
            [ime, priimek, email, telefon || null, leto_rojstva || null, nivo, opis, decoded.id]
        );

        const [users] = await pool.query('SELECT * FROM uporabniki WHERE id = ?', [decoded.id]);
        res.json({ user: users[0] });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Napaka pri posodabljanju profila' });
    }
});

module.exports = router;