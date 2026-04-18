const axios = require('axios');

/**
 * Commande Screenshot : Capture une image d'un site web à partir d'une URL.
 * 
 * @param {object} sock - Le socket Baileys.
 * @param {object} msg - Le message reçu.
 */
const executeScreenshot = async (sock, msg) => {
    const remoteJid = msg.key.remoteJid;
    const textContent = msg.message.conversation || msg.message.extendedTextMessage?.text || "";
    const url = textContent.trim().split(/\s+/).slice(1).join(' ');

    if (!url) {
        return await sock.sendMessage(remoteJid, { text: "❌ Veuillez fournir une URL valide. Exemple: *?ss https://google.com*" }, { quoted: msg });
    }

    // Vérification basique de l'URL
    if (!url.startsWith('http')) {
        return await sock.sendMessage(remoteJid, { text: "❌ L'URL doit commencer par http:// ou https://" }, { quoted: msg });
    }

    try {
        console.log(`[SS] Tentative de capture pour: ${url}`);
        
        // Signalement visuel
        try { await sock.sendMessage(remoteJid, { react: { text: "📸", key: msg.key } }); } catch (e) {}

        const ssApiUrl = `https://api.siputzx.my.id/api/tools/ssweb?url=${encodeURIComponent(url)}`;
        
        const response = await axios.get(ssApiUrl, { responseType: "arraybuffer", timeout: 15000 });

        if (!response || response.status !== 200) {
            throw new Error("Réponse API invalide");
        }

        await sock.sendMessage(
            remoteJid,
            {
                image: Buffer.from(response.data, "binary"),
                caption: `╭───────◇\n│ 🤖 *DAZBOT SS-WEB* 🤖\n╰───────◇\n\n🔗 *URL:* ${url}\n\n> © DazBot`,
            },
            { quoted: msg }
        );
        
        try { await sock.sendMessage(remoteJid, { react: { text: "✅", key: msg.key } }); } catch (e) {}
    } catch (error) {
        console.error('[SS] Error:', error.message);
        try { await sock.sendMessage(remoteJid, { react: { text: "❌", key: msg.key } }); } catch (e) {}
        await sock.sendMessage(remoteJid, { text: "❌ Impossible de capturer ce site. Il est peut-être protégé ou l'URL est incorrecte." }, { quoted: msg });
    }
};

module.exports = { executeScreenshot };
