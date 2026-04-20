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
    phoneNumber: "22947726871",        // TON numéro complet SANS le +
    likeMyOwnStatus: true,
    reactionEmojis: ["❤️", "🔥", "😂", "👏", "💯"],
    autoReplyMessage: "",              // optionnel : msg privé après like
    whitelist: [],
    blacklist: [],
    timezone: "Africa/Porto-Novo"      // fuseau pour ?planstatus / ?planmsg
};
```

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

### Option 4 : Railway / Render / Fly.io

Plateformes PaaS avec auto-déploiement depuis GitHub.

**Railway :**
1. [railway.app](https://railway.app) → New Project → Deploy from GitHub Repo
2. Sélectionne `DazBot`
3. Variables d'env : aucune requise (config dans `config.js`)
4. Premier démarrage : regarde les logs pour le Pairing Code
5. **Volume persistant** : attache un volume sur `/app/auth_info_baileys` pour garder la session entre les restarts

**Render :**
Similaire, avec un "Background Worker" type et un Persistent Disk monté sur `/opt/render/project/src/auth_info_baileys`.

**⚠️ Free tiers** : certaines plateformes endorment les bots inactifs — vérifie que le plan choisi permet un process toujours up.

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
