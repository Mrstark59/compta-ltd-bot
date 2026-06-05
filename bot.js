require('dotenv').config();
const { Client, GatewayIntentBits, Events } = require('discord.js');
const admin = require('firebase-admin');

// ══════════════════════════════════════════════════════════════
// FIREBASE INIT
// ══════════════════════════════════════════════════════════════
admin.initializeApp({
  credential: admin.credential.cert({
    projectId:   process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey:  process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
  }),
});
const db = admin.firestore();

// ══════════════════════════════════════════════════════════════
// DISCORD CLIENT
// ══════════════════════════════════════════════════════════════
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// ══════════════════════════════════════════════════════════════
// CONFIG CHANNELS
// ══════════════════════════════════════════════════════════════
const CHANNEL_REVENUE  = process.env.CHANNEL_REVENUE;   // Entrées d'argent
const CHANNEL_DEPENSES = process.env.CHANNEL_DEPENSES;  // Sorties d'argent
const CHANNEL_FACTURES = process.env.CHANNEL_FACTURES;
const CHANNEL_LOGS_IG  = process.env.CHANNEL_LOGS_IG;
const CHANNEL_SERVICE  = process.env.CHANNEL_SERVICE;

// ══════════════════════════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════════════════════════
function extract(text, ...labels) {
  if (!text) return null;
  // Supprime tout le markdown Discord : **bold**, __underline__, `code`, ~strike~
  const clean = text.replace(/\*+|_+|~+|`+/g, '');
  for (const label of labels) {
    const m = clean.match(new RegExp(`${label}\\s*[:\\-]\\s*([^\\n<]+)`, 'i'));
    if (m) return m[1].replace(/^@/, '').trim();
  }
  return null;
}

function parseMontant(str) {
  if (!str) return 0;
  // Gère "135 $", "582 476 $", "582476$", "582,476$"
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

// ══════════════════════════════════════════════════════════════
// PARSERS
// ══════════════════════════════════════════════════════════════

// Parse un embed de transaction (revenue ou dépense)
// forceType: 'entree' ou 'sortie' selon le channel
function parseTransaction(embed, forceType) {
  // Combine description + fields en un seul texte pour le parsing
  let desc = embed.description || '';
  if (embed.fields && embed.fields.length) {
    for (const f of embed.fields) {
      desc += `\n${f.name}: ${f.value}`;
    }
  }
  const montant     = parseMontant(extract(desc, 'Montant'));
  const raison      = extract(desc, 'Raison');
  const payeur      = extract(desc, 'Payeur');
  const utilisateur = extract(desc, 'Utilisateur');
  const soldeAvant  = parseMontant(extract(desc, 'Solde avant'));
  const soldeApres  = parseMontant(extract(desc, 'Solde après', 'Solde apres'));

  if (!montant) {
    console.log(`   ⚠️  Parser: montant=0 | desc="${desc.slice(0,100).replace(/\n/g,' ')}"`);
    return null;
  }

  let categorie = 'autre';
  if (raison) {
    const r = raison.toLowerCase();
    if (r.includes('paiement facture'))                   categorie = forceType === 'entree' ? 'vente_client' : 'depense_facture';
    else if (r.includes('redistribution'))                categorie = 'essence';
    else if (r.includes('salaire'))                       categorie = 'salaire';
    else if (r.includes('achat') || r.includes('appro')) categorie = 'approvisionnement';
  }

  return {
    type: forceType,
    montant, categorie,
    raison:    raison || '',
    personne:  payeur || utilisateur || 'Inconnu',
    soldeAvant, soldeApres,
    timestamp: now(),
  };
}

function parseFacture(embed) {
  const title = (embed.title || '').replace(/[*_~`]/g,'');
  if (!title.toUpperCase().includes('FACTURE')) return null;

  // Combine description + champs embed
  let desc = embed.description || '';
  if (embed.fields && embed.fields.length) {
    for (const f of embed.fields) desc += `\n${f.name}: ${f.value}`;
  }

  const idInTitle = title.match(/(\d{6,})/);
  const factureId = idInTitle ? idInTitle[1] : (extract(desc, 'Facture ID') || '');

  // Statut : Payée / Annulée / En attente
  const rawStatus = (extract(desc, 'Status') || '').toLowerCase();
  const status = rawStatus.includes('pay') ? 'payee'
               : rawStatus.includes('annul') ? 'annulee'
               : 'en_attente';

  return {
    factureId,
    emetteur:     extract(desc, 'Émetteur', 'Emetteur') || 'Inconnu',
    destinataire: extract(desc, 'Destinataire') || 'Inconnu',
    montant:      parseMontant(extract(desc, 'Montant')),
    raison:       extract(desc, 'Raison') || '',
    status,
    paiement:     extract(desc, 'Paiement') || '',
    creeLe:       extract(desc, 'Créée le', 'Creee le') || '',
    payeeLe:      extract(desc, 'Payée le', 'Payee le') || '',
    timestamp:    now(),
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
  return {
    type:       isAdd ? 'add' : 'remove',
    item:       data.item,
    count:      parseInt(data.count) || 0,
    discordId:  data.discord || '',
    name:       data.name || '',
    properName: data.properName || '',
    date:       data.date || '',
    source:     'discord',
    timestamp:  now(),
  };
}

function parseService(embed) {
  const title = (embed.title || '').replace(/[*_~`]/g,'').toLowerCase().trim();
  const isDebut = title.includes('commenc');
  const isFin   = title.includes('termin');
  if (!isDebut && !isFin) return null;

  // Combine description + champs
  let text = embed.description || '';
  if (embed.fields && embed.fields.length) {
    for (const f of embed.fields) text += `\n${f.name}: ${f.value}`;
  }

  const m = text.match(/^(.+?)\s+a\s+(commenc|termin)/i);
  const nom = m ? m[1].trim() : null;
  if (!nom) return null;
  return { action: isDebut ? 'debut' : 'fin', employeNom: nom };
}

// ══════════════════════════════════════════════════════════════
// SAUVEGARDE
// ══════════════════════════════════════════════════════════════
async function saveTransaction(data) {
  await db.collection('transactions').add(data);
  console.log(`✅ Transaction [${data.type}] ${data.montant}$ — ${data.categorie}`);
}

async function saveOrUpdateFacture(data) {
  if (!data.factureId) { await db.collection('factures').add(data); return; }
  await db.collection('factures').doc(data.factureId).set(data, { merge: true });
  console.log(`✅ Facture #${data.factureId} [${data.status}] ${data.montant}$`);
}

// Fire-and-forget pour le stock (haute fréquence)
function saveStockMouvement(data) {
  db.collection('stock_mouvements').add(data)
    .then(() => console.log(`✅ Stock [${data.type}] ${data.count}x ${data.item}`))
    .catch(err => console.error(`❌ Stock: ${err.message}`));
}

async function saveService(data) {
  if (data.action === 'debut') {
    await db.collection('services').add({
      employeNom: data.employeNom,
      debut: now(), fin: null, duree: null,
    });
    console.log(`✅ Service début : ${data.employeNom}`);
  } else {
    const snap = await db.collection('services')
      .where('employeNom', '==', data.employeNom)
      .where('fin', '==', null)
      .orderBy('debut', 'desc')
      .limit(1).get();

    if (!snap.empty) {
      const doc   = snap.docs[0];
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

// ══════════════════════════════════════════════════════════════
// MESSAGE HANDLER
// ══════════════════════════════════════════════════════════════
async function handleMessage(message) {
  if (!message.embeds?.length) return;
  const embed = message.embeds[0];

  try {
    // Titre nettoyé pour filtrage strict
    const cleanTitle = (embed.title || '').replace(/[*_~`]/g,'').toUpperCase().trim();

    switch (message.channelId) {

      case CHANNEL_REVENUE: {
        // On accepte uniquement les messages ENTRÉE D'ARGENT
        if (!cleanTitle.includes('ENTR') || !cleanTitle.includes('ARGENT')) break;
        const d = parseTransaction(embed, 'entree');
        if (d) await saveTransaction(d);
        break;
      }

      case CHANNEL_DEPENSES: {
        // On accepte uniquement les messages SORTIE D'ARGENT
        if (!cleanTitle.includes('SORTIE') || !cleanTitle.includes('ARGENT')) break;
        const d = parseTransaction(embed, 'sortie');
        if (d) await saveTransaction(d);
        break;
      }

      case CHANNEL_FACTURES: {
        // On accepte uniquement les messages CREATION D'UNE FACTURE
        if (!cleanTitle.includes('FACTURE')) break;
        const d = parseFacture(embed);
        if (d) await saveOrUpdateFacture(d);
        break;
      }

      case CHANNEL_LOGS_IG: {
        // On accepte uniquement inventory - add et inventory - remove
        const t = (embed.title || '').toLowerCase();
        if (!t.includes('inventory')) break;
        const d = parseInventory(embed);
        if (d) saveStockMouvement(d); // fire-and-forget
        break;
      }

      case CHANNEL_SERVICE: {
        // On accepte uniquement Service commencé et Service terminé
        if (!cleanTitle.includes('SERVICE') && !cleanTitle.includes('COMMENC') && !cleanTitle.includes('TERMIN')) break;
        const d = parseService(embed);
        if (d) await saveService(d);
        break;
      }
    }
  } catch (err) {
    console.error(`❌ Erreur [${message.channelId}]: ${err.message}`);
  }
}

// ══════════════════════════════════════════════════════════════
// BACKFILL HISTORIQUE #SERVICE
// ══════════════════════════════════════════════════════════════
async function backfillServices(channel) {
  console.log('\n📚 Backfill #service — lecture de l\'historique...');
  
  // Récupère tous les messages (max 5000, par tranches de 100)
  let allMessages = [];
  let lastId = null;
  let fetched = 0;
  
  while (fetched < 5000) {
    const opts = { limit: 100 };
    if (lastId) opts.before = lastId;
    
    const batch = await channel.messages.fetch(opts);
    if (!batch.size) break;
    
    allMessages.push(...batch.values());
    lastId = batch.last()?.id;
    fetched += batch.size;
    if (batch.size < 100) break;
  }
  
  console.log(`   → ${allMessages.length} messages récupérés`);
  
  // Trie du plus ancien au plus récent
  allMessages.sort((a, b) => a.createdTimestamp - b.createdTimestamp);
  
  // Parse tous les messages de service
  const events = [];
  for (const msg of allMessages) {
    if (!msg.embeds?.length) continue;
    const embed = msg.embeds[0];
    const title = (embed.title || '').replace(/[*_~`]/g, '').toLowerCase().trim();
    if (!title.includes('commenc') && !title.includes('termin')) continue;
    
    let text = embed.description || '';
    if (embed.fields?.length) {
      for (const f of embed.fields) text += `\n${f.name}: ${f.value}`;
    }
    const m = text.match(/^(.+?)\s+a\s+(commenc|termin)/i);
    if (!m) continue;
    
    events.push({
      action: title.includes('commenc') ? 'debut' : 'fin',
      employeNom: m[1].trim(),
      timestamp: msg.createdAt,
      msgId: msg.id,
    });
  }
  
  console.log(`   → ${events.length} événements de service parsés`);
  
  // Vérifie les services déjà en base (par msgId)
  const existing = await db.collection('services')
    .where('source', '==', 'discord').get();
  const existingMsgIds = new Set(existing.docs.map(d => d.data().msgId).filter(Boolean));
  
  // Reconstitue les paires début/fin
  const openSessions = {}; // nom -> {timestamp, msgId}
  let saved = 0;
  
  for (const ev of events) {
    if (ev.action === 'debut') {
      openSessions[ev.employeNom] = { timestamp: ev.timestamp, msgId: ev.msgId };
    } else if (ev.action === 'fin' && openSessions[ev.employeNom]) {
      const debut = openSessions[ev.employeNom];
      delete openSessions[ev.employeNom];
      
      // Evite les doublons
      if (existingMsgIds.has(debut.msgId)) continue;
      
      const duree = Math.round((ev.timestamp - debut.timestamp) / 60000);
      if (duree < 0 || duree > 1440) continue; // sanity check (max 24h)
      
      await db.collection('services').add({
        employeNom: ev.employeNom,
        debut: admin.firestore.Timestamp.fromDate(debut.timestamp),
        fin: admin.firestore.Timestamp.fromDate(ev.timestamp),
        duree,
        source: 'discord',
        msgId: debut.msgId,
      });
      saved++;
    }
  }
  
  // Sessions encore ouvertes (service commencé sans fin)
  for (const [nom, session] of Object.entries(openSessions)) {
    if (!existingMsgIds.has(session.msgId)) {
      await db.collection('services').add({
        employeNom: nom,
        debut: admin.firestore.Timestamp.fromDate(session.timestamp),
        fin: null,
        duree: null,
        source: 'discord',
        msgId: session.msgId,
      });
    }
  }
  
  console.log(`   ✅ ${saved} sessions de service sauvegardées`);
}

// ══════════════════════════════════════════════════════════════
// EVENTS DISCORD
// ══════════════════════════════════════════════════════════════
client.once(Events.ClientReady, async () => {
  console.log(`\n🟢 Bot connecté : ${client.user.tag}`);
  console.log(`   Revenue   : ${CHANNEL_REVENUE}`);
  console.log(`   Dépenses  : ${CHANNEL_DEPENSES}`);
  console.log(`   Factures  : ${CHANNEL_FACTURES}`);
  console.log(`   Logs-IG   : ${CHANNEL_LOGS_IG}`);
  console.log(`   Service   : ${CHANNEL_SERVICE}`);
  console.log(`\n📦 Stock : fire-and-forget activé`);
  console.log(`\n🔍 Vérification des derniers messages...\n`);

  const channelsToCheck = [
    { id: CHANNEL_REVENUE,  label: 'Revenue' },
    { id: CHANNEL_DEPENSES, label: 'Dépenses' },
    { id: CHANNEL_FACTURES, label: 'Factures' },
    { id: CHANNEL_SERVICE,  label: 'Service' },
  ];

  for (const { id, label } of channelsToCheck) {
    try {
      const channel = await client.channels.fetch(id);
      if (!channel) { console.log(`   ❌ ${label} : channel introuvable`); continue; }

      const messages = await channel.messages.fetch({ limit: 1 });
      const last = messages.first();

      if (!last) {
        console.log(`   ⚪ ${label} : aucun message`);
      } else if (!last.embeds?.length) {
        console.log(`   ⚠️  ${label} : dernier message sans embed (${last.author.username} - "${last.content?.slice(0,40) || 'vide'}")`);
      } else {
        const embed = last.embeds[0];
        const title = embed.title || '(sans titre)';
        const ts = last.createdAt.toLocaleString('fr-FR');
        console.log(`   ✅ ${label} : "${title}" — ${ts}`);

        // Try to parse and save to Firebase
        let saved = false;
        if (id === CHANNEL_REVENUE) {
          const d = parseTransaction(embed, 'entree');
          if (d) { await saveTransaction(d); saved = true; }
        } else if (id === CHANNEL_DEPENSES) {
          const d = parseTransaction(embed, 'sortie');
          if (d) { await saveTransaction(d); saved = true; }
        } else if (id === CHANNEL_FACTURES) {
          const d = parseFacture(embed);
          if (d) { await saveOrUpdateFacture(d); saved = true; }
        } else if (id === CHANNEL_SERVICE) {
          const d = parseService(embed);
          if (d) console.log(`      → Service : ${d.employeNom} (${d.action})`);
          saved = !!d;
        }
        if (saved) console.log(`      → ✅ Enregistré dans Firebase`);
        else console.log(`      → ⚠️  Pas pu parser ce message`);
      }
    } catch (err) {
      console.log(`   ❌ ${label} : erreur — ${err.message}`);
    }
  }
  console.log('');

  // Backfill historique #service
  if (CHANNEL_SERVICE) {
    try {
      const svcChannel = await client.channels.fetch(CHANNEL_SERVICE);
      if (svcChannel) await backfillServices(svcChannel);
    } catch(e) {
      console.log(`⚠️  Backfill service ignoré : ${e.message}`);
    }
  }
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

client.login(process.env.DISCORD_TOKEN).catch(err => {
  console.error('❌ Connexion Discord impossible :', err.message);
  process.exit(1);
});
