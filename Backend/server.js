const express = require('express');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const pool = require('./db');
const authRoutes = require('./routes/auth');
const reservationRoutes = require('./routes/reservations');

const app = express();
app.use(cors());
app.use(express.json());

// API poti
app.use('/api/auth', authRoutes);
app.use('/api/reservations', reservationRoutes);

// ===== ADMIN POTI =====

// Pridobi vse uporabnike (z omejitvijo)
app.get('/api/admin/users', async (req, res) => {
    try {
        const [users] = await pool.query('SELECT * FROM uporabniki ORDER BY id DESC');
        res.json({ users });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Napaka pri pridobivanju uporabnikov' });
    }
});

// Posodobi uporabnika (admin)
app.put('/api/admin/users/:id', async (req, res) => {
    const { ime, priimek, email, telefon, leto_rojstva, opis, nivo, letna_karta, krediti, admin } = req.body;
    try {
        await pool.query(
            `UPDATE uporabniki 
             SET ime = ?, priimek = ?, email = ?, telefon = ?, leto_rojstva = ?, opis = ?, nivo = ?, letna_karta = ?, krediti = ?, admin = ? 
             WHERE id = ?`,
            [ime, priimek, email, telefon || null, leto_rojstva || null, opis || '', nivo || 'Rekreativec', letna_karta ? 1 : 0, krediti || 0, admin ? 1 : 0, req.params.id]
        );
        res.json({ message: 'Uporabnik posodobljen' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Napaka pri posodabljanju uporabnika' });
    }
});

// Izbriši uporabnika
app.delete('/api/admin/users/:id', async (req, res) => {
    try {
        await pool.query('DELETE FROM uporabniki WHERE id = ?', [req.params.id]);
        res.json({ message: 'Uporabnik izbrisan' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Napaka pri brisanju uporabnika' });
    }
});

// Pridobi vse rezervacije (admin)
app.get('/api/admin/reservations', async (req, res) => {
    try {
        const [reservations] = await pool.query(
            `SELECT r.*, u.ime, u.priimek 
             FROM rezervacije r 
             JOIN uporabniki u ON r.user_id = u.id 
             ORDER BY r.datum DESC, r.ura_zacetka ASC`
        );
        res.json({ reservations });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Napaka pri pridobivanju rezervacij' });
    }
});

// Izbriši posamezno rezervacijo (admin)
app.delete('/api/admin/reservations/:id', async (req, res) => {
    try {
        await pool.query('DELETE FROM rezervacije WHERE id = ?', [req.params.id]);
        res.json({ message: 'Rezervacija izbrisana' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Napaka pri brisanju rezervacije' });
    }
});

// Izbriši vse rezervacije
app.delete('/api/admin/reservations', async (req, res) => {
    try {
        await pool.query('DELETE FROM rezervacije');
        res.json({ message: 'Vse rezervacije izbrisane' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Napaka pri brisanju rezervacij' });
    }
});

// ===== STATIČNE DATOTEKE =====
const rootDir = path.join(__dirname, '..');
const frontendPath = path.join(rootDir, 'Frontend');
app.use(express.static(frontendPath));

app.get('/', (req, res) => res.sendFile(path.join(frontendPath, 'landing.html')));
app.get('/app', (req, res) => res.sendFile(path.join(frontendPath, 'index.html')));

// Neznane API poti – JSON napaka
app.use('/api', (req, res) => res.status(404).json({ message: 'API pot ne obstaja' }));

// Vse ostale – landing.html
app.get('*', (req, res) => res.sendFile(path.join(frontendPath, 'landing.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Strežnik teče na portu: ${PORT}`);
    console.log('Povezan na MySQL bazo');
});