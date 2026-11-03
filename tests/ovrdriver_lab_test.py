"""Scoped synthetic display setup must never leave physical-driver settings changed."""
import sys
sys.dont_write_bytecode = True
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('petplay_lab', ROOT / 'utils/petplay-ovrdriver-lab.py')
lab = importlib.util.module_from_spec(spec)
spec.loader.exec_module(lab)


class DisplayProfileTests(unittest.TestCase):
    def test_scoped_beyond_profile_and_byte_exact_restoration(self):
        with tempfile.TemporaryDirectory(dir=ROOT / '_scratch', prefix='profile-test-') as work:
            root = Path(work)
            settings = root / 'steamvr.vrsettings'
            paths = root / 'openvrpaths.vrpath'
            runtime = root / 'runtime'
            (runtime / 'drivers/lighthouse').mkdir(parents=True)
            driver = root / 'submodules/petplay_ovrdriver/zig-out/petplay/bin/linux64/driver_petplay.so'
            driver.parent.mkdir(parents=True)
            driver.touch()
            settings.write_text('{"steamvr":{"supersampleScale":0.5},"driver_lighthouse":{"enable":true}}\n')
            paths.write_text(json.dumps({'runtime': [str(runtime)], 'external_drivers': ['/original/driver']}) + '\n')
            originals = [settings.read_bytes(), paths.read_bytes()]
            session = root / 'session'
            profile = json.loads((ROOT / 'utils/vrlab/display-presets/beyond75.json').read_text())
            with patch.multiple(lab, ROOT=root, SETTINGS=settings, PATHS=paths, SESSION=session, BACKUP=session / 'restore.json'), patch.object(lab, 'running', return_value=[]):
                lab.prepare(driver_direct=True, display_profile=profile)
                configured = json.loads(settings.read_text())
                self.assertEqual(configured['driver_petplay']['renderWidth'], 3562)
                self.assertEqual(configured['driver_petplay']['refreshHz'], 75)
                self.assertFalse(configured['driver_lighthouse']['enable'])
                self.assertEqual(configured['steamvr']['forcedDriver'], 'petplay')
                self.assertEqual(configured['steamvr']['supersampleScale'], 1.0)
                self.assertEqual(json.loads(paths.read_text())['external_drivers'], [str(driver.parents[2])])
                self.assertTrue((session / 'display-profile.json').is_file())
                lab.restore()
                self.assertEqual([settings.read_bytes(), paths.read_bytes()], originals)

    def test_server_coordinates_compositor_exit_before_fallback_signal(self):
        signals = []
        def named(name):
            return {'vrserver': [101], 'vrcompositor': [102]}.get(name, [])
        with patch.object(lab, 'pids', side_effect=named), patch.object(lab, 'running', return_value=[]), patch.object(lab.os, 'kill', side_effect=lambda pid, sig: signals.append(pid)):
            lab.stop()
        self.assertEqual(signals, [101])

    def test_hung_server_keeps_recovery_and_does_not_terminate_compositor_under_it(self):
        signals = []
        def named(name):
            return {'vrserver': [101], 'vrcompositor': [102]}.get(name, [])
        with patch.object(lab, 'pids', side_effect=named), patch.object(lab, 'running', return_value=[('vrserver', 101)]), patch.object(lab.time, 'monotonic', side_effect=[0, 16]), patch.object(lab.os, 'kill', side_effect=lambda pid, sig: signals.append(pid)):
            with self.assertRaisesRegex(RuntimeError, 'leave synthetic configuration'):
                lab.stop()
        self.assertEqual(signals, [101])

    def test_refuses_to_change_settings_while_runtime_is_live(self):
        with patch.object(lab, 'running', return_value=[('vrserver', 123)]):
            with self.assertRaisesRegex(RuntimeError, 'Stop SteamVR'):
                lab.prepare(display_profile={'driver_petplay': {'refreshHz': 90}})


if __name__ == '__main__':
    unittest.main()
