# Sir David i Admin

Detta är webbmodulen för Sir David Blackenfeather: korpikonen, samtalet, det gemensamma minnet och den serverbaserade röstfunktionen. Exporten innehåller den publicerade ikonversionen från sp1e.se.

## Bygg och testa

Node.js 24 eller senare behövs för SQLite-testerna.

```sh
npm ci
npm run check
npm run build
npm test
```

Bygget skapar en portabel ESM-bundle för API-logiken. Testerna använder en tom lokal SQLite-databas och simulerade Ollama- och ElevenLabs-svar. De skickar inga modellprompts eller röstanrop till externa tjänster.

## Integration och åtkomst

Modulen kräver värdwebbplatsens autentisering. Den är inte en fristående webbplats med egen inloggning. `portal-session.ts` verifierar en HttpOnly-cookie mot D1 och accepterar bara Admin för Sir David. `portal-policy.ts` är dess oförändrade direkta beroende; inga andra appar exporteras.

Värdwebbplatsen måste skydda **hela /admin/ inklusive CSS, JavaScript och bilder** före sina regler för publika statiska filer. API-handlern kontrollerar dessutom Admin för varje anrop. Publicera inte adminfilerna som en oskyddad statisk webbplats. Inloggningen måste bevara direktlänken `/admin/?panel=sir-david` efter lyckad Admin-inloggning.

Migrering 003 skapar portalens identitetstabeller. Migrering 002 skapar kvot-/försöksräknare. Migrering 005 skapar Sir Davids profil, minne, samtal och lås. De innehåller schema och en statisk startprofil, utan användarsamtal, konton eller sessionsvärden. Kontrollera värdprojektets migreringshistorik före tillämpning.

Servern behöver D1-bindningen `DB` och hemligheterna `OLLAMA_API_KEY` samt `SIR_DAVID_ELEVENLABS_API_KEY`. Ingen nyckel eller produktionsbindning ingår. Röst-ID:t i startprofilen är en identifierare, inte en API-nyckel; ett annat ElevenLabs-konto måste ha tillgång till rösten eller använda sitt eget röst-ID.

Vanlig `/admin/` visar korpikonen. Klick öppnar panelen; Escape eller stängknappen återgår till ikonen och stoppar uppläsning. Windows-klientens exakta direktlänk öppnar panelen direkt. Samtal och minne delas genom samma skyddade server, utan lokal kopia i webbläsarlagringen.

## Exportens gränser

18 API-tester och 11 DOM-tester ingår. Två tester av sp1e-värdens middleware och inloggningsretur stannar i värdrepot; de kräver resten av portalintegrationen. Kärnmodulen kan byggas och testas självständigt, men drift kräver integrationen ovan.

`EXPORT-MANIFEST.json` anger ursprungscommit och filernas SHA-256. Grafikfilerna är befintliga projektresurser. Den som publicerar projektet ansvarar för att ange deras licens och rättigheter.
