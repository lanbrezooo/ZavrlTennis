const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const authRoutes = require('./routes/auth');
const reservationRoutes = require('./routes/reservations');

const app = express();
app.use(cors());
app.use(express.json());

// Inicializacija db.json
const DB_FILE = path.join(__dirname, 'db.json');
if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify({ users: [], reservations: [] }));
}

// API poti
app.use('/api/auth', authRoutes);
app.use('/api/reservations', reservationRoutes);

// Admin poti (dodane)
app.get('/api/admin/users', (req, res) => {
    const db = JSON.parse(fs.readFileSync(DB_FILE));
    res.json({ users: db.users });
});

app.delete('/api/admin/users/:id', (req, res) => {
    const db = JSON.parse(fs.readFileSync(DB_FILE));
    db.users = db.users.filter(u => u.id !== parseInt(req.params.id));
    fs.writeFileSync(DB_FILE, JSON.stringify(db));
    res.json({ message: 'Uporabnik izbrisan' });
});

app.delete('/api/admin/reservations', (req, res) => {
    const db = JSON.parse(fs.readFileSync(DB_FILE));
    db.reservations = [];
    fs.writeFileSync(DB_FILE, JSON.stringify(db));
    res.json({ message: 'Vse rezervacije izbrisane' });
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

// Neznane API poti – vrnemo JSON napako (ne HTML)
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
    console.log(`Nastavljena pot do frontenda: ${frontendPath}`);
});