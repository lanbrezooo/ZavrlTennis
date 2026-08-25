const express = require('express');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const authRoutes = require('./routes/auth');
const reservationRoutes = require('./routes/reservations');

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// API poti
app.use('/api/auth', authRoutes);
app.use('/api/reservations', reservationRoutes);

// Statične datoteke (frontend) – velika začetnica Frontend
app.use(express.static(path.join(__dirname, '../Frontend')));

// Za vse ostale GET zahteve vrni index.html (za SPA)
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '../Frontend/index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Strežnik teče na http://localhost:${PORT}`);
});