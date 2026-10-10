# Claude Code genom Sir David

Klient och adapter är implementerade. Webbägaren granskar och integrerar server, migration och lokal brygga i sp1e.se PR241. Mocktester innebär inte att verklig parning eller generering har verifierats.

## Gemensam konversation

Admin begär `POST /api/sir-david/local/prepare` med `{text, version, provider:"claude"}`. Texten får vara högst 4 000 tecken. Servern returnerar `{turn:{id,version,expiresAt},context:{persona,text,messages,memories}}`. Turens UUID binds till ägare, aktuell Admin-session och konversationsversion, med högst tre minuters giltighet. Bara en aktiv tur per ägare tillåts, med gemensam spärr för lokal och molngenererad chatt.

Personlighet, historik och uttryckliga minnesanteckningar kommer från servern. Persona begränsas till 6 000 tecken, historik till 15 meddelanden och sammanlagt 16 000 tecken, minne till 100 anteckningar om högst 1 000 tecken vardera och 20 000 tecken som JSON. Förberedelsen använder ingen modell eller uppläsning.

Efter generering skickas `POST /api/sir-david/local/commit` med `{turnId,version,text}`. Svaret begränsas till 12 000 tecken. Servern kontrollerar session, ägare, giltighet, engångsanvändning och version atomärt och sparar den förberedda användartexten med svaret. Den returnerar `{text,conversation:{version,messages}}`, samma format som molnchatten. Klienten kan inte skriva över historik, persona eller minne. Servern kan kontrollera turen men kan inte bevisa vilken modell som skapade texten på klienten.

`POST /api/sir-david/local/cancel` med `{turnId}` frigör turen. Klienten använder en separat avbrytning för detta städanrop. Versionskonflikt behåller utkastet. Sena svar efter avbrytning eller förlorad Admin-behörighet visas eller läses inte upp.

## Lokal anslutning

Parningstoken finns bara i instansminnet, aldrig i webbläsarlagring. Parning tillåts från `https://sp1e.se` och `https://www.sp1e.se` till exakt `http://127.0.0.1:4318/__connect/?origin=<kodad origin>`. Meddelandet måste komma från den öppnade popupens WindowProxy och exakt loopback-origin. Frånkoppling raderar token, avbryter uppgift/parning och återkallar bryggsessionen.

Status kontrolleras via `/__agents/status?provider=claude&kind=sir-david`. Bryggan rapporterar `billingMode:"subscription"` först efter kontroll av Claude-inloggning i samma avgränsade miljö som den kommande processen. API- och alternativa providerinställningar får inte ersätta den valda inloggningen. Hanterade organisationsregler behålls. Detta visar abonnemangsvägen; kontots kvoter och eventuell extra användning gäller fortfarande.

Jobbet innehåller `provider:"claude"`, `kind:"sir-david"`, `prompt`, `messages`, `persona` och `notes` som en array. Valfria `model` och `effort` väljs från bryggans aktuella metadata. Standardval utelämnar fälten. En tidigare vald modell som försvunnit stoppar uppgiften. Fable visar information om extra krediter. Ingen automatisk övergång till molnmodell eller API-nyckel sker.

Claude körs med Sir Davids fasta instruktioner, verktyg avstängda, strikt tom MCP-konfiguration och utan lokalt permanent samtalsminne. Historik och anteckningar är underlag. Parningen ger ingen lokal fil- eller datorstyrning; dessa verktyg är nästa utvecklingsfas.

Efter sparat svar används den gemensamma ElevenLabs-rösten enligt ägarens sparade ljudinställning. Stopp avbryter uppläsningen; Avbryt svar avbryter modelluppgiften.

## Verifiering

`node --test local-adapter/claude-adapter.test.mjs` kör nio adaptertester. Webbens nya DOM-tester kör den faktiska genererade adaptern och hela prepare–jobb–commit-flödet med simulerade tjänster. De täcker avbrytning, sena svar, versionskonflikt, förlorad behörighet under städning, modellmetadata och utebliven abonnemangsbekräftelse. Inga Claude- eller ElevenLabs-krediter används. Verklig parning och generering verifieras separat efter integration.
