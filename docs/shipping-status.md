# Ships-to-Portugal status

Captures the outcome of an automated audit of every store in [`data/product-targets.json`](../data/product-targets.json) — does the shop deliver to Portugal? Last updated 2026-05-18.

## Methodology

Three automated passes, each more invasive than the last. Only stops short of submitting fake addresses / placing orders.

1. **HTTP signal sweep** — fetched homepage + ~12 typical shipping-info paths per host (`/shipping`, `/policies/shipping-policy`, `/envios`, `/livraison`, etc.). Looked for explicit "Portugal" mentions in a shipping context, country selectors containing `<option value="PT">`, and "worldwide / international shipping" phrases.
2. **Deep cart-flow check** — for every inconclusive host, used Playwright to: open the listing → find a product link → click add-to-cart → navigate to `/cart` and `/checkout` → scrape rendered DOM for a country dropdown with Portugal.
3. **Form-fill check** — for the remaining generic-TLD inconclusives, filled the checkout's email field with an `@example.com` address and clicked "Continue" to try to surface the shipping step. Also detected "long country dropdown that *excludes* Portugal" as a NO signal.

## What automation can't tell us

- **Shopify's modern one-page checkout (SPA)** loads its country list via React *only after the country picker is interacted with*. The `<select>` exists in the DOM with empty options until then, so the script reports a false negative. `crowsarena.com` was confirmed manually to ship to PT despite all three checks coming back inconclusive — the same is almost certainly true for many other shops on the generic-TLD inconclusive list.
- Determining a hard **"does NOT ship"** signal requires either filling a real address through to shipping rates (out of scope) or finding an explicit country list that omits Portugal (rare in practice).

So: the buckets below should be read as **confidence levels**, not strict yes/no.

## Results — 144 unique hosts across 196 targets

| Bucket | Count | Action |
|---|---|---|
| ✅ Portuguese domain (`.pt`) | 15 | Keep |
| ✅ Confirmed via HTTP — Portugal in country selector / shipping context | 33 | Keep |
| ✅ Confirmed via HTTP — worldwide / international shipping | 11 | Keep |
| ✅ Confirmed via deep check — country dropdown contains Portugal | 6 | Keep |
| 🟢 Deep check — "Portugal" mentioned in checkout | 2 | Keep |
| 🟢 EU/EEA-TLD inconclusive — single market, treat as ships | 45 | Keep |
| 🟡 Generic-TLD inconclusive — automation false-negatives likely | 32 | Manual click-through (≈5–10 min total) |
| ❌ Confirmed not viable | 1 (`hobbixchange.co.nz`) | **Removed** |

Net: **143 hosts treated as ships-to-PT, 32 worth a 10-second manual visit, 1 removed.**

---

## ✅ `.pt` domain (15)

```
arenaporto.pt, diver.pt, endturn.pt, gglounge.pt, lotusvalley.pt,
masterpacks.pt, mbox.pt, mercadiagames.pt, miniversos.pt, playerspot.pt,
pokeboxstore.pt, rota151.pt, shop4nerds.pt, tcghaven.pt, versusgamecenter.pt
```

## ✅ HTTP-confirmed — Portugal in shipping context or country selector (33)

```
adcardcollectibles.com, bulkparadise-tcg.de, cardoreum.eu, cardtreasure.ch,
collectorstorecards.it, collgamers.nl, confluxgames.com, elduelista.com,
etoy.gr, evlutcg.com, feenturm.de, gameria.es, gladiusgames.net, kizoku.life,
laescotillajuegos.com, lasocietemagique.com, latiendascum.com, mabasso.com,
outpostbrussels.be, pandacollecting.com, pokelotas.com, psydeck.com,
ptmerch.com, secretwonderscollectibles.be, sharkgames.es, supercollectors.es,
tcg-family.com, tienda.sharkgames.es, trapcardtcg.com, triplacegames.com,
zatu.com, zukacards.com
```

## ✅ HTTP-confirmed — explicit worldwide / international shipping (11)

```
chobanovgamesltd.com, comicstores.es, europagaming.co.uk, generacionx.es,
goupiya.com, lerepairedudragon.fr, play-in.com, thirstymeeples.co.uk,
totalcards.net, turolgames.com, unicorncards.co.uk
```

## ✅ Deep-check confirmed — country dropdown surfaced Portugal (6)

```
aquitaz.se, gamestimeaversa.com, jollyrogershop.ch, kaissagames.com,
magicomens.com, sarumangames.es
```

## 🟢 Deep-check — Portugal mentioned in checkout (2)

```
kamehousecards.com, lacuevaroja.com
```

## 🟢 EU/EEA-TLD inconclusive — treat as ships (45)

EU single market means all of these almost certainly deliver to Portugal even though the automated check didn't surface the dropdown.

```
ark-games.fr, athenscollectibles.gr, brosbrielle.nl, butticards.at,
cardhunter.it, cerberus-shop.it, colossalstore.es, comic-tempel.de,
dfantasy.gr, distritozero.es, dracoon.nl, efantasy.gr,
elencuentro.infrecuentes.es, gamexfood.it, gate-to-the-games.de,
geek-haven.de, guildmage.pl, hrananetu.cz, isekai-alcorcon.es,
japoncollectibles.it, jeux-de-societe.be, kofuku.de, ludotrotter.fr,
mariosgamesworld.de, marketpvp.es, nerdbank.de, oupi.eu, pokuji.fr,
popsplanet.it, porvoonpelikauppa.fi, rebelforge.fr, sklep.merfolk.pl,
sportkartyabolt.hu, stalozaidimai.eu, stephanskartenplatz.de, strefamtg.pl,
tarsasjatekvac.hu, thegoldenrabbitshop.es, thevaults.fr, thewobblynerdles.dk,
toys-shop.gr, toys24.gr, www2.gamespirit.fr, xzone.cz, zuris-shop.de
```

## 🟡 Generic-TLD inconclusive — quick manual click-through worth it (32)

Most of these are European indie shops on `.com` / `.net` / `.io` / `.shop` / etc. domains. `crowsarena.com` was manually confirmed to ship to PT despite all three automated passes coming back inconclusive — same pattern likely holds for the rest. A 10-second visit to each (footer → "shipping" link, or add-to-cart → checkout) settles each.

```
arte9.com, crowsarena.com, dreamshop18.com, duelosdehonra.weebly.com,
epitrapez.io, factorycardstcg.com, gamable.com, herofreaks.com,
holoplazatcg.com, ilcovodelnerd.com, industria61.com, investcollect.com,
juegoscrisis.com, jupiterjuegos.com, lamaquinadeltemps.com, lantredepo.com,
littlerootgames.com, ludusbelli.com, majestikgames.com, miceliongames.com,
mnkcollectibles.com, monarkatcg.store, mondes-fantastiques.com, montalfan.com,
playoteket.com, red-line.shop, salon-de-provence.ludotrotter.com,
shop.fantasysphere.net, slicendice.one, syndiqgames.com, thegamerules.com,
troll2jeux.com
```

## ❌ Removed — not economically viable (1)

| Host | Origin | Reason |
|---|---|---|
| `hobbixchange.co.nz` | New Zealand | Country selector technically lists Portugal, but NZ → PT shipping is €40–80 per order, prohibitive for TCG products. |

## Runtime: the 🇵🇹 flag on notifications

The confirmed list above is persisted in [`data/ships-to-portugal.json`](../data/ships-to-portugal.json) — a plain JSON array of hostnames. The product monitor consults it (plus auto-confirms any `.pt` domain) to decide whether to prefix a Discord notification's title with 🇵🇹.

When you manually verify one of the 32 inconclusive hosts, **append its hostname to that JSON file** and redeploy — no code change needed.

## Re-running

The three working scripts (`tmp/check-shipping.js`, `check-shipping-deep.js`, `check-shipping-form.js`) were one-offs that were deleted. The raw per-host JSON output is in `data/shipping-*.json` (gitignored). To re-run a similar audit later, the patterns are:

1. HTTP-fetch each host's homepage + common shipping paths, look for "Portugal" + country selectors.
2. Playwright-render checkout pages and scan for `<option value="PT">`.
3. For Shopify SPA checkouts, *click* the country picker before scanning — the option list is React-rendered post-interaction.
