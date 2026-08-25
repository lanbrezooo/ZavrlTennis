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

// Dinamična določitev prave poti do mape frontend
let frontendPath = path.join(__dirname, '../frontend');
if (!fs.existsSync(frontendPath)) {
    frontendPath = path.join(__dirname, 'frontend');
}
if (!fs.existsSync(frontendPath)) {
    frontendPath = path.join(process.cwd(), 'frontend');
}

// Statične datoteke
app.use(express.static(frontendPath));

// Ob obisku domene prikaži landing.html
app.get('/', (req, res) => {
    res.sendFile(path.join(frontendPath, 'landing.html'));
});

// Povezavi do koledarja
app.get('/index.html', (req, res) => {
    res.sendFile(path.join(frontendPath, 'index.html'));
});
app.get('/app', (req, res) => {
    res.sendFile(path.join(frontendPath, 'index.html'));
});

// Vse ostale neznane GET zahteve preusmeri na landing.html
app.get('*', (req, res) => {
    res.sendFile(path.join(frontendPath, 'landing.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Strežnik teče na http://localhost:${PORT}`);
    console.log(`Uporabljena pot do frontenda: ${frontendPath}`);
});