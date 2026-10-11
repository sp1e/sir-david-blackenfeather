import os, tempfile, unittest, json, shutil
from pathlib import Path
from unittest.mock import patch
from workspace_tools import Workspace, digest, native_path

class WorkspaceTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.base=Path(self.temp.name)
        self.root=self.base/'workspace';self.root.mkdir();self.files=Workspace(self.root,self.base/'history')
    def tearDown(self):
        # This owned fixture may now contain paths beyond the legacy Win32 limit.
        self.assertEqual(self.base,Path(self.temp.name))
        self.assertTrue(self.base.absolute().is_relative_to(Path(tempfile.gettempdir()).absolute()))
        shutil.rmtree(native_path(self.base))
        self.temp.cleanup()
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
        self.assertEqual((self.files.history/(created['changeId']+'.created.bin')).read_text(),'Sparad text')
        self.assertEqual(self.files.activity()[0]['action'],'undo-create')
        self.files.undo(created['changeId'],None)
        self.assertEqual(self.files.read('new.txt')['text'],'Sparad text')
    def test_create_is_exclusive_and_wrong_revision_never_writes(self):
        first=self.files.write('notes.txt','original',None)
        with self.assertRaises(OSError):self.files.write('notes.txt','overwrite',None)
        with self.assertRaises(ValueError):self.files.write('notes.txt','overwrite','0'*64)
        self.assertEqual(self.files.read('notes.txt')['text'],'original')
    def test_recovery_failure_before_new_file_creation_leaves_no_file(self):
        with patch.object(Path,'write_bytes',side_effect=OSError('backup unavailable')):
            with self.assertRaises(OSError):self.files.write('new.txt','new',None)
        self.assertFalse((self.root/'new.txt').exists())
        with patch.object(self.files,'save_record',side_effect=OSError('journal unavailable')):
            with self.assertRaises(OSError):self.files.write('new.txt','new',None)
        self.assertFalse((self.root/'new.txt').exists())
        self.assertEqual(self.files.activity(),[])
    def test_final_journal_failure_rolls_back_existing_and_new_files(self):
        first=self.files.write('notes.txt','original',None)
        saved=self.files.save_record
        def fail_done(row):
            if row['state']=='done':raise OSError('journal unavailable')
            return saved(row)
        with patch.object(self.files,'save_record',side_effect=fail_done):
            with self.assertRaises(ValueError):self.files.write('notes.txt','modified',first['version'])
            with self.assertRaises(ValueError):self.files.write('new.txt','new',None)
        self.assertEqual(self.files.read('notes.txt')['text'],'original')
        self.assertFalse((self.root/'new.txt').exists())
    def test_undo_create_journal_failure_preserves_file_and_retry(self):
        created=self.files.write('new.txt','owner text',None)
        saved=self.files.save_record
        def fail_undo(row):
            if row['state']=='undone':raise OSError('journal unavailable')
            return saved(row)
        with patch.object(self.files,'save_record',side_effect=fail_undo):
            with self.assertRaises(OSError):self.files.undo(created['changeId'],created['version'])
        self.assertEqual(self.files.read('new.txt')['text'],'owner text')
        self.assertEqual(self.files.activity()[0]['action'],'create')
        self.files.undo(created['changeId'],created['version'])
        self.assertEqual(self.files.activity()[0]['action'],'undo-create')
        self.files.undo(created['changeId'],None)
        self.assertEqual(self.files.read('new.txt')['text'],'owner text')
    def test_changing_root_isolates_history_even_with_matching_file_revision(self):
        first=self.files.write('notes.txt','first workspace',None)
        edit=self.files.write('notes.txt','same revision',first['version'])
        other_root=self.base/'other';other_root.mkdir()
        other=Workspace(other_root,self.base/'history')
        other.write('notes.txt','same revision',None)
        self.assertNotEqual(self.files.history,other.history)
        self.assertEqual(len(other.activity()),1)
        self.assertNotIn(edit['changeId'],json.dumps(other.activity()))
        with self.assertRaises(OSError):other.undo(edit['changeId'],edit['version'])
        self.assertEqual(other.read('notes.txt')['text'],'same revision')
        reopened=Workspace(self.root,self.base/'history')
        reopened.undo(edit['changeId'],edit['version'])
        self.assertEqual(reopened.read('notes.txt')['text'],'first workspace')
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
    @unittest.skipUnless(os.name=='nt','Windows extended-path I/O')
    def test_windows_long_file_and_history_paths_preserve_identity_and_operations(self):
        root=self.root/('r'*140)/('s'*80)
        history=self.base/'history'/('h'*160)
        native_path(root).mkdir(parents=True)
        files=Workspace(root,history)
        self.assertEqual(files.root,root)
        self.assertGreater(len(str(root/'note.md')),260)
        self.assertGreater(len(str(files.history/'example.bin')),260)
        first=files.write('note.md','Long path text',None)
        self.assertEqual(files.read('note.md')['text'],'Long path text')
        self.assertEqual(files.listing()['items'][0]['path'],'note.md')
        self.assertEqual(files.search('Long')['matches'][0]['path'],'note.md')
        changed=files.write('note.md','Changed text',first['version'])
        restored=files.undo(changed['changeId'],changed['version'])
        self.assertEqual(files.read('note.md')['text'],'Long path text')
        files.undo(restored['changeId'],restored['version'])
        self.assertEqual(files.read('note.md')['text'],'Changed text')
        created=files.write('new.md','Recoverable',None)
        files.undo(created['changeId'],created['version'])
        self.assertFalse(native_path(root/'new.md').exists())
        files.undo(created['changeId'],None)
        self.assertEqual(files.read('new.md')['text'],'Recoverable')
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
