/*
 * aiService.js — wrapper OpenRouter / OpenAI pour le chatbot IA intégré à DazBot.
 *
 * Porté depuis dazbot-1/Chat-Bot-Dazi (src/services/openaiService.js) :
 *   - Compatibilité OpenRouter ET OpenAI (même API /chat/completions).
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
    constructor(config) {
        this.config = config;
        const provider = (config.aiProvider || 'openrouter').toLowerCase();

        if (provider === 'openrouter') {
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
        this.history = new Map();
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
        return (
            this.config.aiModel ||
            (this.provider === 'openrouter'
                ? 'openai/gpt-4o-mini'
                : 'gpt-4o-mini')
        );
    }

    async generateReply(conversationId, incomingMessage) {
        const maxContextMessages = Number(this.config.aiMaxContextMessages || 10);

        let history = this.history.get(conversationId) || [];
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
            presence_penalty: 0.3,
            frequency_penalty: 0.3,
        };

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
