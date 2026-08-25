const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');

const DB_FILE = path.join(__dirname, '..', 'db.json');

function getDB() {
    return JSON.parse(fs.readFileSync(DB_FILE));
}

function saveDB(db) {
    fs.writeFileSync(DB_FILE, JSON.stringify(db));
}

// Registracija
router.post('/register', (req, res) => {
    const { ime, priimek, email, geslo, telefon, leto_rojstva, opis, nivo, letna_karta, krediti } = req.body;
    const db = getDB();
    if (db.users.find(u => u.email === email)) {
        return res.status(400).json({ message: 'Email že obstaja' });
    }
    const newUser = {
        id: Date.now(),
        ime, priimek, email, geslo,
        telefon: telefon || null,
        leto_rojstva: leto_rojstva || null,
        opis: opis || '',
        nivo: nivo || 'Rekreativec',
        letna_karta: letna_karta ? 1 : 0,
        krediti: krediti || 0,
        admin: false
    };
    db.users.push(newUser);
    saveDB(db);
    res.json({ token: Buffer.from(String(newUser.id)).toString('base64'), user: newUser });
});

// Prijava
router.post('/login', (req, res) => {
    const { email, geslo } = req.body;
    const db = getDB();
    const user = db.users.find(u => u.email === email && u.geslo === geslo);
    if (!user) {
        return res.status(401).json({ message: 'Napačen email ali geslo' });
    }
    res.json({ token: Buffer.from(String(user.id)).toString('base64'), user });
});

// Trenutni uporabnik
router.get('/me', (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ message: 'Niste prijavljeni' });
    const userId = parseInt(Buffer.from(token, 'base64').toString());
    const db = getDB();
    const user = db.users.find(u => u.id === userId);
    if (!user) return res.status(404).json({ message: 'Uporabnik ne obstaja' });
    res.json({ user });
});

// Posodobi profil
router.put('/profile', (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ message: 'Niste prijavljeni' });
    const userId = parseInt(Buffer.from(token, 'base64').toString());
    const db = getDB();
    const user = db.users.find(u => u.id === userId);
    if (!user) return res.status(404).json({ message: 'Uporabnik ne obstaja' });

    const { ime, priimek, email, telefon, leto_rojstva, nivo, opis } = req.body;
    user.ime = ime || user.ime;
    user.priimek = priimek || user.priimek;
    user.email = email || user.email;
    user.telefon = telefon || user.telefon;
    user.leto_rojstva = leto_rojstva || user.leto_rojstva;
    user.nivo = nivo || user.nivo;
    user.opis = opis || user.opis;

    saveDB(db);
    res.json({ user });
});

module.exports = router;