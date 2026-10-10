# Sir David i Admin

Detta är webbmodulen för Sir David Blackenfeather: korpikonen, samtalet, det gemensamma minnet och den serverbaserade röstfunktionen. Exporten innehåller den granskade ljudversionen från sp1e.se PR240: automatisk uppläsning av nya svar och ett sparat ljudval som delas med skrivbordet.

## Bygg och testa

Node.js 24 eller senare behövs för SQLite-testerna.

```sh
npm ci
npm run check
npm run build
npm test
```

Bygget skapar en portabel ESM-bundle för API-logiken och en webbläsarbundle från den gemensamma Claude-adaptern. Testerna använder en tom lokal SQLite-databas och simulerade modell- och röstsvar. De skickar inga modellprompts eller röstanrop till externa tjänster.

## Integration och åtkomst

Modulen kräver värdwebbplatsens autentisering. Den är inte en fristående webbplats med egen inloggning. `portal-session.ts` verifierar en HttpOnly-cookie mot D1 och accepterar bara Admin för Sir David. Portalens gate, API och returadressfunktion ingår som beroenden för att testa Admin-skydd och inloggningsretur.

Värdwebbplatsen måste skydda **hela /admin/ inklusive CSS, JavaScript och bilder** före sina regler för publika statiska filer. API-handlern kontrollerar dessutom Admin för varje anrop. Publicera inte adminfilerna som en oskyddad statisk webbplats. Inloggningen måste bevara direktlänken `/admin/?panel=sir-david` efter lyckad Admin-inloggning.

Migrering 003 skapar portalens identitetstabeller. Migrering 002 skapar kvot-/försöksräknare. Migrering 005 skapar Sir Davids profil, minne, samtal och lås. Migrering 006 skapar ägarens versionsstyrda ljudval och måste tillämpas före ljudkodens aktivering. De innehåller schema och en statisk startprofil, utan användarsamtal, konton eller sessionsvärden. Kontrollera värdprojektets migreringshistorik före tillämpning.

`_redirects` innehåller de relevanta Admin- och Sir David SQL-reglerna från värden. Integrera dem med värdens befintliga redirects. Den tysta `admin/assets/silence.wav` ska omfattas av samma Admin-gate som övriga assets. Den förbereder ett återanvänt ljudobjekt under användarinteraktion; den är en syntetisk testfri ljudresurs.

Servern behöver D1-bindningen `DB` och hemligheterna `OLLAMA_API_KEY` samt `SIR_DAVID_ELEVENLABS_API_KEY`. Ingen nyckel eller produktionsbindning ingår. Röst-ID:t i startprofilen är en identifierare, inte en API-nyckel; ett annat ElevenLabs-konto måste ha tillgång till rösten eller använda sitt eget röst-ID.

Vanlig `/admin/` visar korpikonen. Klick öppnar panelen; Escape eller stängknappen återgår till ikonen och stoppar uppläsning. Windows-klientens exakta direktlänk öppnar panelen direkt. Samtal och minne delas genom samma skyddade server, utan lokal kopia i webbläsarlagringen.

## Exportens gränser

59 API- och DOM-tester passerar i exporten, inklusive Admin-gate, inloggningsretur, ljudlagring, historik, Stopp, mute, lokal Claude-pipeline och sena svar. Därutöver finns nio adaptertester och 22 tester för den exporterade bryggan. Kärnmodulen kan byggas och testas självständigt, men drift kräver integrationen ovan. Verklig Claude-generering och ljuduppspelning i webbläsare/WebView2 kräver separat kontroll.

Migrering 007 skapar kortlivade, sessionsbundna Claude-turer och ska tillämpas före aktivering av prepare/commit/cancel. Den lokala tjänstens setup-paket ligger i `assets/setup/sp1e-local-agents.zip`; källa och tester finns i `../local-adapter/bridge`. Adapterns kanoniska källa ligger i `../local-adapter/claude-adapter.mjs`. Bygget bevarar exportens egen katalogstruktur.

`EXPORT-MANIFEST.json` anger ursprungscommit och filernas SHA-256. Grafikfilerna är befintliga projektresurser. Den som publicerar projektet ansvarar för att ange deras licens och rättigheter.
