// api/index.js
// Node 18+ (ESM). Exporta um handler serverless.
// Opcionalmente reescreve a resposta com OpenAI, mas SEM inventar nada.

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || null;

// Cache em memória (sobrevive entre invocações em serverless)
let CACHE = { products: [], lastScrape: 0 };

// Páginas públicas para raspagem
const BASE = 'https://diravena.com';
const LISTING_URLS = [
    `${BASE}/`,
    `${BASE}/collections/mais-vendidos`,
    `${BASE}/collections/mais-vendidos?page=2`,
    `${BASE}/collections/mais-vendidos?page=3`,
];

export default async function handler(req, res) {
    // CORS básico
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

            // Resposta curta/determinística (sem IA)
            const baseline = makeDeterministicAnswer(question, matches);

            // Opcional: reescrever com IA (sem adicionar fatos)
            let answer = baseline;
            if (OPENAI_API_KEY && matches.length) {
                try { answer = await llmRewrite(baseline, question); } catch {}
            }

            return json(res, {
                answer,
                matches,              // base factual usada (para debug/telemetria)
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

/* ========================= Coleta e parsing ========================= */

async function ensureCatalog(force = false) {
    const MAX_AGE_MS = 60 * 60 * 1000; // 1h
    const stale = Date.now() - CACHE.lastScrape > MAX_AGE_MS;
    if (!force && CACHE.products.length && !stale) return;

    const found = new Map(); // url -> {name, price, url}

    // 1) Coleta links/nome das listagens
    for (const url of LISTING_URLS) {
        try {
            const html = await fetchText(url);
            const fromList = extractFromListing(html);
            for (const p of fromList) found.set(p.url, p);
        } catch (e) {
            console.warn('Falha ao ler listagem', url, e?.message);
        }
    }

    // 2) Completa com preço CONFIÁVEL pegando a página do produto (metatags)
    const urls = [...found.values()].map(p => p.url);
    const limit = 6; // concorrência
    for (let i = 0; i < urls.length; i += limit) {
        await Promise.all(
            urls.slice(i, i + limit).map(async (u) => {
                try {
                    const html = await fetchText(u);
                    const det = extractFromProductPage(html, u);
                    const base = found.get(u);
                    if (det?.name) base.name = det.name;
                    if (det?.price) base.price = det.price;
                } catch {}
            })
        );
    }

    CACHE.products = [...found.values()]
        .filter(p => p.name && p.price)
        .map(p => ({
            ...p,
            priceValue: toNumberBRL(p.price.replace('R$','').trim()),
            normName: normalize(p.name),
        }));
    CACHE.lastScrape = Date.now();
}

async function fetchText(url) {
    const r = await fetch(url, {
        headers: { 'user-agent': 'Mozilla/5.0; StarmindBot/1.0' },
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

/* -------- Listagem: obtém nome+link (preço vem da página do produto) -------- */
function extractFromListing(html) {
    const out = [];
    const reA = /<a\s+[^>]*href="(\/products\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    let m;
    while ((m = reA.exec(html))) {
        const href = m[1];
        const block = innerText(m[2]);
        let name = block
            .replace(/\b\d+\s*x\s*R\$\s*[\d\.,]+\b/gi, '') // remove “10x R$ …”
            .replace(/\s+PROMO(ÇÃO)?!?\s*/gi, ' ')
            .split(/—|\|/)[0]
            .trim();
        if (!name) continue;
        const url = new URL(href, BASE).toString();
        out.push({ name, price: null, url });
    }
    return out;
}

/* -------- Produto: pega preço por metatag (og:price/product:price), fallback robusto -------- */
function extractFromProductPage(html, url) {
    // Nome
    const name =
        (/<meta[^>]+property="og:title"[^>]+content="([^"]+)"/i.exec(html)?.[1]) ||
        (/<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html)?.[1]?.replace(/<[^>]+>/g, '').trim()) ||
        null;

    // 1) Meta
    let priceNum = null;
    let m =
        /<meta[^>]+property="og:price:amount"[^>]+content="([\d\.]+)"/i.exec(html) ||
        /<meta[^>]+property="product:price:amount"[^>]+content="([\d\.]+)"/i.exec(html);
    if (m) priceNum = Number(m[1]);

    // 2) Fallback: captura "R$ xx,xx" ignorando parcelas ("10x R$ …")
    if (!priceNum) {
        const text = innerText(html);
        const candidates = [];
        const re = /R\$\s*([\d\.]{1,3}(?:\.\d{3})*,\d{2})/gi;
        let pm;
        while ((pm = re.exec(text))) {
            const before = text.slice(Math.max(0, pm.index - 8), pm.index).toLowerCase();
            const isInstallment = /\b\d+\s*x\s*$/i.test(before) || /\b\d+x\s*$/i.test(before);
            if (isInstallment) continue; // ignora “10x R$…”
            const val = toNumberBRL(pm[1]);
            if (val) candidates.push(val);
        }
        if (candidates.length) priceNum = Math.max(...candidates); // tende a ser o preço cheio
    }

    const price = priceNum ? fromNumberToBRL(priceNum) : null;
    return { name, price, url };
}

/* ========================= Busca e resposta ========================= */

function normalize(s) {
    return (s || '')
        .toLowerCase()
        .normalize('NFD').replace(/\p{Diacritic}/gu, '')
        .replace(/[^a-z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

const PT_STOP = new Set([
    'o','a','os','as','um','uma','de','da','do','das','dos','que','qual','quais','quanto','quanta',
    'cust','custa','custam','preco','preço','tem','e','ou'
]);

const HARD_FILTERS = ['sapatenis','mocatenis','mocassim','bota','sandalia','tenis'];
const SYN = new Map([
    ['sapatenis','sapatennis'],
    ['mocatenis','mocatennis'],
]);

function findMatches(question, catalog) {
    const qn = normalize(question);
    const toks = qn.split(' ').filter(t => t && !PT_STOP.has(t));
    if (!toks.length) return [];
    const hard = HARD_FILTERS.find(h => qn.includes(h));

    function score(p) {
        let s = 0;
        for (const t of toks) {
            const t2 = SYN.get(t) || t;
            if (p.normName.includes(t)) s += 2;
            if (t2 !== t && p.normName.includes(t2)) s += 1;
        }
        return s;
    }

    let ranked = catalog
        .map(p => ({ ...p, _score: score(p) }))
        .filter(p => p._score > 0);

    // Se citou categoria, aplica filtro duro
    if (hard) {
        ranked = ranked.filter(p => {
            const alt = SYN.get(hard) || hard;
            return p.normName.includes(hard) || p.normName.includes(alt);
        });
    }

    ranked.sort((a,b) => b._score - a._score || (a.priceValue ?? 1e9) - (b.priceValue ?? 1e9));
    return ranked.slice(0, 5).map(({_score, normName, priceValue, ...rest}) => rest);
}

function makeDeterministicAnswer(question, matches) {
    if (!matches.length) return 'Não achei esse item no catálogo público da diRavena agora.';

    const asksPrice = /quanto|preco|preço|custa|custam/i.test(question);
    const cheapest = matches.reduce((a,b) => (a.priceValue < b.priceValue ? a : b));

    if (asksPrice) {
        // Resposta curta e direta
        return [
            'Encontrei algumas opções. A mais barata é:',
            `${cheapest.name} — ${cheapest.price}`,
            cheapest.url
        ].join('\n');
    }

    return [
        `Encontrei ${matches.length} opções (mostrando até 3):`,
        ...matches.slice(0,3).map(m => `${m.name} — ${m.price}\n${m.url}`)
    ].join('\n');
}

/* ========================= IA opcional (rephrase) ========================= */

async function llmRewrite(baseline, question) {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
            authorization: `Bearer ${OPENAI_API_KEY}`,
            'content-type': 'application/json',
        },
        body: JSON.stringify({
            model: 'gpt-4o-mini',
            temperature: 0.2,
            messages: [
                { role: 'system', content: 'Responda em PT-BR, de forma curta e só com o conteúdo fornecido. Não invente.' },
                { role: 'user', content: `PERGUNTA: ${question}\n\nRESPOSTA_BASE:\n${baseline}` },
            ],
        }),
    });
    if (!r.ok) throw new Error(`OpenAI HTTP ${r.status}`);
    const j = await r.json();
    return j?.choices?.[0]?.message?.content?.trim() || baseline;
}

/* ========================= Utils ========================= */

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

function toNumberBRL(s) {
    if (!s) return null;
    const n = String(s).replace(/\./g, '').replace(',', '.');
    const v = Number(n);
    return Number.isFinite(v) ? v : null;
}
function fromNumberToBRL(v) {
    return 'R$ ' + v.toFixed(2).replace('.', ',');
}

/* ========================= Dev server local (opcional) =========================
   Execute: node api/index.js
   Em produção (Vercel) esse bloco é ignorado.
--------------------------------------------------------------------------- */
if (import.meta.url === `file://${process.argv[1]}`) {
    const http = await import('http');
    const PORT = process.env.PORT || 3001;
    const server = http.createServer((req, res) => {
        const url = new URL(req.url, `http://localhost:${PORT}`);
        if (url.pathname === '/' || url.pathname === '/api/index') {
            return handler(req, res);
        }
        res.statusCode = 404;
        res.end('Not found');
    });
    server.listen(PORT, () => {
        console.log(`Dev server ON em http://localhost:${PORT} (rota /api/index)`);
    });
}
