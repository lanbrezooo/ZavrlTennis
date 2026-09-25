// routes/minimax.js
const axios = require('axios');
require('dotenv').config();
const { Resend } = require('resend');
const resend = new Resend(process.env.RESEND_API_KEY);

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
async function sendInvoiceByEmail({ to, ime, priimek, znesek, opis, pdfBuffer, invoiceId }) {
    try {
        const response = await resend.emails.send({
            from: process.env.EMAIL_FROM,
            to: [to],
            subject: `Račun – ${opis}`,
            html: `
                <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
                    <h2 style="color: #1a5632;">Zavrl Tennis Team</h2>
                    <p>Pozdravljeni ${ime || ''},</p>
                    <p>v priponki vam pošiljamo račun za storitev:</p>
                    <p style="background:#f0f4f0;padding:1rem;border-radius:8px;">
                        <strong>${opis}</strong><br>
                        Znesek: <strong>${znesek.toFixed(2)} €</strong>
                    </p>
                    <p>Račun je priložen kot PDF datoteka.</p>
                    <p style="font-size: 12px; color: #666; margin-top: 30px;">
                        Zavrl Tennis Team<br>
                        Pot v Toplice 10, 2250 Ptuj
                    </p>
                </div>
            `,
            attachments: [
                {
                    filename: `racun-${invoiceId}.pdf`,
                    content: pdfBuffer.toString('base64')
                }
            ]
        });

        console.log(`✓ Račun ${invoiceId} poslan po emailu na ${to} (Resend ID: ${response?.data?.id || 'neznan'})`);
        return { uspeh: true, resendId: response?.data?.id || null };
    } catch (err) {
        console.error('✗ Napaka pri pošiljanju emaila z računom:', err.message);
        return { uspeh: false, napaka: err.message };
    }
}

async function findCustomerByEmail(email) {
    const token = await getMinimaxToken();
    try {
        

        const response = await axios.get(
            `${MINIMAX_API_URL}/orgs/${ORGANISATION_ID}/customers`,
            {
                headers: { 'Authorization': `Bearer ${token}` },
                params: {
            SearchString: email,
            PageSize: 50

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
            SubjectToVAT: 'N',
            EInvoiceIssuing: 'SeNePripravlja'
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

// 2. Dodaj privzeti kontakt z e-mailom
try {
    await axios.post(
        `${MINIMAX_API_URL}/orgs/${ORGANISATION_ID}/customers/${customerId}/contacts`,
        {
            FullName: `${ime} ${priimek}`.trim(),
            Email: email,
            Default: 'D'
        },
        {
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            }
        }
    );

    console.log(`✓ Privzeti kontakt dodan stranki ${customerId}`);
} catch (contactErr) {
    console.error(
        '✗ Napaka pri dodajanju kontakta:',
        contactErr.response?.data || contactErr.message
    );

    // Zelo pomembno:
    // brez kontakta ne smemo nastaviti EPosta.
    throw new Error('Minimax kontakt z e-pošto ni bil ustvarjen');
}


// 3. Zdaj, ko kontakt obstaja, nastavi EInvoiceIssuing = EPosta
try {
    const customerResponse = await axios.get(
        `${MINIMAX_API_URL}/orgs/${ORGANISATION_ID}/customers/${customerId}`,
        {
            headers: {
                'Authorization': `Bearer ${token}`
            }
        }
    );

    const customer = customerResponse.data;

    const updatePayload = {
        CustomerId: Number(customer.CustomerId || customerId),
        Code: customer.Code || null,
        Name: customer.Name,
        Address: customer.Address,
        PostalCode: customer.PostalCode,
        City: customer.City,
        Country: customer.Country,
        CountryName: customer.CountryName || null,
        TaxNumber: customer.TaxNumber || null,
        RegistrationNumber: customer.RegistrationNumber || null,
        VATIdentificationNumber: customer.VATIdentificationNumber || null,
        SubjectToVAT: customer.SubjectToVAT,
        ConsiderCountryForBookkeeping:
            customer.ConsiderCountryForBookkeeping || null,
        Currency: customer.Currency,
        ExpirationDays: customer.ExpirationDays || 0,
        RebatePercent: customer.RebatePercent || 0,
        WebSiteURL: customer.WebSiteURL || null,

        // Zdaj je kontakt že ustvarjen
        EInvoiceIssuing: 'EPosta',

        InternalCustomerNumber:
            customer.InternalCustomerNumber || null,

        GLN: customer.GLN || null,
        BudgetUserNumber: customer.BudgetUserNumber || null,
        Usage: customer.Usage || 'D',
        AssociationType: customer.AssociationType || null,

        RecordDtModified: customer.RecordDtModified,
        RowVersion: customer.RowVersion
    };

    await axios.put(
        `${MINIMAX_API_URL}/orgs/${ORGANISATION_ID}/customers/${customerId}`,
        updatePayload,
        {
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            }
        }
    );

    console.log(`✓ EInvoiceIssuing nastavljen na EPosta za stranko ${customerId}`);

} catch (updateErr) {
    console.error(
        '✗ Napaka pri nastavljanju EPosta:',
        updateErr.response?.data || updateErr.message
    );

    throw new Error('Minimax EPosta nastavitve ni bilo mogoče nastaviti');
}

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

    

    const payload = {
    InvoiceType: 'R',
    Customer: { ID: Number(customerId) },
    DateIssued: today,
    DateTransaction: today,
    DateTransactionFrom: today,
    DateDue: dueDate,
    AddresseeName: customerData?.Name?.trim() || `${user.ime} ${user.priimek}`.trim(),
    AddresseeAddress: customerData?.Address || 'Pot v Toplice 10',
    AddresseePostalCode: customerData?.PostalCode || '2250',
    AddresseeCity: customerData?.City || 'Ptuj',
    AddresseeCountry: { ID: 192 },
    Currency: { ID: 7 },
    InvoiceText: opis,
    ExternalReference: stripeSessionId || null,

    // Predlogi izpisa (obvezno po dokumentaciji)
    IssuedInvoiceReportTemplate: { ID: 2077676 },   // Izdani račun 1 (privzeto)
    DeliveryNoteReportTemplate: { ID: 1882233 },     // Standardno - Dobavnica
    PricesOnInvoice: 'N',                            // DDV se prišteva cenam
    RecurringInvoice: 'N',                           // Ni ponavljajoči

    IssuedInvoiceRows: [{
        RowNumber: 1,
        Item: { ID: 10739145 },
        Description: opis,
        Quantity: 1,
        UnitOfMeasurement: 'kom',
        Price: Number((znesek / 1.095).toFixed(6)),
        PriceWithVAT: znesek,
        VatRate: { ID: 28 },
        VATPercent: 9.5
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

        console.log(`✓ Ustvarjen osnutek računa: ${invoiceId}, RowVersion: ${rowVersion}`);
        return { invoiceId, rowVersion };
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
/**
 * Prenese PDF izdanega računa iz Minimaxa.
 * Vrne Buffer s PDF vsebino ali null, če PDF ne obstaja.
 */
async function downloadInvoicePdf(invoiceId) {
    const token = await getMinimaxToken();
    try {
        const res = await axios.get(
            `${MINIMAX_API_URL}/orgs/${ORGANISATION_ID}/issuedinvoices/${invoiceId}/attachments`,
            { headers: { 'Authorization': `Bearer ${token}` } }
        );

        const rows = res.data?.Rows || res.data?.rows || [];
        // Poišči prilogo tipa PDF (InvoiceAttachment)
        const pdfAttachment = rows.find(a =>
            (a.MimeType || a.mimeType || '').toLowerCase().includes('pdf') ||
            (a.FileName || a.filename || '').toLowerCase().endsWith('.pdf')
        );

        if (!pdfAttachment) {
            console.warn('⚠ PDF priloga ni najdena med prilogami računa');
            return null;
        }

        // Prenesi samo datoteko (običajno prek DownloadUrl ali FileId)
        const fileUrl = pdfAttachment.DownloadUrl || pdfAttachment.downloadUrl ||
                        pdfAttachment.Url || pdfAttachment.url;

        if (!fileUrl) {
            console.warn('⚠ DownloadUrl za PDF ni na voljo');
            return null;
        }

        const fileRes = await axios.get(fileUrl, {
            headers: { 'Authorization': `Bearer ${token}` },
            responseType: 'arraybuffer'
        });

        return Buffer.from(fileRes.data);
    } catch (err) {
        console.warn('Napaka pri prenosu PDF-ja:', err.response?.data || err.message);
        return null;
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
    const { withInvoiceLock } = require('./invoiceLock');

    try {
        return await withInvoiceLock(stripeSessionId, async () => {

            // 0. IDEMPOTENTNOST
            try {
                const [existing] = await pool.query(
                    'SELECT minimax_invoice_id, status, email_poslan FROM minimax_racuni WHERE stripe_session_id = ? LIMIT 1',
                    [stripeSessionId]
                );
                if (existing.length && existing[0].status === 'izdan' && existing[0].minimax_invoice_id) {
                    console.log(`✓ Račun za ${stripeSessionId} že izdan: ${existing[0].minimax_invoice_id}`);
                    return {
                        uspeh: true,
                        invoiceId: existing[0].minimax_invoice_id,
                        emailPoslan: !!existing[0].email_poslan,
                        zeObstaja: true
                    };
                }
            } catch (dbErr) {
                console.warn('Napaka pri preverjanju obstoječega računa:', dbErr.message);
            }

            // 0b. Zabeleži začetek (če še ni zapisa)
            try {
                await pool.query(
                    `INSERT INTO minimax_racuni 
                        (stripe_session_id, user_id, znesek, opis, status)
                     VALUES (?, ?, ?, ?, 'v_obdelavi')
                     ON DUPLICATE KEY UPDATE
                        status = 'v_obdelavi',
                        znesek = VALUES(znesek),
                        opis = VALUES(opis)`,
                    [stripeSessionId, user.id, znesek, opis]
                );
            } catch (dbErr) {
                console.warn('Napaka pri zapisu v minimax_racuni (začetek):', dbErr.message);
            }

            // 1. Poišči customerId v bazi
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

            // 2. Iskanje po emailu / imenu
            if (!customerId) {
                try {
                    customerId = await findCustomerByEmail(user.email);
                } catch (e) {
                    console.warn('Iskanje po emailu ni uspelo:', e.message);
                }
            }

            if (!customerId) {
                try {
                    customerId = await findCustomerByName(user.ime, user.priimek);
                } catch (e) {
                    console.warn('Iskanje po imenu ni uspelo:', e.message);
                }
            }

            // 3. Ustvari novo stranko
            if (!customerId) {
                customerId = await createCustomer({
                    ime: user.ime,
                    priimek: user.priimek,
                    email: user.email
                });
            }

            // 4. Shrani v minimax_stranke
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
            const { invoiceId, rowVersion } = await createDraftInvoice({
                customerId,
                znesek,
                opis,
                user,
                stripeSessionId
            });

            // 6. Izda račun in generiraj PDF
            await issueInvoiceAndGeneratePdf(invoiceId, rowVersion);

            // 7. Takoj zabeleži ID izdanega računa (že preden pošljemo e-mail)
            try {
                await pool.query(
                    `UPDATE minimax_racuni
                     SET minimax_invoice_id = ?, minimax_customer_id = ?, status = 'izdan'
                     WHERE stripe_session_id = ?`,
                    [invoiceId, customerId, stripeSessionId]
                );
            } catch (dbErr) {
                console.warn('Napaka pri posodobitvi minimax_racuni (izdan):', dbErr.message);
            }

            // 8. Prenesi PDF
            const pdfBuffer = await downloadInvoicePdf(invoiceId);

            if (!pdfBuffer) {
                console.warn('⚠ PDF ni bil prenesen – račun je izdan, a email ni poslan');
                try {
                    await pool.query(
                        `UPDATE minimax_racuni
                         SET email_poslan = 0, email_napaka = ?
                         WHERE stripe_session_id = ?`,
                        ['PDF ni bil prenesen', stripeSessionId]
                    );
                } catch (dbErr) {
                    console.warn('Napaka pri zapisu email napake:', dbErr.message);
                }
                return { uspeh: true, invoiceId, customerId, emailPoslan: false };
            }

            // 9. Pošlji e-mail prek Resenda
            const emailResult = await sendInvoiceByEmail({
                to: user.email,
                ime: user.ime,
                priimek: user.priimek,
                znesek,
                opis,
                pdfBuffer,
                invoiceId
            });

            // 10. Zabeleži rezultat e-maila
            try {
                await pool.query(
                    `UPDATE minimax_racuni
                     SET email_poslan = ?, email_poslan_dt = ?, email_napaka = ?
                     WHERE stripe_session_id = ?`,
                    [
                        emailResult.uspeh ? 1 : 0,
                        emailResult.uspeh ? new Date() : null,
                        emailResult.uspeh ? null : (emailResult.napaka || 'neznana napaka'),
                        stripeSessionId
                    ]
                );
            } catch (dbErr) {
                console.warn('Napaka pri zapisu email statusa:', dbErr.message);
            }

            return {
                uspeh: true,
                invoiceId,
                customerId,
                emailPoslan: emailResult.uspeh,
                emailNapaka: emailResult.uspeh ? null : emailResult.napaka
            };
        });
    } catch (err) {
        console.error('✗ Napaka pri izdaji Minimax računa:', err.message);

        // Zabeleži napako v bazo
        try {
            const pool = require('../db');
            await pool.query(
                `UPDATE minimax_racuni
                 SET status = 'napaka', napaka = ?
                 WHERE stripe_session_id = ?`,
                [err.message, stripeSessionId]
            );
        } catch (dbErr) {
            console.warn('Napaka pri zapisu napake v bazo:', dbErr.message);
        }

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
                params: {
                    SearchString: `${ime} ${priimek}`,
                    PageSize: 50
                }
            }
        );

        const customers = response.data?.Rows || [];
        console.log(`Iskanje po imenu: ${customers.length} strank`);

        const found = customers.find(c => {
            const cName = (c.Name || '').toLowerCase().replace(/\s+/g, ' ').trim();
            return cName.includes(ime.toLowerCase()) && cName.includes(priimek.toLowerCase());
        });

        if (found) {
            const id = found.CustomerId || found.customerId || found.id || found.ID;
            console.log(`✓ Stranka najdena po imenu: ${id}`);
            return id;
        }

        console.log(`Stranka ${ime} ${priimek} ni najdena.`);
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
        const res = await axios.get(
            `${MINIMAX_API_URL}/orgs/${ORGANISATION_ID}/issuedinvoices`,
            {
                headers: { 'Authorization': `Bearer ${token}` },
                params: {
                    $top: 100,
                    $orderby: 'IssuedInvoiceId desc'
                }
            }
        );
        
        const rows = res.data?.Rows || [];
        console.log(`✓ Naloženih ${rows.length} računov (najnovejših)`);
        
        const letosnji = rows.filter(r => Number(r.Year) === leto);
        console.log(`✓ Najdenih ${letosnji.length} računov v letu ${leto}`);
        
        if (letosnji.length === 0) {
            console.log(`✓ Prvi račun v letu ${leto}: številka 1`);
            return 1;
        }
        
        const maxNumber = Math.max(...letosnji.map(r => Number(r.InvoiceNumber) || 0));
        const nextNumber = maxNumber + 1;
        console.log(`✓ Max v letu ${leto}: ${maxNumber}, naslednja: ${nextNumber}`);
        return nextNumber;
    } catch (err) {
        console.error('Napaka pri branju zadnje številke:', err.message);
        return Math.floor(Date.now() / 1000);
    }
}
module.exports = {
    izdajMinimaxRacun,
    getMinimaxToken,
    findCustomerByEmail,
    findCustomerByName,
    downloadInvoicePdf,
    createCustomer,
     debugCountries,     
    debugCurrencies,
    getLastInvoiceNumberFromMinimax
};