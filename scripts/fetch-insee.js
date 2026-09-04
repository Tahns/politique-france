#!/usr/bin/env node
/**
 * fetch-insee.js
 * --------------
 * Récupère les derniers points publiés pour une liste d'indicateurs INSEE (API BDM officielle)
 * et met à jour data/indicateurs.json.
 *
 * SOURCE OFFICIELLE : API BDM de l'Insee (https://portail-api.insee.fr), qui sert exactement
 * les mêmes séries que celles publiées sur insee.fr — aucune donnée recalculée ou estimée.
 *
 * PRÉREQUIS : une clé d'API Insee (gratuite). À obtenir sur https://portail-api.insee.fr
 * (créer un compte → souscrire à l'API "BDM V1" → générer une clé), puis la fournir via
 * la variable d'environnement INSEE_API_KEY (en local : fichier .env ; en CI : secret GitHub
 * "INSEE_API_KEY", voir .github/workflows/update-data.yml).
 *
 * IMPORTANT — HONNÊTETÉ SUR LA COUVERTURE ACTUELLE :
 * Seule la série "chômage" ci-dessous a un idBank vérifié avec certitude au moment de l'écriture
 * de ce script (001688527, page officielle : insee.fr/fr/statistiques/serie/001688527).
 * Les autres indicateurs du site (inflation, population, déficit, dette) n'ont PAS d'idBank
 * vérifié ici : plutôt que de deviner un identifiant et risquer de publier la mauvaise série,
 * ils sont laissés à compléter — voir INDICATEURS ci-dessous et le README.
 *
 * USAGE :
 *   INSEE_API_KEY=xxxx node scripts/fetch-insee.js
 *   INSEE_API_KEY=xxxx node scripts/fetch-insee.js --dry-run
 */

import { readFile, writeFile } from "fs/promises";
import path from "path";

const API_KEY = process.env.INSEE_API_KEY;
const DATA_FILE = path.resolve("data/indicateurs.json");
const BASE_URL = "https://api.insee.fr/series/BDM/V1/data/SERIES_BDM";

const DRY_RUN = process.argv.includes("--dry-run");

function log(...m) {
  console.log("[fetch-insee]", ...m);
}
function warn(...m) {
  console.warn("[fetch-insee][ATTENTION]", ...m);
}

// Chaque entrée décrit un indicateur affiché sur le site. `idBank: null` = pas encore vérifié,
// le script le signale et NE LE MET PAS À JOUR plutôt que de deviner.
const INDICATEURS = [
  {
    nom: "Chômage",
    idBank: "001688527",
    label: "Taux de chômage au sens du BIT — Ensemble, France hors Mayotte, données CVS",
    formatValeur: (v) => `${v.toFixed(1)} %`,
    sourceUrl: "https://www.insee.fr/fr/statistiques/serie/001688527",
  },
  {
    nom: "Inflation",
    idBank: null, // TODO : trouver l'idBank de l'IPC (glissement annuel) sur insee.fr et le renseigner ici
    label: "Indice des prix à la consommation, glissement annuel",
    formatValeur: (v) => `${v > 0 ? "+" : ""}${v.toFixed(1)} %`,
    sourceUrl: null,
  },
  {
    nom: "Population",
    idBank: null, // TODO : idBank population totale (estimations de population)
    label: "Population totale (estimations de population)",
    formatValeur: (v) => `${(v / 1e6).toFixed(2)} M`,
    sourceUrl: null,
  },
  {
    nom: "Déficit public",
    idBank: null, // TODO : idBank déficit public en % du PIB (comptes nationaux annuels)
    label: "Déficit public, en % du PIB",
    formatValeur: (v) => `${v.toFixed(1)} % du PIB`,
    sourceUrl: null,
  },
  {
    nom: "Dette publique",
    idBank: null, // TODO : idBank dette publique en % du PIB (comptes nationaux annuels)
    label: "Dette publique au sens de Maastricht, en % du PIB",
    formatValeur: (v) => `${v.toFixed(1)} % du PIB`,
    sourceUrl: null,
  },
];

async function fetchSerie(idBank) {
  const url = `${BASE_URL}/${idBank}?lastNObservations=1`;
  const res = await fetch(url, {
    headers: {
      Accept: "application/json",
      "X-INSEE-Api-Key-Integration": API_KEY,
    },
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText} pour idBank ${idBank}`);
  }
  const json = await res.json();

  // Format SDMX-JSON : la valeur et la période sont encodées par position dans
  // dataSets[0].series["0:0:0:..."].observations["0"] = [valeur, ...]
  // et structure.dimensions.observation[0].values[i].id donne la période correspondante.
  const dataset = json?.dataSets?.[0];
  const seriesKey = dataset && Object.keys(dataset.series || {})[0];
  const serie = seriesKey ? dataset.series[seriesKey] : null;
  const obsKeys = serie ? Object.keys(serie.observations || {}) : [];
  if (!serie || obsKeys.length === 0) {
    throw new Error(`Réponse inattendue ou vide pour idBank ${idBank} — vérifier le format à la main`);
  }
  const dernierIndex = obsKeys[obsKeys.length - 1];
  const valeur = serie.observations[dernierIndex][0];

  const periodeValues = json.structure?.dimensions?.observation?.[0]?.values;
  const periode = periodeValues?.[parseInt(dernierIndex, 10)]?.id || null;

  return { valeur: Number(valeur), periode };
}

async function main() {
  if (!API_KEY) {
    console.error(
      "[fetch-insee] ÉCHEC : variable d'environnement INSEE_API_KEY absente.\n" +
        "  → Créer une clé gratuite sur https://portail-api.insee.fr (souscrire à l'API BDM V1),\n" +
        "    puis la fournir en local (INSEE_API_KEY=... node scripts/fetch-insee.js)\n" +
        "    ou en CI (secret GitHub 'INSEE_API_KEY', voir README.md)."
    );
    process.exitCode = 1;
    return;
  }

  const existing = JSON.parse(
    await readFile(DATA_FILE, "utf-8").catch(() => '{"indicateurs":[]}')
  );
  const parIndex = new Map(existing.indicateurs.map((i) => [i.nom, i]));

  const aTraiter = INDICATEURS.filter((i) => i.idBank);
  const nonCouverts = INDICATEURS.filter((i) => !i.idBank);
  if (nonCouverts.length) {
    warn(
      `${nonCouverts.length} indicateur(s) sans idBank vérifié, non mis à jour automatiquement : ` +
        nonCouverts.map((i) => i.nom).join(", ") +
        " — voir les TODO dans ce script."
    );
  }

  for (const ind of aTraiter) {
    try {
      const { valeur, periode } = await fetchSerie(ind.idBank);
      log(`${ind.nom} : ${ind.formatValeur(valeur)} (période ${periode})`);
      const precedent = parIndex.get(ind.nom) || {};
      parIndex.set(ind.nom, {
        ...precedent, // conserve tendance/detail/motsCles déjà en place si le script ne les fournit pas
        nom: ind.nom,
        valeur: ind.formatValeur(valeur),
        date: periode,
        detail: ind.label,
        source: "INSEE (API BDM, automatique)",
        url: ind.sourceUrl || precedent.url || null,
        idBank: ind.idBank,
        misAJourLe: new Date().toISOString(),
      });
    } catch (e) {
      warn(`${ind.nom} : échec — ${e.message} (valeur précédente conservée si présente)`);
    }
  }

  const resultat = { indicateurs: Array.from(parIndex.values()), lastUpdated: new Date().toISOString() };

  if (DRY_RUN) {
    log("Dry-run — résultat qui aurait été écrit :");
    console.log(JSON.stringify(resultat, null, 2));
    return;
  }

  await writeFile(DATA_FILE, JSON.stringify(resultat, null, 2) + "\n");
  log("data/indicateurs.json mis à jour.");
}

main().catch((e) => {
  console.error("[fetch-insee] ÉCHEC :", e);
  process.exitCode = 1;
});
