const os = require('os');
const process = require('process');

const executeHost = async (socket, msg, config) => {
    try {
        const hostname = os.hostname();
        const platform = os.platform();
        const arch = os.arch();
        const release = os.release();
        const cpus = os.cpus();
        const cpuModel = cpus[0]?.model || 'Unknown CPU';
        const cpuCores = cpus.length;
        const totalMem = (os.totalmem() / (1024 ** 3)).toFixed(2);
        const freeMem = (os.freemem() / (1024 ** 3)).toFixed(2);
        const nodeVersion = process.version;
        const uptimeSeconds = process.uptime();
        const uptime = `${Math.floor(uptimeSeconds / 3600)}h ${Math.floor((uptimeSeconds % 3600) / 60)}m ${Math.floor(uptimeSeconds % 60)}s`;
        const now = new Date().toLocaleString();

        let deployedOn = 'Unknown';
        if (process.env.RENDER === 'true' || process.env.RENDER_INSTANCE_ID) deployedOn = 'Render';
        else if (process.env.HEROKU === 'true' || process.env.DYNO) deployedOn = 'Heroku';
        else if (process.env.REPL_ID || process.env.REPLIT_DB_URL) deployedOn = 'Replit';
        else if (process.env.RAILWAY_STATIC_URL || process.env.RAILWAY_ENVIRONMENT) deployedOn = 'Railway';
        else if (process.env.GLITCH_PROJECT_ID) deployedOn = 'Glitch';
        else if (process.env.VERCEL === '1' || process.env.NEXT_PUBLIC_VERCEL_URL) deployedOn = 'Vercel';
        else if (hostname.includes('fly')) deployedOn = 'Fly.io';

        const messageText = `
*╭───〔 🖥️ DAZBOT HOST 〕───⬣*
*│* 📍 *Deployed On*   : ${deployedOn}
*│* 🌐 *Hostname*      : ${hostname}
*│* 🖥️ *Platform*       : ${platform} (${arch})
*│* 📦 *OS Release*    : ${release}
*│* ⚙️ *CPU*           : ${cpuModel} (${cpuCores} cores)
*│* 💾 *Memory*        : ${freeMem} GB free / ${totalMem} GB total
*│* 🔧 *Node.js*       : ${nodeVersion}
*│* ⏳ *Uptime*        : ${uptime}
*│* 🕒 *Server Time*   : ${now}
*╰────────────────────────────⬣*`.trim();

        // Le bot répond dans la conversation depuis laquelle on l'a appelé
        const remoteJid = msg.key.remoteJid;
        
        await socket.sendMessage(remoteJid, {
            text: messageText,
            contextInfo: {
                forwardingScore: 5,
                isForwarded: true,
                externalAdReply: {
                    title: "DazBot",
                    body: "Host Environment Details",
                    mediaType: 1,
                    renderLargerThumbnail: true,
                    showAdAttribution: true,
                    sourceUrl: "https://github.com/DazBot/DazBot"
                }
            }
        }, { quoted: msg });

    } catch (error) {
        console.error('[ERROR] Host command:', error.message);
        await socket.sendMessage(msg.key.remoteJid, { text: "❌ Failed to retrieve host info." }, { quoted: msg });
    }
};

module.exports = { executeHost };
