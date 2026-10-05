// api/audit.js
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,POST');
  res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido.' });

  try {
    const b = req.body || {};

    // Captura hiper-resiliente (pega em português, inglês, camelCase ou snake_case)
    const nomeFinal = (b.nome || b.businessName || b.nomeComercial || b.empresa || '').trim();
    const cidadeFinal = (b.cidade || b.stateCity || b.cidadeEstado || b.city || '').trim();
    const segmentoFinal = (b.segmento || b.niche || b.setor || b.categoria || '').trim();
    const itemFinal = (b.item || b.specificItem || b.especialidade || '').trim();
    const bairroFinal = (b.bairro || b.district || '').trim() || 'toda a cidade';
    const respFinal = (b.responsavel || b.contactName || '').trim();
    const foneFinal = (b.whatsapp || b.phone || '').trim();
    const emailFinal = (b.email || '').trim();
    const refFinal = (b.ref || 'raiz_direta').trim();

    // Validação real: só barra se realmente estiver vazio
    if (!nomeFinal) {
      return res.status(400).json({ error: 'Por favor, informe o Nome Comercial da empresa.' });
    }
    if (!cidadeFinal) {
      return res.status(400).json({ error: 'Por favor, informe a Cidade e Estado.' });
    }
    if (!segmentoFinal) {
      return res.status(400).json({ error: 'Por favor, informe o Segmento / Setor.' });
    }

    // 1. WEBHOOK DE LEADS (SE CONFIGURADO)
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
        }).catch(e => console.error("Webhook lead erro:", e));
      } catch (ignore) {}
    }

    // 2. CHAVE DA API DO GOOGLE GEMINI
    const apiKey = (process.env.GEMINI_API_KEY || '').trim();
    if (!apiKey) {
      return res.status(500).json({ error: 'Chave GEMINI_API_KEY não configurada na Vercel.' });
    }

    const localContexto = bairroFinal !== 'toda a cidade' ? `\({bairroFinal},\){cidadeFinal}` : cidadeFinal;
    const itemContexto = itemFinal ? `com foco ou especialidade em "${itemFinal}"` : '';

    const prompt = `Você é um morador bem informado e exigente de ${localContexto}.
Pergunta do usuário no smartphone: "Quais são os 3 ou 4 melhores estabelecimentos recomendados no segmento de \({segmentoFinal}\){itemContexto} em ${localContexto}?"
Instruções obrigatórias:
1. Responda citando o nome real de 3 a 4 estabelecimentos mais conhecidos, bem avaliados ou tradicionais da região.
2. Seja objetivo e mencione brevemente o diferencial de cada um.
3. Não cite ou invente estabelecimentos que não correspondam à realidade local.`;

    const modelsToTry = [
      "gemini-2.5-flash",
      "gemini-2.0-flash",
      "gemini-flash-latest"
    ];

    let iaResponseText = "";
    let lastError = "";

    for (const model of modelsToTry) {
      try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
        const resp = await fetch(url, {
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
        error: `Os servidores de IA estão com alta demanda temporária. (${lastError})`
      });
    }

    // 3. ROBÔ DE CONFRONTO
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
