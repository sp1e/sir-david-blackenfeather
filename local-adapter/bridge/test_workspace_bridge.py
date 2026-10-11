import io,json,tempfile,time,unittest
from pathlib import Path
from unittest.mock import patch
import agent_bridge as bridge
from workspace_tools import Workspace

class Handler:
    def __init__(self,path,body=None,origin='https://www.sp1e.se',token='paired'):
        self.path=path;self.command='POST' if body is not None else 'GET'
        data=json.dumps(body).encode() if body is not None else b''
        self.headers={'Origin':origin,'Host':'127.0.0.1:4318','X-Sp1e-Session':token,'Content-Type':'application/json','Content-Length':str(len(data))}
        self.rfile=io.BytesIO(data)

class BridgeWorkspaceTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();base=Path(self.temp.name);root=base/'work';root.mkdir()
        self.files=Workspace(root,base/'history');self.stub=patch.object(bridge.workspace_tools,'configured',return_value=self.files);self.stub.start()
        bridge.SESSIONS['paired']={'origin':'https://www.sp1e.se','expires':time.time()+60}
    def tearDown(self):
        self.stub.stop();bridge.SESSIONS.clear();bridge.JOBS.clear();self.temp.cleanup()
    def call(self,handler):
        with patch.object(bridge,'respond') as reply:
            (bridge.post if handler.command=='POST' else bridge.get)(handler)
            args=reply.call_args.args
            return args[1],args[2] if len(args)>2 else 200
    def test_old_chat_pairing_cannot_read_history_or_start_file_job(self):
        data,code=self.call(Handler('/__agents/workspace'));self.assertEqual(code,403)
        body={'provider':'claude','kind':'sir-david','prompt':'test','messages':[],'persona':'Gentleman','notes':[],'workspace':True}
        with patch.object(bridge,'claude_options',return_value={}):_,code=self.call(Handler('/__agents/jobs',body))
        self.assertEqual(code,403);self.assertEqual(bridge.JOBS,{})
    def test_explicit_local_pairing_grants_only_configured_workspace(self):
        data,code=self.call(Handler('/__agents/session',{'origin':'https://www.sp1e.se','workspace':True},origin='http://127.0.0.1:4318'))
        self.assertEqual(code,200);self.assertEqual(bridge.SESSIONS[data['token']]['workspace'],str(self.files.root))
        self.assertNotIn(str(self.files.root),json.dumps(data))
        _,code=self.call(Handler('/__agents/session',{'origin':'https://www.sp1e.se','workspace':True},origin='https://www.sp1e.se'));self.assertEqual(code,403)
    def test_scope_cannot_grant_files_to_preview_or_select_another_root(self):
        _,code=self.call(Handler('/__agents/session',{'origin':'https://sp1e-design-mirror.chatgepetee.chatgpt.site','workspace':True},origin='http://127.0.0.1:4318'));self.assertEqual(code,403)
        _,code=self.call(Handler('/__agents/session',{'origin':'https://www.sp1e.se','workspace':True,'root':'C:/'},origin='http://127.0.0.1:4318'));self.assertEqual(code,400)
    def test_expiry_and_local_config_revocation_prevent_undo(self):
        change=self.files.write('note.txt','safe',None);bridge.SESSIONS['paired']['workspace']=str(self.files.root)
        bridge.SESSIONS['paired']['expires']=0
        _,code=self.call(Handler('/__agents/workspace/undo',{'changeId':change['changeId'],'expectedVersion':change['version']}));self.assertEqual(code,401)
        bridge.SESSIONS['paired']={'origin':'https://www.sp1e.se','expires':time.time()+60,'workspace':str(self.files.root)}
        with patch.object(bridge.workspace_tools,'configured',return_value=None):_,code=self.call(Handler('/__agents/workspace'));self.assertEqual(code,403)
        self.assertEqual(self.files.read('note.txt')['text'],'safe')
    def test_revision_checked_undo_and_running_job_conflict(self):
        created=self.files.write('note.txt','before',None);edit=self.files.write('note.txt','after',created['version'])
        bridge.SESSIONS['paired']['workspace']=str(self.files.root)
        bridge.JOBS['test']={'id':'test','token':'paired','state':'running'}
        _,code=self.call(Handler('/__agents/workspace/undo',{'changeId':edit['changeId'],'expectedVersion':edit['version']}));self.assertEqual(code,409)
        bridge.JOBS.clear()
        _,code=self.call(Handler('/__agents/workspace/undo',{'changeId':edit['changeId'],'expectedVersion':'0'*64}));self.assertEqual(code,409)
        _,code=self.call(Handler('/__agents/workspace/undo',{'changeId':edit['changeId'],'expectedVersion':edit['version']}));self.assertEqual(code,200)
        self.assertEqual(self.files.read('note.txt')['text'],'before')
    def test_cli_uses_broker_schema_and_inherited_subscription_route_with_native_tools_off(self):
        with patch.object(bridge,'executable',return_value=['claude']),patch.object(bridge,'claude_options',return_value={}):
            args=bridge.command_for('claude','unused','sir-david-workspace',persona='Gentleman')
        self.assertEqual(args[args.index('--tools')+1],'');self.assertIn('--strict-mcp-config',args)
        self.assertEqual(args[args.index('--setting-sources')+1],'');self.assertIn('--json-schema',args)
        with patch.dict(bridge.os.environ,{'ANTHROPIC_API_KEY':'synthetic','CLAUDE_CODE_USE_BEDROCK':'1'}):
            env=bridge.process_env('sir-david-workspace')
        self.assertNotIn('ANTHROPIC_API_KEY',env);self.assertNotIn('CLAUDE_CODE_USE_BEDROCK',env)
    def test_real_worker_drives_mock_cli_proposals_through_the_actual_file_broker(self):
        created=self.files.write('note.txt','before',None)
        bridge.SESSIONS['paired']['workspace']=str(self.files.root)
        job={'id':'mock','token':'paired','state':'running'}
        def plan(tool=None,args=None,text=''):
            return {'text':text,'calls':[{'tool':tool,'args_json':json.dumps(args)}] if tool else []}
        results=iter([plan('files_read',{'path':'note.txt'}),plan('files_write',{'path':'note.txt','text':'after','expectedVersion':created['version']}),plan(text='Changed note.txt.')])
        launched=[]
        class Process:
            def __init__(self,command,**kwargs):
                launched.append((command,kwargs));self.stdin=io.BytesIO();self.stdout=io.BytesIO(json.dumps({'structured_output':next(results)}).encode());self.stderr=io.BytesIO();self.returncode=0
            def poll(self):return 0
            def wait(self,timeout=None):return 0
        request={'provider':'claude','kind':'sir-david-workspace','prompt':'Edit note.txt','messages':[],'persona':'Gentleman','context':'[]'}
        with patch.object(bridge,'claude_subscription',return_value=True),patch.object(bridge,'executable',return_value=['mock-claude']),patch.object(bridge,'claude_options',return_value={}),patch.object(bridge.subprocess,'Popen',side_effect=Process):
            bridge.workspace_worker(job,request)
        self.assertEqual(job['state'],'done');self.assertEqual(job['result']['text'],'Changed note.txt.')
        self.assertEqual(self.files.read('note.txt')['text'],'after');self.assertEqual(len(launched),3)
        self.assertTrue(all(command[command.index('--tools')+1]=='' for command,_ in launched))
        self.assertNotIn('process',job)
