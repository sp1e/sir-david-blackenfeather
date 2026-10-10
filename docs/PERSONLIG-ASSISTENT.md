# Sir David som personlig assistent

## Mål

Sir David ska kunna hjälpa ägaren med professionella och privata uppgifter genom samma personlighet, röst och granskbara minne. Modellvalet ska kunna ändras utan att skapa en ny identitet eller ett separat användarminne.

Det befintliga Windowsprogrammet visar den autentiserade Admin-klienten. En gemensam server lagrar samtal och uttryckligen sparade minnesanteckningar. Windowsprogrammet har ännu ingen lokal fil- eller datorstyrning. Denna fil beskriver nästa byggsteg; den ger inte den nuvarande appen fler rättigheter.

## Modell och lokal anslutning

- Ollama Cloud körs genom den befintliga serveranslutningen.
- Claude Code ska köras genom ägarens installerade CLI på den egna datorn och dess normala inloggning. OAuth- och API-nycklar ska inte kopieras till webbservern.
- Den lokala anslutningen ska rapportera installerad motor och inloggningsstatus utan att generera ett testsvar.
- Vald motor, modell och resonemangsnivå ska visas före en uppgift. Kvotfel ska stanna hos vald motor; appen ska inte byta till en annan betald anslutning utan ägarens val.
- Claude Code-anrop kräver att den anslutna datorn är igång. Samma krav gäller när Admin öppnas i en webbläsare.

Anthropics dokumentation beskriver aktuell abonnemangsanvändning för `claude -p`, Agent SDK och tredjepartsappar. API-krediter och abonnemangskvot är separata användningsvägar. Lokal anslutning måste därför visa vilken väg den använder och undvika att en ärvd API-nyckel ersätter den valda abonnemangsinloggningen.

Källor, kontrollerade 2026-10-10:

- https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan
- https://support.claude.com/en/articles/11145838-use-claude-code-with-your-pro-or-max-plan

## Första lokala verktyg

Första versionen ska kunna söka efter och läsa filer i valda mappar, öppna dokument, föreslå och genomföra avgränsade redigeringar, samt söka och läsa webbsidor. Redigeringar ska använda kontroll av aktuell filversion och skapa en återställningsbar kopia. Symboliska länkar och junctions får inte leda utanför godkända mappar. Filstorlek, kodning och binära format måste hanteras innan innehåll skickas till modellen.

Ägaren ska kunna ge beständig behörighet för rutinuppgifter i valda mappar. Läsning och återställningsbara redigeringar inom en godkänd uppgift kan då genomföras utan återkommande frågor. Extern kommunikation, inköp, permanent radering och ändring av konton eller säkerhet kräver separata beslut. Dokument och webbsidor är underlag; instruktioner i dem får inte utöka behörigheten.

Datorstyrning genom skärm, tangentbord och mus läggs till efter fil- och webbverktygen. Det lokala programmet ska visa pågående uppgift, utförda åtgärder och en avbrytknapp. Avbrutna eller återkallade uppgifter ska inte fortsätta i bakgrunden.

OpenAI beskriver motsvarande verktygsuppdelning: applikationen kör sina egna verktyg och återför resultat till modellen. Datorstyrning kräver en separat körmiljö som genomför modellens åtgärder.

- https://developers.openai.com/api/docs/guides/tools
- https://developers.openai.com/api/docs/guides/tools-computer-use

## Gemensamt minne och motorbyte

Servern ska tillhandahålla samma avgränsade samtal, personlighet och uttryckliga minnesanteckningar för varje motor. Ett lokalt Claude-svar ska sparas med samma versionskontroll som dagens servergenererade svar. Rensning av samtalet under en pågående uppgift ska göra det gamla svaret ogiltigt. Vid återkallad Admin-session ska sena svar inte sparas.

Den lokala tjänsten ska inte skriva ett konkurrerande permanent samtalsminne. Ägaren ska kunna märka minnesanteckningar som arbete eller privat och välja vilka som ska ingå i en uppgift. Inga filer eller hela diskar ska läsas in i minnet automatiskt.

## Förberedande kontrakt för lokal Claude-chatt

Detta är ett förslag som webbägaren måste fastställa före implementation:

1. En autentiserad Admin-klient begär förberedelse av en tur med prompt och aktuell samtalsversion. Servern kontrollerar ägarskap och returnerar ett kortlivat tur-ID, fast personlighet, avgränsad historik och valda minnesanteckningar.
2. Klienten skickar underlaget till en uttryckligen parad lokal tjänst. Tjänsten startar Claude Code med verktyg avstängda för den första chattversionen; inget lokalt filarbete aktiveras genom den anslutningen.
3. Klienten återför det avgränsade svaret och tur-ID till servern. Servern kontrollerar ägare, giltighetstid och förväntad version före lagring. Dubbla eller sena svar nekas.
4. Klienten använder den gemensamma ElevenLabs-anslutningen för uppläsning enligt det sparade ljudvalet.

Parningen ska vara begränsad till rätt Admin-origin och lokal loopbackadress. En parning för chatt får inte samtidigt ge fil-, kommandorads- eller datorstyrningsbehörighet.

Windowsklientens förberedda kod stöder nu ett användarinitierat parningsfönster från Admin till exakt `http://127.0.0.1:4318/__connect/?origin=<kodad aktuell origin>`. Den återanvänder WebView2-miljön för att behålla `window.opener`; andra popupadresser och navigationer nekas. Bygget och 26 lokala självtester passerar. Det verifierar adresspolicyn, inte en verklig parning eller Claude-generering. Denna kod har ännu inte ersatt den installerade appversionen.

## Verifiering före aktivering

Offline- och mocktester ska täcka ägarisolering, återkallad åtkomst, sena svar, versionskonflikter, avbrytning och skydd mot otillåtna filvägar. Inloggningskontroll behöver ingen modellprompt. En lyckad mockkörning visar att kontraktet fungerar i testmiljön; den är inte en verifiering av en verklig Claude-generering eller faktiskt datorarbete.
