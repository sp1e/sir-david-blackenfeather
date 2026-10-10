# Sir David Blackenfeather

Simons korpkompanjon: en brittisk gentleman omkring 70 år med mörk, djup röst och torr humor. Projektet innehåller ett Windowsprogram, en privat Admin-klient, serverkod för gemensamt minne och personlighet, korpgrafik och ett valfritt lokalt Codex-rösttillägg.

## Delar

- `desktop/`: Windows Forms och WebView2. Öppnar den privata Admin-vyn på sp1e.se.
- `web/`: webbklient, backend, migreringar, tester och integrationsanvisningar.
- `shared/`: gemensam profil, röstinställningar och korpgrafik.
- `codex-addon/`: valfritt Windows-tillägg som läser upp Codex-svar.
- `local-adapter/`: förberedd Claude Code-anslutning med mocktester och föreslaget serverkontrakt. Den är ännu inte aktiverad i Admin.

Skrivbordsprogrammet och Admin ansluter till samma autentiserade webbserver. Servern lagrar samtal och användarens uttryckligen sparade minnesanteckningar. Offentlig källkod ger inte tillgång till Simons Admin, minne eller ElevenLabs-röstkonto. Röst-ID kräver en nyckel från ett konto som har tillgång till rösten.

Den publicerade Admin-versionen läser upp nya svar automatiskt när ljudet är på. Ljud på/av sparas per ägare och delas med skrivbordsprogrammet. Stopp avbryter det aktuella talet utan att ändra ljudvalet. Gamla svar spelas inte vid inläsning. En webbläsare som blockerar automatljud visar en status med möjlighet att välja Lyssna.

## Bygg Windowsprogrammet

Installera .NET 10 SDK och Microsoft Edge WebView2 Runtime. Kör från repots rot:

```powershell
dotnet publish desktop/SirDavid.csproj -c Release -r win-x64 --self-contained true -o app
```

Starta `app/Sir David Blackenfeather.exe`. Kör `Installera skrivbordsgenväg.ps1` om du vill skapa en genväg på skrivbordet. Appens inställningar och inloggningsprofil stannar lokalt i `%LOCALAPPDATA%/SirDavidBlackenfeather`.

## Röst och åtkomst

ElevenLabs, modellen `eleven_multilingual_v2`, hastighet 0,9, stabilitet 0,65 och similarity boost 0,8. API-nycklar konfigureras separat och ska stanna på servern eller i tilläggets krypterade lokala fil. Admin kräver serverkontrollerad inloggning. Skrivbordsprogrammets huvudvy tillåter HTTPS till sp1e.se och www.sp1e.se. Förberedd Windowskod erbjuder dessutom ett begränsat användarinitierat parningsfönster till den lokala agentbryggan; installerad release v1.0.0 har ännu inte ersatts med det bygget.

Drift på en egen server kräver `SIR_DAVID_ELEVENLABS_API_KEY` som serverhemlighet och en ny publicering efter konfigurationen. Använd en separat begränsad nyckel för Text to Speech och Voices Read. Det lokala Codex-tillägget har en egen anslutning. API-nycklar ska inte finnas i källkod, klientfiler eller GitHub.

## Licens

Ingen projektlicens har valts. Tredjepartsberoenden behåller sina respektive licenser. .NET och Microsoft WebView2 installeras eller återställs genom sina vanliga distributionskanaler.
