const express = require('express');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const authRoutes = require('./routes/auth');
const reservationRoutes = require('./routes/reservations');

const app = express();

app.use(cors());
app.use(express.json());

// API poti
app.use('/api/auth', authRoutes);
app.use('/api/reservations', reservationRoutes);

// Statične datoteke iz mape frontend
app.use(express.static(path.join(__dirname, '../frontend')));

// Ob obisku domene / se odpre landing.html
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '../frontend/landing.html'));
});

// Povezava za sistem rezervacij
app.get('/index.html', (req, res) => {
    res.sendFile(path.join(__dirname, '../frontend/index.html'));
});
app.get('/app', (req, res) => {
    res.sendFile(path.join(__dirname, '../frontend/index.html'));
});

// Vse ostale poti preusmeri na landing.html
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '../frontend/landing.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Strežnik teče na http://localhost:${PORT}`);
});