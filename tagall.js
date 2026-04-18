const config = require('./config.js');

/**
 * Commande TagAll : Mentionne tous les membres d'un groupe.
 * 
 * @param {object} sock - Le socket Baileys.
 * @param {object} msg - Le message reçu.
 */
const executeTagAll = async (sock, msg) => {
    const remoteJid = msg.key.remoteJid;
    
    // Vérifier si c'est un groupe
    if (!remoteJid.endsWith('@g.us')) {
        return await sock.sendMessage(remoteJid, { text: '🚫 Cette commande fonctionne uniquement dans les groupes.' }, { quoted: msg });
    }

    try {
        console.log(`[TAGALL] Exécution dans le groupe: ${remoteJid}`);
        
        const groupMeta = await sock.groupMetadata(remoteJid);
        const participants = groupMeta.participants;
        const senderJid = msg.key.participant || remoteJid;
        const senderName = senderJid.split('@')[0];

        // Image de secours
        const fallbackImage = 'https://i.postimg.cc/BvY75gbx/IMG-20250625-WA0221.jpg';

        // Tente de récupérer la photo de profil de l'auteur
        let profilePicture = fallbackImage;
        try {
            profilePicture = await sock.profilePictureUrl(senderJid, 'image');
        } catch (e) {
            // Si pas de photo de profil, on garde l'image par défaut
            profilePicture = fallbackImage; 
        }

        const mentions = participants.map(p => p.id);
        const adminCount = participants.filter(p => p.admin).length;
        
        // Extraction du texte personnalisé (?tagall le texte ici)
        const textContent = msg.message.conversation || 
                           msg.message.extendedTextMessage?.text || 
                           msg.message.imageMessage?.caption || 
                           msg.message.videoMessage?.caption || 
                           "";
                           
        const rawText = textContent.trim().split(/\s+/).slice(1).join(' ');
        const userText = rawText || 'Aucun';
        
        const tagList = mentions.map(id => `│ 👤 @${id.split('@')[0]}`).join('\n');

        const caption = `╭───────◇\n` +
                        `│ 🤖 *DAZBOT - TAGALL* 🤖\n` +
                        `╰───────◇\n\n` +
                        `👥 *Groupe* : ${groupMeta.subject}\n` +
                        `👤 *Auteur* : @${senderName}\n` +
                        `👨‍👩‍👧‍👦 *Membres* : ${participants.length}\n` +
                        `🛡️ *Admins* : ${adminCount}\n\n` +
                        `🗒️ *Note* : ${userText}\n\n` +
                        `╭───〔 LISTE 〕───⬣\n` +
                        `${tagList}\n` +
                        `╰──────────────⬣\n\n` +
                        `> PRODUCED BY DAZBOT`;

        try {
            await sock.sendMessage(
                remoteJid,
                {
                    image: { url: profilePicture },
                    caption: caption,
                    mentions: mentions
                },
                { quoted: msg }
            );
        } catch (imageErr) {
            console.error('[TAGALL] Image send failed, falling back to text:', imageErr.message);
            // Fallback en texte seul si l'image pose problème
            await sock.sendMessage(
                remoteJid,
                {
                    text: caption,
                    mentions: mentions
                },
                { quoted: msg }
            );
        }

    } catch (err) {
        console.error('[TAGALL] Error:', err);
        await sock.sendMessage(remoteJid, { text: '❌ Une erreur est survenue lors du tag.' }, { quoted: msg });
    }
};

module.exports = { executeTagAll };
