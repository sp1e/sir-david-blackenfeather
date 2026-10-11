"""Local owner setup; this is never callable by an agent or web request."""
from pathlib import Path
import argparse,json,os
from workspace_tools import Workspace,native_path

def main():
    parser=argparse.ArgumentParser(description='Välj Sir Davids lokala arbetsmapp.')
    parser.add_argument('--root',type=Path);parser.add_argument('--disable',action='store_true')
    args=parser.parse_args()
    if os.name!='nt':raise SystemExit('Filverktygen stöds i Windowsversionen.')
    config=Path(__file__).parent/'private/workspace.json'
    if args.disable:
        data={'enabled':False}
    else:
        if args.root is None or not args.root.is_absolute():parser.error('--root behöver vara en absolut sökväg till vald arbetsmapp')
        native_path(args.root).mkdir(parents=True,exist_ok=True)
        workspace=Workspace(args.root,config.parent/'file-history')
        data={'enabled':True,'root':str(workspace.root)}
    config.parent.mkdir(parents=True,exist_ok=True)
    temp=config.with_suffix('.tmp');temp.write_text(json.dumps(data,ensure_ascii=False,indent=2),encoding='utf-8');os.replace(temp,config)
    print(json.dumps({'enabled':data['enabled'],'name':args.root.name if args.root else None},ensure_ascii=False))
if __name__=='__main__':main()
