# Planering och Outlook

Sir David kan hålla en gemensam projektlista, deadlines, nästa steg och ett schema för Admin och Windowsprogrammet. Uppgifterna lagras på den privata servern per Admin-ägare. Projektens egna anteckningar stannar i planeringen. Titlar, tider och nästa steg för de mest aktuella projekten och kalenderhändelserna följer med till den chattmotor användaren väljer.

Prioriteringen tar hänsyn till försenade och nära deadlines, sedan hög prioritet. Påminnelser kommer när ett projekt har mindre än en vecka, tre dygn, ett dygn eller två timmar kvar, och efter passerad deadline en gång per lokal dag. Bara det aktuella steget meddelas; gamla steg spelas inte upp i efterhand. Pausade och avslutade projekt påminner inte. Möten påminner inom 30 minuter, med fem minuters marginal vid start. Heldagshändelser visas i schemat utan möteslarm.

Nattpausen är från 22 till 08 i Stockholm från början och kan ändras. Samma start- och sluttimme stänger av pausen. Snooze gäller hela den aktuella deadlinen, även när den passerar ett nytt påminnelsesteg. Högst sex påminnelseförsök per lokal dag skyddar mot upprepade larm. Admin och skrivbordsprogrammet delar reservationer och kvitton, så samma påminnelse hanteras av en vy åt gången. Ett kvitto betyder att klienten tog emot påminnelsen; det bevisar inte att användaren såg eller hörde den.

Windowsversion 1.3 kan stanna i aktivitetsfältet när huvudfönstret stängs. Windowsnotiser är av tills du väljer dem under Påminnelser och sparar. Det sparade valet aktiverar programmets egen start vid Windowsinloggning. Aktivitetsfältets meny innehåller Öppna och Avsluta; Avsluta stoppar bevakningen. Datorn måste vara vaken, nätet tillgängligt och Admin inloggat. Windows fokusläge eller systeminställningar kan dölja notiser. Notiser innehåller en neutral text, utan projekttitlar eller mötesdetaljer. Uppläsning använder den sparade ElevenLabs-rösten när huvudfönstret är öppet och ljudet är på. Stopp-knappen fungerar som tidigare.

## Anslut Microsoft 365-jobbkalendern

Outlook kräver en separat Microsoft-appregistrering och användarens kalendergodkännande. Företagets regler kan kräva att IT skapar appen eller godkänner den. Codex eller andra connectors ger inte Sir David automatisk tillgång till kontot.

Förbered en webbapp i företagets Microsoft Entra-klient:

1. Namn: **Sir David Blackenfeather**. Välj konton endast i den egna organisationens klient om appen bara ska läsa Simons jobbkalender.
2. Webb-redirect: `https://sp1e.se/api/sir-david/outlook/callback`. Lägg även till `https://www.sp1e.se/api/sir-david/outlook/callback` om båda värdnamnen används. Ingen wildcard-redirect, implicit grant eller publik klient behövs.
3. Microsoft Graph, **delegated**: `Calendars.ReadBasic`. Appen begär även `offline_access` för att behålla anslutningen. Inga skrivbehörigheter, e-post-, fil- eller appomfattande kalenderbehörigheter ska läggas till.
4. Skapa en tidsbegränsad klienthemlighet och planera rotation före utgångsdatumet. Hemligheten ska inte skickas i chatt eller läggas i repot.
5. Konfigurera följande på webbplatsens Cloudflare Production-server: `SIR_DAVID_OUTLOOK_CLIENT_ID`, `SIR_DAVID_OUTLOOK_CLIENT_SECRET`, `SIR_DAVID_OUTLOOK_TENANT` (organisationens klient-ID) och `SIR_DAVID_OUTLOOK_TOKEN_KEY` (en slumpad 32-byte AES-nyckel som 64 hextecken). Tokennyckeln måste behållas vid uppdatering. Ett byte av den kräver att gamla kalenderkopplingar raderas och godkänns igen.
6. Publicera serverkoden med migration `site-migration-010-sir-david-planner.sql`. Kontrollera att migrationsnumret är ledigt i värdprojektet innan införandet. Den bygger på befintliga portalprofiler och ändrar inga andra tabeller.
7. Öppna Sir David i Admin **i webbläsaren**, välj Ditt schema → Anslut jobbkalender i Outlook, välj rätt jobbkonto och granska Microsofts läsbehörighet. Microsoftgodkännandet ska utföras av användaren. Skrivbordsprogrammet använder sedan samma sparade koppling.
8. Välj Hämta schema och kontrollera de kommande kalenderhändelserna och tidpunkten för senaste hämtning. Testa med en ofarlig egen kalenderpost; automatiska synkningar är begränsade till minst fem minuters mellanrum och sker normalt var tionde minut när en klient är aktiv.

Kopplingen läser förekomster och undantag från huvudkalendern tre dagar bakåt och 30 dagar framåt. Den hämtar bara ID, titel, start, slut, heldag, inställd-status och känslighetsmarkering. Textinnehåll, bilagor och deltagare hämtas inte. Privata och konfidentiella händelser får en neutral titel. Upp till 400 händelser och fyra sidor behandlas per uppdatering. Om uppdateringen är ofullständig behålls tidigare schema och anslutningen markeras för kontroll; gamla kalenderkopior ger inga möteslarm efter en timme eller vid synkfel.

OAuth använder PKCE och engångsstate bundet till exakt Admin-session, ägare och redirect. Åtkomst- och refresh-token lagras krypterade med AES-256-GCM på servern, med ägaren som autentiserad tilläggsdata. Servern roterar refresh-token innan den hämtar kalendern. Frånkoppling raderar den egna sparade kopplingen och kalenderkopian, utan att ändra Microsoftkontot eller möten.

Funktionens gränser: användaren hanterar projekt och händelser i formulären; modellen kan ge råd och planförslag men kan inte själv spara nya deadlines. Manuell planering fungerar även när Outlook inte är konfigurerat. Varje projekt har en enda nästa handling; deluppgifter och uppskattad tidsåtgång ingår ännu inte. Ljudet för nya chatt- och påminnelsesvar följer det gemensamma ljudvalet. Ett stängt/sovande eller utloggat program kan inte garantera leverans.

Referenser: [Microsoft calendarView](https://learn.microsoft.com/en-us/graph/api/calendar-list-calendarview?view=graph-rest-1.0), [Microsoft OAuth med PKCE](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow), [Windows NotifyIcon](https://learn.microsoft.com/en-us/dotnet/api/system.windows.forms.notifyicon.showballoontip?view=windowsdesktop-8.0).
