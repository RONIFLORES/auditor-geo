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

  // 1. CAPTURA DO LEAD (GOOGLE SHEETS OU WEBHOOK DISPARADOR)
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

  // 2. CONSULTA ÀS IAs
  const OPENAI_KEY = process.env.OPENAI_API_KEY;
  const GEMINI_KEY = process.env.GEMINI_API_KEY;

  const prompt = `Atue como um morador da cidade de ${city}. Preciso com urgência de recomendação dos 3 melhores locais de ${niche}. Liste apenas os nomes dos estabelecimentos recomendados e os seus diferenciais. Seja direto e objetivo.`;

  const checkPresence = (text, target) => {
    if (!text) return false;
    const cleanText = text.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    const cleanTarget = target.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    return cleanText.includes(cleanTarget);
  };

  const fetchChatGPT = async () => {
    if (!OPENAI_KEY) return { text: "Chave OpenAI não configurada nas variáveis.", mentioned: false };
    try {
      const response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${OPENAI_KEY}` },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          messages: [{ role: "user", content: prompt }],
          temperature: 0.3
        })
      });
      const data = await response.json();
      const output = data.choices?.[0]?.message?.content || "Sem resposta do ChatGPT.";
      return { text: output, mentioned: checkPresence(output, businessName) };
    } catch (err) {
      return { text: "Falha ChatGPT: " + err.message, mentioned: false };
    }
  };

  const fetchGemini = async () => {
    if (!GEMINI_KEY) return { text: "Chave Gemini não configurada nas variáveis.", mentioned: false };
    try {
      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_KEY}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
      });
      const data = await response.json();
      const output = data.candidates?.[0]?.content?.parts?.[0]?.text || "Sem resposta do Gemini.";
      return { text: output, mentioned: checkPresence(output, businessName) };
    } catch (err) {
      return { text: "Falha Gemini: " + err.message, mentioned: false };
    }
  };

  try {
    const [chatgptResult, geminiResult] = await Promise.all([fetchChatGPT(), fetchGemini()]);
    return res.status(200).json({
      promptUtilizado: prompt,
      chatgpt: chatgptResult,
      gemini: geminiResult,
      lead: { businessName, city, niche, phone, email }
    });
  } catch (error) {
    return res.status(500).json({ error: "Erro interno no servidor de auditoria." });
  }
}
