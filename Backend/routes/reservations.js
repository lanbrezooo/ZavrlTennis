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

// Pridobi rezervacije po datumu
router.get('/', (req, res) => {
    const date = req.query.date;
    const db = getDB();
    const reservations = db.reservations.filter(r => r.datum === date);
    // Dodamo ime in priimek uporabnika
    const enriched = reservations.map(r => {
        const user = db.users.find(u => u.id === r.user_id);
        return { ...r, ime: user?.ime, priimek: user?.priimek };
    });
    res.json({ reservations: enriched });
});

// Ustvari novo rezervacijo
router.post('/', (req, res) => {
    const { igrisce, datum, ura_zacetka, trajanje } = req.body;
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ message: 'Niste prijavljeni' });
    const userId = parseInt(Buffer.from(token, 'base64').toString());
    const db = getDB();

    // Preveri ali je termin prost
    const conflict = db.reservations.some(r =>
        r.igrisce === igrisce &&
        r.datum === datum &&
        r.ura_zacetka < ura_zacetka + trajanje &&
        r.ura_zacetka + r.trajanje > ura_zacetka
    );
    if (conflict) {
        return res.status(400).json({ message: 'Termin je že zaseden' });
    }

    const newReservation = {
        id: Date.now(),
        igrisce,
        datum,
        ura_zacetka,
        trajanje,
        user_id: userId
    };
    db.reservations.push(newReservation);
    saveDB(db);
    res.json({ reservation: newReservation });
});

// Izbriši rezervacijo
router.delete('/:id', (req, res) => {
    const id = parseInt(req.params.id);
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ message: 'Niste prijavljeni' });
    const userId = parseInt(Buffer.from(token, 'base64').toString());
    const db = getDB();
    const reservation = db.reservations.find(r => r.id === id);

    if (!reservation) return res.status(404).json({ message: 'Rezervacija ne obstaja' });
    if (reservation.user_id !== userId && !db.users.find(u => u.id === userId)?.admin) {
        return res.status(403).json({ message: 'Nimate dovoljenja' });
    }

    db.reservations = db.reservations.filter(r => r.id !== id);
    saveDB(db);
    res.json({ message: 'Rezervacija izbrisana' });
});

module.exports = router;