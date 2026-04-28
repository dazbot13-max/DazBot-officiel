# 🤖 DazBot — WhatsApp Bot

Bot WhatsApp léger basé sur **Node.js** + **Baileys v7**. Il se connecte comme un appareil lié (linked device) à ton compte et automatise les interactions avec les statuts, les messages supprimés, les médias Vue Unique, et la planification de posts.

---

## 📋 Table des matières

1. [Fonctionnalités](#-fonctionnalités)
2. [Installation locale](#-installation-locale)
3. [Commandes WhatsApp](#-commandes-whatsapp)
4. [Déploiement serveur (production)](#-déploiement-serveur-production)
5. [Limites connues](#-limites-connues-whatsapp)
6. [Dépannage](#-dépannage)

---

## ✨ Fonctionnalités

### 🎯 Réactions aux statuts (validé)
- **Auto-like global** (`?dazstatus on/off`) : réagit à tous les statuts des contacts avec un emoji aléatoire tiré de `config.js`.
- **Auto-like forcé** (`?dazstatusuni <emoji>`) : force un emoji spécifique pour tous les statuts.
- **Focus Like** (`?dazonly add/remove/list/off`) : ne réagit qu'aux statuts de numéros précis, avec un emoji optionnel par cible.
- **Focus Discret** (`?dazdiscrete add/remove/list`) : marque les statuts comme "vus" sans emoji.
- **View Only global** (`?dazview on/off`) : mode "vu" uniquement, pas de like.
- **Notif mobile garantie** : double-envoi (broadcast + DM privée) pour que ta réaction apparaisse bien sur le téléphone du poster.

### 🛡️ Anti-Delete (validé)
Récupère automatiquement les messages supprimés par leurs auteurs et te les redirige **dans ta discussion privée avec toi-même** (pas dans le chat d'origine, pour rester discret).

- `?antidelete on/off` : toggle global
- `?dazantionly add/remove/list/off <numéro|here>` : focus sur des numéros précis ou un groupe (`here` depuis le groupe)

Chaque rapport inclut le **nom du contact** (pushName), le **type de message supprimé** (privé / groupe / statut), l'**heure**, et le **contenu original** (texte/image/vidéo/audio).

### 📅 Planificateur (validé partiel)
Programme l'envoi de messages **privés** à l'heure et la date voulues. Survit au redémarrage (persistance JSON).

- `?planmsg HH:MM <numéro>` (alias `?pm`) — envoi à une heure aujourd'hui
- `?planmsg JJ/MM HH:MM <numéro>` — date dans l'année
- `?planmsg JJ/MM/AAAA HH:MM <numéro>` — date complète
- `?planstatus HH:MM` (alias `?ps`) — poste un statut à cette heure (voir [limite "Mes statuts"](#statuts-programmés))
- `?planlist` (alias `?pl`) — liste les tâches en attente
- `?plancancel <id>` (alias `?pc`) — annule une tâche
- `?planreset` — vide toutes les tâches

**Fuseau horaire** configurable dans `config.js` (défaut : `Africa/Porto-Novo`, UTC+1 Bénin).

**Tous les types de médias** sont supportés : texte, image, vidéo, audio. Il suffit de répondre au message voulu avec la commande.

### 🎬 Message de connexion (validé)
À chaque connexion / reconnexion, le bot t'envoie dans ta discussion perso :
- une **bannière image** (URL configurable, téléchargée à la volée, pas de fichier local)
- une **citation du haut** en italique
- le **cadre d'état** : propriétaire, numéro, personne réellement connectée, mode
- une **citation du bas** en italique

Tout est paramétrable dans `config.js` via `bootBannerUrl`, `bootQuotes`, `ownerName`, `ownerNumber` (voir [Configuration](#configuration)).

### 🤖 Chatbot IA (porté depuis [Chat-Bot-Dazi](https://github.com/dazbot-1/Chat-Bot-Dazi))
Répond **automatiquement** aux messages privés texte en imitant ta personnalité via **Gemini** (Google AI Studio, plan gratuit), **OpenRouter** ou **OpenAI**. Le bot tient un historique court par contact (10 derniers échanges), affiche un indicateur "composing", attend un délai réaliste (~40ms/char ±15%) puis envoie la réponse. En cas d'erreur API (crédits épuisés, clé invalide, etc.) l'owner reçoit une notification explicite dans sa DM.

- Désactivé par défaut : active avec `?dazai on`
- Personnalité = prompt système + description + 48 exemples de style dans `personality.json` (modifiable, rechargeable à chaud avec `?dazai reload`)
- Jamais de réponse sur : status, commandes, messages envoyés par toi-même
- Filtres : `aiAllowedNumbers` (whitelist) et `aiBlockedNumbers` (blacklist) dans `config.js`
- Groupes : désactivé par défaut (`aiRespondToGroups: false`)

Commandes :
- `?dazai` — état courant
- `?dazai on` / `?dazai off` — toggle
- `?dazai stats` — conversations/messages en mémoire, provider, modèle
- `?dazai clear` — reset historique de la conversation courante
- `?dazai clear all` — reset historique de tous les contacts
- `?dazai model <nom>` — change le modèle à chaud (ex: `openai/gpt-4o-mini`, `anthropic/claude-3.5-sonnet`)
- `?dazai reload` — recharge `personality.json` sans redémarrer

**Clé API** : mets l'une des trois clés suivantes dans un fichier `.env` à la racine du repo selon le provider choisi dans `config.aiProvider` :
- **Gemini** (défaut, gratuit) : `GEMINI_API_KEY=AIza...` → création sur https://aistudio.google.com/apikey (aucune carte requise, plan gratuit suffit)
- **OpenRouter** : `OPENROUTER_API_KEY=sk-or-...` → https://openrouter.ai/keys (créditer au moins 1$ sur https://openrouter.ai/settings/credits)
- **OpenAI** : `OPENAI_API_KEY=sk-...` → https://platform.openai.com/api-keys

### 👁️ Autre
- `?dazsticker` (réponse à un sticker) — téléchargement
- `?dazstats` — statistiques globales + TOP 5 des contacts
- `?dazreset` — désactive tous les focus d'un coup
- `?menu` / `?help` — menu complet

---

## 🚀 Installation locale

### Prérequis
- **Node.js** ≥ 20 (recommandé : dernière LTS)
- **npm** ou **pnpm**
- Un **numéro WhatsApp** actif pour lier le bot comme appareil secondaire

### Étapes

```bash
git clone https://github.com/dazbot-1/DazBot.git
cd DazBot
npm install
```

### Configuration

Édite `config.js` pour mettre au minimum :

```js
module.exports = {
    prefix: "?",                       // préfixe des commandes
    phoneNumber: "22947726871",        // TON numéro d'appairage (SANS le +)
    usePairingCode: true,              // pairing code au lieu du QR
    likeMyOwnStatus: true,
    reactionEmojis: ["❤️", "🔥", "😂", "👏", "💯"],
    autoReplyMessage: "",              // optionnel : msg privé après like
    whitelist: [],
    blacklist: [],
    timezone: "Africa/Porto-Novo",     // fuseau pour ?planstatus / ?planmsg

    // Message de connexion (envoyé en DM à chaque boot)
    sendWelcomeMessage: true,
    ownerName: "Daziano",              // nom affiché (fallback: pushName WA)
    ownerNumber: "22955724800",        // numéro owner affiché (peut différer du pairing)
    bootBannerUrl: "https://i.postimg.cc/rFR6bHgL/17762702118f23.png",
    bootQuotes: [                      // [0] = haut, [1] = bas
        "Et tout ça 🤒, c'est le destin 🫠🤲🧎",
        "St4y F0cuS, St4Y D3termi4t3 🫠🤲🧎"
    ],

    // Anti-Delete
    antiDeleteEnabled: true,
    antiDeleteChat: "",                // vide = DM perso (recommandé)

    // Chatbot IA (facultatif, nécessite une clé dans .env)
    aiAutoReply: false,                // active avec ?dazai on
    aiProvider: "gemini",              // "gemini" | "openrouter" | "openai"
    aiModel: "gemini-2.5-flash",       // ex. "gemini-2.5-pro", "openai/gpt-4o-mini", "gpt-4o-mini"...
    aiMaxContextMessages: 10,
    aiRespondToGroups: false,
    aiTypingDelayMsMin: 1000,
    aiTypingDelayMsMax: 4000,
    aiAllowedNumbers: [],              // vide = tous les contacts privés
    aiBlockedNumbers: []
};
```

**Variables d'environnement** (fichier `.env` à la racine, déjà dans `.gitignore`) :

```
# Par défaut (gratuit) : Google AI Studio
GEMINI_API_KEY=AIza...

# Ou OpenRouter (payant) :
# OPENROUTER_API_KEY=sk-or-v1-...

# Ou OpenAI direct (payant) :
# OPENAI_API_KEY=sk-...
# OPENAI_PROJECT_ID=proj_...
# OPENAI_ORG_ID=org-...
```

**Options clés du message de connexion :**
- `bootBannerUrl` : URL directe d'une image. Laisse vide pour envoyer uniquement le texte.
- `bootQuotes` : tableau, la 1re apparaît **au-dessus** du cadre, la 2e **en-dessous**. Ajoute-en autant que tu veux, seules les 2 premières sont utilisées.
- `ownerName` / `ownerNumber` : personnalisation de l'identité. Si `ownerName` est vide, le bot prend ton pushName WhatsApp. Si `ownerNumber` est vide, il prend le numéro appairé.
- `sendWelcomeMessage: false` pour couper complètement le message de boot.

### Premier démarrage (appairage)

```bash
npm start
```

Le bot va afficher un **Pairing Code à 8 caractères**. Sur ton téléphone :

1. Ouvre WhatsApp → **Paramètres** → **Appareils liés** → **Lier un appareil**
2. Choisis **Se connecter avec un numéro de téléphone**
3. Entre le code affiché par le bot

Une fois appairé, les clés sont stockées dans `auth_info_baileys/`. Le bot se reconnecte automatiquement aux prochains démarrages, **pas besoin de ré-appairer**.

---

## 📱 Commandes WhatsApp

Toutes les commandes se tapent soit **dans ta discussion avec toi-même** (Message à soi-même), soit dans n'importe quel chat où tu es présent — le bot n'écoute **que toi** (le `phoneNumber` configuré).

Préfixe par défaut : `?` (modifiable via `?setprefix !`).

| Commande | Rôle |
|---|---|
| `?dazstatus on/off` | Active/désactive les réactions globales aux statuts |
| `?dazstatusuni <emoji>` | Force un emoji fixe (ou `random` pour aléatoire) |
| `?dazonly add <num> [emoji]` | Focus Like : statut de ce num → emoji |
| `?dazonly remove/list/off` | Gestion liste focus |
| `?dazdiscrete add/remove/list <num>` | Focus Discret : vu sans emoji |
| `?dazview on/off` | Mode vu-seul global |
| `?dazantionly add/remove/list/off <num\|here>` | Focus Anti-Delete |
| `?antidelete on/off` | Toggle global anti-delete |
| `?dazvv on/off` | Capture Vue Unique globale ([voir limite](#vv--vue-unique)) |
| `?planstatus HH:MM` (alias `?ps`) | Programmer un statut ([voir limite](#statuts-programmés)) |
| `?planmsg HH:MM <num>` (alias `?pm`) | Programmer un message privé |
| `?planlist` / `?plancancel <id>` / `?planreset` | Gestion des tâches |
| `?dazreset` | Reset tous les focus |
| `?dazstats` | Statistiques du bot |
| `?setprefix <symbole>` | Changer le préfixe de commandes |
| `?dazai on/off` | Active/coupe le chatbot IA (auto-réponse aux DM) |
| `?dazai stats` / `clear [all]` / `model <nom>` / `reload` | Gestion du chatbot IA |
| `?menu` / `?help` | Menu complet |

**Format numéro :** indicatif pays + numéro sans `+` ni espaces (ex : `22955724800`).

**Format date :** `HH:MM` (aujourd'hui ou demain), `JJ/MM HH:MM` (cette année ou l'an prochain), ou `JJ/MM/AAAA HH:MM`.

---

## 🖥️ Déploiement serveur (production)

Le bot doit tourner **24/7** pour ne rater aucun statut/message. Voici plusieurs options.

### Option 1 : VPS Linux + PM2 (recommandé)

**Sur un VPS Ubuntu/Debian :**

```bash
# Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs git

# Clone + install
git clone https://github.com/dazbot-1/DazBot.git
cd DazBot
npm install

# PM2 pour gérer le process
sudo npm install -g pm2
pm2 start npm --name dazbot -- start
pm2 save
pm2 startup           # suis les instructions pour auto-start au boot
```

**Commandes utiles :**
```bash
pm2 logs dazbot       # voir les logs en direct
pm2 restart dazbot    # redémarrer
pm2 stop dazbot       # arrêter
pm2 monit             # dashboard
```

Premier démarrage : `pm2 logs dazbot` pour récupérer le Pairing Code et appairer ton téléphone.

### Option 2 : systemd (sans PM2)

Crée `/etc/systemd/system/dazbot.service` :

```ini
[Unit]
Description=DazBot WhatsApp Bot
After=network.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/home/ubuntu/DazBot
ExecStart=/usr/bin/npm start
Restart=always
RestartSec=10
StandardOutput=append:/var/log/dazbot.log
StandardError=append:/var/log/dazbot.log

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now dazbot
sudo journalctl -u dazbot -f      # logs
```

### Option 3 : Docker

Crée un `Dockerfile` à la racine :

```dockerfile
FROM node:20-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
EXPOSE 3000
CMD ["npm", "start"]
```

Build et run :
```bash
docker build -t dazbot .
docker run -d \
  --name dazbot \
  --restart unless-stopped \
  -v $(pwd)/auth_info_baileys:/app/auth_info_baileys \
  -v $(pwd)/scheduled_tasks.json:/app/scheduled_tasks.json \
  -p 3000:3000 \
  dazbot
docker logs -f dazbot    # récup le pairing code au 1er démarrage
```

**Volume obligatoire** pour `auth_info_baileys/` et `scheduled_tasks.json` sinon tu perds la session + les tâches à chaque rebuild.

### Option 4 : Render Free + Supabase (gratuit, recommandé pour un ami)

Render Free a deux pièges : il **endort** le service après 15 min d'inactivité, et son **filesystem est éphémère** (effacé à chaque redéploiement). Le bot intègre désormais ce qu'il faut pour contourner les deux : un endpoint HTTP `/` pour le keep-alive, et un backend de session **Supabase** (Postgres) qui remplace `auth_info_baileys/`.

**Étapes complètes (≈ 15 min) :**

**1. Créer un projet Supabase (stockage de session)**
- [supabase.com](https://supabase.com) → New Project (plan Free, 500 Mo gratuits)
- Une fois créé : **SQL Editor** → coller :
  ```sql
  CREATE TABLE whatsapp_auth (id text PRIMARY KEY, data jsonb);
  ```
- **Project Settings → API** : copier la `Project URL` et la `anon public key` (pas la `service_role`).

**2. Créer le service Render**
- [render.com](https://render.com) → New + → **Web Service** (pas Background Worker, on a besoin d'un endpoint HTTP)
- Connect au repo GitHub forké
- Runtime : `Node`, Build Command : `npm install`, Start Command : `node index.js`
- Plan : **Free**
- **Environment Variables** (toutes configurables sans toucher `config.js`) :
  | Variable | Valeur |
  |---|---|
  | `PHONE_NUMBER` | numéro WhatsApp à appairer, sans `+` (ex: `22912345678`) |
  | `OWNER_NUMBER` | numéro affiché dans la bannière (souvent identique à `PHONE_NUMBER`) |
  | `OWNER_NAME` | nom affiché dans la bannière (ex: `Jean`) |
  | `USE_PAIRING_CODE` | `true` (Pairing Code 8 chiffres) ou `false` (QR) |
  | `GEMINI_API_KEY` | clé Gemini (https://aistudio.google.com/apikey) |
  | `SUPABASE_URL` | URL Supabase de l'étape 1 |
  | `SUPABASE_KEY` | anon key Supabase de l'étape 1 |
  | `BOT_ID` | identifiant unique pour cette instance, ex: `ami_jean` (voir multi-bot ci-dessous) |
  | `RENDER_URL` | l'URL du service Render (visible après création, ex: `https://mon-bot.onrender.com`) |
  | `TZ` | `Africa/Porto-Novo` (ou autre fuseau local) |

**3. Premier démarrage (appairage)**

Deux méthodes possibles :

**a) Via la page web `/pair` (recommandé pour un ami)**
- Ouvre l'URL : `https://mon-bot.onrender.com/pair?key=<PAIR_PASSWORD>` (env var optionnelle pour protéger la page).
- Saisir le numéro WhatsApp + choisir **QR Code** (à scanner) ou **Pairing Code** (8 chiffres à taper dans WhatsApp).
- Page bascule sur ✅ "Connecté" dès que le pairing réussit.
- Tu peux envoyer le lien à l'ami pour qu'il fasse le pairing tout seul depuis son navigateur.

**b) Via les logs Render (méthode historique)**
- Onglet **Logs** Render → chercher `[ACTION REQUIRED] Your Pairing Code: XXXX-XXXX`.
- Sur le téléphone de l'ami : WhatsApp → Appareils liés → Lier un appareil avec un numéro → entrer le code.

Une fois pairé, la session est sauvée dans Supabase, plus aucun re-pairing nécessaire — même après redéploiement / restart Render.

**4. Configurer le keep-alive externe (anti-sleep)**
Le bot s'auto-ping déjà toutes les 5 min via `RENDER_URL`, mais Render Free dort si **aucun trafic externe** ne tape l'endpoint. Ajouter un monitor gratuit :
- [UptimeRobot](https://uptimerobot.com) → New Monitor → HTTP(s)
- URL : `https://mon-bot.onrender.com/`
- Interval : **5 min** (le minimum gratuit)

**Limites du Free tier Render :**
- 750h cumulées par mois (≈ 31 jours, donc tout juste si le bot tourne 24/7).
- Cold start de ~30 s après un sleep — d'où l'importance du ping externe.
- Si tu dépasses, le service reste off jusqu'au mois suivant.

### Multi-bot dans un seul Supabase (un par ami)

Pour héberger plusieurs instances (toi + tes amis) en partageant **un seul** projet Supabase, il suffit de donner à chaque instance un `BOT_ID` différent. Toutes les clés de session sont préfixées par `<BOT_ID>:` dans la table `whatsapp_auth`, donc les sessions ne se mélangent pas.

| Instance | BOT_ID | Lignes Supabase |
|---|---|---|
| Toi | `daziano` | `daziano:creds`, `daziano:pre-key-1`, … |
| Ami 1 | `ami_jean` | `ami_jean:creds`, `ami_jean:pre-key-1`, … |
| Ami 2 | `ami_marie` | `ami_marie:creds`, … |

**Workflow pour ajouter un ami (5 min par ami, sans rien push) :**
1. Sur Render → New Web Service pointant sur le même repo (jamais besoin de fork).
2. Env vars du nouveau service :
   - `PHONE_NUMBER` = numéro de l'ami (ex: `22912345678`)
   - `OWNER_NUMBER` = pareil
   - `OWNER_NAME` = nom de l'ami
   - `BOT_ID` = identifiant unique pour cet ami (ex: `ami_jean`)
   - `SUPABASE_URL` / `SUPABASE_KEY` = TES credentials (toujours les mêmes pour tous les amis)
   - `RENDER_URL` = l'URL de CE service Render (donc différente par ami)
   - `GEMINI_API_KEY`, `TZ`, `USE_PAIRING_CODE=true`
3. Render déploie automatiquement. Logs → Pairing Code → tu le donnes à l'ami → il lie l'appareil dans WhatsApp.
4. Session sauvée dans Supabase sous `ami_jean:creds`, `ami_jean:pre-key-1`, etc.
5. UptimeRobot → 1 monitor par URL Render, ping 5 min.

Comme tout est dans les env vars, **tu n'as jamais besoin de toucher `config.js` ni de push** pour ajouter un ami. Un seul repo, N services Render avec leurs env vars.

**Quotas Supabase Free** : 500 Mo storage, ≈ 500 sessions max (chaque session pèse < 1 Mo). Bandwidth 5 Go/mois (~10 amis actifs en simultané, à surveiller au-delà).

### Option 5 : Railway / Fly.io

Railway (5 $/mois minimum depuis 2023) et Fly.io (free tier limité, carte bancaire requise) sont des alternatives. Configuration similaire à Render :
- Variables d'env identiques (`SUPABASE_URL`, `SUPABASE_KEY`, etc.)
- Persistent volume sur `/app/auth_info_baileys` si tu préfères les fichiers locaux à Supabase

### Prérequis communs

- **Volume persistant** : `auth_info_baileys/` (session WhatsApp, chiffrée) + `scheduled_tasks.json` (tâches programmées) doivent survivre aux redémarrages.
- **RAM** : ~150-250 MB en idle, jusqu'à 400 MB pendant les syncs. Un VPS 1 GB suffit largement.
- **Réseau sortant** : WhatsApp sur ports 443/5222. Pas de port entrant requis (le bot est client).
- **Pas de port 3000 public** : il n'y a pas d'interface web, garde-le en local.

---

## 🚫 Limites connues (WhatsApp)

Deux fonctionnalités ont été **explicitement abandonnées** après tests exhaustifs parce qu'il s'agit de limites côté **serveurs WhatsApp**, pas de bugs du bot.

### VV — Vue Unique

La commande `?dazvv on/off` est disponible mais **WhatsApp ne livre pas systématiquement le contenu des VV aux appareils liés** (linked devices). C'est une restriction serveur intentionnelle : les VV sont conçues pour rester sur l'appareil principal. Dans les logs tu verras `timed out waiting for message` sans que le payload arrive jamais. Aucun patch Baileys connu ne contourne ça de façon fiable (les tentatives se font bannir). La commande reste présente au cas où WhatsApp change sa politique.

### Statuts programmés

`?planstatus` fonctionne : le statut est bien publié et **tes contacts le voient** dans leur feed "Mises à jour". **Mais ton propre téléphone ne l'affiche pas dans "Mes statuts"** — c'est une limite du multi-device WhatsApp (les statuts postés depuis un linked device ne sont pas re-synchronisés dans le feed local du mobile).

**Compensation automatique :** après chaque statut programmé, le bot t'envoie en DM privée une **copie du contenu** avec `📤 Statut publié à HH:MM` pour que tu aies toujours une trace visible.

---

## 🛠️ Dépannage

**Le bot demande un Pairing Code à chaque démarrage :**
- Vérifie que `auth_info_baileys/` est bien persisté entre les restarts (volume Docker, disque Render, etc.)
- S'il est vide ou corrompu, ré-appaire une seule fois, il se reconnectera ensuite tout seul.

**Les statuts ne sont pas likés :**
- Vérifie `?dazstatus` → `🟢 ACTIVÉ`
- Vérifie `?dazview off` (le mode vu-seul bloque les likes)
- Vérifie `?dazonly list` → si non vide, le bot ne like que cette liste

**Les messages programmés ne partent pas :**
- Fuseau horaire dans `config.js` doit correspondre à ton pays
- Regarde les logs : `[SCHEDULER] Exécution de la tâche #X` doit apparaître
- `?planlist` pour vérifier qu'elle est bien enregistrée

**Erreur `received error in ack error: 400` :**
- Liste de destinataires malformée ou vide — le bot filtre automatiquement les LIDs non-résolus depuis PR #3

**Session corrompue / déconnexions répétées :**
- Stoppe le bot, supprime `auth_info_baileys/`, relance et ré-appaire
- Vérifie que ton téléphone est bien connecté à internet (le linked device suit son état)

---

## 📦 Fichiers importants

| Fichier | Rôle |
|---|---|
| `index.js` | Point d'entrée + handlers de messages |
| `config.js` | Configuration (numéro, emojis, fuseau) |
| `scheduler.js` | Planificateur (parse date, persistance, exécution) |
| `antidelete.js` | Détection + rapport des messages supprimés |
| `auth_info_baileys/` | Clés de session WhatsApp (NE PAS COMMIT) |
| `scheduled_tasks.json` | Tâches programmées persistées |

---

## 🔒 Sécurité

- Les clés Signal (`auth_info_baileys/`) sont chiffrées de bout-en-bout par WhatsApp.
- **Ne commit jamais `auth_info_baileys/` ni `config.js` avec ton vrai numéro** sur un repo public.
- Le bot n'écoute que les commandes du `phoneNumber` configuré — impossible qu'un tiers le pilote.
- Les messages supprimés récupérés ne sont **jamais** renvoyés dans le chat d'origine, uniquement dans ta DM perso.

---

**Développé en Node.js + [Baileys v7](https://github.com/WhiskeySockets/Baileys). © 2025 DazBot by Daz.**
