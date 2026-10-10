import io,json,tempfile,time,unittest,uuid,sys,threading
from pathlib import Path
from unittest.mock import patch
import agent_bridge as a
import gadget_publish as p

class Handler:
    def __init__(self,origin='http://127.0.0.1:4318',host='127.0.0.1:4318',token=''):
        self.command='POST';self.headers={'Origin':origin,'Host':host,'X-Sp1e-Session':token}

class BridgeTests(unittest.TestCase):
    def test_sir_david_auth_metadata_is_fail_closed_and_never_exposes_identity(self):
        from types import SimpleNamespace
        valid={'loggedIn':True,'authMethod':'claude.ai','subscriptionType':'team','apiProvider':'firstParty','email':'private@example.com','token':'secret'}
        def result(data):return SimpleNamespace(returncode=0,stdout=json.dumps(data))
        with tempfile.TemporaryDirectory() as cwd,patch.object(a,'executable',return_value=['agent']):
            with patch.object(a.subprocess,'run',return_value=result(valid)) as run:
                self.assertTrue(a.claude_subscription(cwd,{'NO_COLOR':'1'}))
                self.assertEqual(run.call_args.args[0],['agent','--setting-sources','','--safe-mode','auth','status'])
                self.assertEqual(run.call_args.kwargs['env'],{'NO_COLOR':'1'})
            for extra in ({'authMethod':'api_key'},{'authMethod':'api_key_helper'},{'authMethod':'oauth_token'},
                          {'apiProvider':'bedrock'},{'loggedIn':False},{'subscriptionType':None},{'apiKeySource':'env'}):
                with patch.object(a.subprocess,'run',return_value=result({**valid,**extra})):
                    self.assertFalse(a.claude_subscription(cwd,{}))
        with patch.object(a,'claude_subscription',return_value=True),patch.object(a,'claude_models',return_value=[]):
            data=a.sir_david_status()
        self.assertEqual(data[0]['billingMode'],'subscription')
        self.assertNotIn('private',json.dumps(data));self.assertNotIn('secret',json.dumps(data))

    def test_sir_david_environment_removes_api_routes_but_keeps_own_auth_and_managed_settings(self):
        variables={'ANTHROPIC_API_KEY':'secret','ANTHROPIC_BASE_URL':'other','CLAUDE_CODE_USE_BEDROCK':'1',
                   'CLAUDE_CODE_OAUTH_TOKEN':'secret','CLAUDE_CONFIG_DIR':'own-auth-directory','HOME':'normal-home',
                   'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC':'1','DISABLE_TELEMETRY':'1'}
        with patch.dict(a.os.environ,variables,clear=True):
            env=a.process_env('sir-david')
            self.assertEqual(env,{'CLAUDE_CONFIG_DIR':'own-auth-directory','HOME':'normal-home','NO_COLOR':'1',
                'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC':'1','DISABLE_TELEMETRY':'1'})
            self.assertEqual(a.process_env()['ANTHROPIC_API_KEY'],'secret')

    def test_sir_david_body_persona_and_tools_off_command_with_model_and_effort(self):
        body={'provider':'claude','kind':'sir-david','prompt':'Hello','persona':'Server persona','notes':['Explicit note'],
              'messages':[{'role':'user','content':'Prior'}],'model':'sonnet','effort':'high'}
        catalog=[{'id':'sonnet','name':'Sonnet','efforts':['high']}]
        with patch.object(a,'claude_models',return_value=catalog),patch.object(a,'executable',return_value=['agent']),tempfile.TemporaryDirectory() as cwd:
            request=a.clean_request(body)
            command=a.command_for('claude',cwd,'sir-david',request['model'],request['effort'],request['persona'])
            self.assertIn('Server persona',command[command.index('--system-prompt')+1])
            self.assertEqual(command[command.index('--tools')+1],'')
            self.assertEqual(command[command.index('--mcp-config')+1],'{"mcpServers":{}}')
            self.assertEqual(command[command.index('--setting-sources')+1],'')
            self.assertIn('--safe-mode',command);self.assertIn('--disallowedTools',command)
            self.assertEqual(command[command.index('--model')+1],'sonnet')
            for extra in ({'provider':'codex'},{'persona':''},{'persona':'x'*6001},{'notes':['x'*1001]},
                          {'prompt':'x'*4001},{'current':'code'},{'context':'override'},{'notes':None},
                          {'messages':[{'role':'system','content':'override'}]}):
                with self.assertRaises(ValueError):a.clean_request({**body,**extra})
            self.assertEqual(a.parse_result('claude','sir-david','{"result":"Hello"}',cwd),{'text':'Hello'})
            with self.assertRaises(ValueError):a.parse_result('claude','sir-david',json.dumps({'result':'x'*12001}),cwd)

    def test_sir_david_job_rechecks_auth_and_does_not_spawn_on_unverified_billing(self):
        job={'id':'sir-auth-failure','token':'test','state':'running'}
        a.JOBS[job['id']]=job;a.SLOTS.acquire()
        request={'provider':'claude','kind':'sir-david','prompt':'mock','persona':'Persona','current':'','messages':[]}
        with patch.object(a,'claude_subscription',return_value=False) as probe,patch.object(a.subprocess,'Popen') as process:
            a.worker(job['id'],request)
        self.assertEqual(job['state'],'error');process.assert_not_called();probe.assert_called_once()
        self.assertNotIn('process',job)
        self.assertTrue(a.SLOTS.acquire(blocking=False));a.SLOTS.release();a.JOBS.pop(job['id'])

    def test_sir_david_job_uses_same_checked_environment_and_never_falls_back(self):
        job={'id':'sir-mocked-job','token':'test','state':'running'}
        a.JOBS[job['id']]=job;a.SLOTS.acquire()
        request={'provider':'claude','kind':'sir-david','prompt':'mock','persona':'Persona','current':'','messages':[]}
        command=[sys.executable,'-c','import sys;sys.stdin.read();print(\'{"is_error":true}\')']
        real_popen=a.subprocess.Popen
        with patch.object(a,'claude_subscription',return_value=True) as probe,patch.object(a,'command_for',return_value=command),\
             patch.object(a.subprocess,'Popen',wraps=real_popen) as process:
            a.worker(job['id'],request)
        self.assertEqual(probe.call_args.args[1],process.call_args.kwargs['env'])
        self.assertEqual(job['state'],'error');self.assertEqual(process.call_count,1)
        self.assertNotIn('process',job);a.JOBS.pop(job['id'])

    def test_claude_capabilities_follow_installed_version_without_inference(self):
        class Result:returncode=0;stdout='2.1.291 (Claude Code)'
        with patch.object(a,'executable',return_value=['agent']),patch.object(a.subprocess,'run',return_value=Result()) as run:
            catalog={item['id']:item for item in a.claude_models()}
            self.assertEqual(catalog['sonnet']['efforts'],['low','medium','high','xhigh','max'])
            self.assertEqual(catalog['haiku']['efforts'],[])
            self.assertEqual(run.call_args.args[0],['agent','--version'])
            Result.stdout='2.1.293 (Claude Code)'
            self.assertIn('max',next(item for item in a.claude_models() if item['id']=='haiku')['efforts'])
            Result.stdout='unknown'
            self.assertEqual(a.claude_models(),[])
        with patch.object(a,'executable',return_value=None):self.assertEqual(a.claude_models(),[])

    def test_claude_choices_are_validated_for_every_job_with_safety_flags_preserved(self):
        catalog=[{'id':'sonnet','name':'Sonnet','efforts':['low','high']},{'id':'haiku','name':'Haiku','efforts':[]}]
        with patch.object(a,'claude_models',return_value=catalog),patch.object(a,'executable',return_value=['agent']),tempfile.TemporaryDirectory() as cwd:
            for kind in ('chat','gadget','connector'):
                request=a.clean_request({'provider':'claude','kind':kind,'prompt':'mock','model':'sonnet','effort':'high'})
                command=a.command_for('claude',cwd,kind,request['model'],request['effort'])
                self.assertEqual(command[command.index('--model')+1],'sonnet')
                self.assertEqual(command[command.index('--effort')+1],'high')
                self.assertEqual(command[command.index('--tools')+1],'')
                self.assertIn('--safe-mode',command);self.assertIn('--strict-mcp-config',command)
            command=a.command_for('claude',cwd,'chat')
            self.assertNotIn('--model',command);self.assertNotIn('--effort',command)
            for options in ({'model':'unknown'},{'model':'haiku','effort':'high'},{'effort':'low'},{'model':['sonnet']},{'model':'sonnet','effort':'high;exec'}):
                with self.assertRaises(ValueError):a.clean_request({'provider':'claude','kind':'chat','prompt':'mock',**options})

    def test_codex_cache_is_sanitized_and_missing_or_corrupt_is_safe(self):
        with tempfile.TemporaryDirectory() as cwd,patch.dict(a.os.environ,{'CODEX_HOME':cwd}):
            self.assertEqual(a.codex_models(),[])
            cache=Path(cwd,'models_cache.json')
            cache.write_text('{invalid');self.assertEqual(a.codex_models(),[])
            cache.write_text(json.dumps({'identity':'secret','models':[{'slug':'fixture','display_name':'Fixture','visibility':'list','supported_reasoning_levels':[{'effort':'low'},{'effort':'high'},{'effort':'exec'}],'system_prompt':'secret'},{'slug':'hidden','visibility':'hide'},{'slug':'--unsafe','visibility':'list'}]}))
            self.assertEqual(a.codex_models(),[{'id':'fixture','name':'Fixture','efforts':['low','high']}])
            self.assertNotIn('secret',json.dumps(a.codex_models()))
    def test_codex_options_validate_and_reach_all_job_commands(self):
        catalog=[{'id':'fixture','name':'Fixture','efforts':['low','high']}]
        with patch.object(a,'codex_models',return_value=catalog),patch.object(a,'executable',return_value=['agent']),tempfile.TemporaryDirectory() as cwd:
            for kind in ('chat','gadget','connector'):
                request=a.clean_request({'provider':'codex','kind':kind,'prompt':'mock','model':'fixture','effort':'low'})
                command=a.command_for('codex',cwd,kind,request['model'],request['effort'])
                self.assertEqual(command[command.index('--model')+1],'fixture')
                self.assertIn('model_reasoning_effort="low"',command)
                self.assertIn('--ignore-user-config',command);self.assertIn('multi_agent',command);self.assertIn('read-only',command)
            command=a.command_for('codex',cwd,'chat')
            self.assertNotIn('--model',command);self.assertFalse(any(arg.startswith('model_reasoning_effort=') for arg in command))
            for options in ({'model':'unknown'},{'model':'fixture','effort':'ultra'},{'effort':'low'},{'model':['fixture']},{'model':'fixture','effort':'high;exec'}):
                with self.assertRaises(ValueError):a.clean_request({'provider':'codex','kind':'chat','prompt':'mock',**options})
    def tearDown(self):a.SESSIONS.clear()
    def test_origin_and_rebinding(self):
        self.assertTrue(a.trusted(Handler()))
        self.assertFalse(a.trusted(Handler('https://evil.example')))
        self.assertFalse(a.trusted(Handler(host='evil.example:4318')))
    def test_session_origin_bound_and_expired(self):
        a.SESSIONS['t']={'origin':'https://sp1e.se','expires':time.time()+10}
        self.assertEqual(a.authorized(Handler('https://sp1e.se',token='t')),'t')
        self.assertIsNone(a.authorized(Handler(token='t')))
        a.SESSIONS['t']['expires']=0
        self.assertIsNone(a.authorized(Handler('https://sp1e.se',token='t')))
    def test_get_same_origin_without_origin(self):
        h=Handler();h.command='GET';h.headers.pop('Origin');h.headers['Sec-Fetch-Site']='same-origin'
        self.assertTrue(a.trusted(h))
        h.headers['Sec-Fetch-Site']='cross-site';self.assertFalse(a.trusted(h))
    def test_request_limits(self):
        valid={'provider':'codex','kind':'gadget','prompt':'make timer'}
        self.assertEqual(a.clean_request(valid)['messages'],[])
        for addition in ({'provider':'shell'},{'prompt':'x'*12001},{'current':'x'*200001},{'messages':[{'role':'system','content':'x'}]}):
            with self.assertRaises(ValueError):a.clean_request({**valid,**addition})
    def test_commands_disable_tools(self):
        with tempfile.TemporaryDirectory() as cwd,patch.object(a,'executable',return_value=['agent']):
            codex=a.command_for('codex',cwd,'gadget')
            self.assertIn('read-only',codex);self.assertIn('shell_tool',codex)
            self.assertIn('--ignore-user-config',codex);self.assertIn('--ephemeral',codex)
            claude=a.command_for('claude',cwd,'gadget')
            self.assertEqual(claude[claude.index('--tools')+1],'')
            self.assertIn('--safe-mode',claude);self.assertIn('--strict-mcp-config',claude)
    def test_parse_both_official_formats(self):
        artifact={'title':'Timer','summary':'Test','html':'<!doctype html><p>Timer</p>'}
        with tempfile.TemporaryDirectory() as cwd:
            Path(cwd,'answer.txt').write_text(json.dumps(artifact),encoding='utf-8')
            self.assertEqual(a.parse_result('codex','gadget','',cwd),artifact)
            self.assertEqual(a.parse_result('claude','gadget',json.dumps({'structured_output':artifact}),cwd),artifact)
            with self.assertRaises(ValueError):a.parse_result('claude','chat','{"is_error":true}',cwd)
    def test_connector_protocol_is_proposal_data_with_disabled_cli_tools(self):
        plan={'text':'','calls':[{'tool':'splitt_list_jobs','args_json':'{}'}]}
        with tempfile.TemporaryDirectory() as cwd,patch.object(a,'executable',return_value=['agent']):
            for provider in ('claude','codex'):
                command=a.command_for(provider,cwd,'connector')
                self.assertIn('--json-schema' if provider=='claude' else '--output-schema',command)
            Path(cwd,'answer.txt').write_text(json.dumps(plan),encoding='utf-8')
            self.assertEqual(a.parse_result('codex','connector','',cwd),plan)
            self.assertEqual(a.parse_result('claude','connector',json.dumps({'structured_output':plan}),cwd),plan)
            for calls in ([{'tool':'../../exec','args_json':'{}'}],[{'tool':'splitt_list_jobs','args_json':'[]'}],[None]):
                with self.assertRaises((ValueError,TypeError)):a.parse_result('claude','connector',json.dumps({'structured_output':{'text':'','calls':calls}}),cwd)
        with self.assertRaises(ValueError):a.clean_request({'provider':'codex','kind':'connector','prompt':'test','context':'x'*40001})
    def test_status_does_not_expose_account(self):
        class Result:returncode=0;stdout='{"loggedIn":true,"email":"private@example.com","token":"secret"}'
        with patch.object(a,'executable',return_value=['agent']),patch.object(a.subprocess,'run',return_value=Result()):
            data=a.providers()
        self.assertTrue(all(x['signedIn'] for x in data))
        self.assertNotIn('secret',json.dumps(data));self.assertNotIn('private',json.dumps(data))
    def test_windows_npm_shims_use_official_node_entrypoints_without_shell(self):
        with tempfile.TemporaryDirectory() as cwd:
            root=Path(cwd)
            for provider,package,entry in [('claude','@anthropic-ai/claude-code','cli.js'),('codex','@openai/codex','bin/codex.js')]:
                script=root/'node_modules'/package/entry;script.parent.mkdir(parents=True,exist_ok=True);script.write_text('// fixture')
                with patch.object(a.shutil,'which',side_effect=lambda name: str(root/(provider+'.cmd')) if name==provider else 'node.exe'):
                    self.assertEqual(a.executable(provider),['node.exe',str(script)])
                script.unlink()
                with patch.object(a.shutil,'which',return_value=str(root/(provider+'.cmd'))):self.assertIsNone(a.executable(provider))
    def test_failed_claude_auth_status_is_not_reported_as_signed_in(self):
        class Result:returncode=1;stdout='{"loggedIn":true}'
        with patch.object(a,'executable',return_value=['agent']),patch.object(a.subprocess,'run',return_value=Result()):
            self.assertTrue(all(not x['signedIn'] for x in a.providers()))
    def test_publish_code_only_and_reject_path(self):
        with tempfile.TemporaryDirectory() as cwd:
            body={'id':str(uuid.uuid4()),'title':'Example','summary':'Test','html':'<!doctype html><p>Hi</p>','data':{'private':'value'},'messages':['private']}
            result=p.stage(cwd,body);self.assertTrue(result['staged'])
            saved=json.loads(next(Path(cwd).rglob(body['id']+'.json')).read_text(encoding='utf-8'))
            self.assertNotIn('data',saved);self.assertNotIn('messages',saved)
            with self.assertRaises(ValueError):p.stage(cwd,{**body,'id':'../../secret'})
    def test_cancel_terminates_owned_process_and_releases_slot(self):
        job={'id':'test-cancel','token':'test','state':'running'}
        a.JOBS[job['id']]=job;a.SLOTS.acquire()
        command=[sys.executable,'-c','import sys,time;sys.stdin.read();time.sleep(60)']
        with patch.object(a,'command_for',return_value=command):
            worker=threading.Thread(target=a.worker,args=(job['id'],{'provider':'codex','kind':'chat','prompt':'test','current':'','messages':[]}))
            worker.start()
            for _ in range(100):
                if job.get('process'):break
                time.sleep(.02)
            self.assertIn('process',job)
            process=job['process']
            with a.LOCK:job.update(state='cancelled',finished=time.time());a.stop_process(process)
            worker.join(timeout=15)
        self.assertFalse(worker.is_alive());self.assertIsNotNone(process.poll())
        self.assertEqual(job['state'],'cancelled');self.assertNotIn('process',job)
        self.assertTrue(a.SLOTS.acquire(blocking=False));a.SLOTS.release();a.JOBS.pop(job['id'])
    def test_timeout_covers_a_cli_that_never_reads_stdin(self):
        job={'id':'test-timeout','token':'test','state':'running'}
        a.JOBS[job['id']]=job;a.SLOTS.acquire()
        command=[sys.executable,'-c','import time;time.sleep(60)']
        started=time.monotonic()
        with patch.object(a,'command_for',return_value=command),patch.object(a,'TIMEOUT',.2):
            a.worker(job['id'],{'provider':'codex','kind':'gadget','prompt':'test','current':'x'*200000,'messages':[]})
        self.assertLess(time.monotonic()-started,5)
        self.assertEqual(job['state'],'error');self.assertIn('fyra minuter',job['error'])
        self.assertNotIn('process',job);a.JOBS.pop(job['id'])

if __name__=='__main__':unittest.main()
