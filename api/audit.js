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

  // 2. CONSULTA AO GOOGLE GEMINI COM SEARCH GROUNDING (PESQUISA EM TEMPO REAL)
  const GEMINI_KEY = process.env.GEMINI_API_KEY;
  if (!GEMINI_KEY) {
    return res.status(500).json({ error: 'Chave GEMINI_API_KEY não configurada na Vercel.' });
  }

  const prompt = `Você é um assistente de inteligência artificial consultado por um morador da cidade de ${city}.
O usuário pergunta: "Quais são as melhores opções e estabelecimentos recomendados no segmento de ${niche} em ${city}?"
Pesquise as informações locais mais recentes, avaliações e empresas existentes no município de ${city}.
Apresente uma lista clara dos 3 a 4 estabelecimentos mais bem avaliados ou conhecidos, indicando o nome de cada um e seus diferenciais.
Seja natural, profissional e objetivo.`;

  const normalizeStr = (str) => {
    if (!str) return "";
    return str.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]/g, "");
  };

  const checkPresence = (text, target) => {
    if (!text || !target) return false;
    const cleanT = normalizeStr(text);
    const words = target.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").split(/\s+/).filter(w => w.length > 2);
    // Se a frase contiver o nome completo ou palavras-chave fortes do nome fantasia
    if (cleanT.includes(normalizeStr(target))) return true;
    return words.some(w => cleanT.includes(w) && w.length >= 4);
  };

  try {
    // Chamada à API do Gemini com ferramenta de Google Search habilitada
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        tools: [{ google_search: {} }],
        generationConfig: {
          temperature: 0.2,
          maxOutputTokens: 900
        }
      })
    });

    const data = await response.json();

    if (!response.ok) {
      // Fallback sem tool se a cota do grounding não estiver disponível no projeto
      const fallbackResp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_KEY}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.2, maxOutputTokens: 900 }
        })
      });
      const fbData = await fallbackResp.json();
      if (!fallbackResp.ok) {
        throw new Error(fbData.error?.message || data.error?.message || "Erro na API Gemini");
      }
      const output = fbData.candidates?.[0]?.content?.parts?.[0]?.text || "Sem retorno de texto do motor.";
      const isMentioned = checkPresence(output, businessName);
      return res.status(200).json({
        gemini: { text: output, mentioned: isMentioned },
        lead: { businessName, city, niche, contactName, phone, email }
      });
    }

    const output = data.candidates?.[0]?.content?.parts?.[0]?.text || "Sem retorno de texto do motor.";
    const isMentioned = checkPresence(output, businessName);

    return res.status(200).json({
      gemini: { text: output, mentioned: isMentioned },
      lead: { businessName, city, niche, contactName, phone, email }
    });

  } catch (err) {
    return res.status(500).json({ error: "Erro na varredura algorítmica: " + err.message });
  }
}
