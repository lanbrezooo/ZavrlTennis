const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
require('dotenv').config();
const pool = require('./db');
const authRoutes = require('./routes/auth');
const reservationRoutes = require('./routes/reservations');
const { requireAuth, requireAdmin } = require('./middleware');
const app = express();
const allowedOrigin = process.env.CORS_ORIGIN || '';

app.disable('x-powered-by',1);
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(cors({ origin(origin, cb) { if (!origin || !allowedOrigin || origin === allowedOrigin) return cb(null, true); cb(new Error('Origin ni dovoljen')); }, methods: ['GET','POST','PUT','DELETE'], allowedHeaders: ['Content-Type','Authorization'] }));
app.use(express.json({ limit: '50mb' })); // Povečamo za base64 slike
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
admin.get('/reservations', async (_req,res)=>{ try { const [reservations]=await pool.query('SELECT r.*,u.ime,u.priimek,u.email FROM rezervacije r JOIN uporabniki u ON u.id=r.user_id ORDER BY r.datum DESC,r.ura_zacetka ASC'); res.json({reservations}); }catch(e){console.error(e.message);res.status(500).json({message:'Napaka pri pridobivanju rezervacij'});} });
admin.delete('/reservations/:id', async (req,res)=>{
  const id=Number(req.params.id); if(!Number.isInteger(id)||id<1) return res.status(400).json({message:'Neveljaven ID'});
  const conn=await pool.getConnection();
  try { await conn.beginTransaction(); const [rows]=await conn.query('SELECT user_id, krediti_porabili FROM rezervacije WHERE id=? FOR UPDATE',[id]); if(!rows.length){await conn.rollback();return res.status(404).json({message:'Rezervacija ne obstaja'});} const refund=Number(rows[0].krediti_porabili||0); if(refund>0) await conn.query('UPDATE uporabniki SET krediti=krediti+? WHERE id=?',[refund,rows[0].user_id]); await conn.query('DELETE FROM rezervacije WHERE id=?',[id]); await conn.commit(); res.json({message:'Rezervacija izbrisana',refundedCredits:refund}); } catch(e){await conn.rollback();console.error(e.message);res.status(500).json({message:'Napaka pri brisanju rezervacije'});} finally {conn.release();}
});
admin.delete('/reservations', async (_req,res)=>{
  const conn=await pool.getConnection();
  try { await conn.beginTransaction(); const [reservations]=await conn.query('SELECT user_id, krediti_porabili FROM rezervacije FOR UPDATE'); const refunds=new Map(); for(const row of reservations) refunds.set(row.user_id,(refunds.get(row.user_id)||0)+Number(row.krediti_porabili||0)); for(const [userId,refund] of refunds){ if(refund>0) await conn.query('UPDATE uporabniki SET krediti=krediti+? WHERE id=?',[refund,userId]); } await conn.query('DELETE FROM rezervacije'); await conn.commit(); res.json({message:'Vse rezervacije izbrisane'}); } catch(e){await conn.rollback();console.error(e.message);res.status(500).json({message:'Napaka pri brisanju rezervacij'});} finally {conn.release();}
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
          `DELETE FROM rezervacije 
           WHERE igrisce = ? AND datum = ? 
           AND ura_zacetka < ? AND ura_zacetka + trajanje > ?`,
          [ig, datum, ura + trajanje, ura]
        );
      }

      // Ustvari novo blokado
      await conn.query(
        `INSERT INTO rezervacije 
         (user_id, igrisce, datum, ura_zacetka, trajanje, krediti_porabili, letna_karta_uporabljena, oznaka, blokada)
         VALUES (?, ?, ?, ?, ?, 0, 0, ?, 1)`,
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
app.use('/api/admin', admin);
app.use('/api', (_req,res)=>res.status(404).json({message:'API pot ne obstaja'}));

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