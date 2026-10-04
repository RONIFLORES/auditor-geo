// api/audit.js
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,POST');
  res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido.' });

  const { businessName, city, niche, contactName, phone, email, ref } = req.body;
  if (!businessName || !city || !niche) {
    return res.status(400).json({ error: 'Preencha os dados da empresa (Nome, Cidade e Segmento).' });
  }

  // 1. CAPTURA DO LEAD (WEBHOOK / PLANILHA SE CONFIGURADO)
  const WEBHOOK_URL = process.env.LEADS_WEBHOOK_URL;
  if (WEBHOOK_URL) {
    try {
      fetch(WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          dataHora: new Date().toISOString(),
          businessName,
          city,
          niche,
          contactName: contactName || '',
          phone: phone || '',
          email: email || '',
          mentorRef: ref || 'direto'
        })
      }).catch(e => console.error("Webhook lead erro:", e));
    } catch (ignore) {}
  }

  // 2. CONSULTA AO GOOGLE GEMINI
  const GEMINI_KEY = process.env.GEMINI_API_KEY;
  if (!GEMINI_KEY) {
    return res.status(500).json({ error: 'Chave GEMINI_API_KEY não configurada na Vercel.' });
  }

  const prompt = `Você é um morador bem informado da cidade de ${city}. 
Pergunta: "Quais são as melhores opções e estabelecimentos recomendados no segmento de ${niche} em ${city}?"
Liste de 3 a 4 nomes dos estabelecimentos locais mais conhecidos ou bem avaliados na cidade de ${city} e explique brevemente os diferenciais de cada um.
Seja direto, profissional e objetivo na sua resposta.`;

  const normalizeStr = (str) => {
    if (!str) return "";
    return str.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]/g, "");
  };

  const checkPresence = (text, target) => {
    if (!text || !target) return false;
    const cleanT = normalizeStr(text);
    const targetClean = normalizeStr(target);
    if (cleanT.includes(targetClean)) return true;
    const words = target.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").split(/\s+/).filter(w => w.length >= 4);
    return words.some(w => cleanT.includes(w));
  };

  // Descobrir dinamicamente os modelos ativos para esta chave ou usar a lista atualizada
  async function callGemini() {
    // 1. Tentar os endpoints oficiais mais recentes e estáveis
    const modelsToTry = [
      "gemini-2.5-flash",
      "gemini-2.0-flash",
      "gemini-2.0-flash-lite",
      "gemini-flash-latest"
    ];

    for (const m of modelsToTry) {
      try {
        const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${GEMINI_KEY}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": GEMINI_KEY
          },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.3, maxOutputTokens: 800 }
          })
        });

        const data = await resp.json();
        if (resp.ok && data.candidates?.[0]?.content?.parts?.[0]?.text) {
          return { model: m, text: data.candidates[0].content.parts[0].text };
        }
      } catch (err) {
        // tenta o próximo
      }
    }

    // 2. Se nenhum dos nomes fixos responder, pergunta à API quais modelos suportam generateContent
    try {
      const listResp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${GEMINI_KEY}`);
      const listData = await listResp.json();
      if (listData.models && Array.isArray(listData.models)) {
        const available = listData.models.filter(mod => 
          mod.supportedGenerationMethods && 
          mod.supportedGenerationMethods.includes("generateContent") &&
          mod.name.includes("flash")
        );

        for (const targetMod of available) {
          const modName = targetMod.name.replace("models/", "");
          const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${modName}:generateContent?key=${GEMINI_KEY}`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-goog-api-key": GEMINI_KEY
            },
            body: JSON.stringify({
              contents: [{ parts: [{ text: prompt }] }],
              generationConfig: { temperature: 0.3, maxOutputTokens: 800 }
            })
          });
          const data = await resp.json();
          if (resp.ok && data.candidates?.[0]?.content?.parts?.[0]?.text) {
            return { model: modName, text: data.candidates[0].content.parts[0].text };
          }
        }
      }
    } catch (discoveryErr) {
      console.error("Erro na auto-descoberta:", discoveryErr);
    }

    throw new Error("Nenhum modelo da API do Gemini respondeu com sucesso. Verifique a validade da chave GEMINI_API_KEY no Google AI Studio.");
  }

  try {
    const result = await callGemini();
    const isMentioned = checkPresence(result.text, businessName);

    return res.status(200).json({
      modelUsed: result.model,
      gemini: { text: result.text, mentioned: isMentioned },
      lead: { businessName, city, niche, contactName, phone, email }
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
