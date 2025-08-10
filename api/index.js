// api/index.js
// Runtime: Node 18+ (Vercel Serverless Function, arquivo único)

// Opcional: reescrita "mais natural" com IA usando os dados raspados
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || null;

// Cache em memória entre invocações
let CACHE = { products: [], lastScrape: 0 };

// URLs alvo (páginas públicas)
const BASE = 'https://diravena.com';
const LISTING_URLS = [
    `${BASE}/`,
    `${BASE}/collections/mais-vendidos`,
    `${BASE}/collections/mais-vendidos?page=2`,
    `${BASE}/collections/mais-vendidos?page=3`,
];

export default async function handler(req, res) {
    // CORS básico para permitir servir o front estático
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'content-type,authorization');
    if (req.method === 'OPTIONS') return res.status(204).end();

    try {
        if (req.method === 'GET') {
            // GET /api/index?refresh=1 -> força nova raspagem
            const force = /(?:\?|&)refresh=1\b/.test(req.url || '');
            await ensureCatalog(force);
            return json(res, {
                ok: true,
                count: CACHE.products.length,
                updatedAt: CACHE.lastScrape,
            });
        }

        if (req.method === 'POST') {
            const body = await readJson(req);
            const question = String(body?.question || '').trim();
            if (!question) return json(res, { error: 'Pergunta vazia.' }, 400);

            await ensureCatalog(false);
            const matches = findMatches(question, CACHE.products);

            // Resposta "determinística": usa apenas os dados encontrados
            const baseline = makeDeterministicAnswer(question, matches);

            // Se houver chave OpenAI, pedir para reescrever de forma mais natural SEM adicionar nada
            let answer = baseline;
            if (OPENAI_API_KEY && matches.length) {
                try {
                    answer = await llmRewrite(baseline, question, matches);
                } catch {
                    // Falhou? segue com baseline
                }
            }

            return json(res, {
                answer,
                matches,              // Top itens usados como base
                updatedAt: CACHE.lastScrape,
            });
        }

        res.statusCode = 405;
        res.end('Method Not Allowed');
    } catch (e) {
        console.error(e);
        json(res, { error: 'Erro interno.' }, 500);
    }
}

/* -------------------- Coleta e parsing -------------------- */

async function ensureCatalog(force = false) {
    const MAX_AGE_MS = 60 * 60 * 1000; // 1h
    const stale = Date.now() - CACHE.lastScrape > MAX_AGE_MS;
    if (!force && CACHE.products.length && !stale) return;

    const found = new Map(); // url -> {name, price, url}
    for (const url of LISTING_URLS) {
        try {
            const html = await fetchText(url);
            const fromList = extractFromListing(html, url);
            for (const p of fromList) found.set(p.url, p);
        } catch (e) {
            console.warn('Falha ao ler listagem', url, e?.message);
        }
    }

    // Preenche preços que faltaram, consultando página do produto (limite para não estourar tempo)
    const needDetails = [...found.values()].filter(p => !p.price).slice(0, 15);
    await Promise.all(
        needDetails.map(async (p) => {
            try {
                const html = await fetchText(p.url);
                const det = extractFromProductPage(html, p.url);
                if (det?.price) p.price = det.price;
                if (det?.name) p.name = det.name;
            } catch {}
        })
    );

    CACHE.products = [...found.values()]
        .filter(p => p.name && p.price)
        .map(p => ({ ...p, priceValue: parsePrice(p.price), normName: normalize(p.name) }));
    CACHE.lastScrape = Date.now();
}

async function fetchText(url) {
    const r = await fetch(url, {
        headers: { 'user-agent': 'Mozilla/5.0; ChatBot/1.0 (+vercel)' },
    });
    if (!r.ok) throw new Error(`HTTP ${r.status} ao baixar ${url}`);
    return await r.text();
}

// Remove tags e condensa espaços
function innerText(html) {
    return html.replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

// Extrai itens de uma listagem (cards com link para /products/...)
function extractFromListing(html, pageUrl) {
    const out = [];
    const reA = /<a\s+[^>]*href="(\/products\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    let m;
    while ((m = reA.exec(html))) {
        const href = m[1];
        const block = innerText(m[2]);
        // Tentativa 1: nome " — Preço promocional R$ X"
        let priceMatch = /Preço\s+promocional\s*R\$\s*([\d\.,]+)/i.exec(block);
        let name = null;
        let price = null;

        if (priceMatch) {
            price = `R$ ${priceMatch[1]}`;
            // nome é o texto antes do "— Preço promocional"
            const idx = block.toLowerCase().lastIndexOf('preço promocional');
            if (idx > 0) {
                const before = block.slice(0, idx);
                // corta no travessão mais próximo se existir
                const dashIdx = before.lastIndexOf('—');
                name = (dashIdx >= 0 ? before.slice(0, dashIdx) : before).trim();
            }
        }

        // Se ainda sem nome, usa heurísticas: maior trecho de palavras no bloco
        if (!name) {
            const parts = block.split(/—|\|/).map(s => s.trim()).filter(Boolean);
            if (parts.length) name = parts[0];
        }

        // Monta URL absoluta
        const url = new URL(href, BASE).toString();
        if (name) out.push({ name, price, url });
    }
    return out;
}

// Extrai dados da página de produto
function extractFromProductPage(html, url) {
    const text = innerText(html);
    const name = (/<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html)?.[1] || '').replace(/<[^>]+>/g, '').trim()
        || (/^#\s*(.+)$/m.exec(text)?.[1] || '').trim()
        || null;
    const price = (/Preço\s+promocional\s*R\$\s*([\d\.,]+)/i.exec(text)?.[1])
        ? `R$ ${/Preço\s+promocional\s*R\$\s*([\d\.,]+)/i.exec(text)[1]}`
        : null;

    return { name, price, url };
}

function parsePrice(brl) {
    // "R$ 139,90" -> 139.90 (number)
    const m = /([\d\.,]+)/.exec(brl || '');
    if (!m) return null;
    const n = m[1].replace(/\./g, '').replace(',', '.');
    const v = Number(n);
    return Number.isFinite(v) ? v : null;
}

/* -------------------- Busca e resposta -------------------- */

function normalize(s) {
    return (s || '')
        .toLowerCase()
        .normalize('NFD').replace(/\p{Diacritic}/gu, '')
        .replace(/[^a-z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

const PT_STOP = new Set(['o','a','os','as','um','uma','de','da','do','das','dos','que','qual',
    'quais','quanto','quanta','cust','custa','custam','preco','preço','tem','e']);

function findMatches(question, catalog) {
    const qn = normalize(question);
    const toks = qn.split(' ').filter(t => t && !PT_STOP.has(t));
    if (!toks.length) return [];

    const synonyms = new Map([
        ['sapatenis','sapatennis'], // variações
        ['mocatenis','mocatennis'],
    ]);

    function score(p) {
        let s = 0;
        for (const t of toks) {
            const t2 = synonyms.get(t) || t;
            if (p.normName.includes(t)) s += 2;
            if (t2 !== t && p.normName.includes(t2)) s += 1;
        }
        // bônus por tokens "produto"
        if (/\b(sapatenis|mocatenis|mocassim|bota|sandalia|babydoll)\b/.test(qn)) {
            if (/\b(sapatenis|mocatenis|mocassim|bota|sandalia|babydoll)\b/.test(p.normName)) s += 1;
        }
        return s;
    }

    const ranked = catalog.map(p => ({ ...p, _score: score(p) }))
        .filter(p => p._score > 0)
        .sort((a,b) => b._score - a._score || (a.priceValue ?? 1e9) - (b.priceValue ?? 1e9));
    return ranked.slice(0, 5).map(({_score, normName, priceValue, ...rest}) => rest);
}

function makeDeterministicAnswer(question, matches) {
    if (!matches.length) {
        return 'Não encontrei esse item no catálogo público da diRavena agora. Tente outro termo ou peça para atualizar a busca.';
    }
    // Se a pergunta sugere "quanto custa", foque no preço
    const asksPrice = /quanto|preco|preço|custa|custam/i.test(question);
    if (asksPrice) {
        if (matches.length === 1) {
            const m = matches[0];
            return `O preço atual é ${m.price} para “${m.name}”. Link: ${m.url}`;
        } else {
            const min = matches.reduce((a,b) => (a.priceValue < b.priceValue ? a : b));
            const examples = matches.slice(0,3).map(m => `• ${m.name} — ${m.price}`).join('\n');
            return `Encontrei ${matches.length} opções. O menor preço entre elas é ${min.price}.\n${examples}\nLinks:\n${matches.slice(0,3).map(m=>`- ${m.url}`).join('\n')}`;
        }
    }
    // Outra pergunta: apenas listar correspondências
    return `Encontrei ${matches.length} item(ns) que combinam:\n${matches.slice(0,3).map(m => `• ${m.name} — ${m.price}\n  ${m.url}`).join('\n')}`;
}

/* -------------------- IA opcional para reescrever -------------------- */

async function llmRewrite(baseline, question, matches) {
    const content = [
        `PERGUNTA: ${question}`,
        `RESPOSTA_BASE (não invente nada além disso):`,
        baseline,
    ].join('\n\n');

    const r = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
            'authorization': `Bearer ${OPENAI_API_KEY}`,
            'content-type': 'application/json',
        },
        body: JSON.stringify({
            model: 'gpt-4o-mini',
            temperature: 0.2,
            messages: [
                { role: 'system', content: 'Você responde em PT-BR apenas com o conteúdo fornecido. Não invente nada. Seja direto.' },
                { role: 'user', content },
            ],
        }),
    });

    if (!r.ok) throw new Error(`OpenAI HTTP ${r.status}`);
    const j = await r.json();
    const out = j?.choices?.[0]?.message?.content?.trim();
    return out || baseline;
}

/* -------------------- util -------------------- */

function json(res, obj, status=200) {
    res.statusCode = status;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(obj));
}

function readJson(req) {
    return new Promise(resolve => {
        let data = '';
        req.on('data', chunk => (data += chunk));
        req.on('end', () => {
            try { resolve(JSON.parse(data || '{}')); }
            catch { resolve({}); }
        });
    });
}
