// routes/minimax.js
const axios = require('axios');
require('dotenv').config();

// ===== KONFIGURACIJA =====
const MINIMAX_API_URL = 'https://moj.minimax.si/SI/API/api';
const MINIMAX_AUTH_URL = 'https://moj.minimax.si/si/aut/oauth20/token';
const ORGANISATION_ID = process.env.MINIMAX_ORG_ID;

// ===== POMOŽNE FUNKCIJE =====

/**
 * Pridobi OAuth2 žeton za komunikacijo z Minimax API-jem.
 * Žeton se shrani v pomnilnik in se ponovno uporabi, dokler ne poteče.
 */
let cachedToken = null;
let tokenExpiry = 0;

async function getMinimaxToken() {
    // Če imamo še veljaven žeton, ga vrni
    if (cachedToken && Date.now() < tokenExpiry) {
        return cachedToken;
    }

    try {
        const response = await axios.post(MINIMAX_AUTH_URL, new URLSearchParams({
            grant_type: 'password',
            client_id: process.env.MINIMAX_CLIENT_ID,
            client_secret: process.env.MINIMAX_CLIENT_SECRET,
            username: process.env.MINIMAX_USERNAME,
            password: process.env.MINIMAX_PASSWORD,
            scope: 'minimax.si'
        }), {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        });

        cachedToken = response.data.access_token;
        // Žeton običajno velja 1 uro; nastavimo expiracijo 5 minut prej
        const expiresIn = (response.data.expires_in || 3600) - 300;
        tokenExpiry = Date.now() + expiresIn * 1000;

        console.log('✓ Minimax žeton pridobljen');
        return cachedToken;
    } catch (err) {
        console.error('✗ Napaka pri pridobivanju Minimax žetona:', err.response?.data || err.message);
        throw new Error('Minimax avtentikacija ni uspela');
    }
}

async function findCustomerByEmail(email) {
    const token = await getMinimaxToken();
    try {
        const response = await axios.get(
            `${MINIMAX_API_URL}/orgs/${ORGANISATION_ID}/customers`,
            {
                headers: { 'Authorization': `Bearer ${token}` },
                params: { search: email, limit: 50 }
            }
        );

        // Debug: izpiši strukturo odgovora
        console.log('Minimax customers response:', JSON.stringify(response.data).slice(0, 500));

        // Poskusi različne strukture odgovora
        let customers = [];
        if (Array.isArray(response.data)) customers = response.data;
        else if (response.data?.Rows) customers = response.data.Rows;
        else if (response.data?.rows) customers = response.data.rows;
        else if (response.data?.items) customers = response.data.items;
        else if (response.data?.data) customers = response.data.data;
        else if (response.data?.Customers) customers = response.data.Customers;
        else if (response.data?.Result) customers = response.data.Result;

        console.log(`Najdenih strank: ${customers.length}`);
        if (customers.length > 0) {
            console.log('Prva stranka (struktura):', JSON.stringify(customers[0]).slice(0, 500));
        }

        const found = customers.find(c =>
            (c.Email || c.email || c.EMail || '').toLowerCase() === email.toLowerCase()
        );

        if (found) {
            const id = found.CustomerId || found.customerId || found.id || found.ID;
            console.log(`✓ Stranka najdena: ${id}`);
            return id;
        }

        console.log('Stranka ni najdena v seznamu');
        return null;
    } catch (err) {
        console.error('Iskanje stranke ni uspelo:');
        console.error('  Status:', err.response?.status);
        console.error('  Data:', JSON.stringify(err.response?.data).slice(0, 500));
        return null;
    }
}

/**
 * Ustvari novo stranko v Minimaxu.
 * Vrne CustomerId nove stranke.
 */
async function createCustomer({ ime, priimek, email }) {
    const token = await getMinimaxToken();
    try {
        const response = await axios.post(
            `${MINIMAX_API_URL}/orgs/${ORGANISATION_ID}/customers`,
            {
    Name: `${ime} ${priimek}`.trim(),
    Email: email,
    Address: 'Pot v Toplice 10',
    PostalCode: '2250',
    City: 'Ptuj',
    Country: 'SI',
    Currency: 'EUR',
    CustomerType: 'I' // I = fizična oseba (Individual) brez davčne
},
            {
                headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }
            }
        );

        // Minimax vrne ID nove stranke v glavi Location
        const location = response.headers.location;
        if (!location) {
            throw new Error('Minimax ni vrnil lokacije nove stranke');
        }
        const customerId = location.split('/').pop();
        console.log(`✓ Ustvarjena nova Minimax stranka: ${customerId} za ${email}`);
        return customerId;
    } catch (err) {
    console.error('✗ Napaka pri ustvarjanju stranke:');
    console.error('  Status:', err.response?.status);
    console.error('  Data:', String(err.response?.data || err.message).slice(0, 2000));
    
    // Ohrani response v napaki, da fallback lahko zazna 409
    const wrapped = new Error('Napaka pri ustvarjanju stranke v Minimaxu');
    wrapped.response = err.response;
    wrapped.status = err.response?.status;
    throw wrapped;
}
}

/**
 * Pridobi ID številčenja za izdane račune.
 */
let cachedNumberingId = null;

async function getNumberingId() {
    if (cachedNumberingId) return cachedNumberingId;

    const token = await getMinimaxToken();
    try {
        const response = await axios.get(
            `${MINIMAX_API_URL}/orgs/${ORGANISATION_ID}/document-numbering`,
            { headers: { 'Authorization': `Bearer ${token}` } }
        );
        const numberings = response.data || [];
        if (!numberings.length) {
            throw new Error('Ni najdenega številčenja dokumentov');
        }
        cachedNumberingId = numberings[0].DocumentNumberingId;
        return cachedNumberingId;
    } catch (err) {
        console.error('✗ Napaka pri pridobivanju številčenja:', err.message);
        throw new Error('Napaka pri pridobivanju številčenja');
    }
}

/**
 * Ustvari osnutek izdanega računa v Minimaxu.
 * Vrne { invoiceId, rowVersion }.
 */
async function createDraftInvoice({ customerId, znesek, opis }) {
    const token = await getMinimaxToken();
    const numberingId = await getNumberingId();
    const today = new Date().toISOString().slice(0, 10);
    const dueDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    try {
        const response = await axios.post(
            `${MINIMAX_API_URL}/orgs/${ORGANISATION_ID}/issuedinvoices`,
            {
                InvoiceType: 'R', // R = izdan račun
                Customer: customerId,
                InvoiceNumber: numberingId,
                DateIssued: today,
                DateTransaction: today,
                DateDue: dueDate,
                Rows: [{
                    Description: opis,
                    Quantity: 1,
                    Price: znesek,
                    VAT: 22 // 22% DDV
                }]
            },
            {
                headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }
            }
        );

        const location = response.headers.location;
        if (!location) {
            throw new Error('Minimax ni vrnil lokacije računa');
        }
        const invoiceId = location.split('/').pop();
        const rowVersion = response.data.RowVersion;

        console.log(`✓ Ustvarjen osnutek računa: ${invoiceId}`);
        return { invoiceId, rowVersion };
    } catch (err) {
        console.error('✗ Napaka pri ustvarjanju računa:', err.response?.data || err.message);
        throw new Error('Napaka pri ustvarjanju računa v Minimaxu');
    }
}

/**
 * Izda račun in generira PDF.
 */
async function issueInvoiceAndGeneratePdf(invoiceId, rowVersion) {
    const token = await getMinimaxToken();
    try {
        await axios.put(
            `${MINIMAX_API_URL}/orgs/${ORGANISATION_ID}/issuedinvoices/${invoiceId}/actions/issueAndGeneratepdf_${rowVersion}`,
            {},
            { headers: { 'Authorization': `Bearer ${token}` } }
        );
        console.log(`✓ Račun ${invoiceId} izdan in PDF generiran`);
    } catch (err) {
        console.error('✗ Napaka pri izdaji računa:', err.response?.data || err.message);
        throw new Error('Napaka pri izdaji računa');
    }
}

/**
 * Pošlje e-račun stranki.
 */
async function sendEInvoice(invoiceId, rowVersion) {
    const token = await getMinimaxToken();
    try {
        await axios.put(
            `${MINIMAX_API_URL}/orgs/${ORGANISATION_ID}/issuedinvoices/${invoiceId}/actions/sendEInvoice_${rowVersion}`,
            {},
            { headers: { 'Authorization': `Bearer ${token}` } }
        );
        console.log(`✓ E-račun ${invoiceId} poslan stranki`);
    } catch (err) {
        // Pošiljanje e-računa ni kritično – račun je že izdan
        console.warn('⚠ Napaka pri pošiljanju e-računa:', err.response?.data || err.message);
    }
}

// ===== GLAVNA FUNKCIJA =====

/**
 * Celoten postopek: preveri/ustvari stranko, ustvari račun, izdaj ga in pošlji.
 * @param {Object} params
 * @param {Object} params.user - Uporabnik iz baze { id, ime, priimek, email }
 * @param {number} params.znesek - Znesek v EUR (npr. 80)
 * @param {string} params.opis - Opis storitve (npr. "Nakup 10 kreditov")
 * @param {string} params.stripeSessionId - Stripe session ID (za sledenje)
 * @param {string} params.tip - 'krediti' ali 'rezervacija'
 * @returns {Object} { uspeh: boolean, invoiceId, napaka }
 */
async function izdajMinimaxRacun({ user, znesek, opis, stripeSessionId, tip }) {
    const pool = require('../db');
    try {
        // 0. NAJPREJ preveri bazo minimax_stranke
        let customerId = null;
        try {
            const [dbRows] = await pool.query(
                'SELECT minimax_customer_id FROM minimax_stranke WHERE user_id = ?',
                [user.id]
            );
            if (dbRows.length && dbRows[0].minimax_customer_id) {
                customerId = dbRows[0].minimax_customer_id;
                console.log(`✓ Stranka iz baze: ${customerId}`);
            }
        } catch (dbErr) {
            console.warn('Napaka pri branju minimax_stranke:', dbErr.message);
        }

        // 1. Če ni v bazi, poskusi najti po IMENU (ker API ne vrača emaila)
if (!customerId) {
    customerId = await findCustomerByName(user.ime, user.priimek);
}

// 2. Če še vedno ni, poskusi po emailu (za primer, če API kdaj vrne email)
if (!customerId) {
    customerId = await findCustomerByEmail(user.email);
}

// 3. Če še vedno ni, ustvari novo stranko
if (!customerId) {
    try {
        customerId = await createCustomer({
            ime: user.ime,
            priimek: user.priimek,
            email: user.email
        });
    } catch (createErr) {
        // Če 409 (že obstaja) → še enkrat poskusi po imenu
        if (createErr.response?.status === 409 || createErr.status === 409) {
            console.log('Stranka že obstaja (409), še enkrat iščem po imenu...');
            customerId = await findCustomerByName(user.ime, user.priimek);
            if (!customerId) {
                throw new Error('Stranka že obstaja v Minimaxu, ampak je ne najdem. Preverite ročno v Minimax portalu.');
            }
        } else {
            throw createErr;
        }
    }
}

        // 3. Shrani v bazo (da naslednjič ne kličemo API)
        if (customerId) {
            try {
                await pool.query(
                    `INSERT INTO minimax_stranke (user_id, minimax_customer_id, email) 
                     VALUES (?, ?, ?) 
                     ON DUPLICATE KEY UPDATE minimax_customer_id = VALUES(minimax_customer_id)`,
                    [user.id, customerId, user.email]
                );
                console.log(`✓ Stranka shranjena v bazo: ${customerId}`);
            } catch (dbErr) {
                console.warn('Napaka pri shranjevanju v minimax_stranke:', dbErr.message);
            }
        }
        // 2. Ustvari osnutek računa
        const { invoiceId, rowVersion } = await createDraftInvoice({
            customerId,
            znesek,
            opis
        });

        // 3. Izda račun in generiraj PDF
        await issueInvoiceAndGeneratePdf(invoiceId, rowVersion);

        // 4. Pošlji e-račun stranki
        await sendEInvoice(invoiceId, rowVersion);

        return { uspeh: true, invoiceId, customerId };
    } catch (err) {
        console.error('✗ Napaka pri izdaji Minimax računa:', err.message);
        return { uspeh: false, napaka: err.message };
    }
}
async function findCustomerByName(ime, priimek) {
    const token = await getMinimaxToken();
    try {
        const response = await axios.get(
            `${MINIMAX_API_URL}/orgs/${ORGANISATION_ID}/customers`,
            {
                headers: { 'Authorization': `Bearer ${token}` },
                params: { search: priimek, limit: 100 }
            }
        );
        const customers = response.data?.Rows || [];
        const fullName = `${ime} ${priimek}`.toLowerCase().replace(/\s+/g, ' ').trim();
        const found = customers.find(c => {
            const cName = (c.Name || '').toLowerCase().replace(/\s+/g, ' ').trim();
            return cName.includes(ime.toLowerCase()) && cName.includes(priimek.toLowerCase());
        });
        if (found) {
            console.log(`✓ Stranka najdena po imenu: ${found.CustomerId}`);
            return found.CustomerId;
        }
        return null;
    } catch (err) {
        console.warn('Iskanje po imenu ni uspelo:', err.message);
        return null;
    }
}

module.exports = {
    izdajMinimaxRacun,
    getMinimaxToken,
    findCustomerByEmail,
    findCustomerByName,
    createCustomer
};