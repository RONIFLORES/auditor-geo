// Atualizacao forcada 
// api/audit.js
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,POST');
  res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido.' });

  const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

  try {
    const b = req.body || {};

    const nomeFinal = (b.businessName || b.nome || b.nomeComercial || b.empresa || '').trim();
    const cidadeFinal = (b.stateCity || b.cidade || b.cidadeEstado || b.city || '').trim();
    const segmentoFinal = (b.niche || b.segmento || b.setor || b.categoria || '').trim();
    const itemFinal = (b.specificItem || b.item || b.especialidade || '').trim();
    const bairroFinal = (b.district || b.bairro || '').trim() || 'toda a cidade';
    const respFinal = (b.contactName || b.responsavel || '').trim();
    const foneFinal = (b.phone || b.whatsapp || '').trim();
    const emailFinal = (b.email || '').trim();
    const refFinal = (b.ref || 'raiz_direta').trim();

    if (!nomeFinal) return res.status(400).json({ error: 'Por favor, informe o Nome Comercial.' });
    if (!cidadeFinal) return res.status(400).json({ error: 'Por favor, informe a Cidade.' });
    if (!segmentoFinal) return res.status(400).json({ error: 'Por favor, informe o Segmento.' });

    const WEBHOOK_URL = process.env.LEADS_WEBHOOK_URL;
    if (WEBHOOK_URL) {
      try {
        fetch(WEBHOOK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            dataHora: new Date().toISOString(), cidade: cidadeFinal, bairro: bairroFinal,
            segmento: segmentoFinal, item: itemFinal || 'Geral', empresa: nomeFinal,
            responsavel: respFinal, whatsapp: foneFinal, email: emailFinal, mentorRef: refFinal
          })
        }).catch(() => {});
      } catch (ignore) {}
    }

    const apiKey = (process.env.GEMINI_API_KEY || '').trim();
    if (!apiKey) return res.status(500).json({ error: 'Chave API ausente.' });

    const localContexto = (bairroFinal && bairroFinal !== 'toda a cidade') ? `${bairroFinal}, ${cidadeFinal}` : cidadeFinal;
    const itemTexto = itemFinal ? `com foco em ${itemFinal}` : '';

    const prompt = `Você é o assistente neural de buscas locais Google Gemini consultado no smartphone por um cliente real.
Pergunta do usuário: "Quais são os melhores e mais recomendados locais em ${localContexto} para ${segmentoFinal} ${itemTexto}?"
Instruções mandatórias:
1. Responda diretamente listando de 2 a 4 estabelecimentos reais e populares que atendam a essa busca em ${cidadeFinal}.
2. Para cada estabelecimento, destaque brevemente os diferenciais reais.
3. Não faça perguntas de volta. Entregue o laudo imediatamente.`;

    const modelsToTry = ["gemini-3.8-flash", "gemini-3.8-pro", "gemini-flash-latest", "gemini-1.5-flash"];
    let iaResponseText = "";
    
    // Loop Silencioso: Tenta até 3 vezes com intervalo caso o servidor esteja lotado
    for (let tentativa = 1; tentativa <= 3; tentativa++) {
      for (const model of modelsToTry) {
        try {
          const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
          const resp = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
            body: JSON.stringify({
              contents: [{ parts: [{ text: prompt }] }],
              generationConfig: { temperature: 0.2, maxOutputTokens: 850 }
            })
          });

          const data = await resp.json();
          if (resp.ok && data.candidates?.[0]?.content?.parts?.[0]?.text) {
            iaResponseText = data.candidates[0].content.parts[0].text;
            break;
          }
        } catch (err) {}
      }
      if (iaResponseText) break;
      await delay(2500); // Aguarda 2.5 segundos silenciosamente antes de tentar novamente
    }

    if (!iaResponseText) {
      return res.status(500).json({ error: 'Nossos servidores estão com alto tráfego. Por favor, tente novamente.' });
    }

    const cleanStr = (s) => (s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9\s]/g, " ").trim();
    const cleanText = cleanStr(iaResponseText);
    const cleanTarget = cleanStr(nomeFinal);

    let isMentioned = false;
    if (cleanText.includes(cleanTarget)) {
      isMentioned = true;
    } else {
      // Filtro Rigoroso: Remove palavras genéricas para evitar falsos positivos
      const stopWords = ["o", "a", "os", "as", "de", "do", "da", "em", "e", "ltda", "me", "epp", "comercio", "servicos", "loja", "restaurante", "bar", "supermercado", "mercado", "padaria", "farmacia", "clinica", "oficina", "centro", "studio", "espaco"];
      const words = cleanTarget.split(/\s+/).filter(w => w.length >= 3 && !stopWords.includes(w));
      
      // Exige que TODAS as palavras únicas restantes do nome da empresa existam no texto da IA
      if (words.length > 0 && words.every(w => cleanText.includes(w))) {
        isMentioned = true;
      }
    }

    return res.status(200).json({
      iaResponseText,
      isMentioned,
      lead: { nomeFinal, cidadeFinal, segmentoFinal, foneFinal, emailFinal }
    });

  } catch (err) {
    return res.status(500).json({ error: 'Erro interno de conexão.' });
  }
}
