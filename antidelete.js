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
        // Toggle séparé : si le message provient d'un statut et que la récup
        // de statuts est désactivée (?antidelete statut off), on ignore — mais
        // on garde les messages privés/groupes actifs.
        if (cached.chat === 'status@broadcast' && config.antiDeleteStatusEnabled === false) {
            console.log(`[ANTIDELETE] Statut supprimé ignoré (ID: ${deletedId}) car antiDeleteStatusEnabled=false.`);
            messageCache.delete(deletedId);
            return;
        }
        // Skip list par groupe : si le chat est un groupe listé dans
        // config.antiDeleteSkipGroups, on ignore la suppression (utile pour
        // ne pas polluer les discussions où les gens suppriment souvent).
        if (cached.chat.endsWith('@g.us')
                && Array.isArray(config.antiDeleteSkipGroups)
                && config.antiDeleteSkipGroups.includes(cached.chat)) {
            console.log(`[ANTIDELETE] Groupe skip-list (ID: ${deletedId}, chat: ${cached.chat}) — récup ignorée.`);
            messageCache.delete(deletedId);
            return;
        }
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

            // IDs copiables pour blacklist rapide. `chat` = groupe ou chat
            // privé d'origine ; `from` = JID participant (LID en v7) ; `fromPn`
            // = numéro E164 résolu si dispo.
            const chatJid = cached.chat;
            const senderJidRaw = cached.from;
            const senderJidPn = cached.fromPn || '';
            const msgId = cached.id || deletedId;

            // Suggestion blacklist contextuelle : pour un groupe on propose le
            // JID du groupe, pour un statut / privé on propose le numéro du
            // poster (copiable direct dans ?dazantionly add / ?dazblock …).
            let blacklistHint;
            if (isGroup) {
                blacklistHint = `│ 🧱 *Blacklist groupe:* \`${chatJid}\``;
            } else {
                blacklistHint = `│ 🧱 *Blacklist expéditeur:* \`${senderRaw}\``;
            }

            const report = `╭───〔 ❌ *${typeLabel.toUpperCase()}* 〕───⬣\n` +
                           `│ ${typeIcon} *Type:* ${typeLabel}\n` +
                           `│ 👤 *Auteur:* ${senderDisplay}\n` +
                           `│ 📍 *Source:* ${sourceLabel}\n` +
                           `│ ⏰ *Heure:* ${time}\n` +
                           `│ 💬 *Contenu:* ${cached.content || "(Pas de texte)"}\n` +
                           `│ \n` +
                           `│ 🆔 *Chat JID:* \`${chatJid}\`\n` +
                           `│ 🆔 *Expéditeur JID:* \`${senderJidRaw}\`${senderJidPn ? `\n│ 🆔 *Expéditeur PN:* \`${senderJidPn}\`` : ''}\n` +
                           `│ 🆔 *Message ID:* \`${msgId}\`\n` +
                           `${blacklistHint}\n` +
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

        // Dépaquete récursivement les wrappers chiffrés/éphémères/view-once.
        // Dans la vraie vie ces couches s'imbriquent (ex: `ephemeralMessage →
        // viewOnceMessageV2 → imageMessage`), donc on ré-unwrap jusqu'à
        // obtenir un type terminal. On garde un compteur de sécurité pour
        // éviter toute boucle infinie sur message pathologique.
        const UNWRAPPABLE = new Set([
            'ephemeralMessage',
            'viewOnceMessage',
            'viewOnceMessageV2',
            'viewOnceMessageV2Extension',
            'documentWithCaptionMessage',
            'editedMessage',
            'botInvokeMessage'
        ]);
        let safety = 0;
        while (UNWRAPPABLE.has(type) && safety++ < 6) {
            const inner = msg.message[type]?.message;
            if (!inner) break;
            msg.message = inner;
            type = Object.keys(msg.message)[0];
        }

        // Content extraction — couvre aussi les messages "chiffrés/spéciaux"
        // (polls, contacts, géoloc, réactions, messages messageContextInfo…)
        // pour qu'on ait toujours quelque chose d'utile à afficher même si on
        // n'a pas pu télécharger le média avant suppression.
        if (type === 'conversation') {
            content = msg.message.conversation;
        } else if (type === 'extendedTextMessage') {
            content = msg.message.extendedTextMessage.text;
        } else if (type === 'imageMessage') {
            content = msg.message.imageMessage.caption || "[Image]";
        } else if (type === 'videoMessage') {
            content = msg.message.videoMessage.caption || "[Vidéo]";
        } else if (type === 'audioMessage') {
            content = msg.message.audioMessage?.ptt ? "[Vocal]" : "[Audio]";
        } else if (type === 'stickerMessage') {
            content = "[Sticker]";
        } else if (type === 'documentMessage') {
            content = `[Document] ${msg.message.documentMessage.fileName || ""}`;
        } else if (type === 'contactMessage') {
            content = `[Contact] ${msg.message.contactMessage?.displayName || ''}`;
        } else if (type === 'contactsArrayMessage') {
            const names = (msg.message.contactsArrayMessage?.contacts || []).map(c => c.displayName).filter(Boolean);
            content = `[Contacts] ${names.join(', ')}`;
        } else if (type === 'locationMessage') {
            const lm = msg.message.locationMessage || {};
            content = `[Localisation] ${lm.degreesLatitude},${lm.degreesLongitude}${lm.name ? ` (${lm.name})` : ''}`;
        } else if (type === 'liveLocationMessage') {
            content = `[Localisation live]`;
        } else if (type === 'pollCreationMessage' || type === 'pollCreationMessageV2' || type === 'pollCreationMessageV3') {
            const poll = msg.message[type] || {};
            const opts = (poll.options || []).map(o => o.optionName).filter(Boolean);
            content = `[Sondage] ${poll.name || ''}${opts.length ? ` — ${opts.join(' / ')}` : ''}`;
        } else if (type === 'reactionMessage') {
            content = `[Réaction] ${msg.message.reactionMessage?.text || ''}`;
        } else if (type === 'senderKeyDistributionMessage' || type === 'messageContextInfo') {
            // Ces types n'ont pas de contenu utilisable — c'est juste du
            // métadata de session chiffrée. On ne cache pas : on attendra le
            // vrai message (qui arrivera dans une upsert suivante une fois
            // les clés échangées).
            return;
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
 * Cas spécial : un message arrive d'abord sous forme chiffrée (Baileys émet
 * un `messages.upsert` avec un `type === 'ciphertext'` ou un `stub`
 * indiquant qu'on est en attente de décryptage), puis son contenu réel est
 * livré via `messages.update` une fois les clés Signal échangées. On met
 * alors à jour le cache pour que, si ce message est ensuite supprimé, on
 * ait quand même le texte/media.
 */
// Reconnaît un contenu placeholder du type `[ciphertext]`,
// `[senderKeyDistributionMessage]`, `[messageContextInfo]`, etc. — càd le
// fallback `[${type}]` de handleUpsert. Les vrais types Baileys sont en
// camelCase (1ère lettre minuscule) → la regex exige une minuscule en tête
// pour NE PAS matcher les labels de contenu produits par notre code même
// (`[Image]`, `[Vocal]`, `[Audio]`, `[Sticker]` — Title case).
const PLACEHOLDER_CONTENT_RE = /^\[[a-z][A-Za-z]*\]$/;

const handleRetryUpdate = async (sock, updates) => {
    for (const u of updates) {
        if (!u.update?.message || !u.key?.id) continue;

        const existing = messageCache.get(u.key.id);

        // On traite 3 cas légitimes :
        //  a) aucun cache (le 1er upsert était un senderKeyDistributionMessage
        //     rejeté) → on extrait maintenant le vrai contenu décrypté ;
        //  b) cache avec contenu placeholder camelCase `[type]` ET pas encore
        //     de média → on l'écrase avec le contenu réel ;
        //  c) cache avec contenu réel OU média déjà téléchargé → on skip pour
        //     ne pas écraser un média valide par une re-download échouée.
        if (existing && (existing.media || (existing.content && !PLACEHOLDER_CONTENT_RE.test(existing.content)))) {
            continue;
        }

        try {
            const fake = {
                messages: [{
                    key: u.key,
                    message: u.update.message,
                    messageTimestamp: existing?.timestamp || u.update.messageTimestamp || Math.floor(Date.now() / 1000),
                    pushName: existing?.pushName || u.update.pushName || null,
                }],
                type: 'notify',
            };
            await handleUpsert(sock, fake);
            console.log(`[ANTIDELETE] Cache mis à jour après décryptage retardé (ID: ${u.key.id})`);
        } catch (e) {
            console.error('[ANTIDELETE] Retry-update error:', e.message);
        }
    }
};

/**
 * Détecte les messages supprimés dans l'event update.
 */
const handleUpdate = async (sock, updates) => {
    // Profite du même callback pour re-cacher les messages qui se sont
    // décryptés après coup (voir handleRetryUpdate).
    await handleRetryUpdate(sock, updates);

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

