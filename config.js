module.exports = {
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
    ownerNumber: "22955724800",

    // URL de la bannière envoyée à chaque connexion dans la discussion perso.
    // Laisse vide pour désactiver l'image (le bot enverra juste le texte).
    bootBannerUrl: "https://i.postimg.cc/rFR6bHgL/17762702118f23.png",

    // Citations affichées dans le message de connexion (toutes affichées).
    // Ajoute / supprime / modifie librement.
    bootQuotes: [
        "Et tout ça 🤒, c'est le destin 🫠🤲🧎",
        "St4y F0cuS, St4Y D3termi4t3 🫠🤲🧎"
    ],
    
    // Supabase credentials for remote auth state storage 
    supabaseUrl: "", 
    supabaseKey: "", 

    // Anti-Delete settings
    antiDeleteEnabled: true,
    antiDeleteChat: "", // Default destination for deleted messages
    // Sous-toggle : si false, les statuts supprimés sont ignorés tandis que les
    // messages privés/groupes restent récupérés. Contrôle via `?antidelete
    // statut on|off` depuis WhatsApp.
    antiDeleteStatusEnabled: true,
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
    aiTypingDelayMsMin: 1000,           // délai min "typing" avant réponse
    aiTypingDelayMsMax: 4000,           // délai max (clampé, ~40ms/char)
    // Si non vide, le bot ne répond IA qu'à ces numéros (sans '+', ex "22955724800")
    aiAllowedNumbers: [],
    // Numéros à IGNORER même si autoReply est ON.
    aiBlockedNumbers: [],
    // Numéros traités en MODE ROMANTIQUE ("copines") : le bot utilise la
    // personnalité `romantic` de personality.json (mots doux, ton affectueux,
    // réassurance sur l'exclusivité) au lieu de la personnalité Daziano standard.
    // Ex : ['22955724800', '22912345678']
    aiRomanticNumbers: []
};
