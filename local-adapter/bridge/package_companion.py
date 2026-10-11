"""Preserve reviewed workshop assets and package only explicit source files."""
from pathlib import Path
import argparse,zipfile,hashlib,json

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--base',type=Path,required=True);parser.add_argument('--output',type=Path,required=True)
    args=parser.parse_args();root=Path(__file__).parent
    sources=('agent_bridge.py','agent_daemon.py','workspace_tools.py','workspace_agent.py','configure_workspace.py')
    assert args.base.resolve()!=args.output.resolve()
    args.output.parent.mkdir(parents=True,exist_ok=True)
    with zipfile.ZipFile(args.base) as original,zipfile.ZipFile(args.output,'w',zipfile.ZIP_DEFLATED) as target:
        names=set(original.namelist())
        for item in original.infolist():
            if item.filename not in sources and item.filename!='SIR-DAVID-FILER.txt':target.writestr(item,original.read(item))
        for name in sources:
            if (root/name).is_file():target.write(root/name,name)
            elif name in names:target.writestr(name,original.read(name))
            else:raise ValueError('Missing reviewed source: '+name)
        target.writestr('SIR-DAVID-FILER.txt','''Sir David: textfiler i en vald arbetsmapp (Windows)

Välj mapp lokalt med: python configure_workspace.py --root "C:\\din\\arbetsmapp"
Starta om den lokala tjänsten och anslut Claude från Sir David i Admin.
Markera filåtkomst i det lokala anslutningsfönstret och godkänn Tillåt.
Aktivera Arbeta med filer i min arbetsmapp för ett filuppdrag.
Filinnehåll som behövs för uppdraget skickas till Claude via din vanliga inloggning.
Filhistorik och säkerhetskopior sparas lokalt i private/file-history och ingår inte i paketet.
Inbyggda CLI-verktyg och MCP är avstängda. Lokala textverktyg arbetar endast i vald mapp.
Stäng av filåtkomsten med: python configure_workspace.py --disable
''')
    print(json.dumps({'sha256':hashlib.sha256(args.output.read_bytes()).hexdigest(),'bytes':args.output.stat().st_size}))
if __name__=='__main__':main()
