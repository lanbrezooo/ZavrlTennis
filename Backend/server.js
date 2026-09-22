const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const cookieParser = require('cookie-parser');
require('dotenv').config();
const pool = require('./db');
const authRoutes = require('./routes/auth');
const reservationRoutes = require('./routes/reservations');
const { requireAuth, requireAdmin } = require('./middleware');
const { izdajMinimaxRacun } = require('./routes/minimax');
const {
  getEndHour,
  validateReservation,
  calculateCredits
} = require('./routes/reservationRules');

const {
  withReservationLock,
  reservationLockName
} = require('./routes/reservationLock');
const app = express();
app.set('trust proxy', 1);
const allowedOrigin = process.env.CORS_ORIGIN || '';

app.disable('x-powered-by',1);
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(cors({
  origin(origin, cb) {
    if (!origin || !allowedOrigin || origin === allowedOrigin) return cb(null, true);
    cb(new Error('Origin ni dovoljen'));
  },
  credentials: true,
  methods: ['GET','POST','PUT','DELETE'],
  allowedHeaders: ['Content-Type','Authorization']
}));
// ===== STRIPE WEBHOOK – MORA BITI PRED express.json() =====
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

async function handleCreditsPaid(session) {
  const userId = Number(session.metadata.userId);
  const credits = Number(session.metadata.credits);

  if (!Number.isInteger(userId) || userId < 1 || !Number.isFinite(credits) || credits <= 0) {
    throw new Error('Neveljavni metadata za kredite');
  }

  const conn = await pool.getConnection();
  let recordId;
  let alreadyAdded = false;

  try {
    await conn.beginTransaction();

    const [rows] = await conn.query(
      `SELECT id, krediti_dodani, status
       FROM minimax_racuni
       WHERE stripe_session_id = ?
       FOR UPDATE`,
      [session.id]
    );

    if (rows.length) {
      recordId = rows[0].id;
      alreadyAdded = Number(rows[0].krediti_dodani) === 1;
    } else {
      const znesek = credits === 10 ? 80 : credits * 10;

      const [ins] = await conn.query(
        `INSERT INTO minimax_racuni
         (user_id, stripe_session_id, znesek, tip, status, krediti_dodani)
         VALUES (?, ?, ?, 'krediti', 'pending', 0)`,
        [userId, session.id, znesek]
      );

      recordId = ins.insertId;
    }

    if (!alreadyAdded) {
      await conn.query(
        'UPDATE uporabniki SET krediti = krediti + ? WHERE id = ?',
        [credits, userId]
      );

      await conn.query(
        'UPDATE minimax_racuni SET krediti_dodani = 1 WHERE id = ?',
        [recordId]
      );
    }

    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }

  const [statusRows] = await pool.query(
    'SELECT status FROM minimax_racuni WHERE id = ?',
    [recordId]
  );

  if (statusRows[0]?.status === 'izdan') return;

  const [userRows] = await pool.query(
    'SELECT id, ime, priimek, email FROM uporabniki WHERE id = ?',
    [userId]
  );

  if (!userRows.length) return;

  const user = userRows[0];
  const znesek = credits === 10 ? 80 : credits * 10;
  const opis =
    credits === 10
      ? 'Paket 10 kreditov – Zavrl Tennis Team'
      : `Nakup ${credits} kreditov – Zavrl Tennis Team`;

  const rezultat = await izdajMinimaxRacun({
    user,
    znesek,
    opis,
    stripeSessionId: session.id,
    tip: 'krediti'
  });

  if (rezultat.uspeh) {
    await pool.query(
      `UPDATE minimax_racuni
       SET status = 'izdan', minimax_invoice_id = ?, napaka = NULL
       WHERE id = ?`,
      [rezultat.invoiceId, recordId]
    );
  } else {
    await pool.query(
      `UPDATE minimax_racuni
       SET status = 'napaka', napaka = ?
       WHERE id = ?`,
      [rezultat.napaka || 'Neznana napaka', recordId]
    );

    throw new Error(`Minimax račun ni izdan: ${rezultat.napaka || 'neznana napaka'}`);
  }
}

async function handleReservationPaid(session) {
  const reservationId = Number(session.metadata.reservationId);
  const conn = await pool.getConnection();

  let reservation;
  let needRefund = false;

  try {
    await conn.beginTransaction();

    const [rows] = await conn.query(
      `SELECT *
       FROM rezervacije
       WHERE id = ? OR stripe_session_id = ?
       FOR UPDATE`,
      [Number.isInteger(reservationId) ? reservationId : -1, session.id]
    );

    if (!rows.length) {
      throw new Error('Rezervacija ne obstaja');
    }

    reservation = rows[0];

    if (reservation.stripe_refund_id) {
      await conn.commit();
      return;
    }

    if (
      Number(reservation.preklicano) === 1 ||
      reservation.placilo_status === 'preklicano'
    ) {
      needRefund = true;
      await conn.commit();
    } else if (reservation.placilo_status === 'placano') {
      await conn.commit();
      return;
    } else {
      const expired =
        reservation.hold_expires_at &&
        new Date(reservation.hold_expires_at) < new Date();

      if (expired) {
        await conn.query(
          `UPDATE rezervacije
           SET preklicano = 1,
               placilo_status = 'preklicano',
               hold_expires_at = NULL
           WHERE id = ?`,
          [reservation.id]
        );

        needRefund = true;
      } else {
        await conn.query(
          `UPDATE rezervacije
           SET placilo_status = 'placano',
               hold_expires_at = NULL
           WHERE id = ?`,
          [reservation.id]
        );
      }

      await conn.commit();
    }
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }

  if (needRefund && session.payment_intent) {
    try {
      const refund = await stripe.refunds.create({
        payment_intent: session.payment_intent
      });

      await pool.query(
        'UPDATE rezervacije SET stripe_refund_id = ? WHERE id = ?',
        [refund.id, reservation.id]
      );
    } catch (refundErr) {
      console.error('Stripe refund error:', refundErr.message);
      throw refundErr;
    }
  }
}

async function handleReservationExpired(session) {
  await pool.query(
    `UPDATE rezervacije
     SET preklicano = 1,
         placilo_status = 'preklicano',
         hold_expires_at = NULL
     WHERE stripe_session_id = ?
       AND placilo_status = 'pending'
       AND preklicano = 0`,
    [session.id]
  );
}

app.post(
  '/api/payments/webhook',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;

    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.error('Webhook signature error:', err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    try {
      if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
        const type = session.metadata.type || 'credits';

        if (type === 'reservation') {
          await handleReservationPaid(session);
        } else {
          await handleCreditsPaid(session);
        }
      } else if (event.type === 'checkout.session.expired') {
        const session = event.data.object;
        if ((session.metadata.type || 'credits') === 'reservation') {
          await handleReservationExpired(session);
        }
      }

      return res.json({ received: true });
    } catch (err) {
      console.error('Stripe webhook processing error:', err);
      return res.status(500).json({ message: 'Webhook obdelava ni uspela' });
    }
  }
);
app.use(express.json({ limit: '50mb' })); // Povečamo za base64 slike
app.use(cookieParser());
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

app.use(rateLimit({ windowMs: 15*60*1000, max: 500, standardHeaders: true, legacyHeaders: false, message: { message: 'Preveč zahtevkov. Poskusite kasneje.' } }));
app.use('/api/auth/login', rateLimit({ windowMs: 15*60*1000, max: 10, standardHeaders: true, legacyHeaders: false, message: { message: 'Preveč poskusov prijave. Poskusite čez nekaj minut.' } }));
app.use('/api/auth/register', rateLimit({ windowMs: 60*60*1000, max: 20, standardHeaders: true, legacyHeaders: false, message: { message: 'Preveč registracij. Poskusite kasneje.' } }));
app.use('/api/auth', authRoutes);
app.use('/api/reservations', reservationRoutes);

// ===== NOVE POTI ZA NOVICE =====
app.get('/api/novice', async (_req, res) => {
  try {
    const [novice] = await pool.query('SELECT * FROM novice ORDER BY datum DESC');
    res.json({ novice });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ message: 'Napaka pri pridobivanju novic' });
  }
});

// Dodajanje novice (z glavno sliko in do 5 dodatnih slik)
app.post('/api/admin/novice', requireAuth, requireAdmin, async (req, res) => {
  const { naslov, vsebina, glavna_slika, dodatne_slike } = req.body;
  if (!naslov || !String(naslov).trim()) return res.status(400).json({ message: 'Naslov je obvezen' });
  try {
    const slikeArray = dodatne_slike && Array.isArray(dodatne_slike) ? dodatne_slike.slice(0, 5) : [];
    const slikeJson = JSON.stringify(slikeArray);
    const [result] = await pool.query(
      'INSERT INTO novice (naslov, vsebina, slika_url, slike) VALUES (?, ?, ?, ?)',
      [String(naslov).trim(), String(vsebina || ''), glavna_slika || null, slikeJson]
    );
    res.status(201).json({ message: 'Novica dodana', id: result.insertId });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ message: 'Napaka pri dodajanju novice' });
  }
});

// Urejanje novice
app.put('/api/admin/novice/:id', requireAuth, requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ message: 'Neveljaven ID' });
  const { naslov, vsebina, glavna_slika, dodatne_slike } = req.body;
  if (!naslov || !String(naslov).trim()) return res.status(400).json({ message: 'Naslov je obvezen' });
  try {
    const slikeArray = dodatne_slike && Array.isArray(dodatne_slike) ? dodatne_slike.slice(0, 5) : [];
    const slikeJson = JSON.stringify(slikeArray);
    await pool.query(
      'UPDATE novice SET naslov = ?, vsebina = ?, slika_url = ?, slike = ? WHERE id = ?',
      [String(naslov).trim(), String(vsebina || ''), glavna_slika || null, slikeJson, id]
    );
    res.json({ message: 'Novica posodobljena' });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ message: 'Napaka pri posodabljanju novice' });
  }
});

app.delete('/api/admin/novice/:id', requireAuth, requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ message: 'Neveljaven ID' });
  try {
    await pool.query('DELETE FROM novice WHERE id = ?', [id]);
    res.json({ message: 'Novica izbrisana' });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ message: 'Napaka pri brisanju novice' });
  }
});

// ===== JAVNI UPORABNIK =====
app.get('/api/auth/user/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ message: 'Neveljaven ID' });
  try {
    const [rows] = await pool.query(
      'SELECT id, ime, priimek, opis, nivo, telefon, prikazi_telefon FROM uporabniki WHERE id = ?',
      [id]
    );
    if (!rows.length) return res.status(404).json({ message: 'Uporabnik ne obstaja' });
    const user = rows[0];
    if (!user.prikazi_telefon) delete user.telefon;
    res.json({ user });
  } catch (e) {
    console.error(e.message);
    res.status(500).json({ message: 'Napaka pri pridobivanju uporabnika' });
  }
});

// ===== ADMIN POTI =====
const admin = express.Router();
admin.use(requireAuth, requireAdmin);
admin.get('/users', async (_req,res) => { try { const [users] = await pool.query('SELECT id, ime, priimek, email, telefon, leto_rojstva, opis, nivo, letna_karta, krediti, admin, prikazi_telefon, created_at FROM uporabniki ORDER BY id DESC'); res.json({users}); } catch(e){ console.error(e.message); res.status(500).json({message:'Napaka pri pridobivanju uporabnikov'}); } });
admin.put('/users/:id', async (req,res) => { const id=Number(req.params.id); if(!Number.isInteger(id)||id<1) return res.status(400).json({message:'Neveljaven ID'}); const b=req.body; if(!String(b.ime||'').trim()||!String(b.priimek||'').trim()||!String(b.email||'').includes('@')) return res.status(400).json({message:'Preverite obvezna polja'}); const credits=Number(b.krediti); if(!Number.isInteger(credits)||credits<0) return res.status(400).json({message:'Krediti morajo biti celo število 0 ali več'}); try { await pool.query('UPDATE uporabniki SET ime=?, priimek=?, email=?, telefon=?, leto_rojstva=?, opis=?, nivo=?, letna_karta=?, krediti=?, admin=?, prikazi_telefon=? WHERE id=?',[String(b.ime).trim().slice(0,50),String(b.priimek).trim().slice(0,50),String(b.email).trim().toLowerCase().slice(0,100),String(b.telefon||'').trim().slice(0,30)||null,b.leto_rojstva?Number(b.leto_rojstva):null,String(b.opis||'').slice(0,1000),String(b.nivo||'Rekreativec').slice(0,50),b.letna_karta?1:0,credits,b.admin?1:0,b.prikazi_telefon?1:0,id]); res.json({message:'Uporabnik posodobljen'}); } catch(e){ if(e.code==='ER_DUP_ENTRY') return res.status(409).json({message:'Email že obstaja'}); console.error(e.message); res.status(500).json({message:'Napaka pri posodabljanju uporabnika'}); } });
admin.delete('/users/:id', async (req,res)=>{ const id=Number(req.params.id); if(id===req.user.id) return res.status(400).json({message:'Ne morete izbrisati samega sebe'}); try { await pool.query('DELETE FROM uporabniki WHERE id=?',[id]); res.json({message:'Uporabnik izbrisan'}); } catch(e){console.error(e.message);res.status(500).json({message:'Napaka pri brisanju uporabnika'});} });
admin.get('/reservations', async (_req,res)=>{ try { const [reservations]=await pool.query("SELECT r.id, r.user_id, r.igrisce, DATE_FORMAT(r.datum, '%Y-%m-%d') AS datum, r.ura_zacetka, r.trajanje, r.oznaka, r.blokada, r.preklicano, r.datum_preklica, r.krediti_porabili, r.letna_karta_uporabljena, u.ime, u.priimek, u.email FROM rezervacije r JOIN uporabniki u ON u.id=r.user_id ORDER BY r.datum DESC, r.ura_zacetka ASC"); res.json({reservations}); }catch(e){console.error(e.message);res.status(500).json({message:'Napaka pri pridobivanju rezervacij'});} });
admin.delete('/reservations/:id', async (req,res)=>{
  const id=Number(req.params.id); if(!Number.isInteger(id)||id<1) return res.status(400).json({message:'Neveljaven ID'});
  const conn=await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [rows]=await conn.query('SELECT user_id, krediti_porabili FROM rezervacije WHERE id=? AND preklicano = 0 FOR UPDATE',[id]);
    if(!rows.length){await conn.rollback();return res.status(404).json({message:'Rezervacija ne obstaja'});}
    const refund=Number(rows[0].krediti_porabili||0);
    if(refund>0) await conn.query('UPDATE uporabniki SET krediti=krediti+? WHERE id=?',[refund,rows[0].user_id]);
    // ⬇️ Mehko brisanje
    await conn.query('UPDATE rezervacije SET preklicano = 1, datum_preklica = NOW() WHERE id=?',[id]);
    await conn.commit();
    res.json({message:'Rezervacija preklicana',refundedCredits:refund});
  } catch(e){await conn.rollback();console.error(e.message);res.status(500).json({message:'Napaka pri preklicu rezervacije'});} finally {conn.release();}
});
admin.delete('/reservations', async (_req,res)=>{
  const conn=await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [reservations]=await conn.query('SELECT id FROM rezervacije WHERE preklicano = 0 FOR UPDATE');
    for(const r of reservations){
      await conn.query('UPDATE rezervacije SET preklicano = 1, datum_preklica = NOW() WHERE id=?',[r.id]);
    }
    await conn.commit();
    res.json({message:'Vse rezervacije preklicane'});
  } catch(e){await conn.rollback();console.error(e.message);res.status(500).json({message:'Napaka pri preklicu rezervacij'});} finally {conn.release();}
});
// ===== ADMIN: BLOKADA / IZREDNI DOGODEK =====
app.post('/api/admin/block', requireAuth, requireAdmin, async (req, res) => {
  const igrisce = Number(req.body.igrisce);
  const ura = Number(req.body.ura_zacetka);
  const trajanje = Number(req.body.trajanje);
  const datum = String(req.body.datum || '');
  const oznaka = String(req.body.oznaka || 'Izredni dogodek').trim().slice(0, 100);
  const vseIgrisca = req.body.vse_igrisca === true;

  // Seznam igrišč: vsa (1-9) ali samo eno
  const igriscaSeznam = vseIgrisca ? [1,2,3,4,5,6,7,8,9] : [igrisce];

  if (!vseIgrisca && (!Number.isInteger(igrisce) || igrisce < 1 || igrisce > 9)) {
    return res.status(400).json({ message: 'Neveljavno igrišče' });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(datum) ||
      !Number.isInteger(ura) || ura < 8 || ura >= 22 ||
      !Number.isInteger(trajanje) || trajanje < 1 || ura + trajanje > 22) {
    return res.status(400).json({ message: 'Neveljaven termin blokade' });
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    let totalRefunded = 0;
    let totalRefundedCount = 0;

    for (const ig of igriscaSeznam) {
      // Poišči obstoječe rezervacije v tem terminu
            const [existing] = await conn.query(
        `SELECT id, user_id, krediti_porabili FROM rezervacije
         WHERE igrisce = ? AND datum = ? 
         AND ura_zacetka < ? AND ura_zacetka + trajanje > ?
         AND preklicano = 0
         FOR UPDATE`,
        [ig, datum, ura + trajanje, ura]
      );

      // Vrni kredite (letna karta se ne vrača)
      for (const r of existing) {
        const refund = Number(r.krediti_porabili || 0);
        if (refund > 0) {
          await conn.query('UPDATE uporabniki SET krediti = krediti + ? WHERE id = ?', [refund, r.user_id]);
          totalRefunded += refund;
          totalRefundedCount++;
        }
      }

      // Izbriši obstoječe rezervacije
            if (existing.length > 0) {
        await conn.query(
          `UPDATE rezervacije 
           SET preklicano = 1, datum_preklica = NOW()
           WHERE igrisce = ? AND datum = ? 
           AND ura_zacetka < ? AND ura_zacetka + trajanje > ?
           AND preklicano = 0`,
          [ig, datum, ura + trajanje, ura]
        );
      }
      
            // Ustvari novo blokado
      await conn.query(
        `INSERT INTO rezervacije 
         (user_id, igrisce, datum, ura_zacetka, trajanje, krediti_porabili, letna_karta_uporabljena, oznaka, blokada, placilo_status)
         VALUES (?, ?, ?, ?, ?, 0, 0, ?, 1, 'placano')`,
        [req.user.id, ig, datum, ura, trajanje, oznaka]
      );
    }

    await conn.commit();
    res.json({
      message: 'Blokada ustvarjena',
      blocksCreated: igriscaSeznam.length,
      refundedCount: totalRefundedCount,
      refundedTotal: totalRefunded
    });
  } catch (err) {
    await conn.rollback();
    console.error('block', err.message);
    res.status(500).json({ message: 'Napaka pri ustvarjanju blokade' });
  } finally {
    conn.release();
  }
});
// ===== ADMIN: Podrobnosti rezervacije (z podatki uporabnika) =====
admin.get('/reservations/:id/details', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ message: 'Neveljaven ID' });
  try {
        const [rows] = await pool.query(
      `SELECT r.id, r.user_id, r.igrisce, DATE_FORMAT(r.datum, '%Y-%m-%d') AS datum, r.ura_zacetka, r.trajanje, r.oznaka,
              r.krediti_porabili, r.letna_karta_uporabljena, r.blokada,
              u.ime, u.priimek, u.email, u.telefon, u.nivo, u.opis, u.letna_karta
       FROM rezervacije r
       JOIN uporabniki u ON u.id = r.user_id
       WHERE r.id = ?`,
      [id]
    );
    if (!rows.length) return res.status(404).json({ message: 'Rezervacija ne obstaja' });
    res.json({ reservation: rows[0] });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ message: 'Napaka pri pridobivanju podatkov' });
  }
});

// ===== ADMIN: Prekliči rezervacijo z izbiro vračila kreditov =====
admin.post('/reservations/:id/cancel', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ message: 'Neveljaven ID' });
  const refund = req.body.refund === true;

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.query(
      'SELECT user_id, krediti_porabili FROM rezervacije WHERE id=? AND preklicano = 0 FOR UPDATE',
      [id]
    );
    if (!rows.length) { await conn.rollback(); return res.status(404).json({ message: 'Rezervacija ne obstaja' }); }

    const krediti = Number(rows[0].krediti_porabili || 0);
    let refundedCredits = 0;
    if (refund && krediti > 0) {
      await conn.query('UPDATE uporabniki SET krediti = krediti + ? WHERE id=?', [krediti, rows[0].user_id]);
      refundedCredits = krediti;
    }

    // ⬇️ Mehko brisanje
    await conn.query('UPDATE rezervacije SET preklicano = 1, datum_preklica = NOW() WHERE id=?', [id]);
    await conn.commit();
    res.json({ message: 'Rezervacija preklicana', refundedCredits });
  } catch (e) {
    await conn.rollback();
    console.error(e.message);
    res.status(500).json({ message: 'Napaka pri preklicu rezervacije' });
  } finally {
    conn.release();
  }
});
// ===== ADMIN: POROČILO (mesečno/letno) =====
app.get('/api/admin/report', requireAuth, requireAdmin, async (req, res) => {
  const year = Number(req.query.year);
  const month = req.query.month ? Number(req.query.month) : null;

  if (!Number.isInteger(year) || year < 2020 || year > 2100) {
    return res.status(400).json({ message: 'Neveljavno leto' });
  }
  if (month !== null && (!Number.isInteger(month) || month < 1 || month > 12)) {
    return res.status(400).json({ message: 'Neveljaven mesec' });
  }

  let dateFrom, dateTo, label;
  if (month) {
    dateFrom = `${year}-${String(month).padStart(2, '0')}-01`;
    const lastDay = new Date(year, month, 0).getDate();
    dateTo = `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
    const monthNames = ['', 'Januar', 'Februar', 'Marec', 'April', 'Maj', 'Junij', 'Julij', 'Avgust', 'September', 'Oktober', 'November', 'December'];
    label = `${monthNames[month]} ${year}`;
  } else {
    dateFrom = `${year}-01-01`;
    dateTo = `${year}-12-31`;
    label = `Leto ${year}`;
  }

  try {
    // ===== VSE REZERVACIJE (skupaj z blokadami) =====
    const [totalRows] = await pool.query(
      'SELECT COUNT(*) as cnt FROM rezervacije WHERE datum BETWEEN ? AND ? AND preklicano = 0',
      [dateFrom, dateTo]
    );
    const [blocksRows] = await pool.query(
      'SELECT COUNT(*) as cnt FROM rezervacije WHERE datum BETWEEN ? AND ? AND blokada = 1 AND preklicano = 0',
      [dateFrom, dateTo]
    );
    const [cancelledRows] = await pool.query(
      'SELECT COUNT(*) as cnt FROM rezervacije WHERE datum BETWEEN ? AND ? AND preklicano = 1',
      [dateFrom, dateTo]
    );

    // ===== SAMO REZERVACIJE UPORABNIKOV + ADMINA (brez blokad) =====
    const [userResRows] = await pool.query(
      'SELECT COUNT(*) as cnt FROM rezervacije WHERE datum BETWEEN ? AND ? AND preklicano = 0 AND blokada = 0',
      [dateFrom, dateTo]
    );

    // Porabljeni krediti (samo uporabniki, brez blokad)
    const [creditsRows] = await pool.query(
      'SELECT COALESCE(SUM(krediti_porabili), 0) as total FROM rezervacije WHERE datum BETWEEN ? AND ? AND preklicano = 0 AND blokada = 0',
      [dateFrom, dateTo]
    );

    // Rezervacije s sezonsko karto
    const [annualRows] = await pool.query(
      'SELECT COUNT(*) as cnt FROM rezervacije WHERE datum BETWEEN ? AND ? AND preklicano = 0 AND blokada = 0 AND letna_karta_uporabljena = 1',
      [dateFrom, dateTo]
    );

    // Rezervacije plačane s kartico (enkratno)
    const [cardRows] = await pool.query(
      'SELECT COUNT(*) as cnt FROM rezervacije WHERE datum BETWEEN ? AND ? AND preklicano = 0 AND blokada = 0 AND placilo_z_kartico = 1',
      [dateFrom, dateTo]
    );

    // Rezervacije plačane s krediti (odšteti krediti > 0)
    const [creditPaidRows] = await pool.query(
      'SELECT COUNT(*) as cnt FROM rezervacije WHERE datum BETWEEN ? AND ? AND preklicano = 0 AND blokada = 0 AND krediti_porabili > 0',
      [dateFrom, dateTo]
    );

    // Skupno število ur (vse, tudi blokade)
    const [hoursRows] = await pool.query(
      'SELECT COALESCE(SUM(trajanje), 0) as total FROM rezervacije WHERE datum BETWEEN ? AND ? AND preklicano = 0',
      [dateFrom, dateTo]
    );

    // Skupno število ur samo uporabnikov + admina
    const [userHoursRows] = await pool.query(
      'SELECT COALESCE(SUM(trajanje), 0) as total FROM rezervacije WHERE datum BETWEEN ? AND ? AND preklicano = 0 AND blokada = 0',
      [dateFrom, dateTo]
    );

    // ===== TOP STATISTIKA – SAMO UPORABNIKI + ADMIN (brez blokad) =====
    const [topCourtRows] = await pool.query(
      'SELECT igrisce, COUNT(*) as cnt FROM rezervacije WHERE datum BETWEEN ? AND ? AND preklicano = 0 AND blokada = 0 GROUP BY igrisce ORDER BY cnt DESC LIMIT 1',
      [dateFrom, dateTo]
    );

    const [topUserRows] = await pool.query(
      `SELECT u.ime, u.priimek, COUNT(*) as cnt 
       FROM rezervacije r 
       JOIN uporabniki u ON u.id = r.user_id 
       WHERE r.datum BETWEEN ? AND ? AND r.preklicano = 0 AND r.blokada = 0 
       GROUP BY r.user_id ORDER BY cnt DESC LIMIT 1`,
      [dateFrom, dateTo]
    );

    const [topHourRows] = await pool.query(
      'SELECT ura_zacetka, COUNT(*) as cnt FROM rezervacije WHERE datum BETWEEN ? AND ? AND preklicano = 0 AND blokada = 0 GROUP BY ura_zacetka ORDER BY cnt DESC LIMIT 1',
      [dateFrom, dateTo]
    );

    const [uniqueUsersRows] = await pool.query(
      'SELECT COUNT(DISTINCT user_id) as cnt FROM rezervacije WHERE datum BETWEEN ? AND ? AND preklicano = 0 AND blokada = 0',
      [dateFrom, dateTo]
    );

    // Dnevna statistika
    const [dailyRows] = await pool.query(
      `SELECT DATE_FORMAT(datum, '%Y-%m-%d') as dan,
              COUNT(*) as rezervacije,
              SUM(CASE WHEN preklicano = 0 THEN 1 ELSE 0 END) as aktivne,
              SUM(CASE WHEN preklicano = 1 THEN 1 ELSE 0 END) as preklicane,
              COALESCE(SUM(CASE WHEN preklicano = 0 THEN krediti_porabili ELSE 0 END), 0) as krediti
       FROM rezervacije
       WHERE datum BETWEEN ? AND ?
       GROUP BY dan
       ORDER BY dan ASC`,
      [dateFrom, dateTo]
    );

    res.json({
      label,
      dateFrom,
      dateTo,
      stats: {
        // Vse skupaj (z blokadami)
        totalAllReservations: totalRows[0].cnt,
        blocks: blocksRows[0].cnt,
        cancelledReservations: cancelledRows[0].cnt,
        totalHours: Number(hoursRows[0].total),

        // Samo uporabniki + admin
        userReservations: userResRows[0].cnt,
        userHours: Number(userHoursRows[0].total),
        uniqueUsers: uniqueUsersRows[0].cnt,

        // Krediti in plačila
        totalCreditsUsed: Number(creditsRows[0].total),
        annualCardReservations: annualRows[0].cnt,
        cardPaidReservations: cardRows[0].cnt,
        creditPaidReservations: creditPaidRows[0].cnt,

        // Top (samo uporabniki + admin)
        topCourt: topCourtRows[0] ? `Igrišče ${topCourtRows[0].igrisce} (${topCourtRows[0].cnt} rezervacij)` : '—',
        topUser: topUserRows[0] ? `${topUserRows[0].ime} ${topUserRows[0].priimek} (${topUserRows[0].cnt} rezervacij)` : '—',
        topHour: topHourRows[0] ? `${String(topHourRows[0].ura_zacetka).padStart(2, '0')}:00 (${topHourRows[0].cnt} rezervacij)` : '—'
      },
      daily: dailyRows
    });
  } catch (err) {
    console.error('report', err.message);
    res.status(500).json({ message: 'Napaka pri generiranju poročila' });
  }
});
// ===== ADMIN: FIKSNI (PONAVLJAJOČI) TERMINI =====

// Pomožna funkcija: vrne vse datume v obsegu z določenim dnevom in intervalom
function getFixedDates(fromStr, toStr, dayOfWeek, intervalWeeks) {
  const dates = [];
  const fromDate = new Date(fromStr + 'T00:00:00');
  const toDate = new Date(toStr + 'T00:00:00');
  let current = new Date(fromDate);
  const diff = (dayOfWeek - current.getDay() + 7) % 7;
  current.setDate(current.getDate() + diff);
  while (current <= toDate) {
    const y = current.getFullYear();
    const m = String(current.getMonth() + 1).padStart(2, '0');
    const d = String(current.getDate()).padStart(2, '0');
    dates.push(`${y}-${m}-${d}`);
    current.setDate(current.getDate() + 7 * intervalWeeks);
  }
  return dates;
}

// Predogled fiksnih terminov (BREZ preverjanja kreditov)
app.post('/api/admin/fixed-reservations/preview', requireAuth, requireAdmin, async (req, res) => {
  const userId = Number(req.body.user_id);
  const igrisce = Number(req.body.igrisce);
  const danVTednu = Number(req.body.dan_v_tednu);
  const uraZacetka = Number(req.body.ura_zacetka);
  const trajanje = Number(req.body.trajanje);
  const datumOd = String(req.body.datum_od || '');
  const datumDo = String(req.body.datum_do || '');
  const interval = Number(req.body.interval_tednov) === 2 ? 2 : 1;

  if (!Number.isInteger(userId) || userId < 1) return res.status(400).json({ message: 'Neveljaven uporabnik' });
  if (!Number.isInteger(igrisce) || igrisce < 1 || igrisce > 9) return res.status(400).json({ message: 'Neveljavno igrišče' });
  if (!Number.isInteger(danVTednu) || danVTednu < 0 || danVTednu > 6) return res.status(400).json({ message: 'Neveljaven dan v tednu' });
  if (!Number.isInteger(uraZacetka) || uraZacetka < 8 || uraZacetka >= 22) return res.status(400).json({ message: 'Neveljavna ura' });
  if (!Number.isInteger(trajanje) || trajanje < 1 || uraZacetka + trajanje > 22) return res.status(400).json({ message: 'Neveljavno trajanje' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(datumOd) || !/^\d{4}-\d{2}-\d{2}$/.test(datumDo)) return res.status(400).json({ message: 'Neveljavna datuma' });
  if (datumOd > datumDo) return res.status(400).json({ message: 'Datum "od" mora biti pred datumom "do"' });

  try {
    const [userRows] = await pool.query('SELECT id, ime, priimek FROM uporabniki WHERE id=?', [userId]);
    if (!userRows.length) return res.status(404).json({ message: 'Uporabnik ne obstaja' });
    const user = userRows[0];

    const dates = getFixedDates(datumOd, datumDo, danVTednu, interval);
    if (dates.length === 0) return res.json({ dates: [], freeDates: [], conflictDates: [], user, total: 0, freeCount: 0, conflictCount: 0 });

    const [existing] = await pool.query(
      `SELECT DATE_FORMAT(datum, '%Y-%m-%d') AS datum FROM rezervacije
       WHERE igrisce=? AND preklicano=0 AND datum BETWEEN ? AND ?
       AND ura_zacetka < ? AND ura_zacetka + trajanje > ?`,
      [igrisce, datumOd, datumDo, uraZacetka + trajanje, uraZacetka]
    );
    const takenDates = new Set(existing.map(r => r.datum));

    const freeDates = dates.filter(d => !takenDates.has(d));
    const conflictDates = dates.filter(d => takenDates.has(d));

    res.json({
      dates,
      freeDates,
      conflictDates,
      user: { id: user.id, ime: user.ime, priimek: user.priimek },
      total: dates.length,
      freeCount: freeDates.length,
      conflictCount: conflictDates.length
    });
  } catch (err) {
    console.error('fixed preview', err.message);
    res.status(500).json({ message: 'Napaka pri predogledu' });
  }
});

// Ustvari fiksne termine (BREZ porabe kreditov)
app.post('/api/admin/fixed-reservations', requireAuth, requireAdmin, async (req, res) => {
  const userId = Number(req.body.user_id);
  const igrisce = Number(req.body.igrisce);
  const danVTednu = Number(req.body.dan_v_tednu);
  const uraZacetka = Number(req.body.ura_zacetka);
  const trajanje = Number(req.body.trajanje);
  const datumOd = String(req.body.datum_od || '');
  const datumDo = String(req.body.datum_do || '');
  const interval = Number(req.body.interval_tednov) === 2 ? 2 : 1;
    let oznaka = req.body.oznaka ? String(req.body.oznaka).trim().slice(0, 100) : null;
  // Če ni oznake, uporabi ime in priimek uporabnika
  if (!oznaka) {
    const [uRows] = await pool.query('SELECT ime, priimek FROM uporabniki WHERE id=?', [userId]);
    if (uRows.length) oznaka = `${uRows[0].ime} ${uRows[0].priimek}`;
    else oznaka = 'Fiksni termin';
  }

  try {
    const [userRows] = await pool.query('SELECT id FROM uporabniki WHERE id=?', [userId]);
    if (!userRows.length) return res.status(404).json({ message: 'Uporabnik ne obstaja' });

    const dates = getFixedDates(datumOd, datumDo, danVTednu, interval);
    if (dates.length === 0) return res.status(400).json({ message: 'Ni datumov v izbranem obsegu' });

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      let created = 0;
      let skipped = 0;
      const createdDates = [];
      const skippedDates = [];

      for (const d of dates) {
        const [conflict] = await conn.query(
          `SELECT id FROM rezervacije
           WHERE igrisce=? AND datum=? AND preklicano=0
           AND ura_zacetka < ? AND ura_zacetka + trajanje > ?
           FOR UPDATE`,
          [igrisce, d, uraZacetka + trajanje, uraZacetka]
        );
        if (conflict.length) {
          skipped++;
          skippedDates.push(d);
          continue;
        }

        // Ustvari rezervacijo BREZ porabe kreditov
        await conn.query(
          `INSERT INTO rezervacije
           (user_id, igrisce, datum, ura_zacetka, trajanje, krediti_porabili, letna_karta_uporabljena, oznaka)
           VALUES (?, ?, ?, ?, ?, 0, 0, ?)`,
          [userId, igrisce, d, uraZacetka, trajanje, oznaka]
        );

        created++;
        createdDates.push(d);
      }

      await conn.commit();
      res.json({
        message: 'Fiksni termini ustvarjeni',
        created,
        skipped,
        createdDates,
        skippedDates
      });
    } catch (e) {
      await conn.rollback();
      console.error('fixed create', e.message);
      res.status(500).json({ message: 'Napaka pri ustvarjanju fiksnih terminov' });
    } finally {
      conn.release();
    }
  } catch (err) {
    console.error('fixed create outer', err.message);
    res.status(500).json({ message: 'Napaka' });
  }
});
// ===== NASTAVITVE (SEZONA) =====

// Javno branje sezone (uporabljajo vsi uporabniki)
// Javno branje sezone
app.get('/api/nastavitve', async (_req, res) => {
  try {
    const [rows] = await pool.query('SELECT kljuc, vrednost FROM nastavitve');
    const settings = {};
    rows.forEach(r => { settings[r.kljuc] = r.vrednost; });
    res.json({ settings });
  } catch (err) {
    res.status(500).json({ message: 'Napaka' });
  }
});
// ===== ADMIN: ZAPRTJE OBDOBJA (od/do, ura od/do) =====
app.post('/api/admin/period-block', requireAuth, requireAdmin, async (req, res) => {
  const datumOd = String(req.body.datum_od || '');
  const datumDo = String(req.body.datum_do || '');
  const uraZacetka = Number(req.body.ura_zacetka);
  const uraKonca = Number(req.body.ura_konca);
  const igriscaInput = Array.isArray(req.body.igrisca) && req.body.igrisca.length
    ? req.body.igrisca.map(Number)
    : [1,2,3,4,5,6,7,8,9];
  const oznaka = String(req.body.oznaka || 'Zaprto').trim().slice(0, 100);

  if (!/^\d{4}-\d{2}-\d{2}$/.test(datumOd) || !/^\d{4}-\d{2}-\d{2}$/.test(datumDo))
    return res.status(400).json({ message: 'Neveljavna datuma' });
  if (new Date(datumOd + 'T00:00:00') > new Date(datumDo + 'T00:00:00'))
    return res.status(400).json({ message: 'Datum "od" mora biti pred "do"' });
  if (!Number.isInteger(uraZacetka) || uraZacetka < 8 || uraZacetka >= 22 ||
      !Number.isInteger(uraKonca) || uraKonca <= uraZacetka || uraKonca > 22)
    return res.status(400).json({ message: 'Neveljaven časovni obseg' });

  const daysDiff = Math.floor((new Date(datumDo + 'T00:00:00') - new Date(datumOd + 'T00:00:00')) / 86400000);
  if (daysDiff > 90) return res.status(400).json({ message: 'Obdobje je predolgo (max 90 dni)' });

  const trajanje = uraKonca - uraZacetka;
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    let totalRefunded = 0, totalRefundedCount = 0, totalBlocks = 0;

    let current = new Date(datumOd + 'T00:00:00');
    const end = new Date(datumDo + 'T00:00:00');

    while (current <= end) {
      const y = current.getFullYear();
      const m = String(current.getMonth() + 1).padStart(2, '0');
      const d = String(current.getDate()).padStart(2, '0');
      const datumStr = `${y}-${m}-${d}`;

      for (const ig of igriscaInput) {
        if (ig < 1 || ig > 9) continue;

        const [existing] = await conn.query(
          `SELECT id, user_id, krediti_porabili FROM rezervacije
           WHERE igrisce=? AND datum=? AND preklicano=0
           AND ura_zacetka < ? AND ura_zacetka + trajanje > ?
           FOR UPDATE`,
          [ig, datumStr, uraKonca, uraZacetka]
        );
        for (const r of existing) {
          const refund = Number(r.krediti_porabili || 0);
          if (refund > 0) {
            await conn.query('UPDATE uporabniki SET krediti = krediti + ? WHERE id=?', [refund, r.user_id]);
            totalRefunded += refund;
            totalRefundedCount++;
          }
        }
        if (existing.length > 0) {
          await conn.query(
            `UPDATE rezervacije SET preklicano=1, datum_preklica=NOW()
             WHERE igrisce=? AND datum=? AND preklicano=0
             AND ura_zacetka < ? AND ura_zacetka + trajanje > ?`,
            [ig, datumStr, uraKonca, uraZacetka]
          );
        }

                await conn.query(
          `INSERT INTO rezervacije 
           (user_id, igrisce, datum, ura_zacetka, trajanje, krediti_porabili, letna_karta_uporabljena, oznaka, blokada, placilo_status)
           VALUES (?, ?, ?, ?, ?, 0, 0, ?, 1, 'placano')`,
          [req.user.id, ig, datumStr, uraZacetka, trajanje, oznaka]
        );
        totalBlocks++;
      }
      current.setDate(current.getDate() + 1);
    }

    await conn.commit();
    res.json({
      message: 'Obdobje zaprto',
      blocksCreated: totalBlocks,
      daysCount: daysDiff + 1,
      refundedCount: totalRefundedCount,
      refundedTotal: totalRefunded
    });
  } catch (err) {
    await conn.rollback();
    console.error('period block', err.message);
    res.status(500).json({ message: 'Napaka pri ustvarjanju zaprtja' });
  } finally {
    conn.release();
  }
});

// Admin – spremeni sezono
app.put('/api/admin/nastavitve/:kljuc', requireAuth, requireAdmin, async (req, res) => {
  const kljuc = String(req.params.kljuc).slice(0, 50);
  const vrednost = String(req.body.vrednost || '').slice(0, 255);
  try {
    await pool.query(
      'INSERT INTO nastavitve (kljuc, vrednost) VALUES (?, ?) ON DUPLICATE KEY UPDATE vrednost = ?',
      [kljuc, vrednost, vrednost]
    );
    res.json({ message: 'Nastavitev shranjena' });
  } catch (err) {
    res.status(500).json({ message: 'Napaka' });
  }
});
app.use('/api/admin', admin);

// ===== STRIPE – REZERVACIJA S KARTICO =====
app.post(
  '/api/payments/create-reservation-checkout-session',
  requireAuth,
  async (req, res) => {
    const igrisce = Number(req.body.igrisce);
    const uraZacetka = Number(req.body.ura_zacetka);
    const trajanje = Number(req.body.trajanje);
    const datum = String(req.body.datum || '');
    const oznaka = req.body.oznaka
      ? String(req.body.oznaka).trim().slice(0, 100)
      : null;

    const endHour = await getEndHour();

    const validationError = validateReservation({
      igrisce,
      ura: uraZacetka,
      trajanje,
      datum,
      endHour,
      isAdmin: !!req.user.admin
    });

    if (validationError) {
      return res.status(400).json({ message: validationError });
    }

    let pendingId;
    const lockName = reservationLockName(igrisce, datum);

    try {
      await withReservationLock(lockName, async (conn) => {
        await conn.beginTransaction();

        await conn.query(
          `UPDATE rezervacije
           SET preklicano = 1,
               placilo_status = 'preklicano',
               hold_expires_at = NULL
           WHERE placilo_status = 'pending'
             AND hold_expires_at < NOW()
             AND preklicano = 0`
        );

        const [conflicts] = await conn.query(
          `SELECT id
           FROM rezervacije
           WHERE igrisce = ?
             AND datum = ?
             AND ura_zacetka < ?
             AND ura_zacetka + trajanje > ?
             AND preklicano = 0
             AND (placilo_status IS NULL OR placilo_status IN ('pending','placano'))
             AND (hold_expires_at IS NULL OR hold_expires_at > NOW())
           FOR UPDATE`,
          [igrisce, datum, uraZacetka + trajanje, uraZacetka]
        );

        if (conflicts.length) {
          const err = new Error('Termin je že zaseden');
          err.status = 409;
          throw err;
        }

        const [ins] = await conn.query(
          `INSERT INTO rezervacije
           (user_id, igrisce, datum, ura_zacetka, trajanje,
            krediti_porabili, letna_karta_uporabljena, oznaka,
            placilo_z_kartico, placilo_status, hold_expires_at)
           VALUES (?, ?, ?, ?, ?, 0, 0, ?, 1, 'pending',
                   DATE_ADD(NOW(), INTERVAL 15 MINUTE))`,
          [req.user.id, igrisce, datum, uraZacetka, trajanje, oznaka]
        );

        pendingId = ins.insertId;
        await conn.commit();
      });
    } catch (err) {
      if (err.status === 409) {
        return res.status(409).json({ message: err.message });
      }

      console.error('pending reservation', err.message);
      return res.status(500).json({ message: 'Napaka pri pripravi rezervacije' });
    }

    const [sezRows] = await pool.query(
      'SELECT vrednost FROM nastavitve WHERE kljuc = "sezona"'
    );
    const sezona = sezRows.length ? sezRows[0].vrednost : 'poletje';

    const credits = calculateCredits(uraZacetka, trajanje, igrisce, sezona);
    const price = credits * 10;

    const d = new Date(datum + 'T00:00:00');
    const dayNames = ['Ned', 'Pon', 'Tor', 'Sre', 'Čet', 'Pet', 'Sob'];
    const monthNames = [
      'jan', 'feb', 'mar', 'apr', 'maj', 'jun',
      'jul', 'avg', 'sep', 'okt', 'nov', 'dec'
    ];

    const dateLabel = `${dayNames[d.getDay()]}, ${d.getDate()}. ${monthNames[d.getMonth()]} ${d.getFullYear()}`;
    const timeLabel = `${String(uraZacetka).padStart(2, '0')}:00–${String(
      uraZacetka + trajanje
    ).padStart(2, '0')}:00`;

    let session;

    try {
      session = await stripe.checkout.sessions.create({
        payment_method_types: ['card'],
        mode: 'payment',
        customer_email: req.user.email,
        line_items: [
          {
            price_data: {
              currency: 'eur',
              product_data: {
                name: `Rezervacija igrišča ${igrisce}`,
                description: `${dateLabel} ob ${timeLabel} (${trajanje}h) – Zavrl Tennis Team`
              },
              unit_amount: Math.round(price * 100)
            },
            quantity: 1
          }
        ],
        success_url: `${process.env.FRONTEND_URL}/app?payment=success&type=reservation`,
        cancel_url: `${process.env.FRONTEND_URL}/app?payment=cancel`,
        metadata: {
          type: 'reservation',
          userId: String(req.user.id),
          reservationId: String(pendingId),
          igrisce: String(igrisce),
          datum,
          ura_zacetka: String(uraZacetka),
          trajanje: String(trajanje),
          oznaka: oznaka || ''
        }
      });

      await pool.query(
        'UPDATE rezervacije SET stripe_session_id = ? WHERE id = ?',
        [session.id, pendingId]
      );

      res.json({ url: session.url });
    } catch (err) {
      await pool.query(
        `UPDATE rezervacije
         SET preklicano = 1,
             placilo_status = 'preklicano',
             hold_expires_at = NULL
         WHERE id = ?`,
        [pendingId]
      );

      console.error('stripe reservation session', err.message);
      res.status(500).json({ message: 'Napaka pri pripravi plačila' });
    }
  }
);

// ===== STRIPE – USTVARI CHECKOUT SESSION =====
app.post('/api/payments/create-checkout-session', requireAuth, async (req, res) => {
  const credits = Number(req.body.credits);

  // Validacija: 0.5 do 10, korak 0.5
  if (!Number.isFinite(credits) || credits < 0.5 || credits > 10) {
    return res.status(400).json({ message: 'Neveljavno število kreditov (0,5–10)' });
  }
  const doubled = credits * 2;
  if (Math.abs(doubled - Math.round(doubled)) > 1e-9) {
    return res.status(400).json({ message: 'Krediti morajo biti v korakih po 0,5' });
  }

  // Cena: 10 kreditov = 80 €, drugače 10 € / kredit
  const computedPrice = credits === 10 ? 80 : credits * 10;

  const creditsLabel = Number.isInteger(credits) 
    ? credits.toString() 
    : credits.toFixed(1);

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'payment',
      customer_email: req.user.email,
      line_items: [{
        price_data: {
          currency: 'eur',
          product_data: {
    name: credits === 10 
        ? `Paket 10 kreditov – Zavrl Tennis Team`
        : `Nakup ${creditsLabel} ${credits === 0.5 ? 'kredita' : (credits === 1 ? 'kredit' : 'kreditov')} – Zavrl Tennis Team`,
    description: credits === 10
        ? `Prihranek 20 € – krediti za rezervacijo teniških igrišč (1 kredit = 10 €)`
        : `Krediti za rezervacijo teniških igrišč (1 kredit = 10 €)`
},
          unit_amount: Math.round(computedPrice * 100)
        },
        quantity: 1
      }],
      success_url: `${process.env.FRONTEND_URL}/app?payment=success&type=credits`,
      cancel_url: `${process.env.FRONTEND_URL}/app?payment=cancel`,
      metadata: {
        userId: String(req.user.id),
        credits: String(credits)
      }
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error('stripe session', err.message);
    res.status(500).json({ message: 'Napaka pri pripravi plačila' });
  }
});
const frontendPath = path.join(__dirname, '..', 'Frontend');
app.get('/', (_req,res)=>res.sendFile(path.join(frontendPath,'landing.html')));
app.get('/o-klubu', (_req,res)=>res.sendFile(path.join(frontendPath,'o-klubu.html')));
app.get('/rekreacija', (_req,res)=>res.sendFile(path.join(frontendPath,'rekreacija.html')));
app.get('/cenik', (_req,res)=>res.sendFile(path.join(frontendPath,'cenik.html')));
app.get('/novice', (_req,res)=>res.sendFile(path.join(frontendPath,'novice.html')));
app.get('/kontakt', (_req,res)=>res.sendFile(path.join(frontendPath,'kontakt.html')));
app.get('/app', (_req,res)=>res.sendFile(path.join(frontendPath,'index.html')));
app.use(express.static(frontendPath,{ index:false, maxAge:'1h' }));
app.get('*', (_req,res)=>res.sendFile(path.join(frontendPath,'landing.html')));
app.use((err,req,res,_next)=>{ if(err.message==='Origin ni dovoljen') return res.status(403).json({message:'Origin ni dovoljen'}); console.error(err); res.status(500).json({message:'Nepričakovana napaka'}); });
const PORT=process.env.PORT||3000;
app.listen(PORT,()=>console.log(`Zavrl Tennis Team teče na portu ${PORT}`));



