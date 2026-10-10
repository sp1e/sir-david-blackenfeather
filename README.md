# Sir David Blackenfeather

Simons korpkompanjon: en brittisk gentleman omkring 70 år med mörk, djup röst och torr humor. Projektet innehåller ett Windowsprogram, en privat Admin-klient, serverkod för gemensamt minne och personlighet, korpgrafik och ett valfritt lokalt Codex-rösttillägg.

## Delar

- `desktop/`: Windows Forms och WebView2. Öppnar den privata Admin-vyn på sp1e.se.
- `web/`: webbklient, backend, migreringar, tester och integrationsanvisningar.
- `shared/`: gemensam profil, röstinställningar och korpgrafik.
- `codex-addon/`: valfritt Windows-tillägg som läser upp Codex-svar.
- `local-adapter/`: Claude Code-adapter, serverkontrakt och den granskade lokala bryggans källa och tester.

Skrivbordsprogrammet och Admin ansluter till samma autentiserade webbserver. Servern lagrar samtal och användarens uttryckligen sparade minnesanteckningar. Offentlig källkod ger inte tillgång till Simons Admin, minne eller ElevenLabs-röstkonto. Röst-ID kräver en nyckel från ett konto som har tillgång till rösten.

Den publicerade Admin-versionen läser upp nya svar automatiskt när ljudet är på. Ljud på/av sparas per ägare och delas med skrivbordsprogrammet. Stopp avbryter det aktuella talet utan att ändra ljudvalet. Gamla svar spelas inte vid inläsning. En webbläsare som blockerar automatljud visar en status med möjlighet att välja Lyssna.

## Bygg Windowsprogrammet

Installera .NET 10 SDK och Microsoft Edge WebView2 Runtime. Kör från repots rot:

```powershell
dotnet publish desktop/SirDavid.csproj -c Release -r win-x64 --self-contained true -o app
```

Starta `app/Sir David Blackenfeather.exe`. Kör `Installera skrivbordsgenväg.ps1` om du vill skapa en genväg på skrivbordet. Appens inställningar och inloggningsprofil stannar lokalt i `%LOCALAPPDATA%/SirDavidBlackenfeather`.

## Röst och åtkomst

ElevenLabs, modellen `eleven_multilingual_v2`, hastighet 0,9, stabilitet 0,65 och similarity boost 0,8. API-nycklar konfigureras separat och ska stanna på servern eller i tilläggets krypterade lokala fil. Admin kräver serverkontrollerad inloggning. Skrivbordsprogrammets huvudvy tillåter HTTPS till sp1e.se och www.sp1e.se. Windowsversion 1.1.0 erbjuder ett avgränsat användarinitierat parningsfönster till den lokala agentbryggan och en knapp för att öppna Admin i webbläsaren.

Drift på en egen server kräver `SIR_DAVID_ELEVENLABS_API_KEY` som serverhemlighet och en ny publicering efter konfigurationen. Använd en separat begränsad nyckel för Text to Speech och Voices Read. Det lokala Codex-tillägget har en egen anslutning. API-nycklar ska inte finnas i källkod, klientfiler eller GitHub.

## Anslut Claude Code

Installera och logga in i Claude Code på den dator där Sir David ska användas. Hämta värdwebbplatsens lokala agenttjänst genom länken i Admin och följ paketets installationsanvisningar. Välj Claude Code som motor i Sir David, välj Anslut och godkänn den lokala parningen. Datorn och tjänsten behöver vara igång. Parningen gäller för den öppna klienten; den lagras inte permanent i webbläsaren.

Status måste bekräfta abonnemangsanslutningen innan en uppgift skickas. Kontots ordinarie kvot och eventuell extra användning gäller. Modeller och resonemangsnivåer visas utifrån installerad CLI; Fable visar information om extra krediter. Ingen automatisk övergång till API-nyckel eller annan motor sker. Den gemensamma servern lagrar samtal och minne, medan Claude körs lokalt med verktyg avstängda. Nästa utvecklingsversion innehåller avgränsade lokala textfilverktyg, filhistorik och återställning. Hostintegration och aktivering granskas före publicering. Se [lokala filverktyg](docs/LOKALA-FILVERKTYG.md). Webbsurf och datorstyrning återstår.

Integrationens produktionsstatus finns i värdprojektets PR241. Verklig Claude-generering och parning i WebView2 är separata acceptanskontroller; de simulerade testerna använder inga modell- eller röstanrop.

## Licens

Ingen projektlicens har valts. Tredjepartsberoenden behåller sina respektive licenser. .NET och Microsoft WebView2 installeras eller återställs genom sina vanliga distributionskanaler.
