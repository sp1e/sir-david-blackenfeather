# Förberedd Claude-anslutning

Status: isolerad adapter med mocktester. Den laddas inte av Admin och är inte en aktiverad motor. Webbägaren fastställer slutliga endpoint- och migrationsnamn före integration. Den befintliga bryggan behöver dessutom rapportera verifierad abonnemangsanvändning; dagens allmänna `signedIn` räcker inte för att lova rätt debiteringsväg.

## Föreslagna serveranrop

`POST /api/sir-david/local/prepare`, endast aktuell Admin-session och tillåten origin:

```json
{"text":"Användarens meddelande","version":2,"provider":"claude"}
```

Servern validerar en prompt på högst 4 000 tecken och aktuell konversationsversion. Den skapar ett oförutsägbart engångs-ID med cirka tre minuters giltighet, bundet till ägare, aktuell autentiserad session och version. Underlaget kommer från serverns fasta Sir David-profil, gemensamma konversation och uttryckliga minnesanteckningar. Klienten får inte själv ange persona eller välja annan ägares minne.

```json
{
  "turn":{"id":"11111111-1111-4111-8111-111111111111","version":2,"expiresAt":1791663000000},
  "context":{
    "persona":"Serverns fasta Sir David-personlighet",
    "text":"Användarens meddelande",
    "messages":[{"role":"user","content":"Tidigare fråga"},{"role":"assistant","content":"Tidigare svar"}],
    "memories":["Uttryckligen sparad anteckning"]
  }
}
```

Historiken begränsas till 15 meddelanden och 16 000 tecken. Persona begränsas till 6 000 tecken och anteckningarnas JSON till 20 000. Prepare använder ingen modell eller TTS. Servern behöver en gräns för antal väntande turer och regelbunden borttagning av utgångna turer.

`POST /api/sir-david/local/commit`, åter med aktuell Admin-session och tillåten origin:

```json
{"turnId":"11111111-1111-4111-8111-111111111111","version":2,"text":"Claude-svaret"}
```

Servern kontrollerar ägar- och sessionsbindning, giltighetstid, att turen inte förbrukats och samma konversationsversion. Svaret begränsas till 12 000 tecken. Den sparar prepare-turens användarmeddelande och återfört assistantsvar med atomär versionskontroll, förbrukar turen och returnerar samma konversations-DTO som dagens chat-route. En clear, annan avslutad tur, återkallad session, replay eller utgången tur ska ge konflikt eller nekad åtkomst utan att återuppliva historik. Slutlig SQL ska verifieras i värdens D1-testmiljö; en processlokal flagga är inte tillräcklig.

En lokal modelloutput är data. Commit får inte acceptera verktygsanrop, SQL, ändrad persona eller minnesskrivningar. Servern kan verifiera ägare och tur, men kan inte bevisa att texten skapats av Claude på klienten.

## Lokal adapter

`ClaudeAdapter` behåller pairing-token i privat instansminne. `pair()` accepterar endast meddelande från den öppnade popupens WindowProxy och exakt loopback-origin. `answer()` validerar prepare-underlaget, kontrollerar lokal Claude-status och skickar endast ett `provider:claude, kind:chat`-uppdrag till den befintliga bryggan. Den gör ingen automatisk fallback. Avbrytning stoppar bara den aktuella lokala uppgiften och nekar ett sent resultat. `disconnect()` raderar token och återkallar bryggsessionen.

Adaptern använder den allmänna bryggans kontextfält för persona och anteckningar. Värden ska granska hur den befintliga fasta tools-off-systemprompten samverkar med Sir Davids persona. Ett separat Sir David-kind kan vara lämpligt om personan behöver ligga i systemprompten. Det kräver då en uttrycklig, avgränsad bryggändring.

Föreslaget tillägg i status för vald Claude-motor:

```json
{"id":"claude","installed":true,"signedIn":true,"billingMode":"subscription"}
```

Bryggan får rapportera `subscription` först när den har verifierat den vanliga Claude-inloggningen och förhindrat ärvd API-konfiguration eller annan betalväg från att ersätta den för denna körning. Inga nyckelvärden ska visas eller skickas till webbservern. Den nuvarande adaptern nekar start när fältet saknas; det är en avsiktlig integrationsspärr, inte ett nytt bevis om aktuell bryggdebitering.

Första versionen använder CLI:s valda standardmodell. Modell- och resonemangsval kan läggas till enligt webbägarens aktuella allowlist. Bryggan behåller verktyg avstängda, strikt tom MCP-konfiguration och tillfällig arbetsmapp. Lokal filåtkomst och datorstyrning ingår inte i detta kontrakt.

## Verifiering

Kör `node --test local-adapter/claude-adapter.test.mjs`. Åtta mocktester täcker underlagsgränser, pairing-origin och fönsterkälla, utebliven debiteringsbekräftelse, lyckad commit-DTO, avbrytning med sent svar, frånkoppling, återkallad väntande parning och för stort svar. De förbrukar inga Claude- eller ElevenLabs-krediter. Faktisk parning, Claude-generering och sparande genom det kommande host-kontraktet återstår före aktivering.
