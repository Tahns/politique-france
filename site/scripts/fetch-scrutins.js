#!/usr/bin/env node
/**
 * fetch-scrutins.js
 * ------------------
 * Récupère les nouveaux scrutins publiés par l'Assemblée nationale (open data officiel)
 * et met à jour data/lois.json avec le détail des votes par groupe.
 *
 * SOURCE OFFICIELLE (aucune donnée inventée) :
 *   https://data.assemblee-nationale.fr/static/openData/repository/17/loi/scrutins/Scrutins.json.zip
 *   Licence ouverte Etalab.
 *
 * PRINCIPE DE SÉCURITÉ (important) : ce script ne fait JAMAIS confiance à sa propre lecture
 * du JSON sans vérification. Pour chaque scrutin, la somme des votes qu'il extrait par groupe
 * est recomparée à la synthèse officielle du scrutin (pour/contre/abstentions). Si ça ne
 * correspond pas exactement, le scrutin est REJETÉ et signalé dans le rapport plutôt que publié
 * avec un chiffre potentiellement faux — cohérent avec la règle du site : jamais de données
 * inventées ou approximatives.
 *
 * USAGE :
 *   node scripts/fetch-scrutins.js              # récupère et met à jour data/lois.json
 *   node scripts/fetch-scrutins.js --dry-run     # affiche ce qui serait ajouté, sans écrire
 *   node scripts/fetch-scrutins.js --limit=20    # ne traite que les 20 scrutins les + récents
 *
 * DÉPENDANCES : Node.js 18+ (fetch natif), aucun paquet npm requis.
 */

import { readFile, writeFile, mkdtemp } from "fs/promises";
import { createWriteStream, existsSync } from "fs";
import path from "path";
import os from "os";
import { pipeline } from "stream/promises";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

const SCRUTINS_ZIP_URL =
  "https://data.assemblee-nationale.fr/static/openData/repository/17/loi/scrutins/Scrutins.json.zip";

const DATA_FILE = path.resolve("data/lois.json");
const REPORT_FILE = path.resolve("data/fetch-scrutins-report.json");

// Table de correspondance entre le sigle officiel du groupe (tel que publié par l'AN)
// et l'identifiant court utilisé sur le site. À ajuster si l'AN change un sigle
// (ex. en cas de scission/fusion de groupe) — le script log un avertissement pour tout
// sigle rencontré qui n'est pas dans cette table, plutôt que de l'ignorer silencieusement.
const SIGLE_VERS_ID = {
  "RN": "RN",
  "EPR": "EPR",
  "REN": "EPR", // ancien sigle Renaissance, gardé en compatibilité
  "LFI-NFP": "LFI",
  "LFI": "LFI",
  "SOC": "SOC",
  "DR": "LR",
  "LR": "LR",
  "ECOS": "ECO",
  "ECOLO": "ECO",
  "DEM": "DEM",
  "HOR": "HOR",
  "GDR": "GDR",
  "LIOT": "LIOT",
  "UDR": "UDR",
  "NI": "NI",
};

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const LIMIT_ARG = args.find((a) => a.startsWith("--limit="));
const LIMIT = LIMIT_ARG ? parseInt(LIMIT_ARG.split("=")[1], 10) : Infinity;

function log(...m) {
  console.log("[fetch-scrutins]", ...m);
}
function warn(...m) {
  console.warn("[fetch-scrutins][ATTENTION]", ...m);
}

async function downloadAndExtract(url, destDir) {
  const zipPath = path.join(destDir, "scrutins.zip");
  log("Téléchargement :", url);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Échec du téléchargement (${res.status} ${res.statusText}) — l'URL a peut-être changé, vérifier data.assemblee-nationale.fr/opendata`);
  }
  await pipeline(res.body, createWriteStream(zipPath));
  log("Décompression…");
  // Utilise l'utilitaire `unzip` du système (présent sur les runners GitHub Actions ubuntu-latest)
  await execFileAsync("unzip", ["-q", "-o", zipPath, "-d", destDir]);
  return destDir;
}

async function listScrutinFiles(dir) {
  const { stdout } = await execFileAsync("find", [dir, "-name", "*.json", "-type", "f"]);
  return stdout.split("\n").filter(Boolean);
}

function moisFr(m) {
  const mois = ["janvier","février","mars","avril","mai","juin","juillet","août","septembre","octobre","novembre","décembre"];
  return mois[m];
}

function formatDateFr(isoDate) {
  const d = new Date(isoDate);
  return `${d.getDate()} ${moisFr(d.getMonth())} ${d.getFullYear()}`;
}

/**
 * Extrait le détail par groupe d'un objet scrutin brut (JSON tel que publié par l'AN),
 * et vérifie que la somme recalculée correspond à la synthèse officielle.
 * Retourne { ok: true, votes, ... } ou { ok: false, raison }.
 */
function parseScrutin(raw) {
  const s = raw.scrutin;
  if (!s) return { ok: false, raison: "pas de clé 'scrutin' à la racine" };

  const numero = s.numero;
  const dateScrutin = s.dateScrutin;
  const titre = s.titre || s.objet?.libelle || "(titre non renseigné)";
  const synthese = s.syntheseVote?.decompte;
  if (!synthese) return { ok: false, raison: `scrutin ${numero} : pas de syntheseVote.decompte officielle, on ne publie pas` };

  const officiel = {
    pour: parseInt(synthese.pour, 10) || 0,
    contre: parseInt(synthese.contre, 10) || 0,
    abstentions: parseInt(synthese.abstentions, 10) || 0,
  };

  const groupesRaw = s.ventilationVotes?.organe?.groupes?.groupe;
  if (!groupesRaw) return { ok: false, raison: `scrutin ${numero} : pas de détail par groupe disponible dans ce fichier` };
  const groupesArr = Array.isArray(groupesRaw) ? groupesRaw : [groupesRaw];

  const votes = {};
  const sigleInconnus = [];
  let sommePour = 0, sommeContre = 0, sommeAbst = 0;

  for (const g of groupesArr) {
    const sigle = g.organeRef ? undefined : undefined; // le sigle n'est pas toujours inline
    // Selon les exports AN, le sigle peut être en g.groupe.sigle ou nécessiter une table organeRef -> sigle.
    // On tente les emplacements connus ; si aucun ne fonctionne, on loggue le organeRef brut pour investigation.
    const sigleTrouve = g.sigle || g.organe?.libelleAbrev || g.libelleAbrev || null;
    const decompte = g.vote?.decompteVoix || g.decompteVoix;
    if (!sigleTrouve || !decompte) {
      sigleInconnus.push(g.organeRef || JSON.stringify(g).slice(0, 80));
      continue;
    }
    const id = SIGLE_VERS_ID[sigleTrouve];
    if (!id) {
      warn(`Sigle de groupe non reconnu : "${sigleTrouve}" (scrutin ${numero}) — ajouter dans SIGLE_VERS_ID si c'est un nouveau groupe légitime`);
      sigleInconnus.push(sigleTrouve);
      continue;
    }
    const pour = parseInt(decompte.pour, 10) || 0;
    const contre = parseInt(decompte.contre, 10) || 0;
    const abst = parseInt(decompte.abstention ?? decompte.abstentions, 10) || 0;
    votes[id] = { pour, contre, abst };
    sommePour += pour;
    sommeContre += contre;
    sommeAbst += abst;
  }

  // Garde-fou : si des groupes n'ont pas pu être identifiés, on ne publie pas silencieusement
  // un scrutin incomplet — mieux vaut le signaler et attendre une correction de la table de sigles.
  if (sigleInconnus.length > 0) {
    return { ok: false, raison: `scrutin ${numero} : groupes non résolus (${sigleInconnus.join(", ")}) — table SIGLE_VERS_ID à compléter` };
  }

  // Garde-fou principal : recoupement avec la synthèse officielle du scrutin.
  if (sommePour !== officiel.pour || sommeContre !== officiel.contre || sommeAbst !== officiel.abstentions) {
    return {
      ok: false,
      raison: `scrutin ${numero} : somme par groupe (${sommePour}/${sommeContre}/${sommeAbst}) ≠ synthèse officielle (${officiel.pour}/${officiel.contre}/${officiel.abstentions}) — rejeté plutôt que publié avec un écart`,
    };
  }

  return {
    ok: true,
    id: `an-scrutin-${numero}`,
    titre,
    date: formatDateFr(dateScrutin),
    dateISO: dateScrutin,
    resultat: /adopt/i.test(s.sort || s.syntheseVote?.decision?.texte || "") ? "adopte" : "rejete",
    theme: "À catégoriser", // pas de thème officiel fourni par l'AN — à corriger manuellement dans data/lois.json si besoin
    reel: true,
    source: "auto-assemblee-nationale",
    sourceLabel: `Assemblée nationale — scrutin n°${numero}`,
    sourceUrl: `https://www.assemblee-nationale.fr/dyn/17/scrutins/${numero}`,
    proposePar: "Non renseigné automatiquement — à compléter manuellement dans data/lois.json",
    groupeMoteur: "Non renseigné automatiquement — à compléter manuellement dans data/lois.json",
    votes,
  };
}

async function main() {
  log(DRY_RUN ? "Mode dry-run (aucune écriture)" : "Mode normal");

  const existing = JSON.parse(await readFile(DATA_FILE, "utf-8").catch(() => '{"lois":[]}'));
  const existingIds = new Set(existing.lois.map((l) => l.id));

  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "an-scrutins-"));
  await downloadAndExtract(SCRUTINS_ZIP_URL, tmpDir);
  const files = await listScrutinFiles(tmpDir);
  log(`${files.length} fichiers de scrutins trouvés dans l'archive.`);

  const nouveaux = [];
  const rejets = [];
  let traites = 0;

  // Les fichiers ne sont pas garantis triés ; on trie par nom (les numéros de scrutin
  // croissent globalement avec le temps sur une législature donnée).
  files.sort();

  for (const f of files.reverse()) { // du plus récent au plus ancien
    if (traites >= LIMIT) break;
    let raw;
    try {
      raw = JSON.parse(await readFile(f, "utf-8"));
    } catch (e) {
      rejets.push({ fichier: f, raison: `JSON illisible : ${e.message}` });
      continue;
    }
    const numero = raw?.scrutin?.numero;
    if (numero && existingIds.has(`an-scrutin-${numero}`)) continue; // déjà connu

    traites++;
    const parsed = parseScrutin(raw);
    if (!parsed.ok) {
      rejets.push({ fichier: f, raison: parsed.raison });
      continue;
    }
    nouveaux.push(parsed);
  }

  log(`${nouveaux.length} nouveau(x) scrutin(s) valide(s), ${rejets.length} rejeté(s) ou déjà connus.`);

  if (nouveaux.length > 0 && !DRY_RUN) {
    existing.lois.push(...nouveaux.map(({ dateISO, ...l }) => l));
    existing.lastUpdated = new Date().toISOString();
    await writeFile(DATA_FILE, JSON.stringify(existing, null, 2) + "\n");
    log("data/lois.json mis à jour.");
  }

  await writeFile(
    REPORT_FILE,
    JSON.stringify(
      {
        executedAt: new Date().toISOString(),
        dryRun: DRY_RUN,
        nouveaux: nouveaux.map((n) => ({ id: n.id, titre: n.titre, date: n.date })),
        rejets,
      },
      null,
      2
    ) + "\n"
  );
  log("Rapport écrit dans data/fetch-scrutins-report.json — à consulter en cas de rejets.");

  if (nouveaux.length === 0) {
    log("Aucun nouveau scrutin ajouté à cette exécution.");
  }
}

main().catch((e) => {
  console.error("[fetch-scrutins] ÉCHEC :", e);
  process.exitCode = 1;
});
