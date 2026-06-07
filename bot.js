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

const CHANNEL_REVENUE  = process.env.CHANNEL_REVENUE;
const CHANNEL_DEPENSES = process.env.CHANNEL_DEPENSES;
const CHANNEL_FACTURES = process.env.CHANNEL_FACTURES;
const CHANNEL_LOGS_IG  = process.env.CHANNEL_LOGS_IG;
const CHANNEL_SERVICE  = process.env.CHANNEL_SERVICE;

const IGNORE_ITEMS = ['bidon_fuel', 'dollar', 'dollars'];

function extract(text, ...labels) {
  if (!text) return null;
  const clean = text.replace(/\*+|_+|~+|`+/g, '');
  for (const label of labels) {
    const m = clean.match(new RegExp(`${label}\\s*[:\\-]\\s*([^\\n<]+)`, 'i'));
    if (m) return m[1].replace(/^@/, '').trim();
  }
  return null;
}

function parseMontant(str) {
  if (!str) return 0;
  return parseInt(str.replace(/[^0-9]/g, '')) || 0;
}

function parseKeyValues(description) {
  const data = {};
  if (!description) return data;
  for (const line of description.split('\n').map(l => l.trim()).filter(Boolean)) {
    const m = line.match(/^(\w+):(.*)$/);
    if (m) data[m[1]] = m[2].trim();
  }
  return data;
}

const now = () => admin.firestore.FieldValue.serverTimestamp();

function parseTransaction(embed, forceType) {
  let desc = embed.description || '';
  if (embed.fields?.length) for (const f of embed.fields) desc += `\n${f.name}: ${f.value}`;
  const montant     = parseMontant(extract(desc, 'Montant'));
  const raison      = extract(desc, 'Raison');
  const payeur      = extract(desc, 'Payeur');
  const utilisateur = extract(desc, 'Utilisateur');
  const soldeAvant  = parseMontant(extract(desc, 'Solde avant'));
  const soldeApres  = parseMontant(extract(desc, 'Solde après', 'Solde apres'));
  if (!montant) return null;
  let categorie = 'autre';
  if (raison) {
    const r = raison.toLowerCase();
    if (r.includes('paiement facture'))                   categorie = forceType === 'entree' ? 'vente_client' : 'depense_facture';
    else if (r.includes('redistribution'))                categorie = 'essence';
    else if (r.includes('salaire'))                       categorie = 'salaire';
    else if (r.includes('achat') || r.includes('appro')) categorie = 'approvisionnement';
  }
  return { type: forceType, montant, categorie, raison: raison||'', personne: payeur||utilisateur||'Inconnu', soldeAvant, soldeApres, timestamp: now() };
}

function parseFacture(embed) {
  const title = (embed.title || '').replace(/[*_~`]/g, '');
  if (!title.toUpperCase().includes('FACTURE')) return null;
  let desc = embed.description || '';
  if (embed.fields?.length) for (const f of embed.fields) desc += `\n${f.name}: ${f.value}`;
  const idInTitle = title.match(/(\d{6,})/);
  const factureId = idInTitle ? idInTitle[1] : (extract(desc, 'Facture ID') || '');
  const rawStatus = (extract(desc, 'Status') || '').toLowerCase();
  const status = rawStatus.includes('pay') ? 'payee' : rawStatus.includes('annul') ? 'annulee' : 'en_attente';
  return {
    factureId,
    emetteur:     extract(desc, 'Émetteur', 'Emetteur') || 'Inconnu',
    destinataire: extract(desc, 'Destinataire') || 'Inconnu',
    montant:      parseMontant(extract(desc, 'Montant')),
    raison:       extract(desc, 'Raison') || '',
    status, paiement: extract(desc, 'Paiement') || '',
    creeLe:  extract(desc, 'Créée le', 'Creee le') || '',
    payeeLe: extract(desc, 'Payée le', 'Payee le') || '',
    timestamp: now(),
  };
}

function parseInventory(embed) {
  const title = embed.title || '';
  const isAdd    = title === 'inventory - add';
  const isRemove = title === 'inventory - remove';
  if (!isAdd && !isRemove) return null;
  const data = parseKeyValues(embed.description || '');
  if (embed.fields?.length) {
    for (const f of embed.fields) {
      const m = (f.value || '').match(/^[^:]+:(.*)$/);
      if (m) data[f.name] = m[1].trim();
    }
  }
  if (!data.item) return null;
  if (IGNORE_ITEMS.includes(data.item)) return null;
  return { type: isAdd ? 'add' : 'remove', item: data.item, count: parseInt(data.count)||0, discordId: data.discord||'', name: data.name||'', properName: data.properName||'', date: data.date||'', source: 'discord', timestamp: now() };
}

function parseStationFill(embed) {
  const title = (embed.title || '').toLowerCase().trim();
  if (!title.includes('station_fill')) return null;
  const data = {};
  if (embed.fields?.length) {
    for (const f of embed.fields) {
      const m = (f.value || '').match(/^[^:]+:(.*)$/);
      if (m) data[f.name] = m[1].trim();
      else data[f.name] = (f.value||'').trim();
    }
  }
  for (const line of (embed.description||'').split('\n')) {
    const m = line.match(/^(\w+):(.+)$/);
    if (m) data[m[1]] = m[2].trim();
  }
  const volAdded = parseInt(data.vol_added) || 0;
  if (!volAdded) return null;
  return { employeNom: data.properName||data.name||'Inconnu', discordId: data.discord||'', volAdded, volBefore: parseInt(data.vol_before)||0, volAfter: parseInt(data.vol_after)||0, markerId: data.markerId||'', date: data.date||'', timestamp: now() };
}

function parseService(embed) {
  const title = (embed.title || '').replace(/[*_~`]/g, '').toLowerCase().trim();
  const isDebut = title.includes('commenc');
  const isFin   = title.includes('termin');
  if (!isDebut && !isFin) return null;
  let text = embed.description || '';
  if (embed.fields?.length) for (const f of embed.fields) text += `\n${f.name}: ${f.value}`;
  const m = text.match(/^(.+?)\s+a\s+(commenc|termin)/i);
  const nom = m ? m[1].trim() : null;
  if (!nom) return null;
  return { action: isDebut ? 'debut' : 'fin', employeNom: nom };
}

async function saveTransaction(data) {
  await db.collection('transactions').add(data);
  console.log(`✅ Transaction [${data.type}] ${data.montant}$ — ${data.categorie}`);
}

async function saveOrUpdateFacture(data) {
  if (!data.factureId) { await db.collection('factures').add(data); return; }
  await db.collection('factures').doc(data.factureId).set(data, { merge: true });
  console.log(`✅ Facture #${data.factureId} [${data.status}] ${data.montant}$`);
}

function saveStockMouvement(data) {
  db.collection('stock_mouvements').add(data)
    .then(() => console.log(`✅ Stock [${data.type}] ${data.count}x ${data.item}`))
    .catch(err => console.error(`❌ Stock: ${err.message}`));
}

function saveStationFill(data) {
  db.collection('station_fills').add(data)
    .then(() => console.log(`✅ Station fill : ${data.employeNom} +${data.volAdded}L`))
    .catch(err => console.error(`❌ Station fill: ${err.message}`));
}

async function saveService(data) {
  if (data.action === 'debut') {
    // Vérifier s'il y a déjà un service ouvert pour cet employé (sécurité doublon)
    const existing = await db.collection('services')
      .where('employeNom', '==', data.employeNom)
      .orderBy('debut', 'desc')
      .limit(1)
      .get();
    if (!existing.empty) {
      const last = existing.docs[0].data();
      // Si le dernier service n'a pas de fin (null ou undefined ou absent), on ne recrée pas
      const hasFin = last.fin !== null && last.fin !== undefined;
      if (!hasFin) {
        console.log(`⚠️  Service déjà ouvert pour ${data.employeNom} — ignoré`);
        return;
      }
    }
    await db.collection('services').add({
      employeNom: data.employeNom,
      debut: now(),
      fin: null,
      duree: null,
    });
    console.log(`✅ Service début : ${data.employeNom}`);
  } else {
    // Chercher le dernier service ouvert (fin null OU fin absente)
    const snap = await db.collection('services')
      .where('employeNom', '==', data.employeNom)
      .orderBy('debut', 'desc')
      .limit(10)
      .get();

    // Considérer comme "ouvert" : fin === null OU fin === undefined OU champ absent
    const openDocs = snap.docs.filter(d => {
      const fin = d.data().fin;
      return fin === null || fin === undefined;
    });

    if (openDocs.length > 0) {
      const doc   = openDocs[0]; // le plus récent (déjà trié desc)
      const debut = doc.data().debut?.toDate?.() || new Date();
      const duree = Math.round((new Date() - debut) / 60000);
      await doc.ref.update({
        fin: admin.firestore.FieldValue.serverTimestamp(),
        duree,
      });
      console.log(`✅ Service fin : ${data.employeNom} (${duree} min)`);
    } else {
      console.log(`⚠️  Pas de service ouvert pour ${data.employeNom}`);
    }
  }
}

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
  console.log('\n📚 Récupération des msgIds existants...');
  const existingTx  = await getExistingMsgIds('transactions');
  const existingFac = await getExistingMsgIds('factures');
  const existingStk = await getExistingMsgIds('stock_mouvements');
  const existingSta = await getExistingMsgIds('station_fills');
  console.log(`   TX:${existingTx.size} FAC:${existingFac.size} STK:${existingStk.size} STA:${existingSta.size}\n`);

  async function backfill(channelId, label, processFn) {
    try {
      const ch = await client.channels.fetch(channelId);
      if (!ch) { console.log(`⚠️  ${label} : introuvable`); return; }
      console.log(`📚 Backfill ${label}...`);
      const msgs = await fetchAllMessages(ch);
      console.log(`   → ${msgs.length} messages`);
      let saved = 0;
      for (const msg of msgs) {
        if (!msg.embeds?.length) continue;
        try {
          const ok = await processFn(msg);
          if (ok) saved++;
        } catch (e) {
          if (e?.details?.includes('Quota') || e?.message?.includes('Quota')) {
            console.warn(`⚠️  Quota dépassé pendant ${label} — arrêt du backfill`);
            console.log(`   ✅ ${saved} sauvegardés avant arrêt`);
            return;
          }
        }
      }
      console.log(`   ✅ ${saved} nouveaux enregistrements`);
    } catch (e) {
      if (e?.details?.includes('Quota') || e?.message?.includes('Quota')) {
        console.warn(`⚠️  Quota Firebase dépassé — backfill suspendu jusqu'à demain`);
      } else {
        console.log(`❌ Backfill ${label} : ${e.message}`);
      }
    }
  }

  await backfill(CHANNEL_REVENUE, '#revenue', async (msg) => {
    if (existingTx.has(msg.id)) return false;
    const ct = (msg.embeds[0].title||'').replace(/[*_~`]/g,'').toUpperCase();
    if (!ct.includes('ENTR') || !ct.includes('ARGENT')) return false;
    const d = parseTransaction(msg.embeds[0], 'entree');
    if (!d) return false;
    d.msgId = msg.id; d.timestamp = admin.firestore.Timestamp.fromDate(msg.createdAt);
    await db.collection('transactions').add(d);
    existingTx.add(msg.id);
    return true;
  });

  await backfill(CHANNEL_DEPENSES, '#dépenses', async (msg) => {
    if (existingTx.has(msg.id)) return false;
    const ct = (msg.embeds[0].title||'').replace(/[*_~`]/g,'').toUpperCase();
    if (!ct.includes('SORTIE') || !ct.includes('ARGENT')) return false;
    const d = parseTransaction(msg.embeds[0], 'sortie');
    if (!d) return false;
    d.msgId = msg.id; d.timestamp = admin.firestore.Timestamp.fromDate(msg.createdAt);
    await db.collection('transactions').add(d);
    existingTx.add(msg.id);
    return true;
  });

  await backfill(CHANNEL_FACTURES, '#factures', async (msg) => {
    if (existingFac.has(msg.id)) return false;
    const title = (msg.embeds[0].title||'').replace(/[*_~`]/g,'');
    if (!title.toUpperCase().includes('FACTURE')) return false;
    const d = parseFacture(msg.embeds[0]);
    if (!d || !d.factureId) return false;
    d.msgId = msg.id; d.timestamp = admin.firestore.Timestamp.fromDate(msg.createdAt);
    await db.collection('factures').doc(d.factureId).set(d, { merge: true });
    existingFac.add(msg.id);
    return true;
  });

  const cutoff14 = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
  await backfill(CHANNEL_LOGS_IG, '#logs-ig (14j)', async (msg) => {
    if (msg.createdAt < cutoff14) return false;
    const t = (msg.embeds[0].title||'').toLowerCase();
    if (t.includes('station_fill')) {
      if (existingSta.has(msg.id)) return false;
      const d = parseStationFill(msg.embeds[0]);
      if (!d) return false;
      d.msgId = msg.id; d.timestamp = admin.firestore.Timestamp.fromDate(msg.createdAt);
      await db.collection('station_fills').add(d);
      existingSta.add(msg.id);
      return true;
    } else if (t.includes('inventory')) {
      if (existingStk.has(msg.id)) return false;
      const d = parseInventory(msg.embeds[0]);
      if (!d) return false;
      d.msgId = msg.id; d.timestamp = admin.firestore.Timestamp.fromDate(msg.createdAt);
      db.collection('stock_mouvements').add(d).catch(() => {});
      existingStk.add(msg.id);
      return true;
    }
    return false;
  });

  await backfillServices();
  console.log('\n✅ Backfill complet !\n');
}

async function backfillServices() {
  try {
    const ch = await client.channels.fetch(CHANNEL_SERVICE);
    if (!ch) return;
    console.log('📚 Backfill #service...');
    const msgs = await fetchAllMessages(ch);
    const existing = await db.collection('services').where('source', '==', 'discord').get();
    const existingIds = new Set(existing.docs.map(d => d.data().msgId).filter(Boolean));
    const events = [];
    for (const msg of msgs) {
      if (!msg.embeds?.length) continue;
      const embed = msg.embeds[0];
      const title = (embed.title||'').replace(/[*_~`]/g,'').toLowerCase().trim();
      if (!title.includes('commenc') && !title.includes('termin')) continue;
      let text = embed.description || '';
      if (embed.fields?.length) for (const f of embed.fields) text += `\n${f.name}: ${f.value}`;
      const m = text.match(/^(.+?)\s+a\s+(commenc|termin)/i);
      if (!m) continue;
      events.push({ action: title.includes('commenc') ? 'debut' : 'fin', employeNom: m[1].trim(), timestamp: msg.createdAt, msgId: msg.id });
    }
    const open = {};
    let saved = 0;
    for (const ev of events) {
      if (ev.action === 'debut') {
        open[ev.employeNom] = { timestamp: ev.timestamp, msgId: ev.msgId };
      } else if (open[ev.employeNom]) {
        const debut = open[ev.employeNom];
        delete open[ev.employeNom];
        if (existingIds.has(debut.msgId)) continue;
        const duree = Math.round((ev.timestamp - debut.timestamp) / 60000);
        if (duree < 0 || duree > 1440) continue;
        await db.collection('services').add({
          employeNom: ev.employeNom,
          debut: admin.firestore.Timestamp.fromDate(debut.timestamp),
          fin: admin.firestore.Timestamp.fromDate(ev.timestamp),
          duree,
          source: 'discord',
          msgId: debut.msgId,
        });
        existingIds.add(debut.msgId);
        saved++;
      }
    }
    console.log(`   ✅ ${saved} sessions de service sauvegardées`);
  } catch (e) {
    if (e?.details?.includes('Quota') || e?.message?.includes('Quota')) {
      console.warn('⚠️  Quota dépassé pendant backfill service');
    } else {
      console.log(`❌ Backfill service : ${e.message}`);
    }
  }
}

async function handleMessage(message) {
  if (!message.embeds?.length) return;
  const embed = message.embeds[0];
  const cleanTitle = (embed.title||'').replace(/[*_~`]/g,'').toUpperCase().trim();
  try {
    switch (message.channelId) {
      case CHANNEL_REVENUE: {
        if (!cleanTitle.includes('ENTR') || !cleanTitle.includes('ARGENT')) break;
        const d = parseTransaction(embed, 'entree');
        if (d) { d.msgId = message.id; await saveTransaction(d); }
        break;
      }
      case CHANNEL_DEPENSES: {
        if (!cleanTitle.includes('SORTIE') || !cleanTitle.includes('ARGENT')) break;
        const d = parseTransaction(embed, 'sortie');
        if (d) { d.msgId = message.id; await saveTransaction(d); }
        break;
      }
      case CHANNEL_FACTURES: {
        if (!cleanTitle.includes('FACTURE')) break;
        const d = parseFacture(embed);
        if (d) { d.msgId = message.id; await saveOrUpdateFacture(d); }
        break;
      }
      case CHANNEL_LOGS_IG: {
        const t = (embed.title||'').toLowerCase();
        if (t.includes('station_fill')) {
          const d = parseStationFill(embed);
          if (d) { d.msgId = message.id; saveStationFill(d); }
        } else if (t.includes('inventory')) {
          const d = parseInventory(embed);
          if (d) { d.msgId = message.id; saveStockMouvement(d); }
        }
        break;
      }
      case CHANNEL_SERVICE: {
        const d = parseService(embed);
        if (d) await saveService(d);
        break;
      }
    }
  } catch (err) {
    console.error(`❌ Erreur [${message.channelId}]: ${err.message}`);
  }
}

client.once(Events.ClientReady, async () => {
  console.log(`\n🟢 Bot connecté : ${client.user.tag}`);
  console.log(`   Revenue   : ${CHANNEL_REVENUE}`);
  console.log(`   Dépenses  : ${CHANNEL_DEPENSES}`);
  console.log(`   Factures  : ${CHANNEL_FACTURES}`);
  console.log(`   Logs-IG   : ${CHANNEL_LOGS_IG}`);
  console.log(`   Service   : ${CHANNEL_SERVICE}`);
  console.log(`   Ignorés   : ${IGNORE_ITEMS.join(', ')}`);
  console.log(`\n✅ Bot prêt — écoute temps réel active`);

  // Décommenter pour relancer le backfill (après reset quota 2h Paris)
  // await backfillAll();
});

client.on(Events.MessageCreate, async (msg) => {
  if (!msg.author?.bot) return;
  await handleMessage(msg);
});

client.on(Events.MessageUpdate, async (_old, newMsg) => {
  if (!newMsg.author?.bot) return;
  if (!newMsg.embeds?.length) return;
  if (newMsg.channelId !== CHANNEL_FACTURES) return;
  await handleMessage(newMsg);
});

process.on('unhandledRejection', (err) => {
  if (err?.details?.includes('Quota') || err?.message?.includes('Quota')) {
    console.warn('⚠️  Firebase quota dépassé — données non sauvegardées temporairement');
  } else {
    console.error('❌ Erreur non gérée :', err?.message || err);
  }
});

client.login(process.env.DISCORD_TOKEN).catch(err => {
  console.error('❌ Connexion Discord impossible :', err.message);
  process.exit(1);
});
