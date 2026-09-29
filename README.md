# myro-veille

Veille externe et gratuite des funnels Myro, indépendante du VPS : GitHub Actions lance `veille.mjs` toutes les 10 min (Node 20, aucune dépendance).

## Ce qui est surveillé
| id | URL | attendu |
|---|---|---|
| `corsetti-freecourse` / `nabil-freecourse` | `/freecourse` | 200, ≤ 1 redirection, tag `formation.js` + `/evergreen/comportements.js` |
| `corsetti-webinaire` / `nabil-webinaire` | `/webinaire` | 200, tag `webinaire.js` + `/wb/v2/comportements.js` |
| `corsetti-business` / `nabil-business` | `/business` | 200, `id="root"`, et le script `/assets/index-….js` répond 200 (relais Lovable) |
| `myro-kpi` | https://myro-kpi.vercel.app/ | 200 final sur `/login`, « Connexion · Myro » |
| `battement-vps` | variable `BATTEMENT_VPS` | seulement si `BATTEMENT_ACTIF=1` : `<ISO8601> ok`, âge ≤ 15 min |
| `url-test` | variable `URL_TEST_PANNE` | seulement si non vide : 200 |

Redirections suivies à la main (max 5, boucle détectée), délai 20 s, une erreur réseau est retentée une fois après 10 s.

## Alertes
Une panne ouvre une issue `[id] EN PANNE — motif` (label `incident`), envoie un e-mail (Resend) et fait échouer le run (e-mail « Run failed » de GitHub). Tant que l'issue est ouverte : aucune nouvelle alerte. Au retour : commentaire « Rétabli », issue fermée, e-mail « rétabli ».

## Simuler une panne
```
gh variable set URL_TEST_PANNE --body https://httpbin.org/status/503 --repo zwaxzwax6-spec/myro-veille
gh workflow run veille.yml --repo zwaxzwax6-spec/myro-veille
# puis pour rétablir :
gh variable set URL_TEST_PANNE --body "" --repo zwaxzwax6-spec/myro-veille
```

## Couper
`gh workflow disable veille.yml --repo zwaxzwax6-spec/myro-veille` (et `enable` pour relancer).

## Tests
`node --test`
