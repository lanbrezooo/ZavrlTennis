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

// Določitev korensek mape projekta in mape Frontend (z veliko začetnico F)
const rootDir = path.join(__dirname, '..');
const frontendPath = path.join(rootDir, 'Frontend');

// Statične datoteke iz mape Frontend
app.use(express.static(frontendPath));

// Začetna stran prikaže Frontend/landing.html
app.get('/', (req, res) => {
    res.sendFile(path.join(frontendPath, 'landing.html'));
});

// Povezavi do sistema rezervacij (Frontend/index.html)
app.get('/app', (req, res) => {
    res.sendFile(path.join(frontendPath, 'index.html'));
});

// Vse ostale neznane zahteve preusmeri na Frontend/landing.html
app.get('*', (req, res) => {
    res.sendFile(path.join(frontendPath, 'landing.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Strežnik teče na portu: ${PORT}`);
    console.log(`Nastavljena pot do frontenda: ${frontendPath}`);
});