require('dotenv').config();
const { Client, GatewayIntentBits, Events } = require('discord.js');
const admin = require('firebase-admin');

admin.initializeApp({
  credential: admin.credential.cert({
    projectId:   process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey:  process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
  }),
});
const db = admin.firestore();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const CHANNEL_LOGS_IG = process.env.CHANNEL_LOGS_IG;

const now = () => admin.firestore.FieldValue.serverTimestamp();

// ─── Parser fields format "key:value" ───────────────────────────────────────
function parseFields(embed) {
  const data = {};
  // Description
  for (const line of (embed.description || '').split('\n')) {
    const m = line.match(/^(\w+):(.+)$/);
    if (m) data[m[1].toLowerCase()] = m[2].trim();
  }
  // Fields (chaque field a name + value au format "name:value" ou juste value)
  for (const f of (embed.fields || [])) {
    const key = (f.name || '').toLowerCase().replace(/\s+/g, '');
    // value peut être "key:value" ou juste la valeur
    const mv = (f.value || '').match(/^[^:]+:(.+)$/s);
    data[key] = mv ? mv[1].trim() : (f.value || '').trim();
  }
  return data;
}

function parseMontant(str) {
  if (!str) return 0;
  return parseInt(String(str).replace(/[^0-9]/g, '')) || 0;
}

// ─── Handlers ────────────────────────────────────────────────────────────────

async function handlePaid(embed, msgId) {
  const d = parseFields(embed);
  const montant = parseMontant(d.amount);
  if (!montant) return;
  const factureId = d.billid || d.billId || '';
  const data = {
    factureId,
    emetteur:     d.frompropername || d.fromname || 'Inconnu',
    destinataire: d.topropername   || d.toname   || 'Inconnu',
    montant,
    raison:       d.reason || '',
    status:       'payee',
    paiement:     '',
    creeLe:       d.createtimeformatted || d.date || '',
    payeeLe:      d.date || '',
    msgId,
    timestamp:    now(),
  };
  if (factureId) {
    await db.collection('factures').doc(factureId).set(data, { merge: true });
  } else {
    await db.collection('factures').add(data);
  }
  console.log(`✅ Facture payée #${factureId} — ${montant}$ (${data.emetteur} → ${data.destinataire})`);

  // Aussi enregistrer comme transaction entrée
  await db.collection('transactions').add({
    type: 'entree',
    montant,
    categorie: 'vente_client',
    raison: data.raison,
    personne: data.emetteur,
    soldeApres: parseMontant(d.after),
    msgId,
    timestamp: now(),
  });
}

async function handleAddmoney(embed, msgId) {
  const d = parseFields(embed);
  const montant = parseMontant(d.amount);
  if (!montant) return;
  const raison = d.reason || '';
  const iban   = (d.iban || '').toUpperCase();
  // Ignorer si c'est pas le compte LTD
  if (iban && !iban.includes('LTD')) return;
  // Ignorer si c'est un paiement de facture (déjà géré par handlePaid)
  if (raison.toLowerCase().includes('paiement facture')) return;
  let categorie = 'autre';
  if (raison.toLowerCase().includes('redistribution')) categorie = 'essence';
  else if (raison.toLowerCase().includes('salaire'))   categorie = 'salaire';
  await db.collection('transactions').add({
    type: 'entree',
    montant,
    categorie,
    raison,
    personne: d.frompropername || d.fromname || 'Inconnu',
    soldeAvant: parseMontant(d.before),
    soldeApres: parseMontant(d.after),
    msgId,
    timestamp: now(),
  });
  console.log(`✅ Entrée ${montant}$ [${categorie}] — ${raison}`);
}

async function handleWithdraw(embed, msgId) {
  const d = parseFields(embed);
  const montant = parseMontant(d.amount);
  if (!montant) return;
  const iban = (d.iban || '').toUpperCase();
  if (iban && !iban.includes('LTD')) return;
  const raison = d.reason || '';
  let categorie = 'approvisionnement'; // withdraw = achat/dépense par défaut
  const r = raison.toLowerCase();
  if      (r.includes('salaire'))                          categorie = 'salaire';
  else if (r.includes('loyer') || r.includes('location')) categorie = 'loyer';
  await db.collection('transactions').add({
    type: 'sortie',
    montant,
    categorie,
    raison,
    personne: d.propername || d.properName || d.topropername || d.toname || 'Inconnu',
    soldeAvant: parseMontant(d.before),
    soldeApres: parseMontant(d.after),
    msgId,
    timestamp: now(),
  });
  console.log(`✅ Sortie ${montant}$ [${categorie}] — ${raison}`);
}

async function handleDutySetStatus(embed, msgId) {
  const d = parseFields(embed);
  const status      = String(d.status || '').toLowerCase();
  const properName  = d.propername || d.name || '';
  const isDebut     = status === 'true';
  const isFin       = status === 'false';
  if (!properName || (!isDebut && !isFin)) return;

  if (isDebut) {
    // Vérifier doublon service ouvert
    const existing = await db.collection('services')
      .where('employeNom', '==', properName)
      .limit(10).get();
    if (!existing.empty) {
      const sorted = existing.docs.sort((a, b) => {
        return (b.data().debut?.toDate?.()?.getTime()||0) - (a.data().debut?.toDate?.()?.getTime()||0);
      });
      const last = sorted[0].data();
      if (last.fin === null || last.fin === undefined) {
        console.log(`⚠️  Service déjà ouvert pour ${properName} — ignoré`);
        return;
      }
    }
    await db.collection('services').add({
      employeNom: properName,
      debut: now(),
      fin: null,
      duree: null,
      msgId,
    });
    console.log(`✅ Service début : ${properName}`);
  } else {
    const snap = await db.collection('services')
      .where('employeNom', '==', properName)
      .limit(20).get();
    const openDocs = snap.docs
      .filter(doc => { const f = doc.data().fin; return f === null || f === undefined; })
      .sort((a, b) => (b.data().debut?.toDate?.()?.getTime()||0) - (a.data().debut?.toDate?.()?.getTime()||0));
    if (openDocs.length > 0) {
      const docRef = openDocs[0];
      const debut  = docRef.data().debut?.toDate?.() || new Date();
      const duree  = Math.round((new Date() - debut) / 60000);
      await docRef.ref.update({ fin: admin.firestore.FieldValue.serverTimestamp(), duree });
      console.log(`✅ Service fin : ${properName} (${duree} min)`);
    } else {
      console.log(`⚠️  Pas de service ouvert pour ${properName}`);
    }
  }
}

// ─── Router principal ─────────────────────────────────────────────────────────

async function handleMessage(message) {
  if (!message.embeds?.length) return;
  if (message.channelId !== CHANNEL_LOGS_IG) return;
  const embed = message.embeds[0];
  const title = (embed.title || '').toLowerCase().trim();
  const msgId = message.id;

  console.log(`📨 Embed reçu : "${embed.title}" (channel: ${message.channelId})`);
  try {
    if (title === 'xbankaccount - paid') {
      await handlePaid(embed, msgId);
    } else if (title === 'xbankaccount - addmoney') {
      await handleAddmoney(embed, msgId);
    } else if (title === 'xbankaccount - withdraw') {
      await handleWithdraw(embed, msgId);
    } else if (title === 'duty - setstatus') {
      await handleDutySetStatus(embed, msgId);
    }
  } catch (err) {
    console.error(`❌ Erreur [${title}]: ${err.message}`);
  }
}

// ─── Backfill ─────────────────────────────────────────────────────────────────

async function fetchAllMessages(channel, maxMessages = 10000) {
  const all = [];
  let lastId = null;
  while (all.length < maxMessages) {
    const opts = { limit: 100 };
    if (lastId) opts.before = lastId;
    const batch = await channel.messages.fetch(opts);
    if (!batch.size) break;
    all.push(...batch.values());
    lastId = batch.last()?.id;
    if (batch.size < 100) break;
  }
  return all.sort((a, b) => a.createdTimestamp - b.createdTimestamp);
}

async function getExistingMsgIds(collectionName) {
  try {
    const snap = await db.collection(collectionName).select('msgId').get();
    return new Set(snap.docs.map(d => d.data().msgId).filter(Boolean));
  } catch { return new Set(); }
}

async function backfillAll() {
  console.log('\n📚 Backfill CHANNEL_LOGS_IG...');
  try {
    const ch = await client.channels.fetch(CHANNEL_LOGS_IG);
    if (!ch) { console.log('⚠️  Channel introuvable'); return; }
    const msgs = await fetchAllMessages(ch);
    console.log(`   → ${msgs.length} messages`);

    const existingTx  = await getExistingMsgIds('transactions');
    const existingFac = await getExistingMsgIds('factures');
    const existingSvc = await getExistingMsgIds('services');

    let saved = 0;
    for (const msg of msgs) {
      if (!msg.embeds?.length) continue;
      const embed = message.embeds[0];
      const title = (embed.title || '').toLowerCase().trim();
      const msgId = msg.id;
      try {
        if (title === 'xbankaccount - paid' && !existingFac.has(msgId)) {
          await handlePaid(embed, msgId);
          existingFac.add(msgId); existingTx.add(msgId); saved++;
        } else if (title === 'xbankaccount - addmoney' && !existingTx.has(msgId)) {
          await handleAddmoney(embed, msgId);
          existingTx.add(msgId); saved++;
        } else if (title === 'xbankaccount - withdraw' && !existingTx.has(msgId)) {
          await handleWithdraw(embed, msgId);
          existingTx.add(msgId); saved++;
        } else if (title === 'duty - setstatus' && !existingSvc.has(msgId)) {
          await handleDutySetStatus(embed, msgId);
          existingSvc.add(msgId); saved++;
        }
      } catch (e) {
        if (e?.message?.includes('Quota')) {
          console.warn('⚠️  Quota dépassé — arrêt backfill');
          break;
        }
      }
    }
    console.log(`✅ Backfill terminé — ${saved} enregistrements`);
  } catch (e) {
    console.error(`❌ Backfill : ${e.message}`);
  }
}

// ─── Events Discord ───────────────────────────────────────────────────────────

async function clearServices() {
  console.log('🗑️  Nettoyage collection services...');
  let total = 0;
  let snap;
  do {
    snap = await db.collection('services').limit(200).get();
    if (snap.empty) break;
    const batch = db.batch();
    snap.docs.forEach(d => batch.delete(d.ref));
    await batch.commit();
    total += snap.size;
    console.log(`   ${total} docs supprimés...`);
  } while (snap.size > 0);
  console.log(`✅ Services vidés (${total} docs)`);
}

client.once(Events.ClientReady, async () => {
  console.log(`\n🟢 Bot connecté : ${client.user.tag}`);
  console.log(`   Logs-IG : ${CHANNEL_LOGS_IG}`);
  console.log(`\n✅ Bot prêt — écoute temps réel active`);

  // Vider les services orphelins au démarrage (une seule fois)
  await clearServices();

  // await backfillAll();
});

client.on(Events.MessageCreate, async (msg) => {
  if (!msg.author?.bot) return;
  await handleMessage(msg);
});

process.on('unhandledRejection', (err) => {
  if (err?.message?.includes('Quota')) {
    console.warn('⚠️  Firebase quota dépassé');
  } else {
    console.error('❌ Erreur non gérée :', err?.message || err);
  }
});

client.login(process.env.DISCORD_TOKEN).catch(err => {
  console.error('❌ Connexion Discord impossible :', err.message);
  process.exit(1);
});
