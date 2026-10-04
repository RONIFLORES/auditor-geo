// api/audit.js
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,POST');
  res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido.' });

  try {
    const {
      nome,
      businessName,
      cidade,
      stateCity,
      segmento,
      niche,
      item,
      specificItem,
      bairro,
      district,
      contactName,
      responsavel,
      phone,
      whatsapp,
      email,
      ref
    } = req.body;

    // Normalização completa: aceita variáveis em português ou inglês sem desencontro
    const nomeFinal = (nome || businessName || '').trim();
    const cidadeFinal = (cidade || stateCity || '').trim();
    const segmentoFinal = (segmento || niche || '').trim();
    const itemFinal = (item || specificItem || '').trim();
    const bairroFinal = (bairro || district || '').trim() || 'toda a cidade';
    const respFinal = (responsavel || contactName || '').trim();
    const foneFinal = (whatsapp || phone || '').trim();
    const emailFinal = (email || '').trim();
    const refFinal = (ref || 'raiz_direta').trim();

    // Validação dos obrigatórios
    if (!nomeFinal || !cidadeFinal || !segmentoFinal) {
      return res.status(400).json({
        error: 'Preencha os campos obrigatórios (Nome Comercial, Cidade e Segmento).'
      });
    }

    // 1. DISPARO DO LEAD PARA WEBHOOK (TRAQUEAMENTO DE MENTORADO / CAMPANHA)
    const WEBHOOK_URL = process.env.LEADS_WEBHOOK_URL;
    if (WEBHOOK_URL) {
      try {
        fetch(WEBHOOK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            dataHora: new Date().toISOString(),
            cidade: cidadeFinal,
            bairro: bairroFinal,
            segmento: segmentoFinal,
            item: itemFinal || 'Geral',
            empresa: nomeFinal,
            responsavel: respFinal,
            whatsapp: foneFinal,
            email: emailFinal,
            mentorRef: refFinal
          })
        }).catch(e => console.error("Webhook disparo erro:", e));
      } catch (ignore) {}
    }

    // 2. CONEXÃO COM O GOOGLE GEMINI
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: 'Chave GEMINI_API_KEY não configurada na Vercel.' });
    }

    const localContexto = bairroFinal !== 'toda a cidade' ? `\({bairroFinal},\){cidadeFinal}` : cidadeFinal;
    const itemContexto = itemFinal ? `com foco ou especialidade em "${itemFinal}"` : '';

    const prompt = `Você é um morador bem informado e exigente de ${localContexto}.
Pergunta do usuário no smartphone: "Quais são os 3 ou 4 melhores estabelecimentos recomendados no segmento de \({segmentoFinal}\){itemContexto} em ${localContexto}?"
Instruções:
1. Responda citando o nome real de 3 a 4 estabelecimentos mais conhecidos, bem avaliados ou tradicionais da região.
2. Seja objetivo e mencione brevemente o diferencial de cada um.
3. Não cite ou invente estabelecimentos que não correspondam à realidade local.`;

    // Lista de modelos resilientes caso ocorra sobrecarga temporária (503)
    const modelsToTry = [
      "gemini-2.5-flash",
      "gemini-2.0-flash",
      "gemini-flash-latest"
    ];

    let iaResponseText = "";
    let lastError = "";

    for (const model of modelsToTry) {
      try {
        const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/\({model}:generateContent?key=\){apiKey}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": apiKey
          },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: {
              temperature: 0.2,
              maxOutputTokens: 850
            }
          })
        });

        const data = await resp.json();
        if (resp.ok && data.candidates?.[0]?.content?.parts?.[0]?.text) {
          iaResponseText = data.candidates[0].content.parts[0].text;
          break;
        } else {
          lastError = data.error?.message || "Sem resposta do modelo";
        }
      } catch (err) {
        lastError = err.message;
      }
    }

    if (!iaResponseText) {
      return res.status(500).json({
        error: `Os servidores de IA estão com alta demanda temporária. Tente novamente em instantes. (${lastError})`
      });
    }

    // 3. ROBÔ DE CONFRONTO ISENTO (COMPARAÇÃO RIGOROSA)
    const cleanStr = (s) => (s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9\s]/g, " ").trim();
    const cleanText = cleanStr(iaResponseText);
    const cleanTarget = cleanStr(nomeFinal);

    let isMentioned = false;
    if (cleanText.includes(cleanTarget)) {
      isMentioned = true;
    } else {
      const stopWords = ["o", "a", "os", "as", "de", "do", "da", "em", "e", "ltda", "me", "epp", "comercio", "servicos", "loja", "restaurante", "bar"];
      const words = cleanTarget.split(/\s+/).filter(w => w.length >= 4 && !stopWords.includes(w));
      if (words.length > 0 && words.some(w => cleanText.includes(w))) {
        isMentioned = true;
      }
    }

    return res.status(200).json({
      iaResponseText,
      isMentioned,
      lead: { nomeFinal, cidadeFinal, segmentoFinal, foneFinal, emailFinal }
    });

  } catch (err) {
    return res.status(500).json({ error: err.message || 'Erro interno ao processar a auditoria.' });
  }
}
