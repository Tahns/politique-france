# Décrypter la politique française — automatisation

Ce dossier contient le site (`index.html`) et l'infrastructure qui le met à jour
automatiquement à partir de sources officielles :

- **Assemblée nationale** (open data officiel) → `scripts/fetch-scrutins.js` → `data/lois.json`
- **INSEE** (API BDM officielle) → `scripts/fetch-insee.js` → `data/indicateurs.json`
- **GitHub Actions** (`.github/workflows/update-data.yml`) exécute les deux scripts chaque
  jour et republie automatiquement si de nouvelles données sont trouvées.

## Ce qui est déjà automatisable dès maintenant

- **Scrutins de l'Assemblée nationale** : entièrement automatisé. Le script rejette
  activement tout scrutin dont il n'arrive pas à vérifier la cohérence des chiffres
  (voir les commentaires dans `scripts/fetch-scrutins.js`) plutôt que de publier une
  donnée potentiellement fausse.
- **Chômage (INSEE)** : automatisé, idBank vérifié (`001688527`).

## Ce qui nécessite encore un peu de travail avant automatisation complète

- **Inflation, population, déficit, dette (INSEE)** : les idBank de ces séries ne sont
  pas encore renseignés dans `scripts/fetch-insee.js` (marqués `TODO` dans le fichier) —
  je n'ai pas voulu deviner un identifiant au risque de publier la mauvaise série.
  Pour les compléter : aller sur [insee.fr](https://www.insee.fr), chercher la série
  voulue (ex. "indice des prix à la consommation ensemble des ménages"), ouvrir sa page
  "Séries chronologiques", relever l'identifiant à 9 chiffres affiché en haut de page,
  et le coller dans le `idBank: null` correspondant.
- **Justice & politique** : volontairement laissé en mise à jour manuelle — distinguer une
  condamnation définitive d'un appel en cours demande un jugement humain qu'un script ne
  doit pas prendre à ma place.
- **Sondages, meetings** : pas de flux structuré officiel identifié ; mise à jour manuelle
  pour l'instant.

## Déploiement (à faire une fois)

1. **Créer un dépôt GitHub** (public ou privé) et y pousser tout ce dossier :
   ```bash
   git init
   git add .
   git commit -m "Site initial"
   git branch -M main
   git remote add origin https://github.com/<ton-compte>/<ton-repo>.git
   git push -u origin main
   ```

2. **Activer GitHub Pages** : Settings → Pages → Source = "Deploy from a branch" →
   branche `main`, dossier `/ (root)`. Le site sera alors accessible à une adresse du
   type `https://<ton-compte>.github.io/<ton-repo>/`.

3. **(Optionnel mais recommandé) Ajouter la clé INSEE** pour automatiser les indicateurs :
   - Créer un compte gratuit sur [portail-api.insee.fr](https://portail-api.insee.fr)
   - Souscrire à l'API **BDM V1**, générer une clé
   - Dans le dépôt GitHub : Settings → Secrets and variables → Actions → New repository
     secret → nom `INSEE_API_KEY`, valeur = la clé générée

4. **Vérifier que l'automatisation tourne** : onglet "Actions" du dépôt → le workflow
   "Mise à jour automatique des données" doit apparaître et pouvoir être lancé manuellement
   (bouton "Run workflow") pour un premier test, avant d'attendre le déclenchement quotidien.

## Tester en local avant de déployer

Le site utilise `fetch()` pour charger `data/lois.json` et `data/indicateurs.json` : ça ne
fonctionne pas en ouvrant simplement `index.html` depuis l'explorateur de fichiers (le
navigateur bloque les requêtes `fetch` sur `file://`). Il faut un petit serveur local :

```bash
npx serve .
# ou
python3 -m http.server 8000
```

puis ouvrir `http://localhost:8000` (ou le port indiqué).

Pour tester un script d'automatisation sans rien publier :
```bash
node scripts/fetch-scrutins.js --dry-run
INSEE_API_KEY=xxxx node scripts/fetch-insee.js --dry-run
```

## Principe général adopté sur ce site

Aucune valeur n'est jamais inventée ou estimée pour "avoir l'air complet". Une donnée
manquante ou non vérifiable est explicitement marquée comme telle (`null`, "non
communiqué", `idBank: null` avec un `TODO`) plutôt que remplacée par une approximation.
Merci de garder ce principe si vous étendez ce script.
