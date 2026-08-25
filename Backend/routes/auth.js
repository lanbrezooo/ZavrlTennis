const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const pool = require('../db');
const router = express.Router();

// Registracija
router.post('/register', async (req, res) => {
    const { ime, priimek, email, geslo, leto_rojstva, opis, nivo, letna_karta, krediti, telefon } = req.body;
    if (!ime || !priimek || !email || !geslo) {
        return res.status(400).json({ message: 'Manjkajo obvezna polja' });
    }
    try {
        const hashedPassword = await bcrypt.hash(geslo, 10);
        const [result] = await pool.query(
            `INSERT INTO uporabniki 
            (ime, priimek, email, geslo_hash, leto_rojstva, opis, nivo, letna_karta, krediti, telefon)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [ime, priimek, email, hashedPassword, leto_rojstva || null, opis || null, nivo || 'Rekreativec', letna_karta ? 1 : 0, krediti || 0, telefon || null]
        );
        const user = {
            id: result.insertId,
            ime,
            priimek,
            email,
            leto_rojstva: leto_rojstva || null,
            opis: opis || null,
            nivo: nivo || 'Rekreativec',
            letna_karta: letna_karta ? 1 : 0,
            krediti: krediti || 0,
            telefon: telefon || null,
            admin: false
        };
        const token = jwt.sign({ userId: result.insertId, admin: false }, process.env.JWT_SECRET, { expiresIn: '7d' });
        res.status(201).json({ token, user });
    } catch (error) {
        if (error.code === 'ER_DUP_ENTRY') {
            return res.status(400).json({ message: 'Email že obstaja' });
        }
        console.error(error);
        res.status(500).json({ message: 'Napaka na strežniku' });
    }
});

// Prijava
router.post('/login', async (req, res) => {
    const { email, geslo } = req.body;
    if (!email || !geslo) {
        return res.status(400).json({ message: 'Manjkata email ali geslo' });
    }
    try {
        const [rows] = await pool.query(`SELECT * FROM uporabniki WHERE email = ?`, [email]);
        if (rows.length === 0) return res.status(401).json({ message: 'Napačen email ali geslo' });
        const user = rows[0];
        const match = await bcrypt.compare(geslo, user.geslo_hash);
        if (!match) return res.status(401).json({ message: 'Napačen email ali geslo' });

        const token = jwt.sign({ userId: user.id, admin: user.admin }, process.env.JWT_SECRET, { expiresIn: '7d' });
        const userSafe = {
            id: user.id,
            ime: user.ime,
            priimek: user.priimek,
            email: user.email,
            leto_rojstva: user.leto_rojstva,
            opis: user.opis,
            nivo: user.nivo,
            letna_karta: user.letna_karta,
            krediti: user.krediti,
            telefon: user.telefon,
            admin: user.admin
        };
        res.json({ token, user: userSafe });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Napaka na strežniku' });
    }
});

// Trenutni uporabnik
router.get('/me', async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ message: 'Ni avtorizacije' });
    }
    const token = authHeader.split(' ')[1];
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const [rows] = await pool.query(
            `SELECT id, ime, priimek, email, leto_rojstva, opis, nivo, letna_karta, krediti, telefon, admin 
             FROM uporabniki WHERE id = ?`,
            [decoded.userId]
        );
        if (rows.length === 0) return res.status(404).json({ message: 'Uporabnik ne obstaja' });
        res.json({ user: rows[0] });
    } catch (error) {
        res.status(401).json({ message: 'Neveljaven ali potekel token' });
    }
});

// Posodobitev lastnega profila (brez letne karte in kreditov)
router.put('/profile', async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ message: 'Ni avtorizacije' });
    }
    const token = authHeader.split(' ')[1];
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const { ime, priimek, email, leto_rojstva, opis, nivo, telefon } = req.body;
        await pool.query(
            `UPDATE uporabniki SET ime=?, priimek=?, email=?, leto_rojstva=?, opis=?, nivo=?, telefon=? WHERE id=?`,
            [ime, priimek, email, leto_rojstva || null, opis || null, nivo || 'Rekreativec', telefon || null, decoded.userId]
        );
        const [rows] = await pool.query(`SELECT id, ime, priimek, email, leto_rojstva, opis, nivo, letna_karta, krediti, telefon, admin FROM uporabniki WHERE id=?`, [decoded.userId]);
        res.json({ user: rows[0] });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Napaka pri posodabljanju profila' });
    }
});

module.exports = router;