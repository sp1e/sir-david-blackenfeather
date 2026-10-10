# Sir David Blackenfeather

Simons korpkompanjon: en brittisk gentleman omkring 70 år med mörk, djup röst och torr humor. Projektet innehåller ett Windowsprogram, en privat Admin-klient, serverkod för gemensamt minne och personlighet, korpgrafik och ett valfritt lokalt Codex-rösttillägg.

## Delar

- `desktop/`: Windows Forms och WebView2. Öppnar den privata Admin-vyn på sp1e.se.
- `web/`: webbklient, backend, migreringar, tester och integrationsanvisningar.
- `shared/`: gemensam profil, röstinställningar och korpgrafik.
- `codex-addon/`: valfritt Windows-tillägg som läser upp Codex-svar.

Skrivbordsprogrammet och Admin ansluter till samma autentiserade webbserver. Servern lagrar samtal och användarens uttryckligen sparade minnesanteckningar. Offentlig källkod ger inte tillgång till Simons Admin, minne eller ElevenLabs-röstkonto. Röst-ID kräver en nyckel från ett konto som har tillgång till rösten.

## Bygg Windowsprogrammet

Installera .NET 10 SDK och Microsoft Edge WebView2 Runtime. Kör från repots rot:

```powershell
dotnet publish desktop/SirDavid.csproj -c Release -r win-x64 --self-contained true -o app
```

Starta `app/Sir David Blackenfeather.exe`. Kör `Installera skrivbordsgenväg.ps1` om du vill skapa en genväg på skrivbordet. Appens inställningar och inloggningsprofil stannar lokalt i `%LOCALAPPDATA%/SirDavidBlackenfeather`.

## Röst och åtkomst

ElevenLabs, modellen `eleven_multilingual_v2`, hastighet 0,9, stabilitet 0,65 och similarity boost 0,8. API-nycklar konfigureras separat och ska stanna på servern eller i tilläggets krypterade lokala fil. Admin kräver serverkontrollerad inloggning. Skrivbordsprogrammet tillåter endast HTTPS till sp1e.se och www.sp1e.se.

Drift på en egen server kräver `SIR_DAVID_ELEVENLABS_API_KEY` som serverhemlighet och en ny publicering efter konfigurationen. Använd en separat begränsad nyckel för Text to Speech och Voices Read. Det lokala Codex-tillägget har en egen anslutning. API-nycklar ska inte finnas i källkod, klientfiler eller GitHub.

## Licens

Ingen projektlicens har valts. Tredjepartsberoenden behåller sina respektive licenser. .NET och Microsoft WebView2 installeras eller återställs genom sina vanliga distributionskanaler.
