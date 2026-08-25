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

// API poti
app.use('/api/auth', authRoutes);
app.use('/api/reservations', reservationRoutes);

// Poišči korensko mapo projekta (ZAVRLTENNIS) ne glede na to, kje teče Node process
const rootDir = __dirname.endsWith('Backend') || __dirname.endsWith('backend')
    ? path.join(__dirname, '..')
    : __dirname;

const frontendPath = path.join(rootDir, 'frontend');

// Statične datoteke iz mape frontend
app.use(express.static(frontendPath));

// Ob obisku domene / prikaži landing.html
app.get('/', (req, res) => {
    res.sendFile(path.join(frontendPath, 'landing.html'));
});

// Povezavi do koledarja (index.html)
app.get('/index.html', (req, res) => {
    res.sendFile(path.join(frontendPath, 'index.html'));
});

app.get('/app', (req, res) => {
    res.sendFile(path.join(frontendPath, 'index.html'));
});

// Vse ostale zahtevke preusmeri na landing.html
app.get('*', (req, res) => {
    res.sendFile(path.join(frontendPath, 'landing.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Strežnik teče na portu ${PORT}`);
    console.log(`Pravilna pot do frontenda: ${frontendPath}`);
});