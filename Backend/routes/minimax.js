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
        const safeEmail = String(email || '').replace(/'/g, "''");

        const response = await axios.get(
            `${MINIMAX_API_URL}/orgs/${ORGANISATION_ID}/customers`,
            {
                headers: { 'Authorization': `Bearer ${token}` },
                params: { 
               $filter: `contains(Email,'${safeEmail}')`,
               $top: 50
}
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
async function createCustomer({ ime, priimek, email }) {
    const token = await getMinimaxToken();
    try {
        // 1. Definiraj payload PRED axios.post
        const payload = {
            Name: `${ime} ${priimek}`.trim(),
            Email: email,
            Address: 'Pot v Toplice 10',
            PostalCode: '2250',
            City: 'Ptuj',
            Country: { ID: 192 },
            Currency: { ID: 7 },
            SubjectToVAT: 'N'
        };

        console.log('=== PAYLOAD ZA MINIMAX ===');
        console.log(JSON.stringify(payload, null, 2));
        console.log('==========================');

        // 2. Pokliči axios.post s payload
        const response = await axios.post(
            `${MINIMAX_API_URL}/orgs/${ORGANISATION_ID}/customers`,
            payload,
            {
                headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }
            }
        );

        const location = response.headers.location;
        if (!location) {
            throw new Error('Minimax ni vrnil lokacije nove stranke');
        }
        // Odstrani query string (?id=...) in vzemi zadnji del URL-ja
const cleanLocation = location.split('?')[0];
const customerId = cleanLocation.split('/').pop();
        console.log(`✓ Ustvarjena nova Minimax stranka: ${customerId} za ${email}`);
        return customerId;

    } catch (err) {
        const status = err.response?.status;

        if (status === 409) {
            console.log('⚠ Stranka že obstaja (409), poskušam izluščiti ID...');
            
            const location = err.response?.headers?.location;
            if (location) {
                const existingId = location.split('/').pop();
                if (existingId && !isNaN(Number(existingId))) {
                    console.log(`✓ CustomerId iz Location header: ${existingId}`);
                    return existingId;
                }
            }

            const data = err.response?.data;
            if (data && typeof data === 'object') {
                const possibleId = 
                    data.CustomerId || data.customerId || 
                    data.id || data.ID || 
                    data.Customer?.CustomerId || data.Customer?.id ||
                    data.ResourceUrl?.split('/').pop() ||
                    data.Location?.split('/').pop();
                
                if (possibleId && !isNaN(Number(possibleId))) {
                    console.log(`✓ CustomerId iz body: ${possibleId}`);
                    return possibleId;
                }
                
                console.log('Struktura 409 odgovora:', JSON.stringify(data).slice(0, 1000));
            }

            if (typeof data === 'string') {
                const match = data.match(/\/(\d+)(?:\?|$|")/);
                if (match && match[1]) {
                    console.log(`✓ CustomerId iz string body: ${match[1]}`);
                    return match[1];
                }
            }

            throw new Error('Stranka že obstaja, ampak ne morem izluščiti CustomerId iz 409 odgovora');
        }

        console.error('✗ Napaka pri ustvarjanju stranke:');
        console.error('  Status:', status);
        console.error('  Data:', JSON.stringify(err.response?.data).slice(0, 2000));
        
        const wrapped = new Error('Napaka pri ustvarjanju stranke v Minimaxu');
        wrapped.response = err.response;
        wrapped.status = status;
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
        // Debug: izpiši strukturo
console.log('=== DOCUMENT NUMBERING ODGOVOR ===');
console.log(JSON.stringify(response.data).slice(0, 1000));
console.log('===================================');

// Podpri različne strukture
let numberings = [];
if (Array.isArray(response.data)) numberings = response.data;
else if (response.data?.Rows) numberings = response.data.Rows;
else if (response.data?.rows) numberings = response.data.rows;
else if (response.data?.items) numberings = response.data.items;
else if (response.data?.data) numberings = response.data.data;

if (!numberings.length) {
    throw new Error('Ni najdenega številčenja dokumentov');
}

const first = numberings[0];
const numberingId = first.DocumentNumberingId || first.documentNumberingId || first.id || first.ID;

if (!numberingId) {
    console.error('Struktura prvega numbering:', JSON.stringify(first));
    throw new Error('DocumentNumberingId ni najden v odgovoru');
}

cachedNumberingId = numberingId;
console.log(`✓ Uporabljam numbering ID: ${numberingId}`);
return cachedNumberingId;
    } catch (err) {
        console.error('✗ Napaka pri pridobivanju številčenja:', err.message);
        throw new Error('Napaka pri pridobivanju številčenja');
    }
}

async function createDraftInvoice({ customerId, znesek, opis, user, stripeSessionId }) {
    const token = await getMinimaxToken();
    const today = new Date().toISOString().slice(0, 10);
    const dueDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    let customerData = null;
    try {
        const custRes = await axios.get(
            `${MINIMAX_API_URL}/orgs/${ORGANISATION_ID}/customers/${customerId}`,
            { headers: { 'Authorization': `Bearer ${token}` } }
        );
        customerData = custRes.data;
    } catch (e) {
        console.warn('Napaka pri branju stranke:', e.message);
    }

    const invoiceNumber = await getLastInvoiceNumberFromMinimax();

    const payload = {
        InvoiceType: 'R',
        InvoiceNumber: String(invoiceNumber),
        Customer: { ID: Number(customerId) },
        DateIssued: today,
        DateTransaction: today,
        DateDue: dueDate,
        AddresseeName: customerData?.Name?.trim() || `${user.ime} ${user.priimek}`.trim(),
        AddresseeAddress: customerData?.Address || 'Pot v Toplice 10',
        AddresseePostalCode: customerData?.PostalCode || '2250',
        AddresseeCity: customerData?.City || 'Ptuj',
        AddresseeCountry: { ID: 192 },
        Currency: { ID: 7 },
        PaymentMethod: { ID: 456712 },
        InvoiceText: opis,
        ExternalReference: stripeSessionId || null,
        Rows: [{
    RowNumber: 1,
    ItemId: 10739145,
    Description: opis,
    Quantity: 1,
    UnitPrice: znesek,
    VatRateId: 28,
    UnitOfMeasurement: 'kom'
}]
    };

    try {
        const response = await axios.post(
            `${MINIMAX_API_URL}/orgs/${ORGANISATION_ID}/issuedinvoices`,
            payload,
            {
                headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }
            }
        );

        const location = response.headers.location;
        if (!location) throw new Error('Minimax ni vrnil lokacije računa');

        let invoiceId = null;
        const matchSlash = location.match(/\/(\d+)(?:\?|$)/);
        const matchId = location.match(/[?&]id=(\d+)/);
        if (matchSlash) invoiceId = matchSlash[1];
        else if (matchId) invoiceId = matchId[1];
        else invoiceId = location.split('?')[0].split('/').pop();

        if (!invoiceId || !/^\d+$/.test(invoiceId)) {
            throw new Error(`Ne morem izluščiti invoiceId iz Location: ${location}`);
        }

        const getResponse = await axios.get(
            `${MINIMAX_API_URL}/orgs/${ORGANISATION_ID}/issuedinvoices/${invoiceId}`,
            { headers: { 'Authorization': `Bearer ${token}` } }
        );

        const rowVersion = getResponse.data?.RowVersion || getResponse.data?.rowVersion;
        if (!rowVersion) throw new Error('RowVersion ni najden v GET odgovoru');

        console.log(`✓ Ustvarjen osnutek računa: ${invoiceId}, RowVersion: ${rowVersion}, InvoiceNumber: ${invoiceNumber}`);
        return { invoiceId, rowVersion, invoiceNumber };
    } catch (err) {
        console.error('✗ Napaka pri ustvarjanju računa:');
        console.error('  Status:', err.response?.status);
        console.error('  Data:', JSON.stringify(err.response?.data, null, 2).slice(0, 3000));
        throw new Error('Napaka pri ustvarjanju računa v Minimaxu');
    }
}
async function issueInvoiceAndGeneratePdf(invoiceId, rowVersion, invoiceNumber) {
    const token = await getMinimaxToken();
    try {
        const encodedRowVersion = encodeURIComponent(rowVersion);
        await axios.put(
    `${MINIMAX_API_URL}/orgs/${ORGANISATION_ID}/issuedinvoices/${invoiceId}/actions/issueAndGeneratepdf?rowVersion=${encodedRowVersion}`,
    {},   // ← prazno body
    { headers: { 'Authorization': `Bearer ${token}` } }
);
        console.log(`✓ Račun ${invoiceId} izdan in PDF generiran`);
    } catch (err) {
        console.error('✗ Napaka pri izdaji računa:', err.response?.data || err.message);
        throw new Error('Napaka pri izdaji računa');
    }
}

async function sendEInvoice(invoiceId) {
    const token = await getMinimaxToken();
    try {
        // Preberi svež RowVersion (po izdaji se je spremenil)
        const getRes = await axios.get(
            `${MINIMAX_API_URL}/orgs/${ORGANISATION_ID}/issuedinvoices/${invoiceId}`,
            { headers: { 'Authorization': `Bearer ${token}` } }
        );
        const freshRowVersion = getRes.data?.RowVersion || getRes.data?.rowVersion;
        if (!freshRowVersion) {
            throw new Error('Ni RowVersion po izdaji');
        }
        const encoded = encodeURIComponent(freshRowVersion);

        await axios.put(
            `${MINIMAX_API_URL}/orgs/${ORGANISATION_ID}/issuedinvoices/${invoiceId}/actions/sendEInvoice?rowVersion=${encoded}`,
            {},
            { headers: { 'Authorization': `Bearer ${token}` } }
        );

        console.log(`✓ E-račun ${invoiceId} poslan stranki`);
    } catch (err) {
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
        // 0. IDEMPOTENTNOST: preveri, ali je račun že izdan
        try {
            const [existing] = await pool.query(
                'SELECT minimax_invoice_id, status FROM minimax_racuni WHERE stripe_session_id = ? LIMIT 1',
                [stripeSessionId]
            );
            if (existing.length && existing[0].status === 'izdan' && existing[0].minimax_invoice_id) {
                console.log(`✓ Račun za ${stripeSessionId} že izdan: ${existing[0].minimax_invoice_id}`);
                return { uspeh: true, invoiceId: existing[0].minimax_invoice_id };
            }
        } catch (dbErr) {
            console.warn('Napaka pri preverjanju obstoječega računa:', dbErr.message);
        }

        // 1. Preveri, ali imamo customerId v bazi
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

        // 2. Če ni v bazi, poskusi najti po emailu
        if (!customerId) {
            try {
                customerId = await findCustomerByEmail(user.email);
            } catch (e) {
                console.warn('Iskanje po emailu ni uspelo:', e.message);
            }
        }

        // 3. Če še vedno ni, ustvari novo stranko
        if (!customerId) {
            customerId = await createCustomer({
                ime: user.ime,
                priimek: user.priimek,
                email: user.email
            });
        }

        // 4. Shrani v bazo
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

        // 5. Ustvari osnutek računa
        const { invoiceId, rowVersion, invoiceNumber } = await createDraftInvoice({
            customerId,
            znesek,
            opis,
            user,
            stripeSessionId
        });

        // 6. Izda račun in generiraj PDF
        await issueInvoiceAndGeneratePdf(invoiceId, rowVersion, invoiceNumber);

        // 7. Pošlji e-račun (funkcija sama prebere svež RowVersion)
        await sendEInvoice(invoiceId);

        return { uspeh: true, invoiceId, customerId };
    } catch (err) {
        console.error('✗ Napaka pri izdaji Minimax računa:', err.message);
        return { uspeh: false, napaka: err.message };
    }
}
async function findCustomerByName(ime, priimek) {
    const token = await getMinimaxToken();
    const pageSize = 100;
    let skip = 0;
    let allCustomers = [];
    let hasMore = true;

    console.log(`Iskanje stranke: ${ime} ${priimek}...`);

    try {
        // Zanka za pridobivanje vseh strani
        while (hasMore && skip < 2000) { // Varnostna omejitev (max 2000 strank)
            const response = await axios.get(
                `${MINIMAX_API_URL}/orgs/${ORGANISATION_ID}/customers`,
                {
                    headers: { 'Authorization': `Bearer ${token}` },
                    params: {
                        $top: pageSize,
                        $skip: skip
                    }
                }
            );

            const customers = response.data?.Rows || [];
            
            if (customers.length === 0) {
                hasMore = false;
                break;
            }

            allCustomers = allCustomers.concat(customers);
            console.log(`Naloženih ${allCustomers.length} strank...`);

            if (customers.length < pageSize) {
                hasMore = false;
            } else {
                skip += pageSize;
            }
        }

        console.log(`Skupaj naloženih strank: ${allCustomers.length}`);

        // Iskanje po imenu in priimku
        const found = allCustomers.find(c => {
            const cName = (c.Name || '').toLowerCase().replace(/\s+/g, ' ').trim();
            return cName.includes(ime.toLowerCase()) && cName.includes(priimek.toLowerCase());
        });

        if (found) {
            console.log(`✓ Stranka najdena po imenu: ${found.CustomerId}`);
            return found.CustomerId;
        }

        console.log(`Stranka ${ime} ${priimek} ni najdena v vseh ${allCustomers.length} strankah.`);
        return null;

    } catch (err) {
        console.error('Napaka pri iskanju po imenu:', err.message);
        return null;
    }
}
async function debugCountries() {
    const token = await getMinimaxToken();
    try {
        const response = await axios.get(
            `${MINIMAX_API_URL}/orgs/${ORGANISATION_ID}/countries`,
            { headers: { 'Authorization': `Bearer ${token}` } }
        );
        console.log('=== DRŽAVE ===');
        console.log(JSON.stringify(response.data, null, 2).slice(0, 3000));
        return response.data;
    } catch (err) {
        console.error('Napaka pri branju držav:', err.message);
        return null;
    }
}

async function debugCurrencies() {
    const token = await getMinimaxToken();
    try {
        const response = await axios.get(
            `${MINIMAX_API_URL}/orgs/${ORGANISATION_ID}/currencies`,
            { headers: { 'Authorization': `Bearer ${token}` } }
        );
        console.log('=== VALUTE ===');
        console.log(JSON.stringify(response.data, null, 2).slice(0, 3000));
        return response.data;
    } catch (err) {
        console.error('Napaka pri branju valut:', err.message);
        return null;
    }
}
async function getLastInvoiceNumberFromMinimax() {
    const token = await getMinimaxToken();
    const leto = new Date().getFullYear();
    
    try {
        let skip = 0;
        const pageSize = 100;
        let maxNumber = 0;
        let hasMore = true;
        let totalChecked = 0;
        
        // Paginacija skozi vse račune
        while (hasMore && skip < 2000) {
            const res = await axios.get(
                `${MINIMAX_API_URL}/orgs/${ORGANISATION_ID}/issuedinvoices`,
                {
                    headers: { 'Authorization': `Bearer ${token}` },
                    params: {
                        $top: pageSize,
                        $skip: skip,
                        $orderby: 'IssuedInvoiceId desc'
                    }
                }
            );
            
            const rows = res.data?.Rows || [];
            
            if (rows.length === 0) {
                hasMore = false;
                break;
            }
            
            // Filtriraj samo račune iz tega leta
            const letosnji = rows.filter(r => Number(r.Year) === leto);
            totalChecked += rows.length;
            
            if (letosnji.length > 0) {
                const maxInBatch = Math.max(...letosnji.map(r => Number(r.InvoiceNumber) || 0));
                if (maxInBatch > maxNumber) {
                    maxNumber = maxInBatch;
                }
            }
            
            if (rows.length < pageSize) {
                hasMore = false;
            } else {
                skip += pageSize;
            }
        }
        
        console.log(`✓ Preverjenih ${totalChecked} računov, max v letu ${leto}: ${maxNumber}`);
        
        if (maxNumber === 0) {
            console.log(`✓ Prvi račun v letu ${leto}: številka 1`);
            return 1;
        }
        
        const nextNumber = maxNumber + 1;
        console.log(`✓ Naslednja številka računa: ${nextNumber}`);
        return nextNumber;
    } catch (err) {
        console.error('Napaka pri branju zadnje številke:', err.message);
        // Fallback: uporabi timestamp
        return Math.floor(Date.now() / 1000);
    }
}
module.exports = {
    izdajMinimaxRacun,
    getMinimaxToken,
    findCustomerByEmail,
    findCustomerByName,
    createCustomer,
     debugCountries,     
    debugCurrencies,
    getLastInvoiceNumberFromMinimax
};