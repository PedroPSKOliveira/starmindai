const OPENAI_API_KEY = process.env.OPENAI_API_KEY || null;

let CACHE = { products: [], lastScrape: 0 };

const BASE = 'https://diravena.com';
const LISTING_URLS = [
    `${BASE}/`,
    `${BASE}/collections/mais-vendidos`,
    `${BASE}/collections/mais-vendidos?page=2`,
    `${BASE}/collections/mais-vendidos?page=3`,
];

export default async function handler(req, res) {
    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'content-type,authorization');
    if (req.method === 'OPTIONS') return res.status(204).end();

    try {
        if (req.method === 'GET') {
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
            const baseline = makeDeterministicAnswer(question, matches);

            let answer = baseline;
            if (OPENAI_API_KEY && matches.length) {
                try { answer = await llmRewrite(baseline, question); } catch {}
            }

            return json(res, { answer, matches, updatedAt: CACHE.lastScrape });
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

    const found = new Map();

    // 1) Listagens: nome + URL
    for (const url of LISTING_URLS) {
        try {
            const html = await fetchText(url);
            for (const p of extractFromListing(html)) {
                found.set(p.url, p);
            }
        } catch (e) {
            console.warn('Falha ao ler listagem', url, e?.message);
        }
    }

    const urls = [...found.values()].map(p => p.url);
    const limit = 6;
    for (let i = 0; i < urls.length; i += limit) {
        await Promise.all(
            urls.slice(i, i + limit).map(async (u) => {
                try {
                    const html = await fetchText(u);
                    const det = extractFromProductPage(html, u);
                    const base = found.get(u);
                    if (det?.name) base.name = det.name;
                    if (det?.price) base.price = det.price;
                    if (det?.priceNum != null) base.priceValue = det.priceNum;
                } catch {}
            })
        );
    }

    CACHE.products = [...found.values()]
        .filter(p => p.name && (p.priceValue != null))
        .map(p => ({
            ...p,
            price: p.price ?? fromNumberToBRL(p.priceValue),
            priceValue: p.priceValue ?? toNumberBRL(String(p.price).replace('R$','').trim()),
            normName: normalize(p.name),
        }));
    CACHE.lastScrape = Date.now();
}

async function fetchText(url) {
    const r = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0; StarmindBot/1.2' }});
    if (!r.ok) throw new Error(`HTTP ${r.status} ao baixar ${url}`);
    return await r.text();
}

function innerText(html) {
    return html.replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function extractFromListing(html) {
    const out = [];
    const reA = /<a\s+[^>]*href="(\/products\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    let m;
    while ((m = reA.exec(html))) {
        const href = m[1];
        const block = innerText(m[2]);
        let name = block
            .replace(/\b\d+\s*x\s*R\$\s*[\d\.,]+\b/gi, '') // ex.: 10x R$ 15,99
            .replace(/\b\d+\s*x\s*[\d\.,]+\b/gi, '')       // ex.: 10x 15,99 (sem R$)
            .replace(/\s+PROMO(ÇÃO)?!?\s*/gi, ' ')
            .split(/—|\|/)[0]
            .trim();
        if (!name) continue;
        const url = new URL(href, BASE).toString();
        out.push({ name, url });
    }
    return out;
}

function extractFromProductPage(html, url) {
    const name =
        (/<meta[^>]+property="og:title"[^>]+content="([^"]+)"/i.exec(html)?.[1]) ||
        (/<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html)?.[1]?.replace(/<[^>]+>/g, '').trim()) ||
        null;

    const saleCandidates = [];
    const generalCandidates = [];

    const reProductJson = /<script[^>]+type=["']application\/json["'][^>]*data-product-json[^>]*>([\s\S]*?)<\/script>/gi;
    let pj;
    while ((pj = reProductJson.exec(html))) {
        try {
            const j = JSON.parse(pj[1].trim());
            const variants = j?.product?.variants || j?.variants || [];
            for (const v of variants) {
                // preços vêm em centavos
                if (typeof v.price === 'number') saleCandidates.push(v.price / 100);
                if (typeof v.compare_at_price === 'number') generalCandidates.push(v.compare_at_price / 100);
            }
        } catch {}
    }

    const jsonldRe = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
    let jm;
    while ((jm = jsonldRe.exec(html))) {
        try {
            const parsed = JSON.parse(jm[1].trim());
            const nodes = Array.isArray(parsed) ? parsed : [parsed];
            for (const n of nodes) collectOfferPrices(n, saleCandidates, generalCandidates);
        } catch {}
    }

    for (const re of [
        /price-item--sale[\s\S]{0,200}?R\$\s*([\d\.\,]+)/gi,
        /price--on-sale[\s\S]{0,400}?R\$\s*([\d\.\,]+)/gi,
        /price__sale[\s\S]{0,400}?R\$\s*([\d\.\,]+)/gi,
    ]) {
        let m;
        while ((m = re.exec(html))) {
            const val = toNumberBRL(m[1]);
            if (val) saleCandidates.push(val);
        }
    }

    for (const re of [
        /<meta[^>]+property=["']og:price:amount["'][^>]+content=["']([\d\.,]+)["']/i,
        /<meta[^>]+property=["']product:price:amount["'][^>]+content=["']([\d\.,]+)["']/i,
    ]) {
        const mm = re.exec(html);
        if (mm) {
            const v = Number(String(mm[1]).replace(',', '.'));
            if (Number.isFinite(v)) generalCandidates.push(v);
        }
    }

    const text = innerText(html);
    const reBrl = /R\$\s*([\d\.]{1,3}(?:\.\d{3})*,\d{2})/gi;
    let pm;
    while ((pm = reBrl.exec(text))) {
        const before = text.slice(Math.max(0, pm.index - 8), pm.index).toLowerCase();
        const isInstallment = /\b\d+\s*x\s*$/i.test(before) || /\b\d+x\s*$/i.test(before);
        if (isInstallment) continue;
        const val = toNumberBRL(pm[1]);
        if (val) generalCandidates.push(val);
    }

    let priceNum = null;
    if (saleCandidates.length) priceNum = Math.min(...saleCandidates);
    else if (generalCandidates.length) priceNum = Math.min(...generalCandidates);

    const price = priceNum ? fromNumberToBRL(priceNum) : null;
    return { name, price, priceNum, url };
}

function collectOfferPrices(obj, saleOut, generalOut) {
    if (!obj || typeof obj !== 'object') return;

    if (obj.offers) {
        const offers = Array.isArray(obj.offers) ? obj.offers : [obj.offers];
        for (const ofr of offers) collectOfferPrices(ofr, saleOut, generalOut);
    }

    const nums = [];
    if (obj.price != null) nums.push({ v: Number(String(obj.price).replace(',', '.')), sale: false });
    if (obj.lowPrice != null) nums.push({ v: Number(String(obj.lowPrice).replace(',', '.')), sale: true });
    if (obj.highPrice != null) nums.push({ v: Number(String(obj.highPrice).replace(',', '.')), sale: false });

    for (const e of nums) if (Number.isFinite(e.v)) (e.sale ? saleOut : generalOut).push(e.v);

    for (const k in obj) {
        const v = obj[k];
        if (v && typeof v === 'object') collectOfferPrices(v, saleOut, generalOut);
    }
}


function normalize(s) {
    return (s || '')
        .toLowerCase()
        .normalize('NFD').replace(/\p{Diacritic}/gu, '')
        .replace(/[^a-z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

const PT_STOP = new Set([
    'o','a','os','as','um','uma','de','da','do','das','dos','que','qual','quais',
    'quanto','quanta','preco','preço','custa','valor','tem','e','ou','mais','qual'
]);

const HARD_FILTERS = [
    'sapatenis','mocatenis','mocassim','bota','sandalia','tenis',
    'camiseta','camisa','polo','regata','bermuda','calca'
];

const SYN = new Map([
    ['sapatenis','sapatennis'],
    ['mocatenis','mocatennis'],
    ['calca','calça']
]);

function findMatches(question, catalog) {
    const qn = normalize(question);
    const toks = qn.split(' ').filter(t => t && !PT_STOP.has(t));
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

    if (hard) {
        ranked = ranked.filter(p => {
            const alt = SYN.get(hard) || hard;
            return p.normName.includes(hard) || p.normName.includes(alt);
        });
    }

    ranked.sort((a,b) => b._score - a._score || a.priceValue - b.priceValue);
    return ranked.slice(0, 8).map(({_score, normName, ...rest}) => rest);
}

function makeDeterministicAnswer(question, matches) {
    if (!matches.length) return 'Não achei esse item agora no catálogo público da diRavena.';

    const asksPrice     = /quanto|preco|preço|custa|valor/i.test(question);
    const wantsCheapest = /mais\s*barat|minim|menor\s*pre[cç]o/i.test(question) || asksPrice;
    const wantsMostExp  = /mais\s*cara|mais\s*caro|maior\s*pre[cç]o|mais\s*caras/i.test(question);

    let pick = matches[0];
    if (wantsMostExp)  pick = matches.reduce((a,b) => (a.priceValue > b.priceValue ? a : b));
    else if (wantsCheapest) pick = matches.reduce((a,b) => (a.priceValue < b.priceValue ? a : b));

    if (wantsMostExp || wantsCheapest || asksPrice) {
        return [
            'Encontrei algumas opções. A mais barata é:',
            `${pick.name} — ${pick.price}`,
            pick.url
        ].join('\n');
    }

    return [
        'Encontrei essas opções:',
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
    return 'R$ ' + Number(v).toFixed(2).replace('.', ',');
}

