import express from "express";
import OpenAI from "openai";
import pdf from "pdf-parse";
import "dotenv/config";

const app = express();
app.use(express.json({ limit: "10mb" }));

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const SERVER_PARSER_KEY = process.env.PLU_PARSER_API_KEY;
const PORT = process.env.PORT || 3000;

async function fetchPdfBuffer(url) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Erreur HTTP ${res.status} en téléchargeant le PDF`);
  }
  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

app.post("/api/plu-parse", async (req, res) => {
  try {
    // 1️⃣ Auth simple
    const authHeader = req.headers["authorization"] || "";
    const token = authHeader.replace("Bearer ", "").trim();

    if (!SERVER_PARSER_KEY || token !== SERVER_PARSER_KEY) {
      return res.status(401).json({
        success: false,
        error: "UNAUTHORIZED",
      });
    }

    const { commune_insee, commune_nom, source_pdf_url } = req.body || {};

    if (!commune_insee || !source_pdf_url) {
      return res.status(400).json({
        success: false,
        error: "MISSING_PARAMS",
      });
    }

    console.log(
      `[PLU-PARSER] Commune ${commune_nom || "?"} (${commune_insee}) - PDF:`,
      source_pdf_url,
    );

    // 2️⃣ Télécharger le PDF
    const pdfBuffer = await fetchPdfBuffer(source_pdf_url);

    // 3️⃣ Extraire le texte du PDF
    const pdfData = await pdf(pdfBuffer);
    const fullText = pdfData.text || "";
    const truncatedText = fullText.slice(0, 20000); // pour limiter le contexte

    // 4️⃣ Appel OpenAI pour produire le JSON attendu par plu-ingest-rulesets
    const systemPrompt = `
Tu es un moteur d'extraction de règles d'urbanisme (PLU) pour la plateforme Mimmoza.
À partir du texte d'un PLU français, tu dois renvoyer un JSON respectant STRICTEMENT le format :

{
  "commune_insee": "...",
  "commune_nom": "...",
  "plu_version_label": "...",
  "source_document": "...",
  "zones_rulesets": [
    {
      "zone_code": "...",
      "zone_libelle": "...",
      "ruleset": {
        "zone_code": "...",
        "zone_libelle": "...",
        "densite": { "cos_existe": true/false, "cos_max": number|null, "max_sdp_m2_par_m2_terrain": number|null, "commentaire": "..." },
        "hauteur": { "hauteur_max_m": number|null, "hauteur_min_m": number|null, "commentaire": "..." },
        "emprise_sol": { "emprise_sol_max": number|null, "commentaire": "..." },
        "reculs_alignements": { "commentaire": "..." },
        "stationnement": { "commentaire": "..." },
        "autres_regles": { "commentaire": "..." },
        "articles_source": ["..."]
      }
    }
  ]
}

Règles :
- "zones_rulesets" contient une entrée par zone (UA, UB, UG, 1AU, etc.) trouvée dans le texte.
- Pour les pourcentages, utilise des décimaux (0.6 = 60%).
- Si une info n'est pas dans le texte, mets null ou cos_existe=false.
- "plu_version_label" peut être déduit du texte (ex: "PLU Ascain 2020"), sinon mets null.
- "source_document" doit reprendre l'URL du PDF reçu.
- "zone_code" doit être simple (UA, UB, UG, 1AU, 2AU…).
- Réponds UNIQUEMENT avec le JSON, sans texte avant ou après.
`;

    const userPrompt = `
Commune : ${commune_nom || "Inconnue"} (${commune_insee})
Texte du PLU (tronqué si très long) :
${truncatedText}
`;

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      response_format: { type: "json_object" },
      temperature: 0,
    });

    const raw = completion.choices[0]?.message?.content;
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      console.error("Erreur parsing JSON modèle:", raw);
      return res.status(500).json({
        success: false,
        error: "MODEL_JSON_PARSE_ERROR",
      });
    }

    // On s’assure de quelques champs
    parsed.commune_insee = parsed.commune_insee || commune_insee;
    parsed.commune_nom = parsed.commune_nom || commune_nom || null;
    parsed.source_document = parsed.source_document || source_pdf_url;

    if (!Array.isArray(parsed.zones_rulesets)) {
      parsed.zones_rulesets = [];
    }

    return res.json({
      success: true,
      ...parsed,
    });
  } catch (err) {
    console.error("Erreur /api/plu-parse :", err);
    return res.status(500).json({
      success: false,
      error: "PLU_PARSER_INTERNAL_ERROR",
    });
  }
});

app.listen(PORT, () => {
  console.log(`✅ PLU parser server listening on port ${PORT}`);
});
