const fs = require('fs');
const path = require('path');

const STORE_PATH = path.join(__dirname, 'scheduled_tasks.json');

let scheduledTasks = [];
let nextId = 1;

/**
 * Les médias sont des Buffers Node qui ne peuvent pas être sérialisés tels quels
 * en JSON. On les convertit en base64 côté stockage et on reconstruit le Buffer
 * au chargement. Les tâches texte-only sont sérialisées normalement.
 */
const serializeMessage = (message) => {
    const out = { ...message };
    for (const key of ['image', 'video', 'audio', 'document', 'sticker']) {
        if (out[key] && Buffer.isBuffer(out[key])) {
            out[key] = { __buffer: true, data: out[key].toString('base64') };
        }
    }
    return out;
};

const deserializeMessage = (message) => {
    const out = { ...message };
    for (const key of ['image', 'video', 'audio', 'document', 'sticker']) {
        if (out[key] && out[key].__buffer) {
            out[key] = Buffer.from(out[key].data, 'base64');
        }
    }
    return out;
};

const save = () => {
    try {
        const payload = {
            nextId,
            tasks: scheduledTasks.map(t => ({
                ...t,
                message: serializeMessage(t.message)
            }))
        };
        fs.writeFileSync(STORE_PATH, JSON.stringify(payload, null, 2));
    } catch (e) {
        console.error('[SCHEDULER] Save error:', e.message);
    }
};

const load = () => {
    try {
        if (!fs.existsSync(STORE_PATH)) return;
        const raw = fs.readFileSync(STORE_PATH, 'utf8');
        if (!raw.trim()) return;
        const payload = JSON.parse(raw);
        scheduledTasks = (payload.tasks || []).map(t => ({
            ...t,
            message: deserializeMessage(t.message)
        }));
        nextId = payload.nextId || (scheduledTasks.reduce((m, t) => Math.max(m, t.id || 0), 0) + 1);
        console.log(`[SCHEDULER] ${scheduledTasks.length} tâche(s) chargée(s) depuis le disque.`);
    } catch (e) {
        console.error('[SCHEDULER] Load error:', e.message);
    }
};

/**
 * Parse une cible temporelle en timestamp (ms).
 * Accepte :
 *   - "HH:MM"              (prochaine occurrence aujourd'hui ou demain)
 *   - "JJ/MM HH:MM"        (année courante, ou année suivante si déjà passée)
 *   - "JJ/MM/AAAA HH:MM"   (date complète)
 * Retourne { ts, label } ou { error }.
 */
const parseSchedule = (raw) => {
    const s = (raw || '').trim();

    const hmOnly = /^(\d{1,2}):(\d{2})$/;
    const dmHm = /^(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2})$/;
    const dmyHm = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})\s+(\d{1,2}):(\d{2})$/;

    const now = new Date();
    let target = null;

    // Valide explicitement les plages : Date.setHours(25, 70) ne retourne
    // pas NaN, il fait juste déborder vers le jour suivant à 02:10. Sans
    // cette garde, "?ps 25:70" serait accepté silencieusement. Pareil pour
    // les dates : 31/02 devient le 3 mars. On rejette avant de construire.
    const inRange = (n, lo, hi) => Number.isInteger(n) && n >= lo && n <= hi;
    const daysInMonth = (y, moIdx) => new Date(y, moIdx + 1, 0).getDate();

    let m;
    if ((m = s.match(dmyHm))) {
        const [, d, mo, y, h, mi] = m;
        const day = parseInt(d, 10);
        const month = parseInt(mo, 10);
        let year = parseInt(y, 10);
        if (year < 100) year += 2000;
        const hour = parseInt(h, 10);
        const min = parseInt(mi, 10);
        if (!inRange(hour, 0, 23) || !inRange(min, 0, 59)) return { error: "Heure hors plage (00:00 à 23:59)." };
        if (!inRange(month, 1, 12)) return { error: "Mois hors plage (1 à 12)." };
        if (!inRange(day, 1, daysInMonth(year, month - 1))) return { error: `Jour hors plage pour ${String(month).padStart(2, '0')}/${year}.` };
        if (!inRange(year, 1970, 3000)) return { error: "Année hors plage." };
        target = new Date(year, month - 1, day, hour, min, 0, 0);
        // Les formats HH:MM et JJ/MM basculent automatiquement dans le futur
        // (demain, année prochaine). Pour JJ/MM/AAAA on a une date explicite :
        // si elle est passée, c'est probablement une erreur de frappe — on
        // rejette au lieu de laisser checkTasks supprimer la tâche dans 15s.
        if (target.getTime() <= now.getTime()) return { error: "Cette date est déjà passée." };
    } else if ((m = s.match(dmHm))) {
        const [, d, mo, h, mi] = m;
        const day = parseInt(d, 10);
        const month = parseInt(mo, 10);
        const hour = parseInt(h, 10);
        const min = parseInt(mi, 10);
        if (!inRange(hour, 0, 23) || !inRange(min, 0, 59)) return { error: "Heure hors plage (00:00 à 23:59)." };
        if (!inRange(month, 1, 12)) return { error: "Mois hors plage (1 à 12)." };
        let year = now.getFullYear();
        // Si le jour est invalide pour l'année en cours (ex: 29/02 en année
        // non bissextile), on tente l'année suivante avant de rejeter — ça
        // évite de refuser "29/02" juste parce qu'on est en 2027 alors que
        // 29/02/2028 serait parfaitement valide.
        if (!inRange(day, 1, daysInMonth(year, month - 1))) {
            const nextYear = year + 1;
            if (!inRange(day, 1, daysInMonth(nextYear, month - 1))) {
                return { error: `Jour hors plage pour ${String(month).padStart(2, '0')} (ni en ${year} ni en ${nextYear}).` };
            }
            year = nextYear;
        }
        target = new Date(year, month - 1, day, hour, min, 0, 0);
        if (target.getTime() <= now.getTime()) {
            // Bascule sur l'année suivante ; re-valide le jour (29/02 peut
            // devenir invalide si l'année suivante n'est pas bissextile —
            // dans ce cas on saute encore d'un an pour trouver une bissextile).
            let candidate = year + 1;
            let tries = 0;
            while (!inRange(day, 1, daysInMonth(candidate, month - 1)) && tries < 8) {
                candidate += 1;
                tries += 1;
            }
            if (!inRange(day, 1, daysInMonth(candidate, month - 1))) {
                return { error: `Jour hors plage pour ${String(month).padStart(2, '0')}.` };
            }
            year = candidate;
            target = new Date(year, month - 1, day, hour, min, 0, 0);
        }
    } else if ((m = s.match(hmOnly))) {
        const [, h, mi] = m;
        const hour = parseInt(h, 10);
        const min = parseInt(mi, 10);
        if (!inRange(hour, 0, 23) || !inRange(min, 0, 59)) return { error: "Heure hors plage (00:00 à 23:59)." };
        target = new Date(now);
        target.setHours(hour, min, 0, 0);
        if (target.getTime() <= now.getTime()) {
            target.setDate(target.getDate() + 1);
        }
    } else {
        return { error: "Format invalide. Utilise HH:MM, JJ/MM HH:MM, ou JJ/MM/AAAA HH:MM." };
    }

    if (isNaN(target.getTime())) {
        return { error: "Date/heure invalide." };
    }

    const label = `${String(target.getDate()).padStart(2, '0')}/${String(target.getMonth() + 1).padStart(2, '0')}/${target.getFullYear()} ${String(target.getHours()).padStart(2, '0')}:${String(target.getMinutes()).padStart(2, '0')}`;
    return { ts: target.getTime(), label };
};

/**
 * Ajoute une tâche à la file d'attente de planification.
 * task = { type: 'status'|'message', ts: number, label: string, message: {...}, target?: string }
 */
const addTask = (task) => {
    const id = nextId++;
    const entry = { id, createdAt: Date.now(), ...task };
    scheduledTasks.push(entry);
    save();
    console.log(`[SCHEDULER] Tâche #${id} (${task.type}) ajoutée pour ${task.label}.`);
    return entry;
};

const cancelTask = (id) => {
    const idx = scheduledTasks.findIndex(t => t.id === Number(id));
    if (idx === -1) return null;
    const [removed] = scheduledTasks.splice(idx, 1);
    save();
    return removed;
};

const listTasks = () => scheduledTasks.slice().sort((a, b) => a.ts - b.ts);

const clearTasks = () => {
    const count = scheduledTasks.length;
    // Mutation in-place : checkTasks() peut être en train d'itérer le tableau
    // pendant un await. Une réaffectation (`scheduledTasks = []`) ferait que
    // l'itération continue sur l'ancienne référence pendant que le reste du
    // module voit la nouvelle — provoque des reads `undefined` qui crashent.
    scheduledTasks.splice(0, scheduledTasks.length);
    save();
    return count;
};

/**
 * Vérifie et exécute les tâches dont l'heure est passée.
 * Appelé toutes les 15 secondes : on ratisse donc toutes les tâches dont
 * `ts <= now` (avec une fenêtre de rattrapage de 2 min pour les tâches
 * manquées — par ex. bot offline au moment cible).
 */
// Lock de ré-entrance : setInterval fire toutes les 15s mais checkTasks est
// async et peut prendre plus que 15s à cause de uploads média ou du réseau.
// Sans ce verrou, 2 invocations concurrentes lisent le même tableau et
// envoient chacune le statut/message → doublons côté destinataire, puis le
// splice() du premier retire la mauvaise tâche pour le second → corruption.
let isCheckingTasks = false;

const checkTasks = async (sock) => {
    if (isCheckingTasks) return;
    isCheckingTasks = true;
    try {
        await _checkTasksInner(sock);
    } finally {
        isCheckingTasks = false;
    }
};

const _checkTasksInner = async (sock) => {
    const now = Date.now();
    const graceMs = 2 * 60 * 1000;

    for (let i = scheduledTasks.length - 1; i >= 0; i--) {
        const task = scheduledTasks[i];
        // clearTasks() (?planreset) peut vider le tableau pendant un await du
        // loop → scheduledTasks[i] devient undefined et task.ts crash en
        // TypeError. Garde défensif obligatoire.
        if (!task) continue;
        if (typeof task.ts !== 'number') continue;
        if (task.ts > now) continue;
        if (now - task.ts > graceMs && !task.forceRun) {
            // Tâche trop vieille : on la supprime sans l'exécuter pour éviter
            // d'envoyer un message surprise plusieurs heures plus tard.
            console.log(`[SCHEDULER] Tâche #${task.id} trop ancienne (${Math.round((now - task.ts) / 60000)} min de retard), suppression.`);
            scheduledTasks.splice(i, 1);
            save();
            continue;
        }

        console.log(`[SCHEDULER] Exécution de la tâche #${task.id} (${task.type}) - cible ${task.label}`);
        try {
            if (task.type === 'status') {
                // Sans `statusJidList`, Baileys poste le statut sans audience : il est
                // uploadé côté serveur mais invisible à tous les contacts. On fournit
                // donc la liste des contacts connus récupérée via le callback fourni
                // par index.js (events contacts.upsert + fallback messages.upsert).
                let jidList = [];
                if (typeof statusJidListProvider === 'function') {
                    const raw = statusJidListProvider();
                    // Le provider peut être sync ou async : on await dans les 2 cas.
                    jidList = (raw && typeof raw.then === 'function')
                        ? ((await raw) || [])
                        : (raw || []);
                }
                console.log(`[SCHEDULER] Publication statut avec ${jidList.length} destinataire(s): ${jidList.join(', ')}`);
                if (jidList.length === 0) {
                    console.warn('[SCHEDULER] ⚠️ Aucun destinataire dans la liste — le statut va sûrement être invisible à tous.');
                }
                // backgroundColor/font ne s'appliquent qu'aux statuts texte. Les
                // passer pour un status image/vidéo peut perturber le rendu côté
                // app mobile (d'après des rapports dans la commu Baileys).
                const isTextStatus = !!(task.message && (task.message.text || task.message.conversation)) &&
                    !task.message.image && !task.message.video && !task.message.audio;
                const sendOpts = { statusJidList: jidList };
                if (isTextStatus) {
                    sendOpts.backgroundColor = task.backgroundColor || '#000000';
                    sendOpts.font = 1;
                }
                await sock.sendMessage('status@broadcast', task.message, sendOpts);
                // Tente de forcer le téléphone principal à resynchroniser son feed
                // "Mes statuts" — sans garantie, mais sans effet de bord négatif.
                try {
                    if (typeof sock.resyncAppState === 'function') {
                        await sock.resyncAppState(['regular_high'], false);
                        console.log('[SCHEDULER] resyncAppState(regular_high) demandé.');
                    }
                } catch (e) {
                    console.warn('[SCHEDULER] resyncAppState échec:', e.message);
                }
            } else if (task.type === 'message') {
                await sock.sendMessage(task.target, task.message);
            }

            const ownerJid = sock.user.id.split(':')[0] + '@s.whatsapp.net';
            const suffix = task.type === 'message' ? ` vers ${task.target}` : '';
            await sock.sendMessage(ownerJid, {
                text: `✅ Tâche #${task.id} (${task.type})${suffix} exécutée à ${task.label}.`
            });

            // Preuve de publication côté user : si WhatsApp ne synchronise pas
            // le statut dans la liste "Mes statuts" du téléphone de l'émetteur
            // (limitation connue quand on poste depuis un appareil lié), on
            // renvoie une copie du contenu dans sa discussion personnelle pour
            // qu'il ait au moins une preuve visible.
            if (task.type === 'status') {
                try {
                    const proofHeader = { text: `📤 *Statut publié à ${task.label}* (copie ci-dessous)` };
                    await sock.sendMessage(ownerJid, proofHeader);
                    const copy = { ...task.message };
                    if (copy.text) {
                        await sock.sendMessage(ownerJid, { text: copy.text });
                    } else if (copy.image) {
                        await sock.sendMessage(ownerJid, { image: copy.image, caption: copy.caption });
                    } else if (copy.video) {
                        await sock.sendMessage(ownerJid, { video: copy.video, caption: copy.caption });
                    } else if (copy.audio) {
                        await sock.sendMessage(ownerJid, { audio: copy.audio, mimetype: copy.mimetype || 'audio/mpeg', ptt: !!copy.ptt });
                    }
                } catch (copyErr) {
                    console.warn(`[SCHEDULER] Copie preuve échouée: ${copyErr.message}`);
                }
            }

            scheduledTasks.splice(i, 1);
            save();
        } catch (err) {
            console.error(`[SCHEDULER] Erreur exécution tâche #${task.id}:`, err.message);
            // Retire quand même pour éviter les boucles infinies sur tâche cassée.
            scheduledTasks.splice(i, 1);
            save();
        }
    }
};

let schedulerInterval = null;
let tasksLoaded = false;
let statusJidListProvider = null;

const startScheduler = (sock, options = {}) => {
    // startScheduler() est appelé à chaque ouverture de connexion (y compris
    // après une reconnexion). Sans nettoyer l'intervalle précédent, on
    // accumulait N timers après N reconnexions — tous avec des références de
    // socket mortes sauf le dernier, ce qui provoquait des échecs d'envoi
    // (suivis de suppression de la tâche dans le catch) = tâches perdues.
    if (schedulerInterval) clearInterval(schedulerInterval);
    if (typeof options.getStatusJidList === 'function') {
        statusJidListProvider = options.getStatusJidList;
    }
    if (!tasksLoaded) {
        load();
        tasksLoaded = true;
    }
    schedulerInterval = setInterval(() => checkTasks(sock), 15000);
    console.log('[SCHEDULER] Système de planification démarré (polling 15s, persistance activée).');
};

module.exports = {
    addTask,
    cancelTask,
    listTasks,
    clearTasks,
    parseSchedule,
    startScheduler
};
