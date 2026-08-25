const express = require('express');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const pool = require('./db'); // MySQL povezava
const authRoutes = require('./routes/auth');
const reservationRoutes = require('./routes/reservations');

const app = express();
app.use(cors());
app.use(express.json());

// API poti
app.use('/api/auth', authRoutes);
app.use('/api/reservations', reservationRoutes);

// Admin poti (z MySQL)
app.get('/api/admin/users', async (req, res) => {
    try {
        const [users] = await pool.query('SELECT * FROM uporabniki');
        res.json({ users });
    } catch (err) {
        res.status(500).json({ message: 'Napaka pri pridobivanju uporabnikov' });
    }
});

app.delete('/api/admin/users/:id', async (req, res) => {
    try {
        await pool.query('DELETE FROM uporabniki WHERE id = ?', [req.params.id]);
        res.json({ message: 'Uporabnik izbrisan' });
    } catch (err) {
        res.status(500).json({ message: 'Napaka pri brisanju uporabnika' });
    }
});

app.delete('/api/admin/reservations', async (req, res) => {
    try {
        await pool.query('DELETE FROM rezervacije');
        res.json({ message: 'Vse rezervacije izbrisane' });
    } catch (err) {
        res.status(500).json({ message: 'Napaka pri brisanju rezervacij' });
    }
});

// Statične datoteke iz mape Frontend
const rootDir = path.join(__dirname, '..');
const frontendPath = path.join(rootDir, 'Frontend');
app.use(express.static(frontendPath));

// Začetna stran
app.get('/', (req, res) => {
    res.sendFile(path.join(frontendPath, 'landing.html'));
});

app.get('/app', (req, res) => {
    res.sendFile(path.join(frontendPath, 'index.html'));
});

// Neznane API poti – vrnemo JSON napako
app.use('/api', (req, res) => {
    res.status(404).json({ message: 'API pot ne obstaja' });
});

// Vse ostale neznane zahteve preusmeri na landing.html
app.get('*', (req, res) => {
    res.sendFile(path.join(frontendPath, 'landing.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Strežnik teče na portu: ${PORT}`);
    console.log(`Povezan na MySQL bazo`);
});