// Applique le fuseau horaire AVANT tout require/Date : Node lit process.env.TZ
// à la construction de la première Date. Sinon le scheduler interprète les
// heures que l'utilisateur tape comme des heures UTC (= heure serveur), alors
// que l'utilisateur raisonne en heure locale (ex: Bénin UTC+1).
try {
    const _cfg = require('./config.js');
    if (_cfg.timezone) process.env.TZ = _cfg.timezone;
} catch (_) {}

// Charge les variables d'env depuis un .env local (pour OPENROUTER_API_KEY /
// OPENAI_API_KEY utilisés par aiService). Sans .env le bot continue, mais le
// chatbot IA sera simplement désactivé.
try { require('dotenv').config(); } catch (_) {}

console.log('---------------------------------------');
console.log('[SYSTEM] DAZBOT INITIALISATION...');
console.log('---------------------------------------');
console.log(`[SYSTEM] Fuseau horaire: ${process.env.TZ || '(défaut système)'} — ${new Date().toString()}`);

const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    downloadMediaMessage
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const config = require('./config.js');
const NodeCache = require('node-cache');
const express = require('express');
const antiDelete = require('./antidelete.js');
const tagAll = require('./tagall.js');
const screenshot = require('./screenshot.js');
const facebook = require('./facebook.js');
const hostCmd = require('./host.js');
const scheduler = require('./scheduler.js');
const AIService = require('./aiService.js');

console.log('[DEBUG] Bot starting script execution...');

// Chatbot IA (porté depuis dazbot-1/Chat-Bot-Dazi). Initialisé à la demande
// seulement si une clé est présente, pour que l'absence de clé n'empêche pas
// le bot de démarrer. L'auto-réponse elle-même reste gouvernée par le toggle
// `config.aiAutoReply` (default : false).
// Nom de la variable d'env attendue pour le provider actuellement configuré.
// Utilisé pour les messages d'init / de statut / d'erreur côté DM owner.
function envKeyForProvider(providerName) {
    switch ((providerName || '').toLowerCase()) {
        case 'openai': return 'OPENAI_API_KEY';
        case 'openrouter': return 'OPENROUTER_API_KEY';
        case 'groq': return 'GROQ_API_KEY';
        case 'cerebras': return 'CEREBRAS_API_KEY';
        default: return 'GEMINI_API_KEY'; // gemini par défaut
    }
}

const SUPPORTED_PROVIDERS = ['gemini', 'groq', 'cerebras', 'openrouter', 'openai'];

// --- AI POOL + AUTO-FALLBACK ---
// Historique conversationnel partagé entre tous les providers : quand on
// bascule de gemini → groq → cerebras pour un même message, le nouveau
// provider voit le même contexte que l'ancien (sinon on perdrait le fil).
const aiSharedHistory = new Map();

// Pool de providers initialisés (provider name → AIService). On instancie
// paresseusement : seulement les providers dont la clé est dans .env.
const aiPool = new Map();

function initProvider(providerName) {
    const name = (providerName || '').toLowerCase();
    if (aiPool.has(name)) return aiPool.get(name);
    try {
        // Primaire : on respecte config.aiModel (sinon le modèle choisi par
        // l'utilisateur via config.js ou ?dazai model serait ignoré). Fallback :
        // on passe aiModel vide → chaque provider utilise son propre défaut
        // (gemini-2.5-flash-lite pour Gemini, llama-3.3-70b-versatile pour Groq,
        // llama3.1-8b pour Cerebras, etc.). Un `config.aiModel` gemini-spécifique
        // n'a aucun sens pour Groq/Cerebras qui utilisent des namespaces Llama.
        const isPrimary = name === (config.aiProvider || '').toLowerCase();
        const svc = new AIService(
            { ...config, aiProvider: name, aiModel: isPrimary ? (config.aiModel || '') : '' },
            { sharedHistory: aiSharedHistory },
        );
        aiPool.set(name, svc);
        return svc;
    } catch (e) {
        return null;
    }
}

// `aiService` = provider primaire (utilisé pour ?dazai stats / clear /
// affichage courant). Reste pointé sur config.aiProvider par défaut.
let aiService = initProvider(config.aiProvider);

// `aiChain` = ordre d'essai. Tous les providers dont la clé est présente
// dans l'env rentrent automatiquement, primaire en tête.
// Priorité intelligente (gratuits d'abord) : primaire → gemini → groq →
// cerebras → openrouter → openai.
function buildDefaultChain() {
    const primary = (config.aiProvider || '').toLowerCase();
    const prio = ['gemini', 'groq', 'cerebras', 'openrouter', 'openai'];
    const ordered = [primary, ...prio.filter((p) => p !== primary)];
    return ordered.filter((p) => initProvider(p) !== null);
}

let aiChain = buildDefaultChain();

// Si le provider primaire (config.aiProvider) n'a pas pu s'initialiser
// (clé absente, invalide, …) mais qu'un autre de la chaîne est dispo, on
// promeut celui-là en `aiService`. Sans ça, `?dazai on` et l'auto-reply
// refuseraient de fonctionner alors que buildDefaultChain() a trouvé des
// providers utilisables via leurs clés .env — la chaîne de fallback
// serait du code mort.
if (!aiService && aiChain.length) {
    aiService = initProvider(aiChain[0]);
    if (aiService) {
        console.log(`[AI] Primaire ${config.aiProvider} indispo → promotion ${aiService.provider} depuis la chaîne de fallback.`);
    }
}

if (aiService) {
    const extras = aiChain.filter((p) => p !== aiService.provider);
    console.log(`[AI] Service prêt (primaire=${aiService.provider}, model=${aiService._currentModel()}, autoReply=${config.aiAutoReply ? 'ON' : 'OFF'}).`);
    if (extras.length) {
        console.log(`[AI] Fallback chain: ${aiChain.join(' → ')}`);
    } else {
        console.log(`[AI] Fallback chain: aucun (ajoute d'autres clés .env pour activer la bascule auto).`);
    }
} else {
    console.log(`[AI] Service non initialisé: aucune clé API détectée pour ${config.aiProvider}. Renseigne ${envKeyForProvider(config.aiProvider)} dans .env puis redémarre pour activer ?dazai.`);
}

// Bascule systématiquement sur le provider suivant dès qu'une erreur HTTP
// remonte (quota 429, crédits 402, clé révoquée 401/403, modèle rejeté 400,
// surcharge 5xx, …). L'intention : zéro message bloqué tant qu'au moins un
// provider du pool répond. Si notre propre payload est en cause (bug 400
// reproductible partout), tous les providers échoueront et on notifiera
// l'owner à la fin — même comportement qu'avant, en un peu plus verbeux côté
// logs. Mieux vaut ça que rater un switch gratuit.
const AI_FALLBACK_STATUSES = new Set([400, 401, 402, 403, 404, 408, 409, 413, 422, 429, 500, 502, 503, 504]);
// Codes axios correspondant à un problème réseau / hors HTTP (pas de
// `err.response`). On les traite comme des erreurs "retryables sur provider
// suivant" parce que c'est typiquement la machine du provider qui ne répond
// pas — un autre provider peut tout à fait marcher.
const AI_FALLBACK_NET_CODES = new Set(['ECONNABORTED', 'ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'ETIMEDOUT', 'EAI_AGAIN']);

async function aiGenerateWithFallback(conversationId, text, opts = {}) {
    if (!aiChain.length) throw new Error('Aucun provider IA disponible.');
    let lastErr = null;
    for (let i = 0; i < aiChain.length; i++) {
        const providerName = aiChain[i];
        const svc = initProvider(providerName);
        if (!svc) continue;
        try {
            const reply = await svc.generateReply(conversationId, text, { mode: opts.mode || 'default' });
            if (i > 0) {
                console.log(`[AI] Fallback réussi : ${aiChain[0]} → ${providerName}.`);
            }
            return { reply, provider: providerName };
        } catch (err) {
            // On attache le nom du provider qui a échoué pour que la notification
            // owner affiche le bon provider (sinon on reporterait toujours le
            // primaire même si c'est le dernier de la chaîne qui a planté).
            err.failedProvider = providerName;
            lastErr = err;
            const status = err?.status;
            const code = err?.code;
            const isNetErr = !status && AI_FALLBACK_NET_CODES.has(code);
            const hasNext = i < aiChain.length - 1;
            if (hasNext && (AI_FALLBACK_STATUSES.has(status) || isNetErr)) {
                const why = status ? `status ${status}` : `code ${code}`;
                console.log(`[AI] ${providerName} a échoué (${why}), bascule sur ${aiChain[i + 1]}...`);
                continue;
            }
            throw err;
        }
    }
    throw lastErr || new Error('Tous les providers IA ont échoué.');
}

// Throttle des requêtes IA par conversation : si le bot traite déjà un message
// d'un contact, les messages suivants attendent la fin — on évite les doublons
// de réponses et la facture OpenRouter qui explose.
const aiPendingByConv = new Set();
// Notifications d'erreur IA déjà envoyées à l'owner (une par statut HTTP) pour
// ne pas spam sa DM à chaque message reçu quand les crédits sont épuisés.
const aiErrorsNotified = new Set();

// --- STATE & CACHE ---
const reactedStatusCache = new Set();
const CACHE_MAX_SIZE = 1000;
const botStartTime = Math.floor(Date.now() / 1000);

let isActivelyLiking = true;
let fixedEmoji = null;
let focusTargets = new Map(); // Store JID -> { emoji: string }
let discreteTargets = new Set(); // Store JIDs for view-only
let focusJid = null; // Legacy single-target focus view
let focusViewOnly = false; // Legacy, will be removed or repurposed
let reactionSticker = null;
let isViewOnly = false;
let activeSocket = null;

// Persistance VV : on stocke un seul booléen ON/OFF pour intercepter toutes
// les Vues Uniques, peu importe la provenance. Le user ne veut plus de ciblage
// par numéro — trop de cas limites (LID vs PN, typo de numéro, …). Plus simple
// = plus fiable. Le fichier est gardé entre deux redémarrages sinon il faut
// ré-activer à chaque boot.
const FOCUS_VV_FILE = path.join(__dirname, 'focus_vv.json');
let captureAllVV = true; // défaut : ON
const loadFocusVV = () => {
    try {
        if (fs.existsSync(FOCUS_VV_FILE)) {
            const raw = fs.readFileSync(FOCUS_VV_FILE, 'utf8');
            const parsed = JSON.parse(raw);
            // Format nouveau : { enabled: true } | Format ancien : ["22955724800"]
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                captureAllVV = parsed.enabled !== false;
            } else if (Array.isArray(parsed)) {
                // Migration : l'ancien format avec liste => on active global.
                captureAllVV = true;
            }
            console.log(`[VV] Interception globale : ${captureAllVV ? 'ACTIVÉE' : 'DÉSACTIVÉE'}`);
        } else {
            console.log(`[VV] Pas de fichier d'état, défaut ACTIVÉE.`);
        }
    } catch (e) { console.log(`[VV] Impossible de charger: ${e.message}`); }
};
const saveFocusVV = () => {
    try { fs.writeFileSync(FOCUS_VV_FILE, JSON.stringify({ enabled: captureAllVV }), 'utf8'); }
    catch (e) { console.log(`[VV] Impossible de sauvegarder: ${e.message}`); }
};
loadFocusVV();

// JIDs de contacts vus par le bot (sync + messages). Sert de statusJidList
// quand on publie un statut programmé — sans cette liste, Baileys poste le
// statut sans audience et il reste invisible à tous les contacts.
const knownContactsJidList = new Set();

// getStatusAudience devient async pour pouvoir résoudre les @lid → @s.whatsapp.net
// via le LIDMappingStore. Baileys v7 dérive les devices depuis les JIDs dans la
// statusJidList mais préfère nettement les numéros (s.whatsapp.net) pour établir
// les sessions Signal proprement. On inclut les deux formats quand c'est dispo.
const getStatusAudience = async () => {
    const out = new Set();
    const sock = activeSocket;

    for (const jid of knownContactsJidList) {
        if (!jid) continue;
        if (jid.endsWith('@g.us')) continue;
        if (jid === 'status@broadcast' || jid === 'broadcast') continue;
        const [user, domain] = jid.split('@');
        if (!domain) continue;
        if (domain !== 's.whatsapp.net' && domain !== 'lid') continue;
        const bareUser = user.split(':')[0];
        if (!bareUser) continue;

        if (domain === 'lid') {
            // On ne conserve QUE les LIDs qui peuvent être résolus en numéro.
            // Les @lid non résolus font rejeter tout le broadcast par WA
            // (erreur 400 "received error in ack") → aucun contact ne voit rien.
            try {
                const pn = await sock?.signalRepository?.lidMapping?.getPNForLID?.(`${bareUser}@lid`);
                if (pn) {
                    const bare = pn.split(':')[0].split('@')[0];
                    out.add(`${bare}@s.whatsapp.net`);
                }
            } catch (_) {}
            // Si la résolution échoue, on saute cet entry silencieusement.
        } else {
            out.add(`${bareUser}@s.whatsapp.net`);
        }
    }

    // On ajoute nos propres JIDs (PN uniquement, jamais de @lid brut) pour que
    // le statut arrive aussi dans le feed Statuts de nos autres devices. La
    // règle "que des @s.whatsapp.net résolus" s'applique aussi à self : un
    // @lid non-mappable dans statusJidList fait rejeter TOUT le broadcast
    // (erreur 400 "received error in ack") — on ne peut pas se permettre ça
    // uniquement pour se livrer à soi-même.
    try {
        const meId = sock?.user?.id || sock?.authState?.creds?.me?.id;
        if (meId) {
            const bare = meId.split(':')[0].split('@')[0];
            out.add(`${bare}@s.whatsapp.net`);
        }
        const meLid = sock?.user?.lid || sock?.authState?.creds?.me?.lid;
        if (meLid) {
            try {
                const pn = await sock?.signalRepository?.lidMapping?.getPNForLID?.(meLid);
                if (pn) {
                    const bare = pn.split(':')[0].split('@')[0];
                    out.add(`${bare}@s.whatsapp.net`);
                }
            } catch (_) {}
        }
    } catch (_) {}

    return Array.from(out);
};

// Statistiques du bot
const botStats = {
    statusRead: 0,
    statusReacted: 0,
    deletedRecovered: 0,
    vvRecovered: 0,
    byUser: {}
};

// Setup memory cache
const msgRetryCounterCache = new NodeCache();

console.log('[DEBUG] Constants and variables initialized.');

// Réagit à un statut WhatsApp.
// Stratégie double-envoi pour que la réaction apparaisse vraiment sur le
// téléphone du poster :
//   1. sendMessage('status@broadcast', ...) avec statusJidList → réaction visible dans le flux "Statuts"
//   2. sendMessage(posterJid, ...) direct dans le chat privé du poster → déclenche la notif "a réagi à votre statut"
// Sans l'étape 2, WhatsApp reçoit la réaction côté serveur mais ne l'affiche
// pas sur le mobile du poster parce qu'il attend la notification privée qui
// n'a jamais été envoyée.
async function tryStatusReact(socket, msg, emoji) {
    const meJid = socket.user?.id;
    const meLid = socket.user?.lid;
    const participant = msg.key.participant;
    // Baileys v7 ne peuple pas toujours msg.key.participantPn pour les statuts ;
    // si besoin on résout le LID → PN via le LIDMappingStore.
    let participantPn = msg.key.participantPn;
    if (!participantPn && participant && participant.endsWith('@lid')) {
        try {
            participantPn = await socket.signalRepository?.lidMapping?.getPNForLID?.(participant);
        } catch (e) {
            console.log(`[REACT-LID-RESOLVE-FAIL] ${participant}: ${e.message}`);
        }
    }

    // Étape 1 : réaction sur le broadcast status.
    // On essaie plusieurs combinaisons de statusJidList pour couvrir PN et LID.
    const candidates = [];
    if (participantPn && meJid) candidates.push([participantPn, meJid]);
    if (participant && meJid && participant !== participantPn) candidates.push([participant, meJid]);
    if (participantPn && meLid && meLid !== meJid) candidates.push([participantPn, meLid]);
    if (participant && meLid && meLid !== meJid && participant !== participantPn) candidates.push([participant, meLid]);

    let broadcastOk = false;
    for (const list of candidates) {
        try {
            await socket.sendMessage(
                msg.key.remoteJid,
                { react: { text: emoji, key: msg.key } },
                { statusJidList: list }
            );
            broadcastOk = true;
            break;
        } catch (e) {
            console.log(`[REACT-RETRY] ${e.message} (list=${JSON.stringify(list)})`);
        }
    }

    // Étape 2 : doublon en chat privé pour déclencher la notif mobile.
    // On vise le vrai numéro téléphonique du poster (participantPn), avec fallback LID.
    // Uniquement si l'étape 1 a réussi — sinon on risque d'envoyer un doublon
    // orphelin qui n'est rattaché à aucune réaction broadcast.
    // On exclut le chat privé avec soi-même (likeMyOwnStatus), sinon chaque
    // auto-like génère une notif "tu as réagi à ton propre statut".
    const posterJid = participantPn || participant;
    const normalize = (j) => (j ? j.split('@')[0].split(':')[0] : '');
    const isSelf = posterJid && (
        posterJid === meJid ||
        posterJid === meLid ||
        normalize(posterJid) === normalize(meJid) ||
        normalize(posterJid) === normalize(meLid)
    );
    if (broadcastOk && posterJid && !posterJid.endsWith('@broadcast') && !isSelf) {
        try {
            // S'assurer qu'on envoie au JID PN (pas @lid) pour que WhatsApp route la notif mobile.
            let deliveryJid = posterJid;
            if (deliveryJid.endsWith('@lid')) {
                try {
                    const pn = await socket.signalRepository?.lidMapping?.getPNForLID?.(deliveryJid);
                    if (pn) deliveryJid = pn;
                } catch (_) {}
            }
            // Normalise en @s.whatsapp.net si c'est juste un numéro brut
            if (/^\d+(:\d+)?$/.test(deliveryJid)) deliveryJid = `${deliveryJid.split(':')[0]}@s.whatsapp.net`;
            // Strip le suffixe :N device. Un react doit être routé à la PERSONNE
            // (22955724800@s.whatsapp.net), pas à un device spécifique
            // (22955724800:0@s.whatsapp.net) — sinon la notif n'apparaît pas
            // côté mobile du poster.
            deliveryJid = deliveryJid.replace(/:\d+(?=@)/, '');
            await socket.sendMessage(
                deliveryJid,
                { react: { text: emoji, key: msg.key } }
            );
            console.log(`[REACT-PRIVATE] Doublon envoyé à ${deliveryJid}`);
        } catch (e) {
            console.log(`[REACT-PRIVATE-FAIL] ${posterJid}: ${e.message}`);
        }
    }

    return broadcastOk;
}

// Helper to check if a number is allowed based on whitelist and blacklist
function isAllowed(jid, msg) {
    if (!jid) return false;
    
    // Si c'est notre propre statut et que l'auto-like est activé, on autorise toujours
    if (msg?.key?.fromMe && config.likeMyOwnStatus) return true;

    const senderNum = jid.split('@')[0];
    const participantPn = msg?.key?.participantPn || "";
    const pnNum = participantPn.split('@')[0];

    // On vérifie d'abord si la personne est dans le Focus (Priorité haute)
    // On compare de manière floue pour supporter LID et PN
    const isFocus = Array.from(focusTargets.keys()).some(target => 
        jid.includes(target) || 
        senderNum.includes(target) || 
        participantPn.includes(target) || 
        pnNum.includes(target) ||
        target.includes(senderNum) ||
        (pnNum && target.includes(pnNum))
    );
                         
    if (isFocus) {
        console.log(`[FILTER-FOCUS] Match trouvé pour un membre de la liste !`);
        return true;
    }

    // Si on a un focus actif mais que la personne n'est pas dedans, on n'autorise pas le Like (Sauf si Global Liking est ON)
    if (focusTargets.size > 0 && !isActivelyLiking) {
        return false;
    }
    
    // Filtrage classique (Whitelist / Blacklist)
    if (config.blacklist && config.blacklist.length > 0) {
        if (config.blacklist.some(b => jid.includes(b) || participantPn.includes(b) || senderNum === b.split('@')[0])) return false;
    }
    
    if (config.whitelist && config.whitelist.length > 0) {
        return config.whitelist.some(w => jid.includes(w) || participantPn.includes(w) || senderNum === w.split('@')[0]);
    }
    
    return true;
}

async function connectToWhatsApp() {
    console.log('[INFO] Chargement de la session WhatsApp locale...');
    try {
        const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
        const { version, isLatest } = await fetchLatestBaileysVersion();
        console.log(`[INFO] Using WhatsApp v${version.join('.')}, isLatest: ${isLatest}`);

        const logger = pino({ level: 'info' });

        const socket = makeWASocket({
            version,
            logger,
            // printQRInTerminal deprecated - QR is rendered manually in connection.update handler
            browser: ["Mac OS", "Chrome", "121.0.6167.85"],
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, logger)
            },
            msgRetryCounterCache,
            generateHighQualityLinkPreview: true,
            markOnlineOnConnect: true,
            keepAliveIntervalMs: 30_000,
            connectTimeoutMs: 120_000,
            retryRequestDelayMs: 5000,
            maxMsgRetryCount: 5,
            // Activé : sans sync d'historique, Baileys n'émet presque pas
            // d'évènements contacts.upsert / contacts.update, donc la liste
            // knownContactsJidList reste quasi vide → statusJidList vide →
            // statuts programmés invisibles (erreur 400 côté serveur).
            syncFullHistory: true,
            defaultQueryTimeoutMs: 60000
        });

        activeSocket = socket;
        console.log('[DEBUG] Socket created.');
    
    // Configurer le callback pour les stats d'anti-delete
    antiDelete.setOnRecovered((phoneNumber) => {
        botStats.deletedRecovered++;
        botStats.byUser[phoneNumber] = (botStats.byUser[phoneNumber] || 0) + 1;
    });

    // Handle pairing code
    if (config.usePairingCode && !state.creds.me) {
        if (!config.phoneNumber || config.phoneNumber === "1234567890") {
            console.error('[ERROR] phone number issues in config.js');
            process.exit(1);
        }

        setTimeout(async () => {
            try {
                if (!socket.authState.creds.me) {
                    const code = await socket.requestPairingCode(config.phoneNumber);
                    console.log(`\n========================================`);
                    console.log(`[ACTION REQUIRED] Your Pairing Code: ${code}`);
                    console.log(`========================================\n`);
                }
            } catch (err) {
                console.error('[ERROR] Failed to request pairing code:', err);
            }
        }, 5000);
    }

    socket.ev.on('creds.update', saveCreds);

    // --- SEED DE CONTACTS DEPUIS LES SESSIONS SIGNAL ---
    // syncFullHistory est activé mais WhatsApp ne renvoie pas forcément
    // d'events contacts.upsert immédiatement après reconnexion. On regarde
    // donc le dossier auth_info_baileys pour extraire les JIDs des contacts
    // avec qui on a déjà une session Signal : ce sont nos vrais contacts,
    // connus de WhatsApp, et ils constituent un statusJidList valide.
    try {
        const fs = require('fs');
        const path = require('path');
        const authDir = path.resolve(__dirname, 'auth_info_baileys');
        const files = fs.readdirSync(authDir);
        let seeded = 0;
        for (const f of files) {
            const m = f.match(/^session-(\d+)_\d+\.\d+\.json$/);
            if (!m) continue;
            const id = m[1];
            // Ces identifiants sont des LIDs côté Baileys v7. Les contacts
            // qui acceptent les statuts via LID sont acceptés par le serveur.
            const jid = `${id}@lid`;
            if (!knownContactsJidList.has(jid)) {
                knownContactsJidList.add(jid);
                seeded++;
            }
        }
        console.log(`[CONTACTS-SEED] ${seeded} contact(s) détectés via les sessions Signal locales.`);
    } catch (e) {
        console.log('[CONTACTS-SEED] Echec lecture sessions:', e.message);
    }

    // --- TRACKER DE CONTACTS ---
    // Baileys ne remplit pas automatiquement la liste des destinataires quand on
    // poste un statut : sans `statusJidList`, le statut est uploadé mais invisible
    // à tout le monde. On garde donc un Set des JIDs vus (via contacts.upsert et
    // les messages reçus) et on le fournit au scheduler.
    socket.ev.on('contacts.upsert', (contacts) => {
        for (const c of contacts) {
            if (c?.id) knownContactsJidList.add(c.id);
        }
    });
    socket.ev.on('contacts.update', (updates) => {
        for (const u of updates) {
            if (u?.id) knownContactsJidList.add(u.id);
        }
    });

    socket.ev.on('messages.upsert', (m) => antiDelete.handleUpsert(socket, m));
    socket.ev.on('messages.update', (update) => {
        // Log de debug pour voir tous les updates qui arrivent
        update.forEach(u => {
            if (u.update.messageStubType || u.update.message?.protocolMessage) {
                console.log(`[DEBUG-UPDATE] ID: ${u.key.id}, Stub: ${u.update.messageStubType}, Protocol: ${!!u.update.message?.protocolMessage}`);
            }
        });
        antiDelete.handleUpdate(socket, update);
    });

    let reconnectAttempts = 0;

    // Helpers bannière de connexion — utilisés au boot ET via `?dazconnect show`
    // pour pouvoir réafficher la bannière à la demande sans redémarrer le bot.
    const buildConnectBanner = (sock) => {
        const actualConnectedNumber = sock.user.id.split(':')[0].split('@')[0];
        const ownerNumber = (config.ownerNumber && config.ownerNumber.trim()) || actualConnectedNumber;
        const ownerName = (config.ownerName && config.ownerName.trim())
            || sock.user.name
            || sock.user.verifiedName
            || 'Propriétaire';
        const quotes = Array.isArray(config.bootQuotes) ? config.bootQuotes.filter(q => q && q.trim()) : [];
        const topQuote = quotes[0] ? `✨ _${quotes[0]}_\n\n` : '';
        const bottomQuote = quotes[1] ? `\n\n✨ _${quotes[1]}_` : '';
        return (
            topQuote +
            `╭───〔 🤖 *DAZBOT connecté ✅* 〕───⬣\n` +
            `│ ߷ *Propriétaire*      ➜ ${ownerName}\n` +
            `│ ߷ *Numéro*            ➜ +${ownerNumber}\n` +
            `│ ߷ *Personne connectée* ➜ +${actualConnectedNumber}\n` +
            `│ ߷ *Mode*              ➜ Auto-Like\n` +
            `╰──────────────⬣` +
            bottomQuote
        );
    };

    const sendConnectBanner = async (sock, targetJid = null) => {
        const caption = buildConnectBanner(sock);
        console.log(caption);
        const destination = targetJid || (sock.user.id.split(':')[0] + '@s.whatsapp.net');
        const bannerUrl = (config.bootBannerUrl || '').trim();
        if (bannerUrl) {
            try {
                await sock.sendMessage(destination, {
                    image: { url: bannerUrl },
                    caption
                });
                return;
            } catch (imgErr) {
                console.warn('[INFO] Bannière KO, fallback texte:', imgErr.message);
            }
        }
        await sock.sendMessage(destination, { text: caption });
    };

    socket.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log(`\n[QR-CODE] Un nouveau QR Code est disponible. Scannez-le si vous ne voulez pas utiliser le Pairing Code.`);
            try {
                const qrcode = require('qrcode-terminal');
                qrcode.generate(qr, { small: true });
            } catch (e) {
                console.log('[QR-CODE] Installez qrcode-terminal pour afficher le QR dans le terminal, ou utilisez le Pairing Code.');
                console.log(`[QR-CODE] QR brut : ${qr}`);
            }
        }

        if (connection === 'close') {
            const statusCode = (lastDisconnect?.error)?.output?.statusCode;
            const isLoggedOut = statusCode === DisconnectReason.loggedOut;
            const isConflict = statusCode === 440;
            const is401 = statusCode === 401;
            const shouldReconnect = !isLoggedOut;

            console.log('[INFO] Connection closed, code:', statusCode, '| Reconnecting:', shouldReconnect);

            if (shouldReconnect) {
                reconnectAttempts++;
                let baseDelay = 10_000;
                if (isConflict) baseDelay = 30_000;
                if (is401) baseDelay = 5_000;
                const backoff = Math.min(baseDelay * Math.pow(1.5, reconnectAttempts - 1), 120_000);
                const reason = isConflict ? ' (conflit)' : is401 ? ' (invalide, retry)' : '';
                console.log(`[INFO] Reconnexion dans ${Math.round(backoff / 1000)}s (tentative #${reconnectAttempts})${reason}...`);
                setTimeout(() => connectToWhatsApp(), backoff);
            } else {
                console.log('[INFO] Session déconnectée (loggedOut). Nettoyez Supabase.');
            }
        } else if (connection === 'open') {
            reconnectAttempts = 0;
            console.log('[INFO] Successfully connected to WhatsApp!');
            scheduler.startScheduler(socket, { getStatusJidList: getStatusAudience });

            // Force presence for status to trigger key exchange
            try {
                await socket.sendPresenceUpdate('available');
                await socket.sendPresenceUpdate('available', 'status@broadcast');
            } catch (e) { }

            if (config.sendWelcomeMessage) {
                try {
                    await sendConnectBanner(socket);
                    console.log('[INFO] Système synchronisé.');
                } catch (e) {
                    console.warn('[INFO] Envoi message de connexion échoué:', e.message);
                }
            } else {
                // On log quand même le bloc en console pour garder une trace.
                console.log(buildConnectBanner(socket));
            }
        }
    });

    socket.ev.on('messages.upsert', async (m) => {
        try {
            console.log(`[DEBUG-UPSERT] Nouveau pack de messages reçu (Type: ${m.type}, Count: ${m.messages?.length})`);
            const msg = m.messages[0];
            if (!msg || !msg.message) return;

            // Note : le patch VV expérimental (requestPlaceholderResend sur
            // wrappers inconnus) a été retiré. Il ne fonctionnait pas — WA
            // refuse systématiquement de re-livrer une VV à un linked device
            // au niveau serveur — et l'heuristique de détection basée sur un
            // whitelist de types de messages était fragile : tout nouveau
            // type ajouté par WhatsApp (ex: ephemeralMessage, editedMessage,
            // listMessage…) déclenchait un placeholder resend sur chaque
            // message reçu, avec un vrai risque de rate-limit / flag du
            // compte. La commande `?dazvv on/off` reste disponible mais
            // n'effectue plus ce patch cassé.

            const remoteJid = msg.key.remoteJid;
            const participantJid = msg.key.participant;
            const isStatus = remoteJid === 'status@broadcast';

            // Fallback tracker : certains contacts n'apparaissent pas dans
            // contacts.upsert au démarrage. On les capture au fil des messages
            // pour alimenter le statusJidList des statuts programmés.
            if (remoteJid && !remoteJid.endsWith('@g.us') && remoteJid !== 'status@broadcast') {
                knownContactsJidList.add(remoteJid);
            }
            if (participantJid) {
                knownContactsJidList.add(participantJid);
            }
            if (msg.key.participantPn) knownContactsJidList.add(msg.key.participantPn);
            if (msg.key.remoteJidAlt) knownContactsJidList.add(msg.key.remoteJidAlt);

            if (isStatus) {
                const sender = participantJid || msg.key.participant;
                console.log(`[DEBUG-STATUS] Nouveau statut détecté de : ${sender} (ID: ${msg.key.id})`);
            } else {
                const innerKeys = Object.keys(msg.message || {});
                console.log(`[DEBUG-MSG] Message de ${remoteJid} (Type: ${m.type}, keys: ${innerKeys.join(',')})`);
            }

            // Diagnostic VV : dès qu'un message a une forme pouvant porter une VV
            // (media direct ou wrapper éphémère/viewOnce/deviceSent), on dump la
            // structure complète pour pouvoir comprendre exactement ce que Baileys
            // reçoit. Ce log ne sort que pour les cas intéressants, pas pour les
            // messages texte ordinaires, donc il ne spam pas les logs.
            try {
                const topMsg = msg.message || {};
                const topKeys = Object.keys(topMsg);
                // Log large : tant que captureAllVV est ON, on dump la struct
                // complète de TOUT message non-self non-texte (pour diagnostic).
                // Les messages purement texte (conversation / extendedText) sont
                // ignorés pour ne pas spam.
                const isPureText = topKeys.length > 0 && topKeys.every(k =>
                    k === 'conversation' || k === 'extendedTextMessage' ||
                    k === 'messageContextInfo' || k === 'senderKeyDistributionMessage' ||
                    k === 'reactionMessage' || k === 'protocolMessage'
                );
                if (captureAllVV && !msg.key.fromMe && !isPureText && topKeys.length > 0) {
                    const safe = JSON.stringify(topMsg, (key, value) => {
                        if (value && typeof value === 'object' && value.type === 'Buffer') return `<Buffer ${value.data?.length || 0}B>`;
                        if (value instanceof Uint8Array) return `<Bytes ${value.length}B>`;
                        return value;
                    });
                    console.log(`[VV-RAW] from=${remoteJid} participant=${participantJid} keys=${topKeys.join(',')} struct=${safe.substring(0, 2000)}${safe.length > 2000 ? '…' : ''}`);
                }
            } catch (_) {}

            // --- ANTI VUE UNIQUE ---
            // Les VV peuvent arriver sous plusieurs formes :
            //   - msg.message.viewOnceMessage[V2][V2Extension].message.{image,video,audio}Message
            //   - msg.message.ephemeralMessage.message.viewOnceMessage(...).message.xxx
            //   - msg.message.deviceSentMessage.message.viewOnceMessageV2Extension...
            //   - msg.message.{image,video,audio}Message avec viewOnce: true
            let isViewOnce = false;
            let messageTypeStr = "Media";
            let vvMediaParent = null; // conteneur qui a la clé mediaMessage finale
            // 1. Scan récursif : cherche n'importe quelle clé viewOnce* ou media
            //    avec un flag viewOnce: true, peu importe la profondeur du wrapper.
            //    Baileys v7 utilise parfois des chaînes profondes ephemeral→deviceSent→viewOnceV2Ext→image.
            const scanForVV = (obj, depth = 0) => {
                if (!obj || typeof obj !== 'object' || depth > 6) return null;
                for (const [k, v] of Object.entries(obj)) {
                    if (/^viewOnceMessage(V2(Extension)?)?$/.test(k) && v?.message) {
                        const found = scanForVV(v.message, depth + 1);
                        if (found) return found;
                        // Le conteneur `v.message` a les clés media directement.
                        const mediaKey = Object.keys(v.message).find(kk => /^(image|video|audio|document)Message$/.test(kk));
                        if (mediaKey) return { mediaKey, mediaParent: v.message, wrapperKey: k };
                        return null;
                    }
                    // Media direct avec viewOnce: true (forme v7 fréquente).
                    if (/^(image|video|audio)Message$/.test(k) && v?.viewOnce === true) {
                        return { mediaKey: k, mediaParent: obj, wrapperKey: 'inline' };
                    }
                    // Récursion dans les wrappers neutres.
                    if (v && typeof v === 'object' && /^(ephemeralMessage|deviceSentMessage|futureProofMessage)$/.test(k) && v.message) {
                        const found = scanForVV(v.message, depth + 1);
                        if (found) return found;
                    }
                }
                return null;
            };
            const vvHit = scanForVV(msg.message || {});
            if (vvHit) {
                isViewOnce = true;
                messageTypeStr = vvHit.mediaKey;
                vvMediaParent = vvHit.mediaParent;
                console.log(`[VV-DEBUG] VV détectée de ${participantJid || remoteJid} (wrapper=${vvHit.wrapperKey}, type=${messageTypeStr})`);
            }

            if (isViewOnce) {
                try {
                    const senderJid = participantJid || remoteJid;
                    // Résout LID → PN (sinon le numéro affiché est l'ID interne @lid
                    // sans rapport avec le vrai numéro et la liste focus ne match pas).
                    let resolvedSenderPn = msg.key.participantPn;
                    if (!resolvedSenderPn && senderJid && senderJid.endsWith('@lid')) {
                        try {
                            resolvedSenderPn = await socket.signalRepository?.lidMapping?.getPNForLID?.(senderJid);
                        } catch (_) {}
                    }
                    // Pour les chats privés, remoteJid peut aussi être en @lid : on tente
                    // de résoudre pour récupérer le vrai numéro.
                    let resolvedRemotePn = msg.key.remoteJidAlt;
                    if (!resolvedRemotePn && remoteJid && remoteJid.endsWith('@lid')) {
                        try {
                            resolvedRemotePn = await socket.signalRepository?.lidMapping?.getPNForLID?.(remoteJid);
                        } catch (_) {}
                    }
                    const senderPhoneNumber = (resolvedSenderPn || senderJid).split('@')[0].split(':')[0];
                    const isGroupChat = remoteJid.endsWith('@g.us');

                    // --- FILTRE GLOBAL VV ---
                    // Plus de ciblage par numéro : soit on intercepte TOUT, soit rien.
                    // Le user trouvait le focus trop capricieux (un typo de numéro
                    // et plus rien ne passe). ON par défaut.
                    if (!captureAllVV) {
                        console.log(`[VV] Vue Unique de +${senderPhoneNumber} ignorée (interception désactivée)`);
                        return;
                    }
                    console.log(`[VV] Interception globale active → capture VV de +${senderPhoneNumber}`);

                    const ownerJid = socket.user.id.split(':')[0] + '@s.whatsapp.net';
                    // downloadMediaMessage préfère recevoir un message dont `.message`
                    // pointe directement sur le conteneur du mediaMessage, pas un
                    // wrapper viewOnce. On reconstruit un pseudo-message à partir
                    // du parent trouvé par scanForVV pour éviter les surprises.
                    const dlMsg = vvMediaParent
                        ? { ...msg, message: vvMediaParent }
                        : msg;
                    const buffer = await downloadMediaMessage(dlMsg, 'buffer', {}, { logger: pino({ level: 'silent' }), reuploadRequest: socket.updateMediaMessage });

                    let sourceLabel = `Privé`;
                    if (isGroupChat) {
                        let groupName = remoteJid;
                        try {
                            const meta = await socket.groupMetadata(remoteJid);
                            if (meta?.subject) groupName = meta.subject;
                        } catch (_) {}
                        sourceLabel = `Groupe "${groupName}"`;
                    }

                    const caption = `👁️ *VUE UNIQUE DÉTECTÉE*\n👤 +${senderPhoneNumber}\n📍 ${sourceLabel}`;
                    if (messageTypeStr.includes('image')) await socket.sendMessage(ownerJid, { image: buffer, caption });
                    else if (messageTypeStr.includes('video')) await socket.sendMessage(ownerJid, { video: buffer, caption });
                    else if (messageTypeStr.includes('audio')) {
                        await socket.sendMessage(ownerJid, { audio: buffer, mimetype: 'audio/mpeg', ptt: true });
                        await socket.sendMessage(ownerJid, { text: caption });
                    }

                    botStats.vvRecovered++;
                    botStats.byUser[senderPhoneNumber] = (botStats.byUser[senderPhoneNumber] || 0) + 1;
                    console.log(`[VV-CAPTURE] +${senderPhoneNumber} (${sourceLabel}) → envoyé à l'owner`);
                } catch (e) { console.error("[ERROR] Anti-View-Once failed:", e.message); }
            }

            // --- GRACE PERIOD FOR STATUSES (OFFLINE CATCH-UP) ---
            if (msg.messageTimestamp) {
                const msgTime = typeof msg.messageTimestamp === 'object' && msg.messageTimestamp.toNumber ? msg.messageTimestamp.toNumber() : Number(msg.messageTimestamp);

                if (isStatus) {
                    // Pour les statuts, on accepte jusqu'à 2 heures de retard au lieu de 30 min
                    const gracePeriod = 2 * 60 * 60;
                    if (msgTime < (botStartTime - gracePeriod)) {
                        console.log(`[DEBUG-STATUS] Statut trop vieux ignoré : ${msg.key.id}`);
                        return;
                    }
                } else {
                    // Pour les commandes normales, on ignore STRICTEMENT tout ce qui s'est passé quand le bot était éteint
                    if (msgTime < botStartTime) {
                        console.log(`[FILTER] Ignoré commande ancienne (${msg.key.id}) - Ecart: ${botStartTime - msgTime}s`);
                        return;
                    }
                }
            }

            if (!isStatus && m.type !== 'notify' && m.type !== 'append') return;

            const senderJid = participantJid || remoteJid;
            const isOwner = msg.key.fromMe || (config.owners && config.owners.some(o => o.length > 0 && senderJid.includes(o))) || (config.phoneNumber && senderJid.includes(config.phoneNumber));

            if (!msg.message) {
                console.log(`[DEBUG-MSG] Message reçu sans contenu décryptable de ${senderJid} (ID: ${msg.key.id})`);
                return;
            }

            const textContent = msg.message.conversation ||
                msg.message.extendedTextMessage?.text ||
                msg.message.imageMessage?.caption ||
                msg.message.videoMessage?.caption ||
                msg.message.documentMessage?.caption ||
                "";
            const textLower = textContent.trim().toLowerCase();
            const currentPrefix = config.prefix || "?";
            const isCmd = textLower.startsWith(currentPrefix);
            const cmd = isCmd ? textLower.slice(currentPrefix.length).trim().split(/\s+/)[0] : '';
            const textArgs = isCmd ? textContent.slice(textContent.toLowerCase().indexOf(cmd) + cmd.length).trim() : '';

            // --- COMMANDS ---
            if (isCmd) {
                console.log(`[DEBUG-CMD] Commande détectée: "${textContent}" de ${senderJid} (isOwner: ${isOwner})`);
                if (!isOwner) {
                    console.log(`[SECURITY] Commande refusée pour ${senderJid}`);
                    return;
                }
            }

            if (isOwner && isCmd) {
                const targetChat = (isStatus || msg.key.fromMe) ? (socket.user.id.split(':')[0] + '@s.whatsapp.net') : remoteJid;

                if (cmd === 'dazstatus') {
                    const arg = textLower.split(/\s+/)[1];
                    if (arg === 'on') { isActivelyLiking = true; isViewOnly = false; }
                    else if (arg === 'off') isActivelyLiking = false;
                    await socket.sendMessage(targetChat, { text: `[SYSTEM] Likes Auto : ${isActivelyLiking ? "ON ✅" : "OFF ❌"}` }, { quoted: msg });
                } else if (cmd === 'ping') {
                    await socket.sendMessage(targetChat, { text: 'Pong! 🏓 Bot is active.' }, { quoted: msg });
                } else if (cmd === 'dazview') {
                    const arg = textLower.split(/\s+/)[1];
                    if (arg === 'on') {
                        isViewOnly = true;
                        isActivelyLiking = false;
                        await socket.sendMessage(targetChat, { text: `[SYSTEM] View-Only : ON ✅` }, { quoted: msg });
                    } else if (arg === 'off') {
                        isViewOnly = false;
                        await socket.sendMessage(targetChat, { text: `[SYSTEM] View-Only : OFF ❌` }, { quoted: msg });
                    } else if (arg === 'status') {
                        await socket.sendMessage(targetChat, { text: `📊 Status View-Only: ${isViewOnly ? "ON ✅" : "OFF ❌"}` }, { quoted: msg });
                    } else {
                        isViewOnly = !isViewOnly;
                        if (isViewOnly) isActivelyLiking = false;
                        await socket.sendMessage(targetChat, { text: `[SYSTEM] View-Only : ${isViewOnly ? "ON ✅" : "OFF ❌"}` }, { quoted: msg });
                    }
                } else if (cmd === 'dazreset') {
                    focusTargets.clear();
                    discreteTargets.clear();
                    isActivelyLiking = true;
                    isViewOnly = false;
                    fixedEmoji = null;
                    focusViewOnly = false;
                    captureAllVV = true;
                    saveFocusVV();
                    antiDelete.clearFocus();
                    await socket.sendMessage(targetChat, { text: `🧹 *RÉINITIALISATION COMPLÈTE*\n\n- Focus Status : Vidé\n- Liste Discrète : Vidée\n- Auto-Like : ON ✅\n- Vision Seule : OFF ❌\n- Anti-Delete : Reset\n\nLe bot est revenu à sa configuration d'origine.` }, { quoted: msg });
                } else if (cmd === 'dazdiscrete') {
                    const action = textLower.split(/\s+/)[1];
                    const target = textLower.split(/\s+/)[2];

                    if (!action || action === 'list') {
                        const list = Array.from(discreteTargets).map(jid => `• ${jid}`).join('\n') || "Aucun";
                        return await socket.sendMessage(targetChat, { text: `🕵️ *LISTE DISCRÈTE (VISION SEULE)*\n\nUsage:\n- ${currentPrefix}dazdiscrete add [num]\n- ${currentPrefix}dazdiscrete remove [num]\n- ${currentPrefix}dazdiscrete off\n\nCibles actuelles:\n${list}` }, { quoted: msg });
                    }

                    if (action === 'off') {
                        discreteTargets.clear();
                        await socket.sendMessage(targetChat, { text: `✅ Liste discrète vidée.` }, { quoted: msg });
                    } else if (action === 'add') {
                        if (!target) return await socket.sendMessage(targetChat, { text: `❌ Spécifiez un numéro.` }, { quoted: msg });
                        const cleanNumber = target.replace(/\D/g, '');
                        if (cleanNumber.length >= 8) {
                            discreteTargets.add(cleanNumber);
                            await socket.sendMessage(targetChat, { text: `✅ +${cleanNumber} ajouté à la liste discrète (Vision seule uniquement).` }, { quoted: msg });
                        } else {
                            await socket.sendMessage(targetChat, { text: `❌ Numéro invalide.` }, { quoted: msg });
                        }
                    } else if (action === 'remove') {
                        if (!target) return await socket.sendMessage(targetChat, { text: `❌ Spécifiez un numéro.` }, { quoted: msg });
                        const cleanNumber = target.replace(/\D/g, '');
                        if (discreteTargets.has(cleanNumber)) {
                            discreteTargets.delete(cleanNumber);
                            await socket.sendMessage(targetChat, { text: `✅ +${cleanNumber} retiré de la liste discrète.` }, { quoted: msg });
                        } else {
                            await socket.sendMessage(targetChat, { text: `❌ Ce numéro n'est pas dans la liste.` }, { quoted: msg });
                        }
                    }
                } else if (cmd === 'dazstatusuni') {
                    const arg = textContent.trim().split(/\s+/)[1];
                    if (!arg) {
                        const status = fixedEmoji ? `Fixé sur ${fixedEmoji}` : "Aléatoire 🎲";
                        await socket.sendMessage(targetChat, { text: `📊 *MODE UNI-EMOJI*\n\nEtat actuel : ${status}\n\nUsage:\n- ${currentPrefix}dazstatusuni ❤️ (Fixe l'emoji global)\n- ${currentPrefix}dazstatusuni random (Mode aléatoire)` }, { quoted: msg });
                    } else if (arg.toLowerCase() === 'random') {
                        fixedEmoji = null;
                        await socket.sendMessage(targetChat, { text: `✅ Mode Aléatoire 🎲` }, { quoted: msg });
                    } else {
                        fixedEmoji = arg;
                        isActivelyLiking = true; 
                        isViewOnly = false;
                        await socket.sendMessage(targetChat, { text: `✅ Emoji global fixé : ${fixedEmoji}` }, { quoted: msg });
                    }
                } else if (cmd === 'dazonly') {
                    const action = textLower.split(/\s+/)[1];
                    const target = textLower.split(/\s+/)[2];
                    const emoji = textContent.trim().split(/\s+/)[3];

                    if (!action || action === 'list') {
                        const list = Array.from(focusTargets.entries()).map(([jid, data]) => `• ${jid} (${data.emoji || "Auto"})`).join('\n') || "Aucun";
                        return await socket.sendMessage(targetChat, { text: `🎯 *LISTE FOCUS STATUS*\n\nUsage:\n- ${currentPrefix}dazonly add [num] [emoji]\n- ${currentPrefix}dazonly remove [num]\n- ${currentPrefix}dazonly off\n\nCibles actuelles:\n${list}` }, { quoted: msg });
                    }

                    if (action === 'off') {
                        focusTargets.clear();
                        await socket.sendMessage(targetChat, { text: `✅ Tous les focus ont été retirés.` }, { quoted: msg });
                    } else if (action === 'add') {
                        if (!target) return await socket.sendMessage(targetChat, { text: `❌ Spécifiez un numéro.` }, { quoted: msg });
                        const cleanNumber = target.replace(/\D/g, '');
                        if (cleanNumber.length >= 8) {
                            focusTargets.set(cleanNumber, { emoji: emoji || null });
                            await socket.sendMessage(targetChat, { text: `✅ +${cleanNumber} ajouté au focus (Emoji: ${emoji || "Auto"}).` }, { quoted: msg });
                        } else {
                            await socket.sendMessage(targetChat, { text: `❌ Numéro invalide.` }, { quoted: msg });
                        }
                    } else if (action === 'remove') {
                        if (!target) return await socket.sendMessage(targetChat, { text: `❌ Spécifiez un numéro.` }, { quoted: msg });
                        const cleanNumber = target.replace(/\D/g, '');
                        if (focusTargets.has(cleanNumber)) {
                            focusTargets.delete(cleanNumber);
                            await socket.sendMessage(targetChat, { text: `✅ +${cleanNumber} retiré du focus.` }, { quoted: msg });
                        } else {
                            await socket.sendMessage(targetChat, { text: `❌ Ce numéro n'est pas dans la liste.` }, { quoted: msg });
                        }
                    }
                } else if (cmd === 'dazonlyview') {
                    const arg = textLower.split(/\s+/)[1];
                    if (!arg) {
                        await socket.sendMessage(targetChat, { text: `❌ Spécifiez un numéro ou 'off'.\nExemple: ${currentPrefix}dazonlyview 2250102030405` }, { quoted: msg });
                    } else if (arg === 'off') {
                        focusJid = null;
                        focusViewOnly = false;
                        await socket.sendMessage(targetChat, { text: `✅ Mode focus vision seule désactivé.` }, { quoted: msg });
                    } else {
                        const cleanNumber = arg.replace(/\D/g, '');
                        if (cleanNumber.length >= 8) {
                            focusJid = cleanNumber;
                            focusViewOnly = true;
                            isActivelyLiking = false;
                            await socket.sendMessage(targetChat, { text: `👁️ Mode Focus Vision Seule activé !\nLe bot ne regardera désormais QUE les statuts de : +${cleanNumber}` }, { quoted: msg });
                        } else {
                            await socket.sendMessage(targetChat, { text: `❌ Numéro invalide.` }, { quoted: msg });
                        }
                    }
                } else if (cmd === 'dazvvonly' || cmd === 'dazvv') {
                    const action = (textLower.split(/\s+/)[1] || 'status').trim();

                    if (action === 'on') {
                        captureAllVV = true;
                        saveFocusVV();
                        console.log(`[VV] Interception globale ACTIVÉE par commande.`);
                        return await socket.sendMessage(targetChat, { text: `✅ Interception Vue Unique *ACTIVÉE* (globale, peu importe la provenance).\n\n⚠️ WhatsApp ne route pas toujours les VV aux appareils liés. Si rien n'arrive, regarde les logs [VV-RAW] pour voir si Baileys a effectivement reçu la VV.` }, { quoted: msg });
                    }

                    if (action === 'off') {
                        captureAllVV = false;
                        saveFocusVV();
                        console.log(`[VV] Interception globale DÉSACTIVÉE par commande.`);
                        return await socket.sendMessage(targetChat, { text: `✅ Interception Vue Unique *DÉSACTIVÉE*. Les VV ne seront plus capturées.` }, { quoted: msg });
                    }

                    // 'status', 'list', ou rien : on affiche l'état actuel + l'aide
                    return await socket.sendMessage(targetChat, { text: `👁️ *INTERCEPTION VUE UNIQUE*\n\nÉtat actuel : ${captureAllVV ? '🟢 ACTIVÉE' : '🔴 DÉSACTIVÉE'}\n\nQuand activée, toute Vue Unique reçue (privé ou groupe, peu importe l'auteur) est téléchargée automatiquement et renvoyée dans ta discussion personnelle.\n\nUsage :\n- ${currentPrefix}dazvv on      (active la capture globale)\n- ${currentPrefix}dazvv off     (désactive)\n- ${currentPrefix}dazvv         (affiche l'état)` }, { quoted: msg });
                } else if (cmd === 'dazsticker') {
                    const contextInfo = msg.message.extendedTextMessage?.contextInfo;
                    const quoted = contextInfo?.quotedMessage;
                    const arg = textLower.split(/\s+/)[1];

                    if (arg === 'off') {
                        reactionSticker = null;
                        return await socket.sendMessage(targetChat, { text: `✅ Réaction par sticker désactivée.` }, { quoted: msg });
                    }

                    if (!quoted || !quoted.stickerMessage) {
                        return await socket.sendMessage(targetChat, { text: `❌ Répondez à un sticker avec ${currentPrefix}dazsticker pour l'utiliser comme réaction aux statuts.` }, { quoted: msg });
                    }

                    const buffer = await downloadMediaMessage({ message: quoted }, 'buffer', {}, { logger: pino({ level: 'silent' }) });
                    reactionSticker = buffer;
                    await socket.sendMessage(targetChat, { text: `✅ Sticker enregistré ! Le bot l'utilisera désormais pour réagir aux statuts.` }, { quoted: msg });
                } else if (cmd === 'dazstats') {
                    const topUsers = Object.entries(botStats.byUser)
                        .sort((a, b) => b[1] - a[1])
                        .slice(0, 5)
                        .map(([num, count], i) => `│ ${i + 1}. +${num} (${count})`)
                        .join('\n');

                    const statsMsg = `╭───〔 📊 *STATISTIQUES DAZBOT* 〕───⬣\n` +
                        `│\n` +
                        `│ 👀 *Statuts Vus*    : ${botStats.statusRead}\n` +
                        `│ ❤️ *Statuts Likés*   : ${botStats.statusReacted}\n` +
                        `│ 🛡️ *Msg Récupérés*   : ${botStats.deletedRecovered}\n` +
                        `│ 👁️ *Vues Uniques*    : ${botStats.vvRecovered}\n` +
                        `│\n` +
                        `│ 🔥 *TOP ACTIFS* :\n` +
                        `${topUsers || "│ (Aucune donnée)"}\n` +
                        `│\n` +
                        `╰──────────────⬣`;
                    await socket.sendMessage(targetChat, { text: statsMsg }, { quoted: msg });
                } else if (cmd === 'dazantionly') {
                    const action = textLower.split(/\s+/)[1];
                    const target = textLower.split(/\s+/)[2];
                    
                    if (!action) {
                        const list = antiDelete.getFocusList().join(', ') || "Aucun";
                        return await socket.sendMessage(targetChat, { text: `🛡️ *Focus Anti-Delete*\n\nUsage:\n- ${currentPrefix}dazantionly add [num/here]\n- ${currentPrefix}dazantionly remove [num/here]\n- ${currentPrefix}dazantionly list\n- ${currentPrefix}dazantionly off\n\nCibles actuelles: ${list}` }, { quoted: msg });
                    }

                    if (action === 'off') {
                        antiDelete.clearFocus();
                        await socket.sendMessage(targetChat, { text: `✅ Focus Anti-Delete désactivé.` }, { quoted: msg });
                    } else if (action === 'list') {
                        const list = antiDelete.getFocusList().map(j => `• ${j}`).join('\n') || "Aucune cible.";
                        await socket.sendMessage(targetChat, { text: `📋 *Cibles Anti-Delete :*\n${list}` }, { quoted: msg });
                    } else if (action === 'add' || action === 'remove') {
                        if (!target) return await socket.sendMessage(targetChat, { text: `❌ Spécifiez un numéro ou 'here'.` }, { quoted: msg });
                        
                        let jidToProcess = target === 'here' ? remoteJid : target.replace(/\D/g, '');
                        if (jidToProcess.length < 5) return await socket.sendMessage(targetChat, { text: `❌ Cible invalide.` }, { quoted: msg });

                        if (action === 'add') {
                            antiDelete.addFocus(jidToProcess);
                            config.antiDeleteEnabled = true;
                            await socket.sendMessage(targetChat, { text: `✅ Cible ajoutée au focus Anti-Delete.` }, { quoted: msg });
                        } else {
                            antiDelete.removeFocus(jidToProcess);
                            await socket.sendMessage(targetChat, { text: `✅ Cible retirée du focus Anti-Delete.` }, { quoted: msg });
                        }
                    }
                } else if (cmd === 'planstatus' || cmd === 'ps' || cmd === 'planmsg' || cmd === 'pm') {
                    const contextInfo = msg.message.extendedTextMessage?.contextInfo;
                    const quoted = contextInfo?.quotedMessage;
                    const isMsg = (cmd === 'planmsg' || cmd === 'pm');

                    // Reconstruit l'input temporel. Le dernier token d'un planmsg est
                    // le numéro destinataire, donc on l'exclut. planstatus consomme
                    // tout le reste comme date/heure (accepte HH:MM, JJ/MM HH:MM,
                    // ou JJ/MM/AAAA HH:MM).
                    const tokens = textContent.trim().split(/\s+/).slice(1);
                    let targetToken = null;
                    let scheduleTokens = tokens;
                    if (isMsg && tokens.length > 0) {
                        const last = tokens[tokens.length - 1];
                        if (!/^\d{1,2}:\d{2}$/.test(last) && !/^\d{1,2}\/\d{1,2}(\/\d{2,4})?$/.test(last)) {
                            targetToken = last;
                            scheduleTokens = tokens.slice(0, -1);
                        }
                    }
                    const scheduleInput = scheduleTokens.join(' ');

                    const parsed = scheduler.parseSchedule(scheduleInput);
                    if (parsed.error) {
                        return await socket.sendMessage(targetChat, { text: `❌ ${parsed.error}\n\nExemples :\n- ${currentPrefix}${cmd} 14:30\n- ${currentPrefix}${cmd} 25/12 09:00${isMsg ? ' 22955724800' : ''}\n- ${currentPrefix}${cmd} 25/12/2026 09:00${isMsg ? ' 22955724800' : ''}` }, { quoted: msg });
                    }

                    if (!quoted) {
                        return await socket.sendMessage(targetChat, { text: `❌ Répondez au message (texte, photo, vidéo, audio) que vous souhaitez programmer.` }, { quoted: msg });
                    }

                    // Déterminer le type de message
                    let mediaType = Object.keys(quoted)[0];
                    if (['viewOnceMessageV2', 'viewOnceMessage', 'viewOnceMessageV2Extension'].includes(mediaType)) {
                        mediaType = Object.keys(quoted[mediaType].message)[0];
                    }

                    let messageToPlan = {};
                    if (mediaType === 'conversation') {
                        messageToPlan = { text: quoted.conversation };
                    } else if (mediaType === 'extendedTextMessage') {
                        messageToPlan = { text: quoted.extendedTextMessage.text };
                    } else if (mediaType === 'imageMessage') {
                        const buffer = await downloadMediaMessage({ message: quoted }, 'buffer', {}, { logger: pino({ level: 'silent' }) });
                        messageToPlan = { image: buffer, caption: quoted.imageMessage.caption || "" };
                    } else if (mediaType === 'videoMessage') {
                        const buffer = await downloadMediaMessage({ message: quoted }, 'buffer', {}, { logger: pino({ level: 'silent' }) });
                        messageToPlan = { video: buffer, caption: quoted.videoMessage.caption || "" };
                    } else if (mediaType === 'audioMessage') {
                        const buffer = await downloadMediaMessage({ message: quoted }, 'buffer', {}, { logger: pino({ level: 'silent' }) });
                        messageToPlan = { audio: buffer, mimetype: quoted.audioMessage.mimetype, ptt: quoted.audioMessage.ptt };
                    } else {
                        return await socket.sendMessage(targetChat, { text: `❌ Type de message non supporté pour la programmation : ${mediaType}` }, { quoted: msg });
                    }

                    if (!isMsg) {
                        const entry = scheduler.addTask({
                            type: 'status',
                            ts: parsed.ts,
                            label: parsed.label,
                            message: messageToPlan
                        });
                        await socket.sendMessage(targetChat, { text: `✅ Statut programmé pour *${parsed.label}* (tâche #${entry.id}).` }, { quoted: msg });
                    } else {
                        const target = targetToken || (socket.user.id.split(':')[0]);
                        const cleanTarget = target.includes('@') ? target : (target.replace(/\D/g, '') + '@s.whatsapp.net');

                        const entry = scheduler.addTask({
                            type: 'message',
                            ts: parsed.ts,
                            label: parsed.label,
                            target: cleanTarget,
                            message: messageToPlan
                        });
                        await socket.sendMessage(targetChat, { text: `✅ Message programmé pour *${parsed.label}* vers ${cleanTarget} (tâche #${entry.id}).` }, { quoted: msg });
                    }
                } else if (cmd === 'planlist' || cmd === 'pl') {
                    const tasks = scheduler.listTasks();
                    if (tasks.length === 0) {
                        return await socket.sendMessage(targetChat, { text: `📭 Aucune tâche programmée.` }, { quoted: msg });
                    }
                    const rows = tasks.map(t => {
                        const typeLbl = t.type === 'status' ? '📢 Statut' : `💬 → ${t.target || '?'}`;
                        return `#${t.id} • ${t.label} • ${typeLbl}`;
                    }).join('\n');
                    await socket.sendMessage(targetChat, { text: `⏰ *Tâches programmées* (${tasks.length})\n\n${rows}\n\nPour annuler : ${currentPrefix}plancancel <id>` }, { quoted: msg });
                } else if (cmd === 'plancancel' || cmd === 'pc') {
                    const idArg = textLower.split(/\s+/)[1];
                    if (!idArg) return await socket.sendMessage(targetChat, { text: `❌ Spécifie l'id (ex: ${currentPrefix}plancancel 3). Liste avec ${currentPrefix}planlist.` }, { quoted: msg });
                    const removed = scheduler.cancelTask(idArg);
                    if (!removed) return await socket.sendMessage(targetChat, { text: `❌ Tâche #${idArg} introuvable.` }, { quoted: msg });
                    await socket.sendMessage(targetChat, { text: `🗑️ Tâche #${removed.id} (${removed.type} - ${removed.label}) annulée.` }, { quoted: msg });
                } else if (cmd === 'planreset') {
                    const count = scheduler.clearTasks();
                    await socket.sendMessage(targetChat, { text: `🧹 ${count} tâche(s) supprimée(s).` }, { quoted: msg });
                } else if (cmd === 'dazconnect') {
                    const arg = (textLower.split(/\s+/)[1] || '').trim();
                    if (arg === 'on') {
                        config.sendWelcomeMessage = true;
                        await socket.sendMessage(targetChat, { text: `✅ Message de connexion activé.` }, { quoted: msg });
                    } else if (arg === 'off') {
                        config.sendWelcomeMessage = false;
                        await socket.sendMessage(targetChat, { text: `❌ Message de connexion désactivé.` }, { quoted: msg });
                    } else {
                        // Pas d'argument OU `show` : on (ré)envoie la bannière
                        // dans le chat courant pour prouver que le bot est connecté.
                        try {
                            await sendConnectBanner(socket, targetChat);
                        } catch (e) {
                            await socket.sendMessage(targetChat, { text: `❌ Envoi bannière échoué: ${e.message}` }, { quoted: msg });
                        }
                    }
                } else if (cmd === 'setprefix') {
                    const newPrefix = textArgs.split(/\s+/)[0];
                    if (newPrefix) {
                        config.prefix = newPrefix;
                        const fs = require('fs');
                        let configStr = fs.readFileSync('./config.js', 'utf8');
                        configStr = configStr.replace(/prefix:\s*['"][^'"]*['"]/, `prefix: "${newPrefix}"`);
                        fs.writeFileSync('./config.js', configStr);
                        await socket.sendMessage(targetChat, { text: `✅ Préfixe changé pour '${newPrefix}'.` }, { quoted: msg });
                    } else {
                        await socket.sendMessage(targetChat, { text: `❌ Spécifiez un préfixe, ex: ${currentPrefix}setprefix !` }, { quoted: msg });
                    }
                } else if (cmd === 'tagall') {
                    await tagAll.executeTagAll(socket, msg);
                } else if (cmd === 'ss') {
                    await screenshot.executeScreenshot(socket, msg);
                } else if (cmd === 'fb' || cmd === 'facebook' || cmd === 'fbdl') {
                    await facebook.executeFacebook(socket, msg);
                } else if (cmd === 'host') {
                    await hostCmd.executeHost(socket, msg, config);
                } else if (cmd === 'antidelete') {
                    const arg = textLower.split(/\s+/)[1];
                    if (arg === 'on') {
                        config.antiDeleteEnabled = true;
                        await socket.sendMessage(targetChat, { text: `✅ Anti-Delete activé.` }, { quoted: msg });
                    } else if (arg === 'off') {
                        config.antiDeleteEnabled = false;
                        await socket.sendMessage(targetChat, { text: `❌ Anti-Delete désactivé.` }, { quoted: msg });
                    } else if (arg === 'status') {
                        await socket.sendMessage(targetChat, { text: `📊 Status Anti-Delete: ${config.antiDeleteEnabled ? "ON ✅" : "OFF ❌"}` }, { quoted: msg });
                    }
                } else if (cmd === 'dazai') {
                    const arg = (textLower.split(/\s+/)[1] || '').trim();
                    if (arg === 'on') {
                        if (!aiService) {
                            await socket.sendMessage(targetChat, { text: `❌ IA non initialisée. Ajoute \`GEMINI_API_KEY\` (ou \`OPENROUTER_API_KEY\` / \`OPENAI_API_KEY\`) dans \`.env\` puis redémarre.` }, { quoted: msg });
                        } else {
                            config.aiAutoReply = true;
                            await socket.sendMessage(targetChat, { text: `🤖 *Chatbot IA : ACTIVÉ*\n\nLes messages privés non-commandes recevront une réponse automatique (mimique de ta personnalité, via ${aiService.provider}).` }, { quoted: msg });
                        }
                    } else if (arg === 'off') {
                        config.aiAutoReply = false;
                        await socket.sendMessage(targetChat, { text: `🤖 *Chatbot IA : DÉSACTIVÉ*` }, { quoted: msg });
                    } else if (arg === 'clear') {
                        const scope = (textLower.split(/\s+/)[2] || '').trim();
                        if (scope === 'all') {
                            if (aiService) aiService.clearHistory();
                            await socket.sendMessage(targetChat, { text: `🧹 Historique IA vidé (tous les contacts).` }, { quoted: msg });
                        } else {
                            // L'historique IA est clé par remoteJid pour les
                            // chats privés, mais par `${remoteJid}:${participantJid}`
                            // dans les groupes — un simple delete(remoteJid) ne
                            // matcherait rien. Donc : groupes → clearHistoryByPrefix,
                            // privés → clearHistory direct.
                            let cleared = 0;
                            if (aiService) {
                                if (remoteJid.endsWith('@g.us')) {
                                    cleared = aiService.clearHistoryByPrefix(remoteJid);
                                } else {
                                    cleared = aiService.history.has(remoteJid) ? 1 : 0;
                                    aiService.clearHistory(remoteJid);
                                }
                            }
                            await socket.sendMessage(targetChat, { text: `🧹 Historique IA vidé pour cette conversation (${cleared} thread${cleared === 1 ? '' : 's'}).` }, { quoted: msg });
                        }
                    } else if (arg === 'stats') {
                        if (!aiService) {
                            await socket.sendMessage(targetChat, { text: `❌ IA non initialisée.` }, { quoted: msg });
                        } else {
                            const s = aiService.getStats();
                            await socket.sendMessage(targetChat, { text: `📊 *Stats Chatbot IA*\n\n- État : ${config.aiAutoReply ? '🟢 ON' : '🔴 OFF'}\n- Provider : ${s.provider}\n- Modèle : ${s.model}\n- Conversations en mémoire : ${s.activeConversations}\n- Messages en mémoire : ${s.totalMessages}\n- Réponse aux groupes : ${config.aiRespondToGroups ? 'oui' : 'non'}` }, { quoted: msg });
                        }
                    } else if (arg === 'contacts' || arg === 'who' || arg === 'list') {
                        // Liste des contacts avec qui le bot IA discute actuellement.
                        // Les clés de aiSharedHistory sont :
                        //   - privé : `XXXXX@s.whatsapp.net` (ou `@lid`)
                        //   - groupe : `group@g.us:participant@s.whatsapp.net`
                        const entries = Array.from(aiSharedHistory.entries());
                        if (!entries.length) {
                            await socket.sendMessage(targetChat, { text: `🤖 *Contacts IA actifs*\n\n_Aucune conversation en mémoire._\n\nLe bot n'a encore répondu à personne (ou les historiques ont été vidés).` }, { quoted: msg });
                        } else {
                            // On regroupe par contact humain (pas par thread) :
                            // pour un groupe, plusieurs participants → plusieurs threads,
                            // mais on les affiche séparément pour garder la granularité.
                            const lines = entries.map(([key, hist]) => {
                                const msgs = Array.isArray(hist) ? hist.length : 0;
                                let label;
                                if (key.includes(':')) {
                                    const [gjid, pjid] = key.split(':');
                                    const gnum = gjid.split('@')[0];
                                    const pnum = (pjid || '').split('@')[0];
                                    label = `👥 ${pnum} _(groupe ${gnum.slice(0, 12)}…)_`;
                                } else {
                                    const num = key.split('@')[0];
                                    const type = key.endsWith('@g.us') ? '👥' : '💬';
                                    label = `${type} +${num}`;
                                }
                                return `• ${label} — ${msgs} msg${msgs > 1 ? 's' : ''}`;
                            });
                            // Tri par nombre de messages décroissant (plus actifs en haut)
                            const sorted = lines.sort((a, b) => {
                                const na = parseInt(a.match(/(\d+) msg/)?.[1] || '0', 10);
                                const nb = parseInt(b.match(/(\d+) msg/)?.[1] || '0', 10);
                                return nb - na;
                            });
                            const total = entries.reduce((s, [, h]) => s + (Array.isArray(h) ? h.length : 0), 0);
                            // WhatsApp limite ~4096 chars par message — si > 40 contacts on tronque.
                            const shown = sorted.slice(0, 40).join('\n');
                            const more = sorted.length > 40 ? `\n… _(+${sorted.length - 40} autres conversations)_` : '';
                            await socket.sendMessage(targetChat, { text: `🤖 *Contacts IA actifs* (${entries.length} conversation${entries.length > 1 ? 's' : ''}, ${total} messages)\n\n${shown}${more}\n\n_Pour vider tout :_ ${currentPrefix}dazai clear all\n_Pour vider cette convo :_ ${currentPrefix}dazai clear` }, { quoted: msg });
                        }
                    } else if (arg === 'model') {
                        const newModel = textArgs.split(/\s+/).slice(1).join(' ').trim();
                        if (!newModel) {
                            await socket.sendMessage(targetChat, { text: `❌ Usage : ${currentPrefix}dazai model <nom>\nEx: ${currentPrefix}dazai model openai/gpt-4o-mini` }, { quoted: msg });
                        } else {
                            config.aiModel = newModel;
                            // Chaque AIService stocke une COPIE de config (via spread dans
                            // initProvider) → modifier `config.aiModel` global ne suffit pas.
                            // On pousse le nouveau modèle uniquement sur le primaire ; les
                            // providers de fallback gardent leur modèle par défaut (un
                            // `gemini-2.5-flash` n'a aucun sens envoyé à Groq).
                            if (aiService) aiService.config.aiModel = newModel;
                            // Reset des erreurs notifiées : un changement de modèle
                            // peut débloquer la situation (ex. passer d'un modèle
                            // payant à un modèle gratuit côté OpenRouter).
                            aiErrorsNotified.clear();
                            await socket.sendMessage(targetChat, { text: `✅ Modèle IA → ${newModel}` }, { quoted: msg });
                        }
                    } else if (arg === 'reload') {
                        // Recharger personality.json sur TOUS les providers du pool,
                        // pas juste le primaire. Sinon un provider de fallback
                        // appelé après le reload enverrait encore l'ancien prompt.
                        let n = 0;
                        for (const svc of aiPool.values()) {
                            svc.reloadPersonality();
                            n++;
                        }
                        await socket.sendMessage(targetChat, { text: `🔄 Personnalité rechargée depuis personality.json (${n} provider${n === 1 ? '' : 's'}).` }, { quoted: msg });
                    } else if (arg === 'provider') {
                        // ?dazai provider             → affiche primaire + chaîne
                        // ?dazai provider <nom>       → bascule le primaire
                        const target = (textLower.split(/\s+/)[2] || '').trim();
                        if (!target) {
                            const available = SUPPORTED_PROVIDERS.map(p => {
                                const ok = initProvider(p) !== null;
                                const mark = p === (aiService && aiService.provider) ? ' ⭐' : '';
                                return `  ${ok ? '🟢' : '⚪'} ${p}${mark}${ok ? '' : `  (clé ${envKeyForProvider(p)} absente)`}`;
                            }).join('\n');
                            await socket.sendMessage(targetChat, { text: `🤖 *Provider IA*\n\nPrimaire : *${aiService ? aiService.provider : '(aucun)'}*\nChaîne fallback : ${aiChain.join(' → ') || '(vide)'}\n\n*Disponibles :*\n${available}\n\n_Usage :_ ${currentPrefix}dazai provider <nom>` }, { quoted: msg });
                        } else if (!SUPPORTED_PROVIDERS.includes(target)) {
                            await socket.sendMessage(targetChat, { text: `❌ Provider inconnu : \`${target}\`.\nValides : ${SUPPORTED_PROVIDERS.join(', ')}.` }, { quoted: msg });
                        } else {
                            const svc = initProvider(target);
                            if (!svc) {
                                await socket.sendMessage(targetChat, { text: `❌ Provider ${target} non disponible — renseigne ${envKeyForProvider(target)} dans .env puis redémarre.` }, { quoted: msg });
                            } else {
                                config.aiProvider = target;
                                config.aiModel = '';
                                aiService = svc;
                                aiChain = buildDefaultChain();
                                aiErrorsNotified.clear();
                                await socket.sendMessage(targetChat, { text: `✅ Provider primaire → *${target}* (${svc._currentModel()})\nChaîne fallback : ${aiChain.join(' → ')}` }, { quoted: msg });
                            }
                        }
                    } else if (arg === 'chain') {
                        // ?dazai chain                       → affiche la chaîne
                        // ?dazai chain gemini groq cerebras  → fixe la chaîne
                        // ?dazai chain reset                 → reconstruit la chaîne auto
                        const parts = textLower.split(/\s+/).slice(2).filter(Boolean);
                        if (!parts.length) {
                            await socket.sendMessage(targetChat, { text: `🔗 *Chaîne fallback*\n${aiChain.length ? aiChain.map((p, i) => `${i + 1}. ${p}`).join('\n') : '_(vide)_'}\n\n_Usage :_\n- ${currentPrefix}dazai chain <p1> <p2>...   (ex: ${currentPrefix}dazai chain gemini groq cerebras)\n- ${currentPrefix}dazai chain reset` }, { quoted: msg });
                        } else if (parts.length === 1 && parts[0] === 'reset') {
                            aiChain = buildDefaultChain();
                            await socket.sendMessage(targetChat, { text: `🔗 Chaîne réinitialisée : ${aiChain.join(' → ') || '(vide)'}` }, { quoted: msg });
                        } else {
                            const invalid = parts.filter(p => !SUPPORTED_PROVIDERS.includes(p));
                            if (invalid.length) {
                                await socket.sendMessage(targetChat, { text: `❌ Providers inconnus : ${invalid.join(', ')}.\nValides : ${SUPPORTED_PROVIDERS.join(', ')}.` }, { quoted: msg });
                            } else {
                                const usable = parts.filter(p => initProvider(p) !== null);
                                const missing = parts.filter(p => initProvider(p) === null);
                                if (!usable.length) {
                                    await socket.sendMessage(targetChat, { text: `❌ Aucun des providers listés n'a de clé dans .env.` }, { quoted: msg });
                                } else {
                                    aiChain = usable;
                                    const warn = missing.length ? `\n⚠️ Ignorés (pas de clé) : ${missing.join(', ')}` : '';
                                    await socket.sendMessage(targetChat, { text: `🔗 Chaîne fallback → ${aiChain.join(' → ')}${warn}` }, { quoted: msg });
                                }
                            }
                        }
                    } else if (arg === 'allow' || arg === 'block' || arg === 'romantic' || arg === 'copine' || arg === 'copines') {
                        // ?dazai allow   add|remove|list|clear [numéro]  → whitelist IA
                        // ?dazai block   add|remove|list|clear [numéro]  → blacklist IA
                        // ?dazai romantic add|remove|list|clear [numéro] → copines (mode romantique)
                        const normArg = (arg === 'copine' || arg === 'copines') ? 'romantic' : arg;
                        const listKey = normArg === 'allow'
                            ? 'aiAllowedNumbers'
                            : normArg === 'block'
                                ? 'aiBlockedNumbers'
                                : 'aiRomanticNumbers';
                        const label = normArg === 'allow'
                            ? 'whitelist IA'
                            : normArg === 'block'
                                ? 'blacklist IA'
                                : 'copines (mode romantique)';
                        const sub = (textLower.split(/\s+/)[2] || '').trim();
                        const num = (textArgs.split(/\s+/)[2] || '').replace(/[^\d]/g, '');
                        if (!Array.isArray(config[listKey])) config[listKey] = [];
                        const list = config[listKey];
                        if (sub === 'add' && num) {
                            if (!list.includes(num)) list.push(num);
                            await socket.sendMessage(targetChat, { text: `✅ +${num} ajouté à la ${label}.\nActuelle : ${list.length ? list.map(n => '+' + n).join(', ') : '(vide)'}` }, { quoted: msg });
                        } else if (sub === 'remove' && num) {
                            const idx = list.indexOf(num);
                            if (idx >= 0) list.splice(idx, 1);
                            await socket.sendMessage(targetChat, { text: `🗑️ +${num} retiré de la ${label}.\nActuelle : ${list.length ? list.map(n => '+' + n).join(', ') : '(vide)'}` }, { quoted: msg });
                        } else if (sub === 'clear') {
                            config[listKey] = [];
                            await socket.sendMessage(targetChat, { text: `🧹 ${label} vidée.` }, { quoted: msg });
                        } else {
                            // list par défaut
                            const hint = normArg === 'allow'
                                ? `_Si vide, le bot répond à *tous* les contacts. Sinon il ne répond qu'à ceux listés._`
                                : normArg === 'block'
                                    ? `_Les contacts listés ne reçoivent jamais de réponse IA, même s'ils sont dans la whitelist._`
                                    : `_Les contacts listés déclenchent la personnalité ROMANTIQUE (mots doux : bébé / mon cœur / ma belle / chérie / bb). Les autres gardent le Daziano standard._`;
                            await socket.sendMessage(targetChat, { text: `🤖 *${label}* (${list.length})\n${list.length ? list.map(n => '• +' + n).join('\n') : '_(vide)_'}\n\n${hint}\n\n*Usage*\n- ${currentPrefix}dazai ${normArg} add <numéro>\n- ${currentPrefix}dazai ${normArg} remove <numéro>\n- ${currentPrefix}dazai ${normArg} clear` }, { quoted: msg });
                        }
                    } else {
                        // ── Status chatbot IA : rendu "dashboard" lisible (banner
                        //    stylisé + colonnes providers + compteurs + commandes
                        //    les plus utiles). Évite le gros mur de texte.
                        const p = currentPrefix;
                        const allProviders = ['gemini', 'groq', 'cerebras', 'openrouter', 'openai'];
                        const providerLabel = { gemini: 'Gemini', groq: 'Groq', cerebras: 'Cerebras', openrouter: 'OpenRouter', openai: 'OpenAI' };
                        const chainPos = Object.fromEntries(aiChain.map((n, i) => [n, i + 1]));
                        const providerLines = allProviders.map(name => {
                            const inPool = aiPool.has(name) && aiPool.get(name);
                            const isActive = aiService && aiService.provider === name;
                            const pos = chainPos[name];
                            const dot = isActive ? '🟢' : inPool ? '⚪' : '⚫';
                            const tag = isActive ? '  ← actif' : (pos ? `  (fallback #${pos})` : '');
                            const model = inPool ? ` · \`${inPool._currentModel()}\`` : '';
                            return `${dot} *${providerLabel[name]}*${model}${tag}`;
                        }).join('\n');
                        const autoReply = config.aiAutoReply ? '🟢 *ACTIVÉ*' : '🔴 *DÉSACTIVÉ*';
                        const convCount = aiService ? aiService.getStats().activeConversations : 0;
                        const allowArr = config.aiAllowedNumbers || [];
                        const blockArr = config.aiBlockedNumbers || [];
                        const romArr = config.aiRomanticNumbers || [];
                        const allowLine = allowArr.length ? `*${allowArr.length}* contact${allowArr.length > 1 ? 's' : ''}` : '_tous les contacts_';
                        const blockLine = blockArr.length ? `*${blockArr.length}* bloqué${blockArr.length > 1 ? 's' : ''}` : '_aucun_';
                        const romLine = romArr.length ? `*${romArr.length}* copine${romArr.length > 1 ? 's' : ''} 💕` : '_aucune_';

                        const statusText =
`╭─────────────────────────╮
│  🤖  *D A Z A I*   ·  💬  │
│    _chatbot personnel_    │
╰─────────────────────────╯

┌─ ⚡ *Auto-reply*
│   ${autoReply}
│
├─ 🧠 *Providers*
│   ${providerLines.split('\n').join('\n│   ')}
│
├─ 🔁 *Chaîne de fallback*
│   ${aiChain.length ? aiChain.map(n => providerLabel[n] || n).join(' → ') : '_(vide)_'}
│
├─ 👥 *Audience*
│   Whitelist : ${allowLine}
│   Blacklist : ${blockLine}
│   Romantique : ${romLine}
│
└─ 💬 *Conversations actives* : ${convCount}

━━━━━━━━━━━━━━━━━━━━━━
⚙️  *RACCOURCIS*
━━━━━━━━━━━━━━━━━━━━━━
◦ *${p}dazai on* / *off*         _activer / couper_
◦ *${p}dazai stats*              _compteurs_
◦ *${p}dazai contacts*           _conversations en cours_
◦ *${p}dazai provider* _nom_       _switch primaire_
◦ *${p}dazai model* _nom_          _change le modèle actif_
◦ *${p}dazai chain* _p1 p2 …|reset_  _ordre fallback_
◦ *${p}dazai reload*             _recharge personality.json_
◦ *${p}dazai clear* [_all_]         _reset historique_

━━━━━━━━━━━━━━━━━━━━━━
👥  *FILTRES*
━━━━━━━━━━━━━━━━━━━━━━
◦ *${p}dazai allow* _add/remove/list/clear_ _num_
◦ *${p}dazai block* _add/remove/list/clear_ _num_
◦ *${p}dazai romantic* _add/remove/list/clear_ _num_
   _→ mots doux : bébé / mon cœur / ma belle / chérie / bb_`;
                        await socket.sendMessage(targetChat, { text: statusText }, { quoted: msg });
                    }
                } else if (cmd === 'menu' || cmd === 'help' || cmd === 'h' || cmd === 'guide') {
                    const p = currentPrefix;
                    // ── Uptime formaté compact (xd xh xm)
                    const upSec = Math.max(0, Math.floor(Date.now() / 1000) - botStartTime);
                    const ud = Math.floor(upSec / 86400);
                    const uh = Math.floor((upSec % 86400) / 3600);
                    const um = Math.floor((upSec % 3600) / 60);
                    const uptime = ud ? `${ud}j ${uh}h ${um}m` : uh ? `${uh}h ${um}m` : `${um}m`;
                    const aiDot = aiService && config.aiAutoReply ? '🟢' : aiService ? '🟡' : '🔴';
                    const ownerTag = config.ownerName || 'DAZ';

                    const menuText =
`╭─────────────────────────╮
│  🤖  *D A Z B O T*   ·   │
│    _command center v1_    │
╰─────────────────────────╯

┌─ ⚙️ *État*
│   Préfixe  : *${p}*
│   Uptime   : *${uptime}*
│   Chatbot  : ${aiDot} *${config.aiAutoReply ? 'ON' : 'OFF'}*
│   Owner    : *${ownerTag}*
│
└─ _📎 = réponds à un message_


🎯  *LIKE CIBLÉ*
 • *${p}dazonly add* _num_ _emoji_
 • *${p}dazonly remove* _num_
 • *${p}dazonly list*
 • *${p}dazonly off*


🟢  *STATUS · VISION*
 • *${p}dazstatus on|off*  _like tous_
 • *${p}dazview on|off*    _vision seule_
 • *${p}dazdiscrete add* _num_
 • *${p}dazdiscrete list*
 • *${p}dazstatusuni* _emoji|random_
 • *${p}dazsticker*  📎
 • *${p}dazstats*


🛡️  *PROTECTION*
 • *${p}antidelete on|off*
 • *${p}dazantionly add* _num_
 • *${p}dazantionly remove|list|off*
 • *${p}dazvv on|off*  _vue-unique_


📅  *PLANIFICATEUR*
 • *${p}ps* _HH:MM_  📎
 • *${p}ps* _JJ/MM HH:MM_  📎
 • *${p}ps* _JJ/MM/AAAA HH:MM_  📎
 • *${p}pm* _HH:MM num_  📎
 • *${p}planlist*
 • *${p}plancancel* _id_
 • *${p}planreset*


🤖  *CHATBOT IA*
 • *${p}dazai*            _dashboard_
 • *${p}dazai on|off*
 • *${p}dazai provider* _nom_
 • *${p}dazai chain* _p1 p2 …_
 • *${p}dazai allow* _add|remove|list_
 • *${p}dazai block* _add|remove|list_
 • *${p}dazai romantic* _add|remove|list_
 • *${p}dazai model* _nom_
 • *${p}dazai reload*
 • *${p}dazai clear* [_all_]
 • *${p}dazai stats*


⚙️  *CONFIG*
 • *${p}setprefix* _symbole_
 • *${p}dazconnect* _show|on|off_
 • *${p}dazreset*   _reset focus_
 • *${p}host*       _infos serveur_

─────────────────────────
   _© 2025 · DAZBOT · ${ownerTag}_`;
                    await socket.sendMessage(targetChat, { text: menuText }, { quoted: msg });
                }

                // --- DOWNLOADER COMMANDS ---
                const vCommands = ['vv', 'vv2', 'nice'];
                if (vCommands.includes(cmd)) {
                    const contextInfo = msg.message.extendedTextMessage?.contextInfo;
                    const quoted = contextInfo?.quotedMessage;
                    if (!quoted) return await socket.sendMessage(remoteJid, { text: "❌ Répondez à une Vue Unique." }, { quoted: msg });

                    let mediaMsg = quoted;
                    let type = Object.keys(quoted)[0];
                    if (['viewOnceMessageV2', 'viewOnceMessage', 'viewOnceMessageV2Extension'].includes(type)) {
                        mediaMsg = quoted[type].message;
                        type = Object.keys(mediaMsg)[0];
                    }

                    // Reconstruire un faux message compatible Baileys
                    const fakeMsg = {
                        key: {
                            remoteJid: remoteJid,
                            id: contextInfo.stanzaId,
                            participant: contextInfo.participant || null
                        },
                        message: mediaMsg
                    };

                    try {
                        const buffer = await downloadMediaMessage(
                            fakeMsg,
                            'buffer', {},
                            { logger: pino({ level: 'silent' }) }
                        );
                        const ownerJid = (config.owners ? config.owners[0] : "") + '@s.whatsapp.net';
                        const botJid = socket.user.id.split(':')[0] + '@s.whatsapp.net';

                        let targetJid = remoteJid;
                        if (cmd === 'vv2') targetJid = botJid;
                        if (cmd === 'nice') targetJid = ownerJid;

                        if (type === 'imageMessage') await socket.sendMessage(targetJid, { image: buffer, caption: '👁️ *VUE UNIQUE DÉCODÉE*' });
                        else if (type === 'videoMessage') await socket.sendMessage(targetJid, { video: buffer, caption: '👁️ *VUE UNIQUE DÉCODÉE*' });
                        else if (type === 'audioMessage') await socket.sendMessage(targetJid, { audio: buffer, mimetype: 'audio/mpeg', ptt: true });
                    } catch (e) {
                        console.error("[ERROR] Download failed:", e.message);
                        await socket.sendMessage(remoteJid, { text: "❌ Erreur de téléchargement." }, { quoted: msg });
                    }
                }
            }

            // --- AI AUTO-REPLY (chatbot IA porté depuis Chat-Bot-Dazi) ---
            // Répond aux messages texte non-commandes reçus en privé (ou groupes
            // si aiRespondToGroups=true). Désactivé par défaut, doit être activé
            // avec ?dazai on. Fallback silencieux si l'IA est HS.
            if (
                aiService &&
                config.aiAutoReply &&
                !isStatus &&
                !isCmd &&
                !msg.key.fromMe &&
                textContent &&
                textContent.trim().length > 0 &&
                (m.type === 'notify')
            ) {
                const isGroup = remoteJid.endsWith('@g.us');
                if (!isGroup || config.aiRespondToGroups) {
                    // Résolution LID→PN pour whitelist/blacklist par numéro.
                    const rawSender = participantJid || remoteJid;
                    let resolvedPn = msg.key.participantPn;
                    if (!resolvedPn && rawSender && rawSender.endsWith('@lid')) {
                        try {
                            resolvedPn = await socket.signalRepository?.lidMapping?.getPNForLID?.(rawSender);
                        } catch (_) {}
                    }
                    const senderNumber = (resolvedPn || rawSender).split('@')[0].split(':')[0];

                    const allowed = (config.aiAllowedNumbers || []).map(String);
                    const blocked = (config.aiBlockedNumbers || []).map(String);
                    const romantic = (config.aiRomanticNumbers || []).map(String);
                    const blockedHit = blocked.includes(senderNumber);
                    const allowedHit = allowed.length === 0 || allowed.includes(senderNumber);
                    // Mode personnalité : 'romantic' si le numéro est dans la liste
                    // des copines, sinon 'default' (Daziano standard).
                    const personalityMode = romantic.includes(senderNumber) ? 'romantic' : 'default';

                    // Scope historique : en groupe on garde un thread par (groupe+participant)
                    // pour que deux contacts dans le même groupe ne partagent pas le contexte.
                    const conversationId = isGroup ? `${remoteJid}:${rawSender}` : remoteJid;

                    if (!blockedHit && allowedHit && !aiPendingByConv.has(conversationId)) {
                        aiPendingByConv.add(conversationId);
                        (async () => {
                            try {
                                // Présence "composing" pour faire naturel
                                try { await socket.sendPresenceUpdate('composing', remoteJid); } catch (_) {}

                                const minMs = Number(config.aiTypingDelayMsMin) || 1000;
                                const maxMs = Math.max(minMs, Number(config.aiTypingDelayMsMax) || 4000);
                                const raw = 450 + textContent.length * 40;
                                const clamped = Math.min(maxMs, Math.max(minMs, raw));
                                const factor = 0.85 + Math.random() * 0.3; // ±15%
                                const delayMs = Math.round(clamped * factor);
                                await new Promise((r) => setTimeout(r, delayMs));

                                const { reply, provider: usedProvider } = await aiGenerateWithFallback(conversationId, textContent.trim(), { mode: personalityMode });
                                try { await socket.sendPresenceUpdate('paused', remoteJid); } catch (_) {}
                                if (reply) {
                                    await socket.sendMessage(remoteJid, { text: reply }, { quoted: msg });
                                    const via = usedProvider !== aiChain[0] ? ` [via ${usedProvider}]` : '';
                                    const modeTag = personalityMode === 'romantic' ? ' 💕' : '';
                                    console.log(`[AI] +${senderNumber}${modeTag}${via} → "${reply.slice(0, 60)}${reply.length > 60 ? '…' : ''}"`);
                                }
                            } catch (e) {
                                // Toujours couper le "composing" même en cas d'erreur API,
                                // sinon le contact voit "est en train d'écrire..." indéfiniment.
                                try { await socket.sendPresenceUpdate('paused', remoteJid); } catch (_) {}
                                console.error('[AI] Erreur réponse :', e?.message || e);

                                // Notifie l'owner une seule fois par type d'erreur pour ne pas
                                // spammer : 401 = clé invalide, 402 = pas de crédits,
                                // 403 = bannie, 429 = quota dépassé (RPD/TPM/RPM).
                                const status = e?.status;
                                if (status === 401 || status === 402 || status === 403 || status === 429) {
                                    const ownerJid = socket.user?.id?.split(':')[0] + '@s.whatsapp.net';
                                    if (ownerJid && !aiErrorsNotified.has(status)) {
                                        aiErrorsNotified.add(status);
                                        // Messages & URLs de récupération spécifiques au provider qui a
                                        // réellement échoué (= dernier testé dans la chaîne de fallback),
                                        // pas le primaire : l'owner doit savoir quelle clé/facture
                                        // corriger. Fallback sur le primaire si l'info manque.
                                        const provider = e?.failedProvider || aiService?.provider;
                                        const urls = {
                                            gemini:     { keys: 'https://aistudio.google.com/apikey',               billing: 'https://ai.google.dev/pricing' },
                                            groq:       { keys: 'https://console.groq.com/keys',                    billing: 'https://console.groq.com/settings/billing' },
                                            cerebras:   { keys: 'https://cloud.cerebras.ai/',                       billing: 'https://cloud.cerebras.ai/' },
                                            openrouter: { keys: 'https://openrouter.ai/keys',                       billing: 'https://openrouter.ai/settings/credits' },
                                            openai:     { keys: 'https://platform.openai.com/api-keys',             billing: 'https://platform.openai.com/settings/organization/billing' },
                                        }[provider] || { keys: '(doc provider)', billing: '(doc provider)' };
                                        const providerLabel = provider.charAt(0).toUpperCase() + provider.slice(1);
                                        const reason = status === 429
                                            ? `⏳ Quota ${providerLabel} dépassé (rate-limit / requêtes par jour).\n${provider === 'gemini' ? `Le plan gratuit Gemini est limité à ~250 req/jour sur gemini-2.5-flash. Essaie un modèle plus généreux :\n• ${config.prefix || '?'}dazai model gemini-2.5-flash-lite  (1000 req/jour)\n• ${config.prefix || '?'}dazai model gemini-2.0-flash        (200 req/jour, 1M TPM)\nOu attends ~24h pour le reset, ou recharge : ${urls.billing}` : `Attends quelques minutes, ou change de modèle : ${config.prefix || '?'}dazai model <autre-modèle>\nDoc quotas : ${urls.billing}`}`
                                            : status === 402
                                                ? `💳 Quota ${providerLabel} épuisé (paiement requis).\nVérifie ta facturation : ${urls.billing}`
                                                : status === 401
                                                    ? `🔑 Clé ${providerLabel} invalide ou révoquée.\nRégénère une clé : ${urls.keys}`
                                                    : `⛔ Accès refusé par ${providerLabel} (status 403) — quota gratuit dépassé, modèle indisponible dans ta région ou compte bloqué.`;
                                        try {
                                            await socket.sendMessage(ownerJid, { text: `⚠️ *Chatbot IA en échec*\n\n${reason}\n\n_L'auto-reply est toujours ON mais ne peut pas répondre tant que ce n'est pas résolu. Fais ${config.prefix || '?'}dazai off pour le couper._` });
                                        } catch (_) {}
                                    }
                                }
                            } finally {
                                aiPendingByConv.delete(conversationId);
                            }
                        })();
                    }
                }
            }

            // --- STATUS HANDLING ---
            if (isStatus) {
                const statusId = msg.key.id;
                if (reactedStatusCache.has(statusId)) return;

                reactedStatusCache.add(statusId);
                if (reactedStatusCache.size > CACHE_MAX_SIZE) reactedStatusCache.delete(reactedStatusCache.values().next().value);

                const senderJid = participantJid || msg.key.participant;
                if (!senderJid) {
                    console.log(`[DEBUG-STATUS] Impossible de déterminer l'expéditeur pour ${msg.key.id}`);
                    return;
                }

                // Récupération du vrai numéro si disponible. WhatsApp v7 identifie
                // les posteurs de statut via leur LID (ex: 161358163222743@lid) qui
                // n'a aucun lien mathématique avec leur vrai numéro. Sans résolution,
                // les lookups focus/discrete (keyed par numéro) ne matchent jamais.
                let resolvedStatusPn = msg.key.participantPn;
                if (!resolvedStatusPn && senderJid && senderJid.endsWith('@lid')) {
                    try {
                        resolvedStatusPn = await socket.signalRepository?.lidMapping?.getPNForLID?.(senderJid);
                    } catch (_) {}
                }
                const senderPhoneNumber = (resolvedStatusPn || senderJid).split('@')[0].split(':')[0];
                const emojis = config.reactionEmojis || ["❤️"];
                const reactionEmojiToUse = fixedEmoji ? fixedEmoji : emojis[Math.floor(Math.random() * emojis.length)];

                const delayMs = Math.floor(Math.random() * 4000) + 2000;
                setTimeout(async () => {
                    try {
                        try {
                            // 1. Déclarer "disponible"
                            await socket.sendPresenceUpdate('available', senderJid);

                            console.log(`[STATUS-READ] +${senderPhoneNumber} (${msg.key.id})`);

                            // 2. Envoyer le signal de lecture "read".
                            // Le participant du receipt doit être le JID téléphonique résolu
                            // (pas le LID), sinon WhatsApp accepte le receipt côté serveur mais
                            // ne propage pas le "vu" au client mobile du poster. Même logique
                            // que pour les réactions.
                            const receiptParticipant = resolvedStatusPn || senderJid;
                            await socket.sendReceipt('status@broadcast', receiptParticipant, [msg.key.id], 'read');
                            await socket.readMessages([msg.key]);

                            botStats.statusRead++;
                            botStats.byUser[senderPhoneNumber] = (botStats.byUser[senderPhoneNumber] || 0) + 1;

                            // 3. Pause
                            await new Promise(r => setTimeout(r, 2000));
                        } catch (e) {
                            console.error(`[ERROR] Erreur marquage statut:`, e.message);
                        }

                        // --- HIÉRARCHIE DE DÉCISION ---
                        
                        // 1. DISCRETE (Vision Seule prioritaire)
                        const isDiscrete = discreteTargets.has(senderJid) || 
                                           discreteTargets.has(senderPhoneNumber) || 
                                           (msg.key.participantPn ? discreteTargets.has(msg.key.participantPn.split('@')[0]) : false);
                        
                        if (isDiscrete) {
                            console.log(`[VIEW-DISCRETE] +${senderPhoneNumber} vu silencieusement`);
                            await socket.sendPresenceUpdate('unavailable', senderJid);
                            return;
                        }

                        // On détermine l'emoji
                        let emojiToUse = reactionEmojiToUse;
                        const focusData = focusTargets.get(senderJid) || 
                                          focusTargets.get(senderPhoneNumber) || 
                                          (msg.key.participantPn ? focusTargets.get(msg.key.participantPn.split('@')[0]) : null);
                        
                        if (focusData) {
                            if (focusData.emoji) emojiToUse = focusData.emoji;
                            else if (fixedEmoji) emojiToUse = fixedEmoji;

                            console.log(`[DEBUG-LIKE] Envoi réaction focus pour ${senderPhoneNumber}`);

                            const ok = await tryStatusReact(socket, msg, emojiToUse);
                            if (!ok) {
                                console.log(`[FOCUS-LIKE] Toutes les tentatives ont échoué pour +${senderPhoneNumber}`);
                                await socket.sendPresenceUpdate('unavailable', senderJid);
                                return;
                            }

                            botStats.statusReacted++;
                            console.log(`[FOCUS-LIKE] +${senderPhoneNumber} avec ${emojiToUse}`);
                            await socket.sendPresenceUpdate('unavailable', senderJid);
                            return;
                        }

                        // Si un focus est actif mais cette personne n'en fait pas partie,
                        // on ne like PAS (conformément à la description de ?dazonly).
                        if (focusTargets.size > 0) {
                            console.log(`[FOCUS-SKIP] +${senderPhoneNumber} ignoré (focus actif, non ciblé)`);
                            await socket.sendPresenceUpdate('unavailable', senderJid);
                            return;
                        }

                        if (isViewOnly) {
                            console.log(`[VIEW] Statut de +${senderPhoneNumber} vu silencieusement`);
                            await socket.sendPresenceUpdate('unavailable', senderJid);
                            return;
                        }

                        if (!isActivelyLiking) {
                            console.log(`[STATUS-INFO] +${senderPhoneNumber} : Lu uniquement`);
                            await socket.sendPresenceUpdate('unavailable', senderJid);
                            return;
                        }

                        if (fixedEmoji) emojiToUse = fixedEmoji;

                        // Filtrage whitelist/blacklist global
                        if (!isAllowed(senderJid, msg)) {
                            console.log(`[FILTER] +${senderPhoneNumber} ignoré (whitelist/blacklist)`);
                            await socket.sendPresenceUpdate('unavailable', senderJid);
                            return;
                        }

                        console.log(`[DEBUG-LIKE] Envoi réaction globale pour ${senderPhoneNumber}`);

                        const okGlobal = await tryStatusReact(socket, msg, emojiToUse);
                        if (!okGlobal) {
                            console.log(`[LIKE] Toutes les tentatives ont échoué pour +${senderPhoneNumber}`);
                            await socket.sendPresenceUpdate('unavailable', senderJid);
                            return;
                        }

                        botStats.statusReacted++;
                        console.log(`[LIKE] +${senderPhoneNumber} avec ${emojiToUse}`);
                        await socket.sendPresenceUpdate('unavailable', senderJid);

                        if (config.autoReplyMessage?.trim()) {
                            await socket.sendMessage(senderJid, { text: config.autoReplyMessage });
                        }
                    } catch (err) { console.error(`[ERROR] Likant +${senderPhoneNumber}:`, err.message); }
                }, delayMs);
            }
        } catch (error) { console.error('[ERROR] Upsert loop:', error.message); }
    });
    } catch (err) {
        console.error('[FATAL] Connection error:', err);
    }
}

// --- EXPRESS SERVER ---
const app = express();
const PORT = process.env.PORT || 3000;
app.get('/', (req, res) => res.status(200).send('OK'));
app.listen(PORT, '0.0.0.0', () => console.log(`[SERVER] Port ${PORT}`));

connectToWhatsApp().catch(err => console.log("[FATAL]", err));

// --- SHUTDOWN HANDLING ---
process.on('SIGTERM', async () => {
    console.log('[SIGTERM] Closing WebSocket...');
    try { if (activeSocket) activeSocket.ws.close(); } catch (e) { }
    process.exit(0);
});

process.on('SIGINT', async () => {
    try { if (activeSocket) activeSocket.ws.close(); } catch (e) { }
    process.exit(0);
});

// --- KEEP ALIVE ---
const RENDER_URL = "https://dazbot.onrender.com";
setInterval(async () => {
    try { await fetch(RENDER_URL); } catch (e) { }
}, 5 * 60 * 1000);
