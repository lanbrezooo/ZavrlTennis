// routes/minimax.js
const axios = require('axios');
require('dotenv').config();

// ===== KONFIGURACIJA =====
const MINIMAX_API_URL = 'https://moj.minimax.si/SI/api';
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

/**
 * Preveri, ali stranka s tem emailom že obstaja v Minimaxu.
 * Vrne CustomerId, če obstaja, sicer null.
 */
async function findCustomerByEmail(email) {
    const token = await getMinimaxToken();
    try {
        const response = await axios.get(
            `${MINIMAX_API_URL}/orgs/${ORGANISATION_ID}/customers`,
            {
                headers: { 'Authorization': `Bearer ${token}` },
                params: { search: email, limit: 5 }
            }
        );
        const customers = response.data.Rows || response.data || [];
        const found = customers.find(c => c.Email?.toLowerCase() === email.toLowerCase());
        return found ? found.CustomerId : null;
    } catch (err) {
        // Če iskanje ne uspe, vrni null (bomo poskusili ustvariti novo stranko)
        console.warn('Iskanje stranke ni uspelo:', err.message);
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
console.error('  Headers:', JSON.stringify(err.response?.headers, null, 2));
console.error('  Data:', String(err.response?.data || err.message).slice(0, 2000));;
        throw new Error('Napaka pri ustvarjanju stranke v Minimaxu');
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
    try {
        // 1. Preveri, ali stranka že obstaja
        let customerId = await findCustomerByEmail(user.email);
        if (!customerId) {
            customerId = await createCustomer({
                ime: user.ime,
                priimek: user.priimek,
                email: user.email
            });
        }
        console.log(`✓ Uporabljena stranka: ${customerId}`);

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

module.exports = {
    izdajMinimaxRacun,
    getMinimaxToken,
    findCustomerByEmail,
    createCustomer
};