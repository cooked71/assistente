export const config = { runtime: 'nodejs' };

// Helper per fetch con timeout (evita che una chiamata lenta blocchi tutto)
async function fetchWithTimeout(url, options, timeoutMs = 8000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    return response;
  } finally {
    clearTimeout(timeout);
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Metodo non consentito' });
  }

  const { messaggio } = req.body;
  const GROQ_API_KEY = process.env.GROQ_API_KEY; 
  const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;
  const VERCEL_API_TOKEN = process.env.VERCEL_API_TOKEN;
  const EDGE_CONFIG_ID = process.env.EDGE_CONFIG_ID;
  
  if (!GROQ_API_KEY || !DEEPGRAM_API_KEY || !VERCEL_API_TOKEN || !EDGE_CONFIG_ID) {
    return res.status(500).json({ risposta: 'Errore config: Chiavi API o Token mancanti su Vercel.' });
  }

  // 1. Leggi TUTTI i dati in tempo reale da Global Config
  let piattiBase = [];
  let viniBase = [];
  let piattiEsauriti = [];
  let viniEsauriti = [];
  let piattoDelGiorno = "Nessun piatto del giorno configurato";

  try {
    const configResponse = await fetchWithTimeout(`https://api.vercel.com/v1/edge-config/${EDGE_CONFIG_ID}/items`, {
      headers: { 
        'Authorization': `Bearer ${VERCEL_API_TOKEN}`,
        'Content-Type': 'application/json'
      },
      cache: 'no-store' 
    }, 5000);

    if (configResponse.ok) {
        const raw = await configResponse.json();
        const data = Array.isArray(raw) ? Object.fromEntries(raw.map(i => [i.key, i.value])) : raw;
        
        piattiBase = data.piatti || []; 
        viniBase = data.vini || [];     
        piattiEsauriti = data.piatti_esauriti || [];
        viniEsauriti = data.vini_esauriti || [];
        piattoDelGiorno = data.piatto_del_giorno || piattoDelGiorno;
    }
  } catch (error) {
    console.error("Errore lettura Edge Config:", error.message);
    // Fallback: se Global Config fallisce, usa liste vuote (l'AI dirà che non c'è nulla)
  }

  // 2. FASE DI ESTRAZIONE (L'AI estrae le parole chiave)
  let paroleChiave = [];
  
  try {
    const estrazioneResponse = await fetchWithTimeout('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'openai/gpt-oss-20b',
        reasoning_effort: 'low',
        response_format: { type: "json_object" },
        messages: [
          { 
            role: 'system', 
            content: `Sei un estrattore di parole chiave. Analizza la richiesta del cliente e restituisci SOLO un JSON con un array chiamato "keywords". 
            Estrai TUTTI i sostantivi e gli aggettivi che indicano cibo, bevande, vini, regioni, tipi di vino, categorie di piatti, ingredienti o caratteristiche. 
            Trasforma tutto al SINGOLARE e minuscolo. 
            Esempio: Se la domanda è "Avete vini rossi abruzzesi?", restituisci: {"keywords": ["vino", "rosso", "abruzzese"]}.
            Esempio: Se la domanda è "Vorrei un piatto con i funghi", restituisci: {"keywords": ["piatto", "fungo"]}.` 
          },
          { role: 'user', content: messaggio }
        ]
      })
    }, 8000);

    if (estrazioneResponse.ok) {
        const estrazioneData = await estrazioneResponse.json();
        if (estrazioneData.choices && estrazioneData.choices[0] && estrazioneData.choices[0].message) {
            try {
                const parsed = JSON.parse(estrazioneData.choices[0].message.content);
                paroleChiave = parsed.keywords || [];
            } catch (parseError) {
                console.error("Errore parsing JSON estrazione:", parseError.message);
            }
        }
    }
  } catch (e) {
    console.error("Errore estrazione parole chiave:", e.message);
  }

  // FALLBACK: Se l'estrazione fallisce o restituisce un array vuoto, 
  // usiamo le parole del messaggio originale
  if (!paroleChiave || paroleChiave.length === 0) {
      paroleChiave = messaggio.toLowerCase().split(/\s+/).filter(w => w.length > 2);
  }

  // 3. FASE DI FILTRAGGIO
  function contieneParola(oggetto, parola) {
    if (!oggetto) return false;
    const stringaOggetto = JSON.stringify(oggetto).toLowerCase();
    return stringaOggetto.includes(parola.toLowerCase());
  }

  let piattiFiltrati = piattiBase.filter(p => {
    if (piattiEsauriti.some(e => p.nome.toLowerCase().includes(e.toLowerCase()))) return false;
    return paroleChiave.some(k => contieneParola(p, k));
  });

  if (piattiFiltrati.length === 0 && !messaggio.toLowerCase().includes('vino')) {
      piattiFiltrati = piattiBase.filter(p => !piattiEsauriti.some(e => p.nome.toLowerCase().includes(e.toLowerCase())));
  }

  let viniFiltrati = viniBase.filter(v => {
    if (!v.disponibile || viniEsauriti.includes(v.nome)) return false;
    return paroleChiave.some(k => contieneParola(v, k));
  });

  if (viniFiltrati.length === 0 && !messaggio.toLowerCase().includes('piatto')) {
      viniFiltrati = viniBase.filter(v => v.disponibile === true && !viniEsauriti.includes(v.nome));
  }

  // 4. FASE DI RISPOSTA
  const systemPrompt = `
    Sei l'assistente virtuale del ristorante "Fonte La Tavola". 
    Il tuo tono è cordiale, professionale e appassionato.
    
    Oggi il piatto del giorno è: ${piattoDelGiorno}
    
    Ecco i piatti DISPONIBILI (filtrati per la richiesta):
    ${JSON.stringify(piattiFiltrati)}
    
    Ecco i vini ATTUALMENTE DISPONIBILI (filtrati per la richiesta):
    ${JSON.stringify(viniFiltrati)}
    
    REGOLE FONDAMENTALI:
    1. Se l'utente ha chiesto qualcosa e le liste qui sopra sono vuote, dì: "Mi dispiace, al momento non abbiamo nulla con queste caratteristiche".
    2. Se le liste NON sono vuote, elenca gli elementi in modo naturale basandoti SOLO ed ESCLUSIVAMENTE su queste liste.
    3. Non aggiungere mai elementi che non sono in queste liste.
    4. Sii conciso, massimo 2-3 frasi. Il testo verrà letto ad alta voce.
  `;

  try {
    const groqResponse = await fetchWithTimeout('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'openai/gpt-oss-20b',
        reasoning_effort: 'low',
        messages: [ { role: 'system', content: systemPrompt }, { role: 'user', content: messaggio } ],
        temperature: 0.5,
      })
    }, 10000);

    const groqData = await groqResponse.json();
    if (!groqResponse.ok) throw new Error(groqData.error?.message || 'Errore Groq');
    
    const testoRisposta = groqData.choices[0].message.content;

    const deepgramUrl = 'https://api.deepgram.com/v1/speak?model=aura-2-livia-it';
    
    const ttsResponse = await fetchWithTimeout(deepgramUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Token ${DEEPGRAM_API_KEY}`, 
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ text: testoRisposta })
    }, 10000);

    if (!ttsResponse.ok) {
      const ttsError = await ttsResponse.json();
      throw new Error(ttsError.err_msg || ttsError.error || 'Errore TTS Deepgram');
    }

    // Invia l'audio come buffer
    const audioBuffer = await ttsResponse.arrayBuffer();
    res.setHeader('Content-Type', 'audio/mpeg');
    res.send(Buffer.from(audioBuffer));

  } catch (error) {
    console.error('Errore finale:', error.message);
    return res.status(200).json({ risposta: "Mi dispiace, ho avuto un problema tecnico. Puoi ripetere?" });
  }
}
