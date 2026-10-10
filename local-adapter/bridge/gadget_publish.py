"""Stage code, without personal gadget data, for the existing Git review flow."""
from pathlib import Path
import json,os,time,uuid

def stage(dist,body):
    if not isinstance(body,dict):raise ValueError('Gadgeten saknas.')
    try:gadget_id=str(uuid.UUID(body.get('id','')))
    except (ValueError,AttributeError,TypeError):raise ValueError('Gadgeten har inget giltigt id.')
    if any(not isinstance(body.get(key),str) for key in ('title','summary','html')) or not 10<len(body['html'])<=200000:
        raise ValueError('Gadgetens kod är ogiltig eller för stor.')
    target=Path(dist)/'assets/gadgets/published';target.mkdir(parents=True,exist_ok=True)
    path=target/(gadget_id+'.json');index=target/'index.json'
    metadata={'id':gadget_id,'title':body['title'][:100],'summary':body['summary'][:500],'updated':int(time.time()*1000)}
    entries=json.loads(index.read_text(encoding='utf-8')) if index.exists() else []
    entries=[item for item in entries if item['id']!=gadget_id]+[metadata]
    if len(entries)>100:raise ValueError('Det publicerade biblioteket rymmer 100 gadgets.')
    # State, history, conversation, and machine information never enter the review.
    for file,value in ((path,{**metadata,'format':'sp1e-gadget','version':1,'html':body['html']}),(index,entries)):
        temporary=file.with_suffix('.tmp');temporary.write_text(json.dumps(value,ensure_ascii=False,indent=2)+'\n',encoding='utf-8');os.replace(temporary,file)
    return {'staged':True,'url':'/gadgets/?gadget='+gadget_id}
