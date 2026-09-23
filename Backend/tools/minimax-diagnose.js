// Backend/tools/minimax-diagnose.js
require('dotenv').config();
const axios = require('axios');

const MINIMAX_API_URL = 'https://moj.minimax.si/SI/API/api';
const MINIMAX_AUTH_URL = 'https://moj.minimax.si/si/aut/oauth20/token';
const ORG = process.env.MINIMAX_ORG_ID;

async function getToken() {
    const res = await axios.post(MINIMAX_AUTH_URL, new URLSearchParams({
        grant_type: 'password',
        client_id: process.env.MINIMAX_CLIENT_ID,
        client_secret: process.env.MINIMAX_CLIENT_SECRET,
        username: process.env.MINIMAX_USERNAME,
        password: process.env.MINIMAX_PASSWORD,
        scope: 'minimax.si'
    }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    return res.data.access_token;
}

async function fetchAll(token, path, label) {
    try {
        const res = await axios.get(`${MINIMAX_API_URL}/orgs/${ORG}${path}`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        console.log(`\n=== ${label} ===`);
        console.log(JSON.stringify(res.data, null, 2).slice(0, 3000));
        return res.data;
    } catch (err) {
        console.error(`\n✗ Napaka pri ${label}:`, err.response?.status, err.message);
        return null;
    }
}

(async () => {
    console.log('MINIMAX DIAGNOSTIKA\n');
    console.log('ORG ID:', ORG);
    
    const token = await getToken();
    console.log('✓ Žeton pridobljen\n');

    // 1. Vsa številčenja dokumentov
    await fetchAll(token, '/document-numbering', 'ŠTEVILČENJA DOKUMENTOV');

    // 2. Vsi artikli
    await fetchAll(token, '/items', 'ARTIKLI');

    // 3. Vsi DDV
    await fetchAll(token, '/vat-rates', 'DDV STOPNJE');

    // 4. Plačilne metode
    await fetchAll(token, '/paymentMethods', 'PLAČILNE METODE');

    // 5. Države (samo Slovenija)
    await fetchAll(token, '/countries', 'DRŽAVE (iskanje SI)');

    // 6. Valute (samo EUR)
    await fetchAll(token, '/currencies', 'VALUTE (iskanje EUR)');

    console.log('\n=== KONEC DIAGNOSTIKE ===');
})();