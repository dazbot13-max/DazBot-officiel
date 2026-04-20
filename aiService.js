/*
 * aiService.js — wrapper OpenRouter / OpenAI / Gemini pour le chatbot IA
 * intégré à DazBot.
 *
 * Porté depuis dazbot-1/Chat-Bot-Dazi (src/services/openaiService.js) :
 *   - Compatibilité OpenRouter, OpenAI ET Gemini (Gemini expose un endpoint
 *     OpenAI-compatible : /v1beta/openai/chat/completions). Même code pour
 *     les 3 providers, seule la baseURL + l'auth change.
 *   - Historique par conversation en mémoire (Map, bornée par
 *     aiMaxContextMessages).
 *   - Prompt système = personality.json (systemPrompt + description +
 *     examples).
 *   - Pas de Supabase (volontairement retiré : on garde DazBot simple).
 *
 * Dépendances : axios (déjà présent dans package.json).
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');

const PERSONALITY_PATH = path.resolve(__dirname, 'personality.json');

function loadPersonality() {
    try {
        const raw = fs.readFileSync(PERSONALITY_PATH, 'utf8');
        const parsed = JSON.parse(raw);
        const p = parsed.personality || parsed || {};
        return {
            systemPrompt: p.systemPrompt || '',
            description: p.description || '',
            examples: Array.isArray(p.examples) ? p.examples : [],
        };
    } catch (e) {
        return { systemPrompt: '', description: '', examples: [] };
    }
}

class AIService {
    // opts.sharedHistory : Map partagée entre instances (permet de conserver
    // le contexte conversationnel quand on bascule sur un provider de fallback).
    constructor(config, opts = {}) {
        this.config = config;
        this._sharedHistory = opts.sharedHistory || null;
        // Défaut = 'gemini' pour rester cohérent avec envKeyForProvider() côté
        // index.js (message d'erreur qui dit "ajoute GEMINI_API_KEY"). Avant
        // c'était 'openrouter' → incohérence signalée par Devin Review.
        const provider = (config.aiProvider || 'gemini').toLowerCase();

        if (provider === 'gemini') {
            const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
            if (!apiKey) {
                throw new Error('GEMINI_API_KEY manquante dans l\'environnement.');
            }
            this.apiKey = apiKey;
            // Gemini expose un endpoint compatible OpenAI : même schema
            // /chat/completions, donc on réutilise le même code que pour
            // OpenRouter / OpenAI.
            this.baseURL = process.env.GEMINI_BASE_URL
                || 'https://generativelanguage.googleapis.com/v1beta/openai';
            this.extraHeaders = {};
            this.provider = 'gemini';
        } else if (provider === 'groq') {
            const apiKey = process.env.GROQ_API_KEY;
            if (!apiKey) {
                throw new Error('GROQ_API_KEY manquante dans l\'environnement.');
            }
            this.apiKey = apiKey;
            // Groq expose un endpoint OpenAI-compat : /openai/v1/chat/completions
            this.baseURL = process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1';
            this.extraHeaders = {};
            this.provider = 'groq';
        } else if (provider === 'cerebras') {
            const apiKey = process.env.CEREBRAS_API_KEY;
            if (!apiKey) {
                throw new Error('CEREBRAS_API_KEY manquante dans l\'environnement.');
            }
            this.apiKey = apiKey;
            // Cerebras expose un endpoint OpenAI-compat : /v1/chat/completions
            this.baseURL = process.env.CEREBRAS_BASE_URL || 'https://api.cerebras.ai/v1';
            this.extraHeaders = {};
            this.provider = 'cerebras';
        } else if (provider === 'openrouter') {
            const apiKey = process.env.OPENROUTER_API_KEY;
            if (!apiKey) {
                throw new Error('OPENROUTER_API_KEY manquante dans l\'environnement.');
            }
            this.apiKey = apiKey;
            this.baseURL = process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1';
            this.extraHeaders = {
                'HTTP-Referer': process.env.OPENROUTER_HTTP_REFERER || 'https://github.com/dazbot-1/DazBot',
                'X-Title': process.env.OPENROUTER_X_TITLE || 'DazBot',
            };
            this.provider = 'openrouter';
        } else {
            const apiKey = process.env.OPENAI_API_KEY;
            if (!apiKey) {
                throw new Error('OPENAI_API_KEY manquante dans l\'environnement.');
            }
            this.apiKey = apiKey;
            this.baseURL = 'https://api.openai.com/v1';
            this.extraHeaders = {};
            const project = process.env.OPENAI_PROJECT_ID;
            const organization = process.env.OPENAI_ORG_ID;
            if (project) this.extraHeaders['OpenAI-Project'] = project;
            if (organization) this.extraHeaders['OpenAI-Organization'] = organization;
            this.provider = 'openai';
        }

        // Historique par conversation : Map<conversationId, [{role, content}]>
        // Si un `sharedHistory` a été fourni par le host, on l'utilise pour que
        // tous les providers d'un pool voient le même contexte → la bascule de
        // fallback ne casse pas la continuité conversationnelle.
        this.history = this._sharedHistory || new Map();
        this.personality = loadPersonality();
    }

    reloadPersonality() {
        this.personality = loadPersonality();
    }

    _buildSystemMessages() {
        const { systemPrompt, description, examples } = this.personality;
        const exampleLines = (examples || []).map(
            (ex) => `Utilisateur: "${ex.user}" → Toi: "${ex.assistant}"`,
        );
        const content = [
            systemPrompt,
            '',
            description,
            '',
            'Exemples de style :',
            exampleLines.join('\n'),
        ].join('\n');
        return [{ role: 'system', content }];
    }

    _currentModel() {
        if (this.config.aiModel) return this.config.aiModel;
        if (this.provider === 'gemini') return 'gemini-2.5-flash-lite';
        if (this.provider === 'groq') return 'llama-3.3-70b-versatile';
        if (this.provider === 'cerebras') return 'llama3.1-8b'; // dispo sur free tier (vérifié via /v1/models)
        if (this.provider === 'openrouter') return 'openai/gpt-4o-mini';
        return 'gpt-4o-mini';
    }

    async generateReply(conversationId, incomingMessage) {
        const maxContextMessages = Number(this.config.aiMaxContextMessages || 10);

        // Copie défensive : on ne mute pas l'historique stocké tant que l'appel
        // API n'a pas réussi, sinon un échec laisse un message utilisateur
        // orphelin (sans réponse assistant) dans l'historique persistant —
        // la prochaine requête verrait alors deux user successifs, ce qui
        // dégrade les réponses.
        let history = [...(this.history.get(conversationId) || [])];
        history.push({ role: 'user', content: incomingMessage });

        const maxEntries = maxContextMessages * 2;
        if (history.length > maxEntries) history = history.slice(-maxEntries);

        const messages = [...this._buildSystemMessages(), ...history];

        const url = `${this.baseURL}/chat/completions`;
        const body = {
            model: this._currentModel(),
            messages,
            temperature: 0.8,
            max_tokens: 250,
        };
        // presence_penalty / frequency_penalty ne sont pas supportés par
        // l'endpoint OpenAI-compat de Gemini ni par Cerebras (HTTP 400).
        // Groq les accepte mais on reste défensif : on ne les met que pour
        // OpenRouter / OpenAI qui les gèrent correctement.
        if (this.provider === 'openrouter' || this.provider === 'openai') {
            body.presence_penalty = 0.3;
            body.frequency_penalty = 0.3;
        }

        // Retry sur 429 / 503 (surcharge provider, surtout Gemini free tier
        // qui renvoie "This model is currently experiencing high demand"
        // ~30-50% du temps). Backoff exponentiel : 1s, 2s, 4s. On ne retry
        // PAS 401/402/403 (erreurs persistantes, re-essayer ne sert à rien).
        const RETRYABLE = new Set([429, 503]);
        const MAX_ATTEMPTS = 3;
        let lastErr = null;
        try {
            for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
                try {
                    const resp = await axios.post(url, body, {
                        headers: {
                            Authorization: `Bearer ${this.apiKey}`,
                            'Content-Type': 'application/json',
                            ...this.extraHeaders,
                        },
                        timeout: 30000,
                    });

                    const reply = resp?.data?.choices?.[0]?.message?.content?.trim();
                    if (!reply) throw new Error('Réponse IA vide.');

                    history.push({ role: 'assistant', content: reply });
                    this.history.set(conversationId, history);
                    return reply;
                } catch (err) {
                    lastErr = err;
                    const status = err?.response?.status;
                    if (!RETRYABLE.has(status) || attempt === MAX_ATTEMPTS) throw err;
                    const waitMs = 1000 * Math.pow(2, attempt - 1);
                    console.log(`[AI] Retry ${attempt}/${MAX_ATTEMPTS - 1} dans ${waitMs}ms (status ${status}).`);
                    await new Promise((r) => setTimeout(r, waitMs));
                }
            }
            throw lastErr;
        } catch (err) {
            const status = err?.response?.status;
            const code = err?.code;
            const detail = err?.response?.data?.error?.message || err?.message;
            console.error(
                '[AI] Erreur requête :',
                [status ? `status=${status}` : null, code ? `code=${code}` : null, detail]
                    .filter(Boolean)
                    .join(' '),
            );
            const e = new Error(detail || 'AI request failed');
            e.status = status;
            e.code = code;
            e.aiError = true;
            throw e;
        }
    }

    clearHistory(conversationId) {
        if (conversationId) {
            this.history.delete(conversationId);
        } else {
            this.history.clear();
        }
    }

    // Supprime toutes les entrées d'historique dont la clé commence par le
    // préfixe donné. Utile pour les groupes : l'historique y est stocké sous
    // `${groupJid}:${participantJid}` — un simple `clearHistory(groupJid)` ne
    // matcherait aucune clé. `clearHistoryByPrefix(groupJid + ':')` (ou juste
    // `groupJid`) efface tous les threads du groupe d'un coup.
    clearHistoryByPrefix(prefix) {
        if (!prefix) return 0;
        let count = 0;
        for (const key of this.history.keys()) {
            if (key === prefix || key.startsWith(prefix + ':')) {
                this.history.delete(key);
                count++;
            }
        }
        return count;
    }

    getStats() {
        const totalMessages = Array.from(this.history.values()).reduce(
            (acc, h) => acc + h.length,
            0,
        );
        return {
            provider: this.provider,
            model: this._currentModel(),
            activeConversations: this.history.size,
            totalMessages,
        };
    }
}

module.exports = AIService;
