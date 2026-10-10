import copy, importlib.util, json, tempfile, unittest, threading, urllib.request, urllib.error
from types import SimpleNamespace
from pathlib import Path
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('bridge', Path(__file__).with_name('patch_voice.py'))
bridge=importlib.util.module_from_spec(spec);spec.loader.exec_module(bridge)

class SafetyTests(unittest.TestCase):
    def test_chat_and_pet_scope(self):
        cfg={**bridge.DEFAULTS,'enabled':True,'voice_id':'voice1','chats':[bridge.CURRENT_CHAT]}
        event={'hook_event_name':'Stop','session_id':bridge.CURRENT_CHAT}
        self.assertTrue(bridge.eligible(event,cfg,True))
        for invalid in [dict(event,session_id='other'),dict(event,hook_event_name='PostToolUse'),dict(event,stop_hook_active=True)]:
            self.assertFalse(bridge.eligible(invalid,cfg,True))
        self.assertFalse(bridge.eligible(event,cfg,False))
        self.assertFalse(bridge.eligible(event,dict(cfg,muted=True),True))
        self.assertFalse(bridge.eligible(event,dict(cfg,enabled=False),True))
    def test_credentials_and_code_not_spoken(self):
        self.assertEqual(bridge.spoken_text('Password: abc123'), '')
        self.assertEqual(bridge.spoken_text('Here is sk_synthetic_fake_credential'), '')
        self.assertEqual(bridge.spoken_text('```python\nprint("private")\n```'), '')
        self.assertEqual(bridge.spoken_text('Hello [Simon](https://example.com).\n<oai-mem-citation>private</oai-mem-citation>'),'Hello Simon.')
    def test_voice_follows_patch_across_chats(self):
        cfg={**bridge.DEFAULTS,'enabled':True,'scope':'patch','chats':[],'voice_id':'saved'}
        event={'hook_event_name':'Stop','session_id':'another-valid-chat'}
        self.assertTrue(bridge.eligible(event,cfg,True))
        self.assertFalse(bridge.eligible(event,cfg,False))
        self.assertFalse(bridge.eligible(event,dict(cfg,muted=True),True))
        self.assertFalse(bridge.eligible(event,dict(cfg,enabled=False),True))
        self.assertFalse(bridge.eligible(dict(event,session_id=None),cfg,True))
        self.assertFalse(bridge.eligible(event,dict(cfg,scope='listed'),True))
    def test_truncation_stops_at_sentence(self):
        self.assertEqual(bridge.spoken_text('One sentence. Another very long sentence with words.',20),'One sentence.')
    def test_pet_selection_fails_closed(self):
        with tempfile.TemporaryDirectory(dir=bridge.ROOT) as folder:
            path=Path(folder)/'state.json'
            self.assertFalse(bridge.patch_active(path))
            path.write_text(json.dumps({'electron-persisted-atom-state':{'last-observed-cloud-pet-selection-v1':{'account':bridge.PET_ID}}}))
            self.assertTrue(bridge.patch_active(path))
            path.write_text(json.dumps({'electron-persisted-atom-state':{'last-observed-cloud-pet-selection-v1':{'one':bridge.PET_ID,'two':'codex'}}}))
            self.assertFalse(bridge.patch_active(path))
    def test_dpapi_roundtrip(self):
        protected=bridge.protect(b'synthetic-test-not-a-key')
        self.assertNotIn(b'synthetic-test-not-a-key',protected)
        self.assertEqual(bridge.protect(protected,True),b'synthetic-test-not-a-key')
    def test_persistence(self):
        with tempfile.TemporaryDirectory(dir=bridge.ROOT) as folder:
            with patch.object(bridge,'CONFIG',Path(folder)/'profile.json'):
                cfg={**bridge.DEFAULTS,'voice_id':'saved','muted':True}
                bridge.save_profile(cfg)
                self.assertEqual(bridge.profile()['voice_id'],'saved')
                self.assertTrue(bridge.profile()['muted'])
    def test_redirects_are_refused(self):
        self.assertIsNone(bridge.NoRedirect().redirect_request(None,None,None,None,None,None))
    def test_stop_discards_an_inflight_voice_result(self):
        entered=threading.Event();release=threading.Event()
        cfg={**bridge.DEFAULTS,'enabled':True,'voice_id':'voice1','chats':[bridge.CURRENT_CHAT]}
        played=[]
        def fake_service(*args,**kwargs):
            entered.set();release.wait(2);return b'synthetic audio'
        with patch.object(bridge,'profile',return_value=cfg),patch.object(bridge,'eleven',side_effect=fake_service),patch.object(bridge.Playback,'stop'),patch.object(bridge.Playback,'play',side_effect=lambda p:played.append(p)):
            engine=bridge.Engine()
            self.assertTrue(engine.enqueue('A short test.'))
            self.assertTrue(entered.wait(2));engine.stop();release.set();engine.jobs.join()
            self.assertEqual(played,[])
    def test_install_preserves_existing_hooks_and_is_idempotent(self):
        with tempfile.TemporaryDirectory(dir=bridge.ROOT) as folder:
            root=Path(folder);(root/'.codex').mkdir()
            target=root/'.codex/hooks.json'
            existing={'hooks':{'Stop':[{'hooks':[{'type':'command','command':'existing notifier'}]}]},'description':'Keep this'}
            target.write_text(json.dumps(existing))
            with patch.object(bridge.Path,'home',return_value=root),patch.object(bridge,'ROOT',root),patch.object(bridge,'CONFIG',root/'profile.json'):
                bridge.install();bridge.install()
            saved=json.loads(target.read_text())
            self.assertEqual(saved['description'],'Keep this')
            self.assertEqual(saved['hooks']['Stop'][0],existing['hooks']['Stop'][0])
            self.assertEqual(len(saved['hooks']['Stop']),2)
            self.assertEqual(len(saved['hooks']['Interrupt']),1)
    def test_http_requires_host_origin_and_token(self):
        bridge.Handler.token='synthetic-token'
        bridge.Handler.engine=SimpleNamespace(status='Ready',last_error='')
        server=bridge.ThreadingHTTPServer(('127.0.0.1',0),bridge.Handler)
        thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        url=f'http://127.0.0.1:{server.server_port}/api/state'
        try:
            for headers in [{},{'Host':'malicious.example','X-Patch-Token':'synthetic-token'},
                {'Origin':'https://malicious.example','X-Patch-Token':'synthetic-token'},
                {'Sec-Fetch-Site':'cross-site','X-Patch-Token':'synthetic-token'}]:
                with self.assertRaises(urllib.error.HTTPError) as caught:
                    urllib.request.urlopen(urllib.request.Request(url,headers=headers))
                self.assertEqual(caught.exception.code,403)
            with urllib.request.urlopen(urllib.request.Request(url,headers={'X-Patch-Token':'synthetic-token'})) as response:
                data=json.load(response)
                self.assertNotIn('key',data)
                self.assertIn('key_connected',data)
        finally:server.shutdown();server.server_close()

if __name__=='__main__':unittest.main()
