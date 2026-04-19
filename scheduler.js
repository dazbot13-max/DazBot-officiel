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

    let m;
    if ((m = s.match(dmyHm))) {
        const [, d, mo, y, h, mi] = m;
        let year = parseInt(y, 10);
        if (year < 100) year += 2000;
        target = new Date(year, parseInt(mo, 10) - 1, parseInt(d, 10), parseInt(h, 10), parseInt(mi, 10), 0, 0);
    } else if ((m = s.match(dmHm))) {
        const [, d, mo, h, mi] = m;
        const year = now.getFullYear();
        target = new Date(year, parseInt(mo, 10) - 1, parseInt(d, 10), parseInt(h, 10), parseInt(mi, 10), 0, 0);
        if (target.getTime() <= now.getTime()) {
            target.setFullYear(year + 1);
        }
    } else if ((m = s.match(hmOnly))) {
        const [, h, mi] = m;
        target = new Date(now);
        target.setHours(parseInt(h, 10), parseInt(mi, 10), 0, 0);
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
    scheduledTasks = [];
    save();
    return count;
};

/**
 * Vérifie et exécute les tâches dont l'heure est passée.
 * Appelé toutes les 15 secondes : on ratisse donc toutes les tâches dont
 * `ts <= now` (avec une fenêtre de rattrapage de 2 min pour les tâches
 * manquées — par ex. bot offline au moment cible).
 */
const checkTasks = async (sock) => {
    const now = Date.now();
    const graceMs = 2 * 60 * 1000;

    for (let i = scheduledTasks.length - 1; i >= 0; i--) {
        const task = scheduledTasks[i];
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
                await sock.sendMessage('status@broadcast', task.message, {
                    backgroundColor: task.backgroundColor || '#000000',
                    font: 1
                });
            } else if (task.type === 'message') {
                await sock.sendMessage(task.target, task.message);
            }

            const ownerJid = sock.user.id.split(':')[0] + '@s.whatsapp.net';
            const suffix = task.type === 'message' ? ` vers ${task.target}` : '';
            await sock.sendMessage(ownerJid, {
                text: `✅ Tâche #${task.id} (${task.type})${suffix} exécutée à ${task.label}.`
            });

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

const startScheduler = (sock) => {
    // startScheduler() est appelé à chaque ouverture de connexion (y compris
    // après une reconnexion). Sans nettoyer l'intervalle précédent, on
    // accumulait N timers après N reconnexions — tous avec des références de
    // socket mortes sauf le dernier, ce qui provoquait des échecs d'envoi
    // (suivis de suppression de la tâche dans le catch) = tâches perdues.
    if (schedulerInterval) clearInterval(schedulerInterval);
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
