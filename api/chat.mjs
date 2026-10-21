export const config = { runtime: 'edge' };

export default async function handler(req) {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Metodo non consentito' }), { status: 405 });
  }

  const { messaggio } = await req.json();
  const GROQ_API_KEY = process.env.GROQ_API_KEY; 
  const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;
  const VERCEL_API_TOKEN = process.env.VERCEL_API_TOKEN;
  const EDGE_CONFIG_ID = process.env.EDGE_CONFIG_ID;
  
  if (!GROQ_API_KEY || !DEEPGRAM_API_KEY || !VERCEL_API_TOKEN || !EDGE_CONFIG_ID) {
    return new Response(JSON.stringify({ risposta: 'Errore config: Chiavi API o Token mancanti su Vercel.' }), { status: 500 });
  }

  // 1. Leggi TUTTI i dati in tempo reale da Global Config
  let piattiBase = [];
  let viniBase = [];
  let piattiEsauriti = [];
  let viniEsauriti = [];
  let piattoDelGiorno = "Nessun piatto del giorno configurato";

  try {
    const configResponse = await fetch(`https://api.vercel.com/v1/edge-config/${EDGE_CONFIG_ID}/items`, {
      headers: { 
        'Authorization': `Bearer ${VERCEL_API_TOKEN}`,
        'Content-Type': 'application/json'
      },
      cache: 'no-store' 
    });

    if (configResponse.ok) {
        const raw = await configResponse.json();
        // Trasforma l'array [{key, value}, ...] in un oggetto leggibile
        const data = Array.isArray(raw) ? Object.fromEntries(raw.map(i => [i.key, i.value])) : raw;
        
        // Estrai i dati dal database di Vercel
        piattiBase = data.piatti || []; 
        viniBase = data.vini || [];     
        
        piattiEsauriti = data.piatti_esauriti || [];
        viniEsauriti = data.vini_esauriti || [];
        piattoDelGiorno = data.piatto_del_giorno || piattoDelGiorno;
    } else {
        console.error("Risposta API Edge Config non valida:", configResponse.status);
    }
  } catch (error) {
    console.error("Errore lettura Edge Config tramite Fetch:", error);
  }

  // 2. Filtra i piatti esauriti
  const menuPiattiDisponibili = piattiBase.filter(p => {
    const nomePiattoLower = p.nome.toLowerCase();
    return !piattiEsauriti.some(esaurito => nomePiattoLower.includes(esaurito.toLowerCase()));
  });

  // 3. Filtra i vini (sia quelli marcati "disponibile: false" che quelli esauriti)
  const viniDisponibili = viniBase.filter(v => 
    v.disponibile === true && 
    !viniEsauriti.includes(v.nome)
  );

  // 4. Costruisci il prompt con i dati reali
  const systemPrompt = `
    Sei l'assistente virtuale del ristorante "Fonte La Tavola". 
    Il tuo tono è cordiale, professionale e appassionato.
    
    Oggi il piatto del giorno è: ${piattoDelGiorno}
    
    ATTENZIONE: I seguenti piatti NON SONO DISPONIBILI oggi: ${piattiEsauriti.length > 0 ? piattiEsauriti.join(', ') : 'Nessuno'}.
    Non proporli assolutamente.
    
    Ecco il menu dei piatti DISPONIBILI:
    ${JSON.stringify(menuPiattiDisponibili)}
    
    Ecco i vini ATTUALMENTE DISPONIBILI (inclusi regioni, tipi e prezzi):
    ${JSON.stringify(viniDisponibili)}
    
    REGOLE FONDAMENTALI:
    1. Se un cliente chiede informazioni su allergeni non presenti, dì: "Per sicurezza, chieda sempre conferma al nostro personale in sala".
    2. Quando ti chiedono un vino, consiglia SOLO tra quelli della lista. Sii specifico (nome, cantina e regione).
    3. Sii conciso, massimo 2-3 frasi. Il testo verrà letto ad alta voce.
  `;

  try {
    // 5. Groq per il testo
    const groqResponse = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'openai/gpt-oss-20b',
        reasoning_effort: 'low',
        messages: [ { role: 'system', content: systemPrompt }, { role: 'user', content: messaggio } ],
        temperature: 0.5,
      })
    });

    const groqData = await groqResponse.json();
    if (!groqResponse.ok) throw new Error(groqData.error?.message || 'Errore Groq');
    
    const testoRisposta = groqData.choices[0].message.content;

    // 6. Deepgram per la voce Livia
    const deepgramUrl = 'https://api.deepgram.com/v1/speak?model=aura-2-livia-it';
    
    const ttsResponse = await fetch(deepgramUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Token ${DEEPGRAM_API_KEY}`, 
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ text: testoRisposta })
    });

    if (!ttsResponse.ok) {
      const ttsError = await ttsResponse.json();
      throw new Error(ttsError.err_msg || ttsError.error || 'Errore TTS Deepgram');
    }

    return new Response(ttsResponse.body, {
      headers: { 'Content-Type': 'audio/mpeg' }
    });

  } catch (error) {
    console.error('Errore:', error);
    return new Response(JSON.stringify({ risposta: "Mi dispiace, ho avuto un problema tecnico. Puoi ripetere?" }), { 
        status: 200, headers: { 'Content-Type': 'application/json' } 
    });
  }
}
