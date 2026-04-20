const { downloadMediaMessage } = require('@whiskeysockets/baileys');
const config = require('./config.js');

let messageCache = new Map();
const CACHE_LIMIT = 2000;
let focusAntiDeleteJids = new Set();
let onRecoveredCallback = null;

/**
 * Définit le callback pour les statistiques.
 */
const setOnRecovered = (cb) => {
    onRecoveredCallback = cb;
};

/**
 * Ajoute une cible au focus anti-suppression.
 */
const addFocus = (jid) => {
    focusAntiDeleteJids.add(jid);
};

/**
 * Supprime une cible du focus.
 */
const removeFocus = (jid) => {
    focusAntiDeleteJids.delete(jid);
};

/**
 * Vide la liste du focus.
 */
const clearFocus = () => {
    focusAntiDeleteJids.clear();
};

/**
 * Récupère la liste actuelle du focus.
 */
const getFocusList = () => Array.from(focusAntiDeleteJids);

/**
 * Fonction interne pour signaler une suppression.
 */
const reportRevocation = async (sock, deletedId) => {
    if (!config.antiDeleteEnabled) {
        console.log(`[ANTIDELETE] Suppression ignorée (ID: ${deletedId}) car l'option est sur OFF.`);
        return;
    }

    const cached = messageCache.get(deletedId);
    if (cached) {
        // Si focusAntiDeleteJids n'est pas vide, on ne rapporte QUE si le message
        // vient d'une cible (contact ou chat/groupe). On compare contre le JID
        // brut, le numéro extrait du JID brut, ET le PN résolu — ce dernier est
        // essentiel car en v7 cached.from est très souvent un LID (ex:
        // 161358163222743@lid) qui ne matchera jamais un numéro comme 22955724800.
        if (focusAntiDeleteJids.size > 0) {
            const senderNum = cached.from.split('@')[0].split(':')[0];
            const chatNum = cached.chat.split('@')[0].split(':')[0];
            const senderPnNum = cached.fromPn ? cached.fromPn.split('@')[0].split(':')[0] : null;

            const isTargeted = Array.from(focusAntiDeleteJids).some(jid =>
                cached.from.includes(jid)
                || cached.chat.includes(jid)
                || senderNum === jid
                || chatNum === jid
                || (senderPnNum && (senderPnNum === jid || cached.fromPn.includes(jid)))
            );

            if (!isTargeted) {
                console.log(`[ANTIDELETE] Suppression ignorée (ID: ${deletedId}) car focus actif et cible non correspondante.`);
                return;
            }
        }

        try {
            // On redirige TOUJOURS vers le chat privé du propriétaire du bot.
            // Ça évite de renvoyer le message supprimé dans le chat d'origine
            // (où la personne qui a supprimé le verrait réapparaître → bot grillé).
            // `config.antiDeleteChat` reste un override optionnel si le propriétaire
            // veut rediriger vers un chat-poubelle différent.
            const ownerJid = sock.user?.id ? (sock.user.id.split(':')[0] + '@s.whatsapp.net') : null;
            const destination = config.antiDeleteChat || ownerJid || cached.chat;

            // Numéro du poster : on privilégie le PN résolu (22955724800),
            // sinon on retombe sur la partie numérique du JID brut (qui peut
            // être un LID comme 161358163222743 — moins utile mais au moins
            // cohérent).
            const senderRaw = (cached.fromPn || cached.from).split('@')[0].split(':')[0];
            const senderDisplay = cached.pushName ? `${cached.pushName} (+${senderRaw})` : `+${senderRaw}`;

            // Type de conversation d'origine. On classe en 3 cas :
            //   - Statut : cached.chat === 'status@broadcast'
            //   - Groupe : cached.chat finit en '@g.us'
            //   - Privé  : tout le reste (@s.whatsapp.net)
            const isGroup = cached.chat.endsWith('@g.us');
            const isStatus = cached.chat === 'status@broadcast';

            let typeLabel, sourceLabel, typeIcon;
            if (isStatus) {
                typeIcon = '📸';
                typeLabel = 'Statut supprimé';
                sourceLabel = `Statut de ${senderDisplay}`;
            } else if (isGroup) {
                // Essaie de récupérer le nom du groupe pour enrichir le rapport.
                let groupName = cached.chat.split('@')[0];
                try {
                    const meta = await sock.groupMetadata(cached.chat);
                    if (meta?.subject) groupName = meta.subject;
                } catch (_) {}
                typeIcon = '👥';
                typeLabel = 'Message de groupe supprimé';
                sourceLabel = `Groupe "${groupName}"`;
            } else {
                typeIcon = '💬';
                typeLabel = 'Message privé supprimé';
                sourceLabel = `Chat privé avec ${senderDisplay}`;
            }

            // Fix timestamp handling
            const timestampVal = typeof cached.timestamp === 'object' && cached.timestamp.toNumber ? cached.timestamp.toNumber() : Number(cached.timestamp);
            const time = new Date(timestampVal * 1000).toLocaleString('fr-FR');

            const report = `╭───〔 ❌ *${typeLabel.toUpperCase()}* 〕───⬣\n` +
                           `│ ${typeIcon} *Type:* ${typeLabel}\n` +
                           `│ 👤 *Auteur:* ${senderDisplay}\n` +
                           `│ 📍 *Source:* ${sourceLabel}\n` +
                           `│ ⏰ *Heure:* ${time}\n` +
                           `│ 💬 *Contenu:* ${cached.content || "(Pas de texte)"}\n` +
                           `╰──────────────⬣`;

            // Utilisé pour les logs et la stat below
            const sender = senderRaw;

            if (cached.media) {
                if (cached.type === 'imageMessage') {
                    await sock.sendMessage(destination, { image: cached.media, caption: report });
                } else if (cached.type === 'videoMessage') {
                    await sock.sendMessage(destination, { video: cached.media, caption: report });
                } else if (cached.type === 'audioMessage') {
                    await sock.sendMessage(destination, { audio: cached.media, mimetype: 'audio/mp4', ptt: true });
                    await sock.sendMessage(destination, { text: report });
                } else if (cached.type === 'stickerMessage') {
                    await sock.sendMessage(destination, { sticker: cached.media });
                    await sock.sendMessage(destination, { text: report });
                } else {
                    await sock.sendMessage(destination, { text: report });
                }
            } else {
                await sock.sendMessage(destination, { text: report });
            }
            
            console.log(`[ANTIDELETE] Rapport envoyé pour ${deletedId}`);
            if (onRecoveredCallback) onRecoveredCallback(sender);
            messageCache.delete(deletedId);
        } catch (e) {
            console.error("[ANTIDELETE] Send error:", e);
        }
    } else {
        console.log(`[ANTIDELETE] Message ${deletedId} supprimé mais absent du cache.`);
    }
};

/**
 * Stocke les messages entrants dans le cache.
 */
const handleUpsert = async (sock, m) => {
    try {
        const msg = m.messages[0];
        if (!msg || !msg.message) return;

        // Détection de suppression directe via ProtocolMessage dans UPSERT
        const protocolMsg = msg.message.protocolMessage;
        if (protocolMsg && (protocolMsg.type === 0 || protocolMsg.type === 3)) {
            const deletedId = protocolMsg.key?.id;
            if (deletedId) {
                console.log(`[ANTIDELETE] Suppression détectée dans UPSERT (ID: ${deletedId})`);
                await reportRevocation(sock, deletedId);
                return;
            }
        }

        // On ignore les messages du bot lui-même pour ne pas saturer le cache
        if (msg.key.fromMe) return;

        const id = msg.key.id;
        const from = msg.key.remoteJid;
        const participant = msg.key.participant || from;
        
        let content = "";
        let mediaBuffer = null;
        let type = Object.keys(msg.message)[0];
        
        // Handle Ephemeral messages
        if (type === 'ephemeralMessage') {
            msg.message = msg.message.ephemeralMessage.message;
            type = Object.keys(msg.message)[0];
        }

        // Handle View Once
        if (type === 'viewOnceMessage' || type === 'viewOnceMessageV2' || type === 'viewOnceMessageV2Extension') {
            msg.message = msg.message[type].message;
            type = Object.keys(msg.message)[0];
        }

        // Content extraction
        if (type === 'conversation') {
            content = msg.message.conversation;
        } else if (type === 'extendedTextMessage') {
            content = msg.message.extendedTextMessage.text;
        } else if (type === 'imageMessage') {
            content = msg.message.imageMessage.caption || "[Image]";
        } else if (type === 'videoMessage') {
            content = msg.message.videoMessage.caption || "[Vidéo]";
        } else if (type === 'audioMessage') {
            content = "[Audio/Vocal]";
        } else if (type === 'stickerMessage') {
            content = "[Sticker]";
        } else if (type === 'documentMessage') {
            content = `[Document] ${msg.message.documentMessage.fileName || ""}`;
        } else {
            content = `[${type}]`;
        }

        // Media download
        if (['imageMessage', 'videoMessage', 'audioMessage', 'stickerMessage'].includes(type)) {
            try {
                const mediaSize = msg.message[type]?.fileLength || 0;
                if (mediaSize < 15 * 1024 * 1024) {
                    mediaBuffer = await downloadMediaMessage(msg, 'buffer', {}, { 
                        reuploadRequest: sock.updateMediaMessage 
                    });
                }
            } catch (e) { 
                console.error("[ANTIDELETE] Media download failed:", e.message); 
            }
        }

        if (content || mediaBuffer) {
            // Résolution LID → PN pour le participant. Sur v7, participant est
            // souvent au format @lid (ex: 161358163222743@lid) et ne porte pas
            // le vrai numéro. On résout via le LIDMappingStore si dispo.
            let participantPn = msg.key.participantPn || null;
            if (!participantPn && participant && participant.endsWith('@lid')) {
                try {
                    participantPn = await sock.signalRepository?.lidMapping?.getPNForLID?.(participant);
                } catch (_) {}
            }

            messageCache.set(id, {
                from: participant,
                fromPn: participantPn,
                pushName: msg.pushName || null,
                chat: from,
                content: content,
                media: mediaBuffer,
                type: type,
                timestamp: msg.messageTimestamp,
                id: id
            });
            console.log(`[ANTIDELETE] Message mis en cache: ${id} (${type})`);
        }

        if (messageCache.size > CACHE_LIMIT) {
            const oldestKey = messageCache.keys().next().value;
            messageCache.delete(oldestKey);
        }
    } catch (e) {
        console.error("[ANTIDELETE] Cache error:", e);
    }
};

/**
 * Détecte les messages supprimés dans l'event update.
 */
const handleUpdate = async (sock, updates) => {
    for (const u of updates) {
        const key = u.key;
        const update = u.update;
        
        if (update.pollUpdates || update.reaction) continue;
        
        // Détection Baileys classique pour les révocations
        // On vérifie stubType 68 (revoke) ou le champ revocation
        // On vérifie aussi si l'update contient un protocolMessage de type revoke (0)
        const isRevoke = update.messageStubType === 68 || 
                         update.revocation || 
                         update.message?.protocolMessage?.type === 0 ||
                         update.message?.protocolMessage?.type === 3;

        if (isRevoke) {
            let deletedId = null;
            if (update.message?.protocolMessage?.type === 0) {
                // Pour un protocolMessage (delete for everyone), l'ID cible est dans protocolMessage.key.id
                deletedId = update.message.protocolMessage.key?.id;
            } else {
                // Sinon (stubType 68 ou revocation directe), l'ID est dans la clé de l'update
                deletedId = key.id;
            }

            if (deletedId) {
                console.log(`[ANTIDELETE] Suppression détectée dans UPDATE (ID: ${deletedId})`);
                await reportRevocation(sock, deletedId);
            }
        }
    }
};

module.exports = {
    handleUpsert,
    handleUpdate,
    addFocus,
    removeFocus,
    clearFocus,
    getFocusList,
    setOnRecovered
};
