const getFBInfo = require('@xaviabot/fb-downloader');

/**
 * Commande Facebook : Télécharge une vidéo depuis Facebook.
 * 
 * @param {object} sock - Le socket Baileys.
 * @param {object} msg - Le message reçu.
 */
const executeFacebook = async (sock, msg) => {
    const remoteJid = msg.key.remoteJid;
    const textContent = msg.message.conversation || msg.message.extendedTextMessage?.text || "";
    const url = textContent.trim().split(/\s+/).slice(1).join(' ');

    if (!url) {
        return await sock.sendMessage(remoteJid, { text: "❌ Veuillez fournir le lien d'une vidéo Facebook publique. Exemple: *?fb https://fb.watch/...*" }, { quoted: msg });
    }

    try {
        console.log(`[FB] Téléchargement de: ${url}`);
        
        // On signale que le bot travaille
        try { await sock.sendMessage(remoteJid, { react: { text: "🕘", key: msg.key } }); } catch (e) {}

        // Appel de la bibliothèque (gestion CJS/ESM hybride possible)
        const downloader = typeof getFBInfo === 'function' ? getFBInfo : getFBInfo.default;
        
        if (typeof downloader !== 'function') {
            throw new Error("Bibliothèque fb-downloader mal chargée.");
        }

        const fbData = await downloader(url);
        
        if (!fbData || (!fbData.sd && !fbData.hd)) {
            try { await sock.sendMessage(remoteJid, { react: { text: "❌", key: msg.key } }); } catch (e) {}
            return await sock.sendMessage(remoteJid, { text: "❌ Aucune vidéo trouvée pour ce lien. Assurez-vous qu'elle soit publique." }, { quoted: msg });
        }

        const videoUrl = fbData.hd || fbData.sd;
        const title = fbData.title || "Vidéos Facebook";

        await sock.sendMessage(
            remoteJid,
            {
                video: { url: videoUrl },
                caption: `╭───────◇\n│ 🤖 *DAZBOT FB-DL* 🤖\n╰───────◇\n\n📌 *Titre:* ${title}\n\n> © DazBot`,
                mimetype: 'video/mp4'
            },
            { quoted: msg }
        );
        
        try { await sock.sendMessage(remoteJid, { react: { text: "✅", key: msg.key } }); } catch (e) {}

    } catch (error) {
        console.error('[FB] Error:', error.message);
        try { await sock.sendMessage(remoteJid, { react: { text: "❌", key: msg.key } }); } catch (e) {}
        await sock.sendMessage(remoteJid, { text: "❌ Erreur lors du téléchargement. Le lien est peut-être privé, protégé ou invalide." }, { quoted: msg });
    }
};

module.exports = { executeFacebook };
