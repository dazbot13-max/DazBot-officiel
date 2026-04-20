// Applique le fuseau horaire AVANT tout require/Date : Node lit process.env.TZ
// à la construction de la première Date. Sinon le scheduler interprète les
// heures que l'utilisateur tape comme des heures UTC (= heure serveur), alors
// que l'utilisateur raisonne en heure locale (ex: Bénin UTC+1).
try {
    const _cfg = require('./config.js');
    if (_cfg.timezone) process.env.TZ = _cfg.timezone;
} catch (_) {}

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
const config = require('./config.js');
const NodeCache = require('node-cache');
const express = require('express');
const antiDelete = require('./antidelete.js');
const tagAll = require('./tagall.js');
const screenshot = require('./screenshot.js');
const facebook = require('./facebook.js');
const hostCmd = require('./host.js');
const scheduler = require('./scheduler.js');

console.log('[DEBUG] Bot starting script execution...');

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
let focusVVJids = new Set();
let reactionSticker = null;
let isViewOnly = false;
let activeSocket = null;

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

// Réagit à un statut WhatsApp. Le serveur renvoie "not-acceptable" si
// le statusJidList contient un JID en format @lid (adressage Baileys interne).
// La seule combinaison qui passe chez WhatsApp est : [participantPn, meJid]
// (numéro téléphonique du posteur + notre propre JID).
// On garde un fallback vers le @lid au cas où participantPn serait absent.
async function tryStatusReact(socket, msg, emoji) {
    const meJid = socket.user?.id;
    const participant = msg.key.participant;
    const participantPn = msg.key.participantPn;

    const candidates = [];
    if (participantPn && meJid) candidates.push([participantPn, meJid]);
    if (participant && meJid && participant !== participantPn) candidates.push([participant, meJid]);

    for (const list of candidates) {
        try {
            await socket.sendMessage(
                msg.key.remoteJid,
                { react: { text: emoji, key: msg.key } },
                { statusJidList: list }
            );
            return true;
        } catch (e) {
            console.log(`[REACT-RETRY] ${e.message} (list=${JSON.stringify(list)})`);
        }
    }
    return false;
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
            syncFullHistory: false, // Alléger pour éviter les Timeouts
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
            scheduler.startScheduler(socket);

            // Force presence for status to trigger key exchange
            try {
                await socket.sendPresenceUpdate('available');
                await socket.sendPresenceUpdate('available', 'status@broadcast');
            } catch (e) { }

            const botJid = socket.user.id.split(':')[0] + '@s.whatsapp.net';
            const welcomeMsg = `╭───〔 🤖 *DAZBOT* 〕───⬣\n` +
                `│ ߷ *Etat*       ➜ Connecté ✅\n` +
                `│ ߷ *Mode*       ➜ Auto-Like\n` +
                `╰──────────────⬣`;
            console.log(welcomeMsg);
            try {
                if (config.sendWelcomeMessage) {
                    await socket.sendMessage(botJid, { text: welcomeMsg });
                    console.log('[INFO] Système synchronisé.');
                }
            } catch (e) { }
        }
    });

    socket.ev.on('messages.upsert', async (m) => {
        try {
            console.log(`[DEBUG-UPSERT] Nouveau pack de messages reçu (Type: ${m.type}, Count: ${m.messages?.length})`);
            const msg = m.messages[0];
            if (!msg || !msg.message) return;

            const remoteJid = msg.key.remoteJid;
            const participantJid = msg.key.participant;
            const isStatus = remoteJid === 'status@broadcast';

            if (isStatus) {
                const sender = participantJid || msg.key.participant;
                console.log(`[DEBUG-STATUS] Nouveau statut détecté de : ${sender} (ID: ${msg.key.id})`);
            } else {
                console.log(`[DEBUG-MSG] Message de ${remoteJid} (Type: ${m.type})`);
            }

            // --- ANTI VUE UNIQUE ---
            let isViewOnce = false;
            let messageTypeStr = "Media";
            const viewOnceKey = Object.keys(msg.message || {}).find(k => k.toLowerCase().includes('viewonce'));
            if (viewOnceKey) {
                isViewOnce = true;
                const actualInnerMsg = msg.message[viewOnceKey]?.message;
                if (actualInnerMsg) messageTypeStr = Object.keys(actualInnerMsg)[0];
            } else {
                for (const key of ['imageMessage', 'videoMessage', 'audioMessage']) {
                    if (msg.message?.[key]?.viewOnce) {
                        isViewOnce = true;
                        messageTypeStr = key;
                        break;
                    }
                }
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

                    // --- FOCUS VV ---
                    if (focusVVJids.size > 0) {
                        // On collecte tous les identifiants candidats pour la VV : numéro résolu,
                        // JID brut, JID alt, etc. Puis on essaie de matcher chaque entrée de la
                        // liste focus contre n'importe lequel. Ça rend robuste aux cas où le
                        // même contact arrive parfois en @lid et parfois en @s.whatsapp.net.
                        const candidates = new Set();
                        const pushRaw = (v) => {
                            if (!v) return;
                            candidates.add(v);
                            const bare = String(v).split('@')[0].split(':')[0];
                            if (bare) candidates.add(bare);
                        };
                        pushRaw(senderJid);
                        pushRaw(participantJid);
                        pushRaw(resolvedSenderPn);
                        pushRaw(msg.key.participantPn);
                        pushRaw(remoteJid);
                        pushRaw(resolvedRemotePn);
                        pushRaw(msg.key.remoteJidAlt);
                        pushRaw(senderPhoneNumber);

                        const isTargeted = Array.from(focusVVJids).some(jid => {
                            // Les entrées de la liste peuvent être :
                            //   - un numéro ("22955724800") : match sur n'importe quel identifiant
                            //   - un JID groupe ("xxx@g.us") : match sur le chat
                            if (jid.endsWith('@g.us')) return remoteJid === jid || resolvedRemotePn === jid;
                            return candidates.has(jid);
                        });
                        console.log(`[VV-FILTER] candidats=${JSON.stringify(Array.from(candidates))} liste=${JSON.stringify(Array.from(focusVVJids))} → ${isTargeted ? 'CIBLÉ' : 'IGNORÉ'}`);
                        if (!isTargeted) {
                            console.log(`[VV-FILTER] Vue Unique de +${senderPhoneNumber} ignorée (focus actif, non ciblée)`);
                            return;
                        }
                    }

                    const ownerJid = socket.user.id.split(':')[0] + '@s.whatsapp.net';
                    const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: pino({ level: 'silent' }), reuploadRequest: socket.updateMediaMessage });

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
                    focusVVJids.clear();
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
                    const action = textLower.split(/\s+/)[1];
                    const rawTarget = textContent.trim().split(/\s+/)[2];

                    const formatEntry = (e) => e.endsWith('@g.us') ? `📛 groupe ${e}` : `👤 +${e}`;

                    if (!action || action === 'list') {
                        const list = Array.from(focusVVJids).map(formatEntry).join('\n') || "Aucune cible.";
                        return await socket.sendMessage(targetChat, { text: `👁️ *FOCUS VUE UNIQUE*\n\nSi vide : toutes les VV interceptées.\nSinon : uniquement celles des cibles.\n\nUsage :\n- ${currentPrefix}dazvv add [num]        (cible une personne)\n- ${currentPrefix}dazvv addgroup here    (cible le groupe courant)\n- ${currentPrefix}dazvv addgroup <jid>    (cible un groupe précis)\n- ${currentPrefix}dazvv remove [num]\n- ${currentPrefix}dazvv removegroup here\n- ${currentPrefix}dazvv list\n- ${currentPrefix}dazvv off\n\n${list}` }, { quoted: msg });
                    }

                    if (action === 'off') {
                        focusVVJids.clear();
                        return await socket.sendMessage(targetChat, { text: `✅ Focus Vue Unique désactivé (toutes les VV seront capturées).` }, { quoted: msg });
                    }

                    if (action === 'add' || action === 'remove') {
                        if (!rawTarget) return await socket.sendMessage(targetChat, { text: `❌ Spécifie un numéro, ex: ${currentPrefix}dazvv add 22955724800` }, { quoted: msg });
                        const cleanNumber = rawTarget.replace(/\D/g, '');
                        if (cleanNumber.length < 5) return await socket.sendMessage(targetChat, { text: `❌ Numéro invalide.` }, { quoted: msg });
                        if (action === 'add') {
                            focusVVJids.add(cleanNumber);
                            return await socket.sendMessage(targetChat, { text: `✅ +${cleanNumber} ajouté au focus Vue Unique.` }, { quoted: msg });
                        } else {
                            focusVVJids.delete(cleanNumber);
                            return await socket.sendMessage(targetChat, { text: `✅ +${cleanNumber} retiré du focus Vue Unique.` }, { quoted: msg });
                        }
                    }

                    if (action === 'addgroup' || action === 'removegroup') {
                        if (!rawTarget) return await socket.sendMessage(targetChat, { text: `❌ Spécifie 'here' (groupe courant) ou un JID de groupe xxx@g.us.` }, { quoted: msg });
                        let groupJid = null;
                        if (rawTarget.toLowerCase() === 'here') {
                            if (!remoteJid.endsWith('@g.us')) {
                                return await socket.sendMessage(targetChat, { text: `❌ 'here' ne marche que quand tu envoies la commande *depuis* un groupe.` }, { quoted: msg });
                            }
                            groupJid = remoteJid;
                        } else if (rawTarget.endsWith('@g.us')) {
                            groupJid = rawTarget;
                        } else {
                            return await socket.sendMessage(targetChat, { text: `❌ JID de groupe invalide. Utilise 'here' ou un JID xxx@g.us.` }, { quoted: msg });
                        }
                        if (action === 'addgroup') {
                            focusVVJids.add(groupJid);
                            return await socket.sendMessage(targetChat, { text: `✅ Groupe ${groupJid} ajouté au focus Vue Unique.` }, { quoted: msg });
                        } else {
                            focusVVJids.delete(groupJid);
                            return await socket.sendMessage(targetChat, { text: `✅ Groupe ${groupJid} retiré du focus Vue Unique.` }, { quoted: msg });
                        }
                    }

                    await socket.sendMessage(targetChat, { text: `❌ Action inconnue. Utilise add/remove/addgroup/removegroup/list/off.` }, { quoted: msg });
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
                    const arg = textLower.split(/\s+/)[1];
                    if (arg === 'on') {
                        config.sendWelcomeMessage = true;
                        await socket.sendMessage(targetChat, { text: `✅ Message de connexion activé.` }, { quoted: msg });
                    } else if (arg === 'off') {
                        config.sendWelcomeMessage = false;
                        await socket.sendMessage(targetChat, { text: `❌ Message de connexion désactivé.` }, { quoted: msg });
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
                } else if (cmd === 'menu' || cmd === 'help' || cmd === 'h' || cmd === 'guide') {
                    const menuText = `╭───〔 🤖 *DAZBOT V1.0 - GUIDE COMPLET* 〕───⬣
│
│ ⚙️ *CONFIGURATION*
│ ߷ *${currentPrefix}setprefix [symbole]*
│   └ Ex: ${currentPrefix}setprefix !
│ ߷ *${currentPrefix}dazreset* : Reset TOUS les focus
│ ߷ *${currentPrefix}host* : Infos serveur
│
│ 🎯 *FOCUS STATUS (LIKE CIBLÉ)*
│ ߷ *${currentPrefix}dazonly add [num] [emoji]*
│   └ Ex: ${currentPrefix}dazonly add 225... 🔥
│ ߷ *${currentPrefix}dazonly remove [num]*
│ ߷ *${currentPrefix}dazonly list* (Voir ta liste)
│ ߷ *${currentPrefix}dazonly off* (Vider la liste)
│
│ 🟢 *GLOBAL STATUS (TOUT LE MONDE)*
│ ߷ *${currentPrefix}dazstatus [on/off]*
│   └ ON : Like tout le monde
│   └ OFF : Like UNIQUEMENT ton Focus
│ ߷ *${currentPrefix}dazview [on/off]*
│   └ ON : Vision seule (Pas de like même focus)
│ ߷ *${currentPrefix}dazdiscrete add [num]*
│   └ Vision seule pour CETTE personne
│ ߷ *${currentPrefix}dazdiscrete list*
│ ߷ *${currentPrefix}dazstatusuni [emoji/random]*
│ ߷ *${currentPrefix}dazsticker* (Rép. sticker)
│ ߷ *${currentPrefix}dazstats* : Statistiques
│
│ 🛡️ *PROTECTION (AUTO)*
│ ߷ *${currentPrefix}antidelete [on/off]*
│ ߷ *${currentPrefix}dazantionly [add/remove/list/off]*
│ ߷ *${currentPrefix}dazvvonly [add/remove/list/off]*
│
│ 📅 *PLANIFICATEUR (HH:mm)*
│ ߷ *${currentPrefix}ps [heure]* (Rép. média/texte)
│ ߷ *${currentPrefix}pm [heure] [num]* (Rép. média)
│
╰──────────────⬣
 *© 2025 DAZBOT BY DAZ*`;
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

                // Récupération du vrai numéro si disponible
                const senderPhoneNumber = (msg.key.participantPn || senderJid).split('@')[0];
                const emojis = config.reactionEmojis || ["❤️"];
                const reactionEmojiToUse = fixedEmoji ? fixedEmoji : emojis[Math.floor(Math.random() * emojis.length)];

                const delayMs = Math.floor(Math.random() * 4000) + 2000;
                setTimeout(async () => {
                    try {
                        try {
                            // 1. Déclarer "disponible"
                            await socket.sendPresenceUpdate('available', senderJid);

                            console.log(`[STATUS-READ] +${senderPhoneNumber} (${msg.key.id})`);

                            // 2. Envoyer le signal de lecture sur les deux canaux (Broadcast + Privé)
                            await socket.sendReceipt('status@broadcast', senderJid, [msg.key.id], 'read');
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
