const config = {
    // Command prefix
    prefix: "?",

    // List of owner numbers or IDs (LIDs)
    owners: [""],

    // Array of emojis the bot will randomly choose from to react to statuses
    reactionEmojis: ["🩷", "❤️", "💙", "🖤", "❤️", "🔥", "🤍", "💞", "💕", "💓", "💝", "❤️", "🔥", "🫶", "🙌", "🌚", "🙂", "↔️", "🫶🏼", "👀", "🥺", "😎", "🤩"],

    // Optional auto-reply message sent to the user when a status is reacted to.
    // Set to empty string "" to disable auto-reply.
    autoReplyMessage: "",

    // Set to true to automatically like your own posted statuses
    likeMyOwnStatus: true,

    // Active la lecture + réaction automatique aux statuts WhatsApp des contacts.
    // Quand `true`, le bot envoie une présence "en ligne", marque le statut comme
    // lu, puis envoie un emoji aléatoire (cf. `reactionEmojis`). Très utile en
    // usage normal, mais juste après un re-pairing les sessions Signal des
    // contacts sont obsolètes : chaque réaction génère un "En attente de ce
    // message" chez eux. Mettre à `false` (ou env var `STATUS_AUTO_REACT=false`)
    // pour désactiver le temps que les sessions se renégocient.
    statusAutoReactEnabled: true,

    // Envoie un DOUBLON de la réaction directement dans le chat privé du
    // posteur du statut. Astuce historique pour forcer l'affichage de la notif
    // "a réagi à votre statut" sur le mobile du posteur.
    //
    // Comportement par défaut (false) : le doublon est envoyé UNIQUEMENT au
    // owner du bot (cf. `ownerNumber`). Le owner garde donc la notif sur ses
    // propres statuts, mais les autres contacts ne reçoivent rien dans leur
    // chat privé → zéro spam "En attente de ce message" même post-re-pairing.
    //
    // Mettre `true` (ou env `STATUS_REACT_PRIVATE_NOTIFY=true`) pour réactiver
    // le doublon vers TOUS les posteurs (ancien comportement, génère du spam
    // visible chez les contacts désynchronisés).
    statusReactPrivateNotify: false,

    // If whitelist is not empty, the bot will ONLY react to statuses from these numbers.
    // Format must be: "COUNTRY_CODE_NUMBER@s.whatsapp.net"
    // e.g., ["1234567890@s.whatsapp.net"]
    whitelist: [],

    // If blacklist is not empty, the bot will IGNORE statuses from these numbers.
    // Format must be exactly like whitelist items.
    blacklist: [],

    // Set to true to use Pairing Code instead of QR code for login
    usePairingCode: true,

    // Provide your phone number if using pairing code (e.g., "1234567890")
    // Include the country code but no '+' sign or spaces.
    phoneNumber: "22947726871",

    // Nom du propriétaire affiché dans le message de connexion envoyé
    // dans la discussion perso au démarrage du bot. Si vide, le bot utilise
    // le pushName WhatsApp récupéré automatiquement à la connexion.
    ownerName: "Daziano",

    // Numéro du propriétaire affiché dans le message de connexion (sans +).
    // Peut être différent du numéro d'appairage (phoneNumber) si tu veux
    // afficher un autre numéro de contact.
    ownerNumber: "22947726871",

    // URL de la bannière envoyée à chaque connexion dans la discussion perso.
    // Laisse vide pour désactiver l'image (le bot enverra juste le texte).
    bootBannerUrl: "https://i.postimg.cc/rFR6bHgL/17762702118f23.png",

    // Citations affichées dans le message de connexion (toutes affichées).
    // Ajoute / supprime / modifie librement.
    bootQuotes: [
        "Et tout ça 🤒, c'est le destin 🫠🤲🧎",
        "St4y F0cuS, St4Y D3termi4t3 🫠🤲🧎"
    ],
    
    // Supabase credentials for remote auth state storage. Si renseignés (ou
    // définis via env vars `SUPABASE_URL` / `SUPABASE_KEY`), la session
    // WhatsApp est sauvegardée dans une table Postgres au lieu du dossier
    // `auth_info_baileys/`. Indispensable sur Render Free / Railway dont le
    // filesystem est éphémère. Sur VPS classique (Contabo, DO), laisse vide.
    supabaseUrl: "",
    supabaseKey: "",

    // URL publique de l'instance Render / Railway (ex: "https://mon-bot.onrender.com").
    // Si définie (ici ou via env var `RENDER_URL`), le bot s'auto-ping toutes
    // les 5 min pour empêcher Render Free de l'endormir après 15 min
    // d'inactivité. Laisse vide sur VPS classique.
    renderUrl: "",

    // Préfixe unique pour les clés Supabase quand on héberge plusieurs bots
    // (un par ami) sur le même projet Supabase. Chaque instance doit avoir
    // sa propre valeur (ex: "ami_jean", "ami_marie") via env var `BOT_ID` ou
    // ce champ. Vide = mode mono-bot (clés non préfixées, rétrocompatible).
    botId: "",

    // Anti-Delete settings
    antiDeleteEnabled: true,
    antiDeleteChat: "", // Default destination for deleted messages
    // Sous-toggle : si false, les statuts supprimés sont ignorés tandis que les
    // messages privés/groupes restent récupérés. Contrôle via `?antidelete
    // statut on|off` depuis WhatsApp. Désactivé par défaut pour éviter de
    // polluer la discussion perso avec les statuts supprimés (volume élevé).
    antiDeleteStatusEnabled: false,
    // Groupes (JIDs complets `<id>@g.us`) dont on ignore les suppressions —
    // utile pour ne pas polluer certaines discussions avec des récups. Géré
    // depuis WhatsApp via `?antidelete skip add|remove|list|clear <jid>`.
    antiDeleteSkipGroups: [],

    // Fuseau horaire utilisé pour interpréter les heures passées aux commandes
    // de planification (?planstatus / ?planmsg). Par défaut Africa/Porto-Novo
    // (UTC+1, Bénin). Change en "Europe/Paris", "America/New_York", etc.
    timezone: "Africa/Porto-Novo",

    // Global settings
    sendWelcomeMessage: true, // Whether to send a message to yourself when the bot connects

    // ---------------------------------------------------------------
    // Chatbot IA (porté depuis dazbot-1/Chat-Bot-Dazi)
    // ---------------------------------------------------------------
    // Répond automatiquement aux messages privés texte via OpenRouter
    // (ou OpenAI) en imitant la personnalité définie dans personality.json.
    // Désactivé par défaut : active avec `?dazai on`.
    aiAutoReply: false,
    // "gemini" (Google AI Studio, plan gratuit généreux) |
    // "openrouter" | "openai"
    aiProvider: "gemini",
    // Modèle exact côté provider. Gemini : "gemini-2.5-flash" (rapide, gratuit)
    // ou "gemini-2.5-pro". OpenRouter : "openai/gpt-4o-mini" par ex.
    // OpenAI : "gpt-4o-mini". Laisse "" pour prendre le défaut du provider.
    aiModel: "gemini-2.5-flash-lite",
    aiMaxContextMessages: 10,           // mémoire courte par contact
    aiRespondToGroups: false,           // true = répond aussi dans les groupes
    aiTypingDelayMsMin: 2500,           // délai min "typing" avant réponse
    aiTypingDelayMsMax: 8000,           // délai max (clampé, ~40ms/char)
    // Si non vide, le bot ne répond IA qu'à ces numéros (sans '+', ex "22955724800")
    aiAllowedNumbers: [],
    // Numéros à IGNORER même si autoReply est ON.
    aiBlockedNumbers: [],
    // Numéros traités en MODE ROMANTIQUE ("copines") : le bot utilise la
    // personnalité `romantic` de personality.json (mots doux, ton affectueux,
    // réassurance sur l'exclusivité) au lieu de la personnalité Daziano standard.
    // Ex : ['22955724800', '22912345678']
    aiRomanticNumbers: [],

    // ─────────────────────────────────────────────────────────────────────
    // WATCHDOG (auto-recovery anti-freeze)
    // ─────────────────────────────────────────────────────────────────────
    // Avec Baileys multi-device, il arrive que le socket reste ouvert mais
    // qu'aucun event ne remonte (Bad MAC en boucle, conflit, etc.) → le bot
    // semble "online" dans pm2 mais ne réagit plus. Le watchdog surveille
    // le délai depuis le dernier event WhatsApp et fait `process.exit(1)`
    // si dépassé : PM2 relance alors le process automatiquement, et la
    // session reprend depuis `auth_info_baileys/` sans re-pairing.
    watchdogEnabled: true,
    watchdogSilenceMs: 600000,          // 10 min sans event → relance
    watchdogCheckMs: 60000,             // vérification toutes les 60s
    watchdogGracePeriodMs: 120000       // pas de check pendant les 2 premières min après boot
};

// --- Surcharges via variables d'environnement ---
// Permet de configurer une instance (ex: un bot par ami sur Render) en
// définissant les env vars sur le service, sans modifier ce fichier ni
// rien push. Si l'env var est absente ou vide, on garde la valeur ci-dessus.
//
// Utilisation typique sur Render :
//   PHONE_NUMBER=22912345678     (numéro WhatsApp à appairer)
//   OWNER_NUMBER=22912345678     (numéro du propriétaire affiché)
//   OWNER_NAME=Jean              (nom affiché dans la bannière)
//   USE_PAIRING_CODE=true        (true=Pairing Code, false=QR)
//   STATUS_AUTO_REACT=false      (désactive la lecture/réaction auto aux statuts)
//   STATUS_REACT_PRIVATE_NOTIFY=true   (envoie un doublon de la réaction dans
//                                       le chat privé du posteur — défaut
//                                       false : génère du spam "En attente"
//                                       chez les contacts post-re-pairing)
//   BOT_ID=ami_jean              (préfixe Supabase si table partagée)
//   SUPABASE_URL=https://...
//   SUPABASE_KEY=...
//   RENDER_URL=https://mon-bot.onrender.com
//   TZ=Africa/Porto-Novo
const envOverrides = {
    phoneNumber:            process.env.PHONE_NUMBER,
    ownerNumber:            process.env.OWNER_NUMBER,
    ownerName:              process.env.OWNER_NAME,
    usePairingCode:         process.env.USE_PAIRING_CODE,
    statusAutoReactEnabled:    process.env.STATUS_AUTO_REACT,
    statusReactPrivateNotify:  process.env.STATUS_REACT_PRIVATE_NOTIFY,
    botId:                  process.env.BOT_ID,
    supabaseUrl:            process.env.SUPABASE_URL,
    supabaseKey:            process.env.SUPABASE_KEY,
    renderUrl:              process.env.RENDER_URL,
    timezone:               process.env.TZ,
};

for (const [key, raw] of Object.entries(envOverrides)) {
    if (raw === undefined || raw === '') continue;
    if (typeof config[key] === 'boolean') {
        config[key] = raw === 'true' || raw === '1' || raw === 'yes';
    } else {
        config[key] = raw;
    }
}

module.exports = config;
