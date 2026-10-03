// api/audit.js
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,POST');
  res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido.' });

  const { businessName, city, niche, phone, email, ref } = req.body;
  if (!businessName || !city || !niche) {
    return res.status(400).json({ error: 'Preencha os campos obrigatórios (Empresa, Cidade e Nicho).' });
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
          phone,
          email,
          afiliadoOuMentor: ref || 'direto'
        })
      }).catch(e => console.error("Webhook lead erro:", e));
    } catch (ignore) {}
  }

  // 2. CONSULTA AO GOOGLE GEMINI
  const GEMINI_KEY = process.env.GEMINI_API_KEY;

  if (!GEMINI_KEY) {
    return res.status(500).json({ error: 'Chave GEMINI_API_KEY não encontrada nas variáveis de ambiente da Vercel.' });
  }

  const prompt = `Atue como um morador da cidade de ${city}. Preciso com urgência de recomendação dos melhores locais de ${niche} no município. Liste os nomes dos estabelecimentos recomendados e explique sucintamente os diferenciais de cada um. Seja direto e objetivo.`;

  const checkPresence = (text, target) => {
    if (!text) return false;
    const cleanText = text.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    const cleanTarget = target.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    return cleanText.includes(cleanTarget);
  };

  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.3,
          maxOutputTokens: 800
        }
      })
    });

    const data = await response.json();

    if (!response.ok) {
      const errMsg = data.error?.message || "Erro na API do Gemini";
      return res.status(500).json({ error: `Falha no Gemini: ${errMsg}` });
    }

    const output = data.candidates?.[0]?.content?.parts?.[0]?.text || "Sem retorno de texto do Gemini.";
    const isMentioned = checkPresence(output, businessName);

    return res.status(200).json({
      promptUtilizado: prompt,
      gemini: {
        text: output,
        mentioned: isMentioned
      },
      lead: { businessName, city, niche, phone, email }
    });
  } catch (err) {
    return res.status(500).json({ error: "Erro interno no servidor de varredura: " + err.message });
  }
}
