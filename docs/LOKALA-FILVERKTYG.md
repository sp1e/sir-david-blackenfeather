# Sir David: filer i en egen arbetsmapp

Filverktygen är publicerade i den privata Admin-vyn genom värdprojektets PR245 och PR246. Windowsklient 1.2.0 använder samma Admin-vy. En lokal anslutning och ett separat godkännande av arbetsmappen krävs innan Claude får använda filer.

## Användning

1. Välj arbetsmappen lokalt med `python configure_workspace.py --root "C:\din\arbetsmapp"` och starta den uppdaterade lokala tjänsten.
2. Anslut Claude från Sir David och markera filåtkomst i det lokala fönstret. Den ger denna anslutning åtkomst till den valda arbetsmappen i högst en timme.
3. Markera **Arbeta med filer i min arbetsmapp**, skriv ett uppdrag och skicka. Sir David använder samma personlighet, samtal, uttryckliga minnen och röst som vid vanlig chatt.
4. Öppna **Filhistorik** för att återställa ändringar. Återställning nekar en fil som ändrats sedan den tidigare versionen. En ny fil som tagits bort vid återställning kan återskapas därifrån.

Exempel: ”Läs Börja här.md och sammanfatta.” ”Skapa Veckoplan.md med en plan för nästa vecka.” ”Lägg till en avdelning för privata ärenden i Veckoplan.md.”

## Omfattning

Verktygen listar, läser, söker, skapar och ändrar UTF-8-textfiler om högst 64 000 bytes i en enda arbetsmapp. Befintlig fil måste läsas i sin helhet på aktuell revision innan modellen får skriva. Inbyggda Claude Code-verktyg, MCP, shell, nätverk och datorstyrning är avstängda. Claude föreslår JSON-anrop; den lokala filmotorn genomför de tillåtna anropen.

Filinnehåll som behövs för uppgiften skickas till Claude genom den valda inloggningen. Normala kvoter och eventuell extra användning gäller. Filinnehåll och verktygsresultat hålls som underlag för uppdraget; den lokala tjänsten skapar inget separat permanent samtalsminne. Slutligt assistantsvar sparas i det gemensamma serverbaserade samtalet, så svaret kan innehålla sådant du bett honom återge ur en fil.

Filhistorik och gamla bytes sparas lokalt utanför arbetsmappen i `private/file-history`, separat för varje vald arbetsmapp. De ingår inte i repo eller installationspaket. Historiken har en gräns på 256 journaler per arbetsmapp; den raderas inte automatiskt. `configure_workspace.py --disable` stänger filåtkomsten. Mappvalet sparas lokalt, medan varje parning kräver ett separat godkännande för filåtkomst.

Windows handles låser mappar och filer under versionskontroll och skrivning. Traversal, absoluta paths, ADS, enhetsnamn, symlänkar, junctions och befintliga hårda länkar nekas. Äldre bytes sparas före skrivning. Ett flerstegsuppdrag är ingen gemensam filtransaktion: redan genomförda ändringar ligger kvar vid senare fel eller avbrott och kan återställas i filhistoriken. Vid ett process-/diskfel mitt i skrivning kan en ofullständig journal behöva hanteras från dess lokala säkerhetskopia; gränsen ska inte beskrivas som en garanti mot strömavbrott.

Denna första filversion aktiveras bara på Windows. Webbens Admin-inloggning och den lokala parningen är två separata kontroller. Dokument och webbsidor kan inte ge nya rättigheter. Det lokala verktygsprotokollet accepterar inte kommandon, val av annan root eller ändrade minnen.

## Verifiering

63 API/DOM-tester, 9 adaptertester och 58 bryggtester passerar; ett symlinkprivilegetest hoppas över på den här datorn. Samma färdiga anslutningspaket klarar 36 fil-, agent- och routetestfall. Windowsjunction, blockerad mapp-/filrename, blockerad extern writer, versionskonflikter, avbrytning, full lästäckning, återställning, återskapande, scopes och förlorad Admin-behörighet är testade. Pipelineproven använder simulerad CLI och verkliga filer. Provfiler i OneDrive har verifierat läsning, skrivning, återställning och återskapande med sökvägar över 260 tecken. Webbtypkontroll och bygge passerar.

Ingen verklig Claude-generering, ny TTS eller ny WebView2-parning har körts i dessa prov. Filåtkomstens Tillåt och ett verkligt uppdrag återstår som användarens acceptanssteg.

## Skrivbordsprogrammets automatiska ljud

Windowsklient 1.2.0 tillåter automatisk ljuduppspelning för den aktuella privata Admin-vyn och samma webbursprung. Det sparade ljudvalet och Stopp-knappen styr fortfarande uppläsningen. Övriga behörigheter och parningsfönstrets behörigheter är fortsatt nekade. Paketet är byggt och klarar 49 lokala självtester med installerad WebView2. Verklig ljuduppspelning och parning i skrivbordsappen återstår att prova.
