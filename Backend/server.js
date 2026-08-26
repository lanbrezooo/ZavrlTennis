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

app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(cors({ origin(origin, cb) { if (!origin || !allowedOrigin || origin === allowedOrigin) return cb(null, true); cb(new Error('Origin ni dovoljen')); }, methods: ['GET','POST','PUT','DELETE'], allowedHeaders: ['Content-Type','Authorization'] }));
app.use(express.json({ limit: '100kb' }));
app.use(rateLimit({ windowMs: 15*60*1000, max: 500, standardHeaders: true, legacyHeaders: false, message: { message: 'Preveč zahtevkov. Poskusite kasneje.' } }));
app.use('/api/auth/login', rateLimit({ windowMs: 15*60*1000, max: 10, standardHeaders: true, legacyHeaders: false, message: { message: 'Preveč poskusov prijave. Poskusite čez nekaj minut.' } }));
app.use('/api/auth/register', rateLimit({ windowMs: 60*60*1000, max: 20, standardHeaders: true, legacyHeaders: false, message: { message: 'Preveč registracij. Poskusite kasneje.' } }));
app.use('/api/auth', authRoutes);
app.use('/api/reservations', reservationRoutes);

const admin = express.Router();
admin.use(requireAuth, requireAdmin);
admin.get('/users', async (_req,res) => { try { const [users] = await pool.query('SELECT id, ime, priimek, email, telefon, leto_rojstva, opis, nivo, letna_karta, krediti, admin, created_at FROM uporabniki ORDER BY id DESC'); res.json({users}); } catch(e){ console.error(e.message); res.status(500).json({message:'Napaka pri pridobivanju uporabnikov'}); } });
admin.put('/users/:id', async (req,res) => { const id=Number(req.params.id); if(!Number.isInteger(id)||id<1) return res.status(400).json({message:'Neveljaven ID'}); const b=req.body; if(!String(b.ime||'').trim()||!String(b.priimek||'').trim()||!String(b.email||'').includes('@')) return res.status(400).json({message:'Preverite obvezna polja'}); const credits=Number(b.krediti); if(!Number.isInteger(credits)||credits<0) return res.status(400).json({message:'Krediti morajo biti celo število 0 ali več'}); try { await pool.query('UPDATE uporabniki SET ime=?, priimek=?, email=?, telefon=?, leto_rojstva=?, opis=?, nivo=?, letna_karta=?, krediti=?, admin=? WHERE id=?',[String(b.ime).trim().slice(0,50),String(b.priimek).trim().slice(0,50),String(b.email).trim().toLowerCase().slice(0,100),String(b.telefon||'').trim().slice(0,30)||null,b.leto_rojstva?Number(b.leto_rojstva):null,String(b.opis||'').slice(0,1000),String(b.nivo||'Rekreativec').slice(0,50),b.letna_karta?1:0,credits,b.admin?1:0,id]); res.json({message:'Uporabnik posodobljen'}); } catch(e){ if(e.code==='ER_DUP_ENTRY') return res.status(409).json({message:'Email že obstaja'}); console.error(e.message); res.status(500).json({message:'Napaka pri posodabljanju uporabnika'}); } });
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
app.use('/api/admin', admin);
app.use('/api', (_req,res)=>res.status(404).json({message:'API pot ne obstaja'}));

const frontendPath = path.join(__dirname, '..', 'Frontend');
// Pomembno: index:false prepreči, da express.static na / samodejno pošlje index.html.
app.get('/', (_req,res)=>res.sendFile(path.join(frontendPath,'landing.html')));
app.get('/app', (_req,res)=>res.sendFile(path.join(frontendPath,'index.html')));
app.use(express.static(frontendPath,{ index:false, maxAge:'1h' }));
app.get('*', (_req,res)=>res.sendFile(path.join(frontendPath,'landing.html')));
app.use((err,req,res,_next)=>{ if(err.message==='Origin ni dovoljen') return res.status(403).json({message:'Origin ni dovoljen'}); console.error(err); res.status(500).json({message:'Nepričakovana napaka'}); });
const PORT=process.env.PORT||3000;
app.listen(PORT,()=>console.log(`Zavrl Tennis Team teče na portu ${PORT}`));
