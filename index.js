import "dotenv/config";

import express from "express";
import OpenAI from "openai";
import pdf from "pdf-parse";

console.log("🚀 PLU PARSER MODE=target_zone supported");
console.log(
  "🔑 OPENAI_API_KEY prefix =",
  (process.env.OPENAI_API_KEY || "").slice(0, 15),
);

const app = express();

app.use(express.json({ limit: "10mb" }));

app.use((err, req, res, next) => {
  if (err && err.type === "entity.parse.failed") {
    console.error("[PLU-PARSER] INVALID_JSON", err.message);
    return res.status(400).json({ success: false, error: "INVALID_JSON" });
  }
  return next(err);
});

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const SERVER_PARSER_KEY = process.env.PLU_PARSER_API_KEY;
const PORT = process.env.PORT || 3000;

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function normalizeText(text) {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n");
}

/**
 * Normalize a zone code: trim, uppercase, remove "Zone " prefix if present
 */
function normalizeZoneCode(code) {
  if (!code) return null;
  let normalized = code.trim().toUpperCase();
  // Remove "ZONE " prefix if present
  normalized = normalized.replace(/^ZONE\s+/i, "");
  return normalized || null;
}

function parseFrenchDecimal(str) {
  if (!str) return null;
  const cleaned = str.replace(",", ".").replace(/\s/g, "");
  const num = parseFloat(cleaned);
  return isNaN(num) ? null : num;
}

/*
 * Regex lookahead test cases for meter exclusion:
 * - "12 m²"  -> must NOT match (surface, not distance)
 * - "12 m ²" -> must NOT match (surface with space before ²)
 * - "12 m2"  -> must NOT match (surface written as m2)
 * - "5 m"    -> must MATCH (valid distance in meters)
 * - "5m"     -> must MATCH (valid distance without space)
 */

function extractMetersValue(text) {
  if (!text) return null;
  // Match patterns like "5 m", "5m", "5 mètres", but avoid "5 m²", "5 m2", "5 m ²"
  // Lookahead (?!\s*(?:²|2)) ensures we don't match surfaces
  // Lookahead (?!\s*(?:²|2|\d)) also excludes "m10" style patterns
  const patterns = [
    /(\d+(?:[.,]\d+)?)\s*m(?:è|e)?tres?(?!\s*(?:²|2))/gi,
    /(\d+(?:[.,]\d+)?)\s*m(?!\s*(?:²|2|\d))/gi,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      const numMatch = match[0].match(/(\d+(?:[.,]\d+)?)/);
      if (numMatch) {
        return parseFrenchDecimal(numMatch[1]);
      }
    }
  }
  return null;
}

function extractMinimumMeters(text) {
  if (!text) return null;
  // Lookahead (?!\s*(?:²|2)) excludes m², m2, m ² patterns
  const patterns = [
    /minimum\s+(?:de\s+)?(\d+(?:[.,]\d+)?)\s*m(?!\s*(?:²|2))/gi,
    /mini(?:mum)?\s*[:=]?\s*(\d+(?:[.,]\d+)?)\s*m(?!\s*(?:²|2))/gi,
    /au\s+moins\s+(\d+(?:[.,]\d+)?)\s*m(?!\s*(?:²|2))/gi,
    /(\d+(?:[.,]\d+)?)\s*m(?!\s*(?:²|2))\s+(?:au\s+)?minimum/gi,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      const numMatch = match[0].match(/(\d+(?:[.,]\d+)?)/);
      if (numMatch) {
        return parseFrenchDecimal(numMatch[1]);
      }
    }
  }
  return null;
}

function detectRegleType(text) {
  if (!text) return null;
  const lower = text.toLowerCase();
  const hasHOver2 = /h\s*\/\s*2|h÷2|hauteur\s*\/\s*2|moitié\s+de\s+la\s+hauteur/i.test(lower);
  const hasMinimum = /minimum|mini|au\s+moins/i.test(lower);
  
  if (hasHOver2 && hasMinimum) return "H_OVER_2_MIN";
  if (hasHOver2) return "H_OVER_2";
  
  const fixedMatch = extractMinimumMeters(text) || extractMetersValue(text);
  if (fixedMatch !== null) return "FIXED";
  
  return null;
}

function extractPlacesParLogement(text) {
  if (!text) return null;
  const patterns = [
    /(\d+(?:[.,]\d+)?)\s*places?\s*(?:de\s+stationnement\s+)?par\s+logement/gi,
    /(\d+(?:[.,]\d+)?)\s*places?\s*\/\s*logement/gi,
    /par\s+logement\s*[:=]?\s*(\d+(?:[.,]\d+)?)\s*places?/gi,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      const numMatch = match[0].match(/(\d+(?:[.,]\d+)?)/);
      if (numMatch) {
        return parseFrenchDecimal(numMatch[1]);
      }
    }
  }
  return null;
}

function extractSurfaceParPlace(text) {
  if (!text) return null;
  const patterns = [
    /(\d+(?:[.,]\d+)?)\s*m²?\s*(?:par|\/)\s*place/gi,
    /place\s*[:=]?\s*(\d+(?:[.,]\d+)?)\s*m²/gi,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      const numMatch = match[0].match(/(\d+(?:[.,]\d+)?)/);
      if (numMatch) {
        return parseFrenchDecimal(numMatch[1]);
      }
    }
  }
  return null;
}

function extractPlacesPar100m2(text) {
  if (!text) return null;
  const patterns = [
    /(\d+(?:[.,]\d+)?)\s*places?\s*(?:par|pour|\/)\s*100\s*m²/gi,
    /100\s*m²\s*[:=]?\s*(\d+(?:[.,]\d+)?)\s*places?/gi,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      const numMatch = match[0].match(/(\d+(?:[.,]\d+)?)/);
      if (numMatch) {
        return parseFrenchDecimal(numMatch[1]);
      }
    }
  }
  return null;
}

function extractHauteurMax(text) {
  if (!text) return null;
  // Lookahead (?!\s*(?:²|2)) excludes m², m2, m ² patterns
  const patterns = [
    /hauteur\s+(?:maximale?|max\.?|maximum)\s*(?:de\s+|[:=])?\s*(\d+(?:[.,]\d+)?)\s*m(?!\s*(?:²|2))/gi,
    /(\d+(?:[.,]\d+)?)\s*m(?!\s*(?:²|2))\s*(?:de\s+)?hauteur\s+max/gi,
    /h\.?\s*max\.?\s*[:=]?\s*(\d+(?:[.,]\d+)?)\s*m(?!\s*(?:²|2))/gi,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      const numMatch = match[0].match(/(\d+(?:[.,]\d+)?)/);
      if (numMatch) {
        return parseFrenchDecimal(numMatch[1]);
      }
    }
  }
  return null;
}

function extractEmpriseSol(text) {
  if (!text) return null;
  const patterns = [
    /emprise\s+(?:au\s+)?sol\s*(?:maximale?|max\.?|maximum)?\s*(?:de\s+|[:=])?\s*(\d+(?:[.,]\d+)?)\s*%/gi,
    /(\d+(?:[.,]\d+)?)\s*%\s*(?:d[''])?emprise/gi,
    /ces?\s*[:=]?\s*(\d+(?:[.,]\d+)?)\s*%/gi,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      const numMatch = match[0].match(/(\d+(?:[.,]\d+)?)/);
      if (numMatch) {
        const val = parseFrenchDecimal(numMatch[1]);
        if (val !== null) {
          return val > 1 ? val / 100 : val;
        }
      }
    }
  }
  return null;
}

function cleanNote(text, maxLen = 200) {
  if (!text) return null;
  const cleaned = text.trim().replace(/\s+/g, " ");
  if (cleaned.length <= maxLen) return cleaned;
  return cleaned.slice(0, maxLen - 3) + "...";
}

// ─────────────────────────────────────────────────────────────────────────────
// PDF FETCH
// ─────────────────────────────────────────────────────────────────────────────

async function fetchPdfBuffer(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} fetching PDF`);
  }
  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

// ─────────────────────────────────────────────────────────────────────────────
// ZONE DISCOVERY (REGEX-FIRST)
// ─────────────────────────────────────────────────────────────────────────────

function discoverZonesRegex(text) {
  const zonePatterns = [
    /\b(U[A-Z]{1,2}[a-z]?)\b/g,
    /\b([1-9]AU[a-z]?)\b/g,
    /\bZONE\s+(U[A-Z]{1,2}[a-z]?)\b/gi,
    /\bZONE\s+([1-9]AU[a-z]?)\b/gi,
    /\bZONE\s+(A[a-z]?)\b/gi,
    /\bZONE\s+(N[a-z]?)\b/gi,
    /\b(A)\s+[-–]\s+Zone\s+agricole/gi,
    /\b(N)\s+[-–]\s+Zone\s+naturelle/gi,
  ];

  const found = new Set();
  
  for (const pattern of zonePatterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const code = match[1].toUpperCase().replace(/\s+/g, "");
      if (code.length >= 1 && code.length <= 5) {
        found.add(code);
      }
    }
  }

  // Filter out false positives
  const validZones = Array.from(found).filter((z) => {
    if (/^U[A-Z]{1,2}[A-Z]?$/.test(z)) return true;
    if (/^[1-9]AU[A-Z]?$/.test(z)) return true;
    if (/^(A|N)[A-Z]?$/.test(z) && z.length <= 2) return true;
    return false;
  });

  return validZones.slice(0, 15);
}

function extractPluVersionLabel(text) {
  const patterns = [
    /PLU\s+(?:de\s+)?([A-ZÀ-Ÿ][a-zà-ÿ]+(?:\s+[A-ZÀ-Ÿ][a-zà-ÿ]+)?)\s*[-–]?\s*(20\d{2})/gi,
    /(?:approuvé|approbation)\s+(?:le\s+)?(\d{1,2}\s+\w+\s+)?(20\d{2})/gi,
    /PLU\s+(20\d{2})/gi,
    /révision\s+n°?\s*\d+\s*[-–]?\s*(20\d{2})/gi,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      return cleanNote(match[0], 100);
    }
  }
  return null;
}

async function discoverZonesLLM(text, openaiClient) {
  const start = text.slice(0, 10000);
  const mid = text.slice(Math.floor(text.length / 2) - 5000, Math.floor(text.length / 2) + 5000);
  const end = text.slice(-10000);
  const excerpt = `${start}\n\n[...]\n\n${mid}\n\n[...]\n\n${end}`;

  const systemPrompt = `Tu es un extracteur de zones PLU.
À partir d'un extrait de PLU, renvoie UNIQUEMENT un JSON:
{
  "plu_version_label": string|null,
  "zones": [{"zone_code": "UA", "zone_libelle": string|null}, ...]
}
- zone_code: codes simples (UA, UB, UC, 1AU, 2AU, A, N, etc.)
- Maximum 15 zones.
- Si pas trouvé, renvoie zones: []
- Pas de texte avant/après, uniquement le JSON.`;

  const completion = await openaiClient.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: excerpt },
    ],
    response_format: { type: "json_object" },
    temperature: 0,
    max_tokens: 2000,
  });

  const raw = completion.choices[0]?.message?.content;
  try {
    const parsed = JSON.parse(raw);
    return {
      plu_version_label: parsed.plu_version_label || null,
      zones: Array.isArray(parsed.zones) ? parsed.zones.slice(0, 15) : [],
    };
  } catch {
    return { plu_version_label: null, zones: [] };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ARTICLE EXTRACTION
// ─────────────────────────────────────────────────────────────────────────────

function findArticleExcerpt(text, articleNum, zoneCode, windowSize = 5000) {
  const textLower = text.toLowerCase();
  const zoneCodeLower = zoneCode.toLowerCase();

  const articlePatterns = [
    new RegExp(`article\\s+${articleNum}\\b`, "gi"),
    new RegExp(`art\\.?\\s*${articleNum}\\b`, "gi"),
    new RegExp(`${articleNum}\\s*[-–:]\\s*`, "gi"),
  ];

  const zonePatterns = [
    new RegExp(`zone\\s+${zoneCodeLower}\\b`, "gi"),
    new RegExp(`\\b${zoneCodeLower}\\s+[-–]`, "gi"),
    new RegExp(`\\b${zoneCodeLower}\\b`, "gi"),
  ];

  // Find zone boundaries first
  let zoneStart = -1;
  let zoneEnd = text.length;

  for (const zp of zonePatterns) {
    const match = zp.exec(textLower);
    if (match) {
      zoneStart = match.index;
      break;
    }
  }

  if (zoneStart === -1) {
    zoneStart = 0;
  }

  // Find next zone after this one
  const allZoneCodes = ["UA", "UB", "UC", "UD", "UE", "UF", "UG", "UH", "UI", "UJ", "UK", "UL", "UM", "UN", "1AU", "2AU"];
  for (const otherZone of allZoneCodes) {
    if (otherZone.toLowerCase() === zoneCodeLower) continue;
    const nextZonePattern = new RegExp(`\\bzone\\s+${otherZone}\\b`, "gi");
    nextZonePattern.lastIndex = zoneStart + 100;
    const match = nextZonePattern.exec(textLower);
    if (match && match.index < zoneEnd) {
      zoneEnd = match.index;
    }
  }

  const zoneText = text.slice(zoneStart, zoneEnd);

  // Find article within zone text
  for (const ap of articlePatterns) {
    ap.lastIndex = 0;
    const match = ap.exec(zoneText.toLowerCase());
    if (match) {
      const articleStart = match.index;
      const excerptStart = Math.max(0, articleStart - 200);
      const excerptEnd = Math.min(zoneText.length, articleStart + windowSize);
      return zoneText.slice(excerptStart, excerptEnd);
    }
  }

  return "";
}

function buildZoneExcerpts(fullText, zoneCode) {
  const article6 = findArticleExcerpt(fullText, "6", zoneCode, 4000);
  const article7 = findArticleExcerpt(fullText, "7", zoneCode, 4000);
  const article12 = findArticleExcerpt(fullText, "12", zoneCode, 4000);
  const article10 = findArticleExcerpt(fullText, "10", zoneCode, 3000);
  const article9 = findArticleExcerpt(fullText, "9", zoneCode, 3000);

  // Fallback: extract around zone mention
  let fallback = "";
  const zonePattern = new RegExp(`zone\\s+${zoneCode}\\b`, "gi");
  const match = zonePattern.exec(fullText.toLowerCase());
  if (match) {
    const start = Math.max(0, match.index - 500);
    const end = Math.min(fullText.length, match.index + 6000);
    fallback = fullText.slice(start, end);
  }

  return {
    zone_code: zoneCode,
    extrait_article_6: article6.slice(0, 6000),
    extrait_article_7: article7.slice(0, 6000),
    extrait_article_10: article10.slice(0, 4000),
    extrait_article_12: article12.slice(0, 6000),
    extrait_article_9: article9.slice(0, 4000),
    fallback_context: fallback.slice(0, 4000),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// LLM ZONE EXTRACTION
// ─────────────────────────────────────────────────────────────────────────────

async function extractZoneRulesLLM(openaiClient, zoneCode, zoneLibelle, excerpts) {
  const systemPrompt = `Tu es un extracteur de règles PLU pour UNE SEULE zone.
Renvoie UNIQUEMENT un JSON valide avec ce format EXACT:

{
  "zone_code": "${zoneCode}",
  "zone_libelle": string|null,
  "reculs": {
    "voirie": { "regle": "FIXED"|"H_OVER_2"|"H_OVER_2_MIN"|null, "min_m": number|null, "note": string|null },
    "limites_separatives": { "regle": "FIXED"|"H_OVER_2"|"H_OVER_2_MIN"|null, "min_m": number|null, "note": string|null },
    "fond_parcelle": { "regle": "FIXED"|"H_OVER_2"|"H_OVER_2_MIN"|null, "min_m": number|null, "note": string|null },
    "implantation_en_limite": { "autorisee": boolean|null, "note": string|null }
  },
  "stationnement": {
    "places_par_logement": number|null,
    "surface_par_place_m2": number|null,
    "places_par_100m2": number|null,
    "note": string|null
  },
  "hauteur": { "hauteur_max_m": number|null, "note": string|null },
  "emprise_sol": { "emprise_sol_max": number|null, "note": string|null },
  "articles_source": string[]
}

RÈGLES STRICTES:
- regle: "FIXED" si distance fixe, "H_OVER_2" si H/2, "H_OVER_2_MIN" si H/2 avec minimum
- min_m: distance en mètres (nombre), pas de texte
- emprise_sol_max: décimal (0.6 = 60%)
- Si information absente: mettre null, JAMAIS "Non spécifié" ou chaîne vide
- note: phrase source courte (max 150 chars), sinon null
- articles_source: ["Article 6", "Article 7", etc.] si identifiables`;

  const userPrompt = `Zone: ${zoneCode}${zoneLibelle ? ` (${zoneLibelle})` : ""}

ARTICLE 6 (implantation/voirie):
${excerpts.extrait_article_6 || "(non trouvé)"}

ARTICLE 7 (limites séparatives):
${excerpts.extrait_article_7 || "(non trouvé)"}

ARTICLE 9 (emprise au sol):
${excerpts.extrait_article_9 || "(non trouvé)"}

ARTICLE 10 (hauteur):
${excerpts.extrait_article_10 || "(non trouvé)"}

ARTICLE 12 (stationnement):
${excerpts.extrait_article_12 || "(non trouvé)"}

CONTEXTE SUPPLÉMENTAIRE:
${excerpts.fallback_context || "(aucun)"}`;

  const completion = await openaiClient.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt.slice(0, 28000) },
    ],
    response_format: { type: "json_object" },
    temperature: 0,
    max_tokens: 2000,
  });

  const raw = completion.choices[0]?.message?.content;
  return JSON.parse(raw);
}

// ─────────────────────────────────────────────────────────────────────────────
// POST-PROCESSING
// ─────────────────────────────────────────────────────────────────────────────

function postProcessRecul(recul) {
  if (!recul) return { regle: null, min_m: null, note: null };

  let { regle, min_m, note } = recul;
  note = cleanNote(note);

  if (min_m === null && note) {
    min_m = extractMinimumMeters(note) || extractMetersValue(note);
  }

  if (regle === null && note) {
    regle = detectRegleType(note);
  }

  if (regle === "H_OVER_2" && min_m !== null) {
    regle = "H_OVER_2_MIN";
  }

  return { regle, min_m, note };
}

function postProcessImplantationLimite(impl) {
  if (!impl) return { autorisee: null, note: null };

  let { autorisee, note } = impl;
  note = cleanNote(note);

  if (autorisee === null && note) {
    const lower = note.toLowerCase();
    if (/autoris[ée]|permis|possible|admis/i.test(lower) && !/non\s+autoris/i.test(lower)) {
      autorisee = true;
    } else if (/interdit|non\s+autoris|pas\s+autoris/i.test(lower)) {
      autorisee = false;
    }
  }

  return { autorisee, note };
}

function postProcessStationnement(stat) {
  if (!stat) return { places_par_logement: null, surface_par_place_m2: null, places_par_100m2: null, note: null };

  let { places_par_logement, surface_par_place_m2, places_par_100m2, note } = stat;
  note = cleanNote(note);

  if (places_par_logement === null && note) {
    places_par_logement = extractPlacesParLogement(note);
  }
  if (surface_par_place_m2 === null && note) {
    surface_par_place_m2 = extractSurfaceParPlace(note);
  }
  if (places_par_100m2 === null && note) {
    places_par_100m2 = extractPlacesPar100m2(note);
  }

  return { places_par_logement, surface_par_place_m2, places_par_100m2, note };
}

function postProcessHauteur(haut) {
  if (!haut) return { hauteur_max_m: null, note: null };

  let { hauteur_max_m, note } = haut;
  note = cleanNote(note);

  if (hauteur_max_m === null && note) {
    hauteur_max_m = extractHauteurMax(note);
  }

  return { hauteur_max_m, note };
}

function postProcessEmprise(emp) {
  if (!emp) return { emprise_sol_max: null, note: null };

  let { emprise_sol_max, note } = emp;
  note = cleanNote(note);

  if (emprise_sol_max === null && note) {
    emprise_sol_max = extractEmpriseSol(note);
  }

  if (emprise_sol_max !== null && emprise_sol_max > 1) {
    emprise_sol_max = emprise_sol_max / 100;
  }

  return { emprise_sol_max, note };
}

function postProcessZoneRuleset(raw, zoneCode, zoneLibelle) {
  const ruleset = {
    zone_code: raw.zone_code || zoneCode,
    zone_libelle: raw.zone_libelle || zoneLibelle || null,
    reculs: {
      voirie: postProcessRecul(raw.reculs?.voirie),
      limites_separatives: postProcessRecul(raw.reculs?.limites_separatives),
      fond_parcelle: postProcessRecul(raw.reculs?.fond_parcelle),
      implantation_en_limite: postProcessImplantationLimite(raw.reculs?.implantation_en_limite),
    },
    stationnement: postProcessStationnement(raw.stationnement),
    hauteur: postProcessHauteur(raw.hauteur),
    emprise_sol: postProcessEmprise(raw.emprise_sol),
    articles_source: Array.isArray(raw.articles_source) ? raw.articles_source : [],
  };

  return ruleset;
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN ENDPOINT
// ─────────────────────────────────────────────────────────────────────────────

app.post("/api/plu-parse", async (req, res) => {
  const warnings = [];
  const meta = {
    zones_detected: 0,
    zones_processed: 0,
    used_discovery: "regex",
    target_zone_mode: false,
    target_zone_code: null,
    target_zone_found_in_discovery: false,
    warnings: [],
  };

  try {
    // 1️⃣ Auth
    const authHeader = req.headers["authorization"] || "";
    const token = authHeader.replace("Bearer ", "").trim();

    if (!SERVER_PARSER_KEY || token !== SERVER_PARSER_KEY) {
      return res.status(401).json({ success: false, error: "UNAUTHORIZED" });
    }

    const { commune_insee, commune_nom, source_pdf_url, target_zone_code: rawTargetZone } = req.body || {};

    if (!commune_insee || !source_pdf_url) {
      return res.status(400).json({ success: false, error: "MISSING_PARAMS" });
    }

    // Normalize target_zone_code if provided
    const targetZoneCode = normalizeZoneCode(rawTargetZone);
    const isTargetZoneMode = !!targetZoneCode;

    if (isTargetZoneMode) {
      meta.target_zone_mode = true;
      meta.target_zone_code = targetZoneCode;
      console.log(`[PLU-PARSER] 🎯 TARGET_ZONE_MODE: ${targetZoneCode}`);
    }

    console.log(`[PLU-PARSER] Commune ${commune_nom || "?"} (${commune_insee}) - PDF:`, source_pdf_url);

    // 2️⃣ Fetch PDF
    let pdfBuffer;
    try {
      pdfBuffer = await fetchPdfBuffer(source_pdf_url);
    } catch (err) {
      console.error("[PLU-PARSER] PDF fetch error:", err.message);
      return res.status(502).json({
        success: false,
        error: "PDF_FETCH_ERROR",
        message: err.message,
      });
    }

    // 3️⃣ Extract text
    let fullText;
    try {
      const pdfData = await pdf(pdfBuffer);
      fullText = normalizeText(pdfData.text || "");
    } catch (err) {
      console.error("[PLU-PARSER] PDF parse error:", err.message);
      return res.status(500).json({
        success: false,
        error: "PDF_PARSE_ERROR",
        message: err.message,
      });
    }

    if (!fullText || fullText.length < 100) {
      return res.status(400).json({
        success: false,
        error: "PDF_EMPTY_OR_UNREADABLE",
      });
    }

    console.log(`[PLU-PARSER] Extracted ${fullText.length} chars`);

    // 4️⃣ Discovery: zones + plu_version_label
    let discoveredZones = [];
    let plu_version_label = extractPluVersionLabel(fullText);

    // Try regex first
    const regexZones = discoverZonesRegex(fullText);
    
    if (regexZones.length > 0) {
      discoveredZones = regexZones.map((code) => ({ zone_code: code, zone_libelle: null }));
      meta.used_discovery = "regex";
      console.log(`[PLU-PARSER] Regex discovered ${discoveredZones.length} zones:`, regexZones);
    } else {
      // Fallback to LLM discovery
      console.log("[PLU-PARSER] Regex found no zones, using LLM discovery...");
      try {
        const discovery = await discoverZonesLLM(fullText, openai);
        discoveredZones = discovery.zones || [];
        plu_version_label = plu_version_label || discovery.plu_version_label;
        meta.used_discovery = "llm";
        console.log(`[PLU-PARSER] LLM discovered ${discoveredZones.length} zones`);
      } catch (err) {
        console.error("[PLU-PARSER] LLM discovery error:", err.message);
        warnings.push("LLM_DISCOVERY_FAILED");
      }
    }

    meta.zones_detected = discoveredZones.length;

    // 5️⃣ Determine zones to process
    let zonesToProcess = [];

    if (isTargetZoneMode) {
      // TARGET ZONE MODE: only process the target zone
      const foundInDiscovery = discoveredZones.find(
        (z) => normalizeZoneCode(z.zone_code) === targetZoneCode
      );

      if (foundInDiscovery) {
        meta.target_zone_found_in_discovery = true;
        zonesToProcess = [foundInDiscovery];
        console.log(`[PLU-PARSER] 🎯 Target zone ${targetZoneCode} FOUND in discovery`);
      } else {
        // Target zone not found in discovery, but we still try to extract it
        meta.target_zone_found_in_discovery = false;
        zonesToProcess = [{ zone_code: targetZoneCode, zone_libelle: null }];
        console.log(`[PLU-PARSER] 🎯 Target zone ${targetZoneCode} NOT in discovery, attempting extraction anyway`);
        warnings.push(`TARGET_ZONE_NOT_IN_DISCOVERY: ${targetZoneCode}`);
      }
    } else {
      // STANDARD MODE: process all discovered zones (up to 12)
      if (discoveredZones.length === 0) {
        return res.status(200).json({
          success: false,
          error: "NO_ZONES_FOUND",
          commune_insee,
          commune_nom: commune_nom || null,
          plu_version_label,
          source_document: source_pdf_url,
          zones_rulesets: [],
          meta: { ...meta, warnings },
        });
      }

      zonesToProcess = discoveredZones;

      // Limit to 12 zones in standard mode
      if (zonesToProcess.length > 12) {
        warnings.push(`ZONES_TRUNCATED: ${zonesToProcess.length} detected, processing first 12`);
        zonesToProcess = zonesToProcess.slice(0, 12);
      }
    }

    // 6️⃣ Process zones
    const zones_rulesets = [];

    for (const zoneInfo of zonesToProcess) {
      const { zone_code, zone_libelle } = zoneInfo;
      console.log(`[PLU-PARSER] Processing zone ${zone_code}...`);

      try {
        // Build excerpts
        const excerpts = buildZoneExcerpts(fullText, zone_code);

        // Log excerpt lengths for target zone mode
        if (isTargetZoneMode) {
          console.log(`[PLU-PARSER] 🎯 Excerpts for ${zone_code}:`);
          console.log(`  - Article 6: ${excerpts.extrait_article_6.length} chars`);
          console.log(`  - Article 7: ${excerpts.extrait_article_7.length} chars`);
          console.log(`  - Article 12: ${excerpts.extrait_article_12.length} chars`);
          console.log(`  - Article 9: ${excerpts.extrait_article_9.length} chars`);
          console.log(`  - Article 10: ${excerpts.extrait_article_10.length} chars`);
          console.log(`  - Fallback: ${excerpts.fallback_context.length} chars`);
        }

        // LLM extraction
        const rawRuleset = await extractZoneRulesLLM(openai, zone_code, zone_libelle, excerpts);

        // Post-process
        const ruleset = postProcessZoneRuleset(rawRuleset, zone_code, zone_libelle);

        zones_rulesets.push({
          zone_code,
          zone_libelle: ruleset.zone_libelle,
          ruleset,
        });

        meta.zones_processed++;
      } catch (err) {
        console.error(`[PLU-PARSER] Zone ${zone_code} LLM error:`, err.message);
        warnings.push(`ZONE_${zone_code}_LLM_FAILED`);

        // Add a failed zone with null values
        zones_rulesets.push({
          zone_code,
          zone_libelle: zone_libelle || null,
          ruleset: {
            zone_code,
            zone_libelle: zone_libelle || null,
            reculs: {
              voirie: { regle: null, min_m: null, note: "LLM_FAILED" },
              limites_separatives: { regle: null, min_m: null, note: "LLM_FAILED" },
              fond_parcelle: { regle: null, min_m: null, note: "LLM_FAILED" },
              implantation_en_limite: { autorisee: null, note: "LLM_FAILED" },
            },
            stationnement: { places_par_logement: null, surface_par_place_m2: null, places_par_100m2: null, note: "LLM_FAILED" },
            hauteur: { hauteur_max_m: null, note: "LLM_FAILED" },
            emprise_sol: { emprise_sol_max: null, note: "LLM_FAILED" },
            articles_source: [],
          },
        });
      }
    }

    meta.warnings = warnings;

    // 7️⃣ Return result
    const success = zones_rulesets.some(
      (z) => z.ruleset && !z.ruleset.reculs?.voirie?.note?.includes("LLM_FAILED")
    );

    return res.json({
      success,
      commune_insee,
      commune_nom: commune_nom || null,
      plu_version_label,
      source_document: source_pdf_url,
      zones_rulesets,
      meta,
    });
  } catch (err) {
    console.error("[PLU-PARSER] Unexpected error:", err);
    return res.status(500).json({
      success: false,
      error: "PLU_PARSER_INTERNAL_ERROR",
      message: err instanceof Error ? err.message : String(err),
    });
  }
});

app.listen(PORT, () => {
  console.log(`✅ PLU parser server listening on port ${PORT}`);
});