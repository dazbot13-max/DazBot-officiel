const scheduledTasks = [];

/**
 * Ajoute une tâche à la file d'attente de planification.
 */
const addTask = (task) => {
    scheduledTasks.push(task);
    console.log(`[SCHEDULER] Nouvelle tâche ajoutée pour ${task.time}. Type: ${task.type}`);
};

/**
 * Vérifie et exécute les tâches programmées.
 * Appelé toutes les minutes.
 */
const checkTasks = async (sock) => {
    const now = new Date();
    const currentTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    
    for (let i = scheduledTasks.length - 1; i >= 0; i--) {
        const task = scheduledTasks[i];
        
        if (task.time === currentTime) {
            console.log(`[SCHEDULER] Exécution de la tâche (${task.type}) à ${currentTime}`);
            try {
                if (task.type === 'status') {
                    await sock.sendMessage('status@broadcast', task.message, { backgroundColor: task.backgroundColor || '#000000', font: 1 });
                } else if (task.type === 'message') {
                    await sock.sendMessage(task.target, task.message);
                }
                
                // Envoyer une confirmation à l'owner
                const ownerJid = sock.user.id.split(':')[0] + '@s.whatsapp.net';
                await sock.sendMessage(ownerJid, { text: `✅ Tâche programmée exécutée avec succès (${task.type}) !` });
                
                scheduledTasks.splice(i, 1);
            } catch (err) {
                console.error(`[SCHEDULER] Erreur lors de l'exécution:`, err.message);
            }
        }
    }
};

/**
 * Démarre la boucle de vérification.
 */
const startScheduler = (sock) => {
    setInterval(() => checkTasks(sock), 60000); // Vérifie chaque minute
    console.log('[SCHEDULER] Système de planification démarré.');
};

module.exports = {
    addTask,
    startScheduler
};
