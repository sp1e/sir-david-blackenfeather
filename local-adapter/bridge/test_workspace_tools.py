import os, tempfile, unittest, json
from pathlib import Path
from unittest.mock import patch
from workspace_tools import Workspace, digest

class WorkspaceTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.base=Path(self.temp.name)
        self.root=self.base/'workspace';self.root.mkdir();self.files=Workspace(self.root,self.base/'history')
    def tearDown(self):self.temp.cleanup()
    def test_create_read_edit_undo_roundtrip_preserves_utf8(self):
        first=self.files.write('notes.md','En korp.\n',None)
        read=self.files.read('notes.md');self.assertEqual(read['version'],first['version'])
        edit=self.files.write('notes.md','En äldre korp.\n',read['version'])
        restored=self.files.undo(edit['changeId'],edit['version'])
        self.assertEqual(self.files.read('notes.md')['text'],'En korp.\n')
        self.assertEqual(restored['version'],first['version'])
        self.assertEqual(len(self.files.activity()),2)
    def test_new_file_undo_removes_only_version_and_keeps_recoverable_bytes(self):
        created=self.files.write('new.txt','Sparad text',None)
        self.files.undo(created['changeId'],created['version'])
        self.assertFalse((self.root/'new.txt').exists())
        self.assertEqual((self.base/'history'/(created['changeId']+'.created.bin')).read_text(),'Sparad text')
        self.assertEqual(self.files.activity()[0]['action'],'undo-create')
        self.files.undo(created['changeId'],None)
        self.assertEqual(self.files.read('new.txt')['text'],'Sparad text')
    def test_create_is_exclusive_and_wrong_revision_never_writes(self):
        first=self.files.write('notes.txt','original',None)
        with self.assertRaises(OSError):self.files.write('notes.txt','overwrite',None)
        with self.assertRaises(ValueError):self.files.write('notes.txt','overwrite','0'*64)
        self.assertEqual(self.files.read('notes.txt')['text'],'original')
    def test_external_edit_prevents_undo(self):
        first=self.files.write('notes.txt','original',None)
        (self.root/'notes.txt').write_text('user edit')
        with self.assertRaises(ValueError):self.files.undo(first['changeId'],first['version'])
        self.assertEqual((self.root/'notes.txt').read_text(),'user edit')
    def test_traversal_absolute_ads_reserved_and_normalized_paths_rejected(self):
        for path in ('../outside.txt','/outside.txt','C:/outside.txt','x\\y.txt','CON.txt','a/../b','a//b','a/./b','notes.txt:secret','name.','name ','NUL','COM1.log'):
            with self.subTest(path=path),self.assertRaises(ValueError):self.files.path(path)
    def test_binary_invalid_utf8_and_oversize_never_modified(self):
        for data in (b'a\0b',b'\xff',b'a'*64001):
            (self.root/'bad.txt').write_bytes(data)
            with self.assertRaises(ValueError):self.files.read('bad.txt')
            with self.assertRaises(ValueError):self.files.write('bad.txt','safe',digest(data))
            self.assertEqual((self.root/'bad.txt').read_bytes(),data)
    def test_text_pages_and_literal_search(self):
        self.files.write('large.txt','ä'*12001,None)
        self.assertEqual(self.files.read('large.txt')['nextOffset'],12000)
        self.assertEqual(self.files.read('large.txt',12000)['text'],'ä')
        self.files.write('match.md','[literal]\nLITERAL\n',None)
        result=self.files.search('[literal]')
        self.assertEqual(result['matches'][0]['line'],1)
        self.assertEqual(len(result['matches']),1)
    def test_empty_directory_tree_search_is_bounded(self):
        for number in range(110):(self.root/str(number)).mkdir()
        with patch.object(self.files,'entries',wraps=self.files.entries) as scan:
            result=self.files.search('missing')
        self.assertTrue(result['truncated'])
        self.assertLessEqual(scan.call_count,100)
    def test_listing_bounds_enumeration_before_sorting(self):
        for number in range(510):(self.root/str(number)).mkdir()
        entries,truncated=self.files.entries(self.root)
        self.assertEqual(len(entries),500)
        self.assertTrue(truncated)
        self.assertTrue(self.files.listing()['truncated'])
    def test_history_is_outside_workspace_and_payload_has_no_backup_text(self):
        created=self.files.write('secret.txt','synthetic-private-text',None)
        serialized=json.dumps(self.files.activity())
        self.assertNotIn('synthetic-private-text',serialized)
        self.assertNotIn(str(self.base),serialized)
        with self.assertRaises(ValueError):Workspace(self.root,self.root/'history')
    def test_hardlink_cannot_read_or_modify_external_file(self):
        outside=self.base/'outside.txt';outside.write_text('outside')
        os.link(outside,self.root/'link.txt')
        with self.assertRaises(ValueError):self.files.read('link.txt')
        with self.assertRaises(ValueError):self.files.write('link.txt','change',digest(b'outside'))
        self.assertEqual(outside.read_text(),'outside')
    def test_link_cannot_escape_workspace(self):
        outside=self.base/'outside.txt';outside.write_text('outside')
        try:(self.root/'link.txt').symlink_to(outside)
        except OSError:self.skipTest('Windows symlink privilege unavailable; junction test covers directory reparse path')
        with self.assertRaises(ValueError):self.files.read('link.txt')
    @unittest.skipUnless(os.name=='nt','Windows handle policy')
    def test_windows_handle_blocks_rename_and_other_writer_during_revision_check(self):
        self.files.write('notes.txt','original',None)
        with self.files.opened(self.root/'notes.txt',write=True):
            with self.assertRaises(OSError):os.replace(self.root/'notes.txt',self.root/'moved.txt')
            with self.assertRaises(OSError):(self.root/'notes.txt').write_text('other writer')
    @unittest.skipUnless(os.name=='nt','Windows junction policy')
    def test_windows_junction_and_parent_rename_cannot_redirect_write(self):
        import subprocess
        outside=self.base/'outside';outside.mkdir();(outside/'note.txt').write_text('outside')
        junction=self.root/'linked'
        result=subprocess.run(['cmd','/c','mklink','/J',str(junction),str(outside)],capture_output=True)
        self.assertEqual(result.returncode,0,'Could not create synthetic junction')
        try:
            with self.assertRaises(ValueError):self.files.read('linked/note.txt')
            with self.assertRaises(ValueError):self.files.write('linked/note.txt','bad',digest(b'outside'))
            self.assertEqual((outside/'note.txt').read_text(),'outside')
        finally:os.rmdir(junction)
        (self.root/'sub').mkdir();self.files.write('sub/note.txt','original',None)
        with self.files.opened(self.root/'sub/note.txt',write=True):
            with self.assertRaises(OSError):os.rename(self.root/'sub',self.root/'redirected')
    def test_tool_names_and_extra_arguments_never_execute(self):
        for tool,args in [('shell',{'command':'whoami'}),('files_read',{'path':'x','root':'C:/'}),('files_write',{'path':'x','text':'a'}),('files_read',{'path':'x','offset':True})]:
            with self.subTest(tool=tool),self.assertRaises(ValueError):self.files.execute(tool,args)
    def test_full_history_prevents_even_new_file_creation(self):
        with patch('workspace_tools.MAX_HISTORY',0),self.assertRaises(ValueError):self.files.write('new.txt','a',None)
        self.assertFalse((self.root/'new.txt').exists())

if __name__=='__main__':unittest.main()
