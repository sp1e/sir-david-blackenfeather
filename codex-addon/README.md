# Lokalt Codex-tillägg

Valfritt tillägg för Windows med Python 3. Det läser slutliga svar via Codex-hooks och spelar upp dem med ElevenLabs. Starta `Start Voice.cmd`, anslut din egen nyckel och välj din sparade röst. Nyckeln sparas lokalt med Windows DPAPI i `private/`.

Registrera hooks med `py -3 patch_voice.py install` och granska dem i Codex med `/hooks`. Välj pet-ID och vilka chattar som ska omfattas innan tal aktiveras. Ursprungliga privata inställningar följer inte med. Kör tester med `py -3 -m unittest discover -s codex-addon -p "test_*.py"` från repots rot.

Detta tillägg ger tal åt Codex-svar. Skrivbordsprogrammet och Admin använder webbserverns gemensamma personlighet och minne. När tal är aktivt skickar tillägget text till ElevenLabs; textfiltreringen kan inte garantera att privat information tas bort.
