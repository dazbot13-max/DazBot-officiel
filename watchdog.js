// watchdog.js — Détection de silence et auto-recovery du bot.
//
// Pourquoi ce module existe :
//   Avec Baileys multi-device, il arrive (~quelques fois par jour) que le
//   socket WebSocket reste "ouvert" côté Node mais que plus aucun event ne
//   remonte (Bad MAC en boucle, conflit de session, push manquée). Le bot
//   apparaît "online" dans `pm2 list` mais en pratique il ne like plus les
//   statuts, ne répond plus aux commandes, l'IA ne répond plus. Le seul
//   moyen de débloquer est un `pm2 restart dazbot`.
//
// Comment ça marche :
//   - À chaque event WhatsApp utile (messages.upsert, messages.update,
//     connection.update, contacts.upsert), on appelle `tick()` qui met à
//     jour `lastActivityAt`.
//   - Toutes les `checkMs` ms, le watchdog vérifie le délai depuis le
//     dernier tick. Si > `silenceMs`, il appelle `onSilence()`.
//   - Le comportement par défaut est `process.exit(1)` : PM2 (avec
//     `--max-restarts unlimited` par défaut) relance immédiatement le
//     process en réutilisant la session Baileys persistée dans
//     `auth_info_baileys/`. Aucune reconnexion manuelle nécessaire.
//
// Réglages :
//   - config.watchdogEnabled       : active/désactive le watchdog (def: true)
//   - config.watchdogSilenceMs     : silence max toléré (def: 600000 = 10 min)
//   - config.watchdogCheckMs       : intervalle de vérification (def: 60000 = 1 min)
//   - config.watchdogGracePeriodMs : délai après le démarrage avant les
//                                    premiers checks, pour laisser le temps
//                                    à la connexion de se faire (def: 120000 = 2 min)

let lastActivityAt = Date.now();
let timer = null;
let started = false;

function tick() {
    lastActivityAt = Date.now();
}

function getSilenceMs() {
    return Date.now() - lastActivityAt;
}

function start(options = {}) {
    if (started) return;
    started = true;

    const silenceMs = Math.max(60_000, Number(options.silenceMs) || 600_000);
    const checkMs = Math.max(10_000, Number(options.checkMs) || 60_000);
    const gracePeriodMs = Math.max(0, Number(options.gracePeriodMs) || 120_000);
    const onSilence = typeof options.onSilence === 'function'
        ? options.onSilence
        : (silence) => {
            console.error(`[WATCHDOG] Silence détecté (${Math.round(silence / 1000)}s sans event). Sortie du process pour relance PM2…`);
            process.exit(1);
        };

    const startedAt = Date.now();
    lastActivityAt = Date.now();

    timer = setInterval(() => {
        const sinceStart = Date.now() - startedAt;
        if (sinceStart < gracePeriodMs) return; // période de grâce après boot

        const silence = getSilenceMs();
        if (silence >= silenceMs) {
            try { onSilence(silence); } catch (e) {
                console.error('[WATCHDOG] onSilence a levé une exception:', e);
                process.exit(1);
            }
        }
    }, checkMs);

    if (timer && typeof timer.unref === 'function') timer.unref();

    console.log(
        `[WATCHDOG] Démarré (silence max=${Math.round(silenceMs / 1000)}s, ` +
        `check toutes les ${Math.round(checkMs / 1000)}s, ` +
        `grâce de ${Math.round(gracePeriodMs / 1000)}s).`,
    );
}

function stop() {
    if (timer) {
        clearInterval(timer);
        timer = null;
    }
    started = false;
}

module.exports = { tick, start, stop, getSilenceMs };
