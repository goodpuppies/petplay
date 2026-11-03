#!/usr/bin/env python3
"""Scoped Linux synthetic-HMD session. No installation or permanent driver registration.

Run: python3 utils/petplay-ovrdriver-lab.py run --seconds 30
Recover after interruption: python3 utils/petplay-ovrdriver-lab.py recover
Original bytes are saved before mutation; recovery requires SteamVR to be stopped.
"""
import argparse
import base64
import json
import os
from pathlib import Path
import signal
import subprocess
import time
import tempfile

ROOT = Path(__file__).resolve().parents[1]
STEAM = Path.home() / '.local/share/Steam'
SETTINGS = STEAM / 'config/steamvr.vrsettings'
PATHS = Path.home() / '.config/openvr/openvrpaths.vrpath'
SESSION = ROOT / 'logs/ovrdriver-lab'
BACKUP = SESSION / 'restore.json'
RUNTIME_NAMES = ('vrmonitor', 'vrserver', 'vrcompositor', 'vrstartup', 'steamvr_room_se')


class RuntimeLogWatch:
    """Inspect only this session's new log bytes, including log replacement/truncation."""
    def __init__(self, paths):
        self.positions = {}
        self.tails = {}
        for path in paths:
            try:
                stat = path.stat()
                self.positions[path] = (stat.st_ino, stat.st_size)
            except FileNotFoundError:
                self.positions[path] = (0, 0)

    def check(self):
        for path, (inode, offset) in list(self.positions.items()):
            try:
                stat = path.stat()
                if stat.st_ino != inode or stat.st_size < offset:
                    offset = 0
                    self.tails[path] = ''
                with path.open('rb') as log:
                    log.seek(offset)
                    data = log.read()
                    self.positions[path] = (stat.st_ino, log.tell())
            except FileNotFoundError:
                continue
            text = self.tails.get(path, '') + data.decode(errors='replace')
            self.tails[path] = text[-256:]
            for failure in ('VK_ERROR_DEVICE_LOST', 'vkerror=-4',
                            'context is guilty of a hard recovery',
                            'Unexpected failure when checking for timeline signal',
                            'panic: attempt to use null value',
                            'PetPlay capture: Vulkan failure'):
                if failure in text:
                    raise RuntimeError(f'GPU/runtime failure in {path.name}: {failure}; stopping lab')


def pids(name):
    result = subprocess.run(['pgrep', '-x', name], capture_output=True, text=True)
    if result.returncode not in (0, 1):
        raise RuntimeError(result.stderr)
    found = []
    for value in result.stdout.split():
        try:
            # A dead child awaiting waitpid has no runtime state or device ownership.
            if Path(f'/proc/{value}/stat').read_text().rsplit(')', 1)[1].split()[0] != 'Z':
                found.append(int(value))
        except FileNotFoundError:
            pass
    return found


def running():
    return [(name, pid) for name in RUNTIME_NAMES for pid in pids(name)]


def stop():
    # Let vrserver coordinate clients and shared-image release before terminating
    # vrcompositor. Simultaneous SIGTERM can strand resource-release IPC.
    for name in ('steamvr_room_se', 'vrstartup', 'vrmonitor', 'vrserver'):
        for pid in pids(name):
            try:
                os.kill(pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
    deadline = time.monotonic() + 15
    while running() and time.monotonic() < deadline:
        time.sleep(.2)
    if not running():
        return
    # A compositor left after the server has exited cannot service a session.
    # Keep the failed-stop backup if the server itself remains alive.
    if not pids('vrserver'):
        for pid in pids('vrcompositor'):
            try:
                os.kill(pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
        deadline = time.monotonic() + 5
        while running() and time.monotonic() < deadline:
            time.sleep(.2)
    if running():
        raise RuntimeError(f'SteamVR still running; leave synthetic configuration in place: {running()}')


def atomic_write(path, data):
    temporary = path.with_name(path.name + '.petplay-lab-tmp')
    mode = path.stat().st_mode & 0o777 if path.exists() else 0o600
    with temporary.open('wb') as file:
        os.fchmod(file.fileno(), mode)
        file.write(data)
        file.flush()
        os.fsync(file.fileno())
    os.replace(temporary, path)


def restore():
    if running():
        raise RuntimeError('Stop SteamVR before recovery; physical-driver settings must not change live')
    if not BACKUP.exists():
        print('No pending lab recovery')
        return
    data = json.loads(BACKUP.read_text())
    expected = {str(SETTINGS), str(PATHS)}
    if set(data) != expected:
        raise RuntimeError('Unexpected recovery paths')
    for path, content in data.items():
        atomic_write(Path(path), base64.b64decode(content, validate=True))
    BACKUP.rename(SESSION / 'restored.json')
    print('Restored original settings and external-driver registrations; SteamVR remains off', flush=True)


def prepare(direct_server=False, disable_async=False, driver_direct=False, real_hmd=False, touch_controllers=False, display_profile=None):
    # Touch emulation lets applications' shipped Touch bindings drive the synthetic hands.
    controller_type = 'oculus_touch' if touch_controllers else 'petplay_synthetic'
    if running():
        raise RuntimeError('Stop SteamVR before starting a synthetic-only session')
    if BACKUP.exists():
        raise RuntimeError('Pending recovery exists; run recover first')
    driver = ROOT / 'submodules/petplay_ovrdriver/zig-out/petplay'
    if not (driver / 'bin/linux64/driver_petplay.so').is_file():
        raise RuntimeError('Build the driver first')
    SESSION.mkdir(parents=True, exist_ok=True, mode=0o700)
    originals = {str(p): base64.b64encode(p.read_bytes()).decode() for p in (SETTINGS, PATHS)}
    fd = os.open(BACKUP, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'wb') as backup:
        backup.write(json.dumps(originals, indent=2).encode())
        backup.flush()
        os.fsync(backup.fileno())
    try:
        settings = json.loads(SETTINGS.read_text())
        vr = settings.setdefault('steamvr', {})
        if real_hmd:
            # A separate scoped manifest loads the controller provider without
            # claiming display redirection or modifying the installed package.
            hybrid = SESSION / 'controller-driver'
            hybrid.mkdir(exist_ok=True)
            for name in ('bin', 'resources'):
                link = hybrid / name
                if not link.exists():
                    link.symlink_to(driver / name, target_is_directory=True)
            manifest = json.loads((driver / 'driver.vrdrivermanifest').read_text())
            manifest.update(alwaysActivate=True, redirectsDisplay=False)
            atomic_write(hybrid / 'driver.vrdrivermanifest', (json.dumps(manifest, indent=2) + '\n').encode())
            vr.pop('forcedDriver', None)
            vr['activateMultipleDrivers'] = True
            settings.setdefault('driver_petplay', {}).update(enable=True, syntheticHmd=False,
                syntheticControllers=True, driverDirect=False, socketDirectory=str(SESSION / 'ipc'),
                syntheticControllerType=controller_type)
            paths = json.loads(PATHS.read_text())
            paths['external_drivers'] = list(dict.fromkeys([*paths.get('external_drivers', []), str(hybrid)]))
            atomic_write(SETTINGS, (json.dumps(settings, indent=2) + '\n').encode())
            atomic_write(PATHS, (json.dumps(paths, indent=2) + '\n').encode())
            return
        vr.update(forcedDriver='petplay', activateMultipleDrivers=False,
                  displayDebug=not driver_direct, directMode=driver_direct, enableHomeApp=False,
                  allowFallbackMirrorWindowLinux=True)
        if disable_async:
            vr["enableLinuxVulkanAsync"] = False
        if direct_server:
            vr.update(startCompositorFromAppLaunch=False, startMonitorFromAppLaunch=False,
                      startDashboardFromAppLaunch=False, startOverlayAppsFromDashboard=False)
        # A fixed synthetic head has no physical activity/proximity sensor. Keep
        # only this scoped synthetic session awake; exact user settings restore.
        settings.setdefault('power', {}).update(pauseCompositorOnStandby=False,
                                                turnOffScreensTimeout=3600.0,
                                                turnOffControllersTimeout=3600.0)
        settings.setdefault('driver_petplay', {}).update(enable=True, syntheticHmd=True, syntheticControllers=True, driverDirect=driver_direct, socketDirectory=str(SESSION / 'ipc'), syntheticControllerType=controller_type)
        for key in ('renderWidth', 'renderHeight', 'displayEyeWidth', 'displayEyeHeight',
                    'refreshHz', 'ipdMeters', 'maxSwapchainMiB'):
            settings['driver_petplay'].pop(key, None)
        if display_profile:
            settings['driver_petplay'].update(display_profile['driver_petplay'])
            vr.update(supersampleManualOverride=True, supersampleScale=1.0,
                      maxRecommendedResolution=8192, renderTargetMultiplier=1.0)
            atomic_write(SESSION / 'display-profile.json', (json.dumps(display_profile, indent=2) + '\n').encode())
        # Explicitly disable every bundled physical/remote driver, in addition to forcedDriver.
        runtime = Path(json.loads(PATHS.read_text())['runtime'][0])
        for folder in (runtime / 'drivers').iterdir():
            if folder.is_dir() and folder.name != 'petplay':
                settings.setdefault('driver_' + folder.name, {})['enable'] = False
        paths = json.loads(PATHS.read_text())
        paths['external_drivers'] = [str(driver)]
        atomic_write(SETTINGS, (json.dumps(settings, indent=2) + '\n').encode())
        atomic_write(PATHS, (json.dumps(paths, indent=2) + '\n').encode())
    except BaseException:
        restore()
        raise


def desktop_env():
    env = dict(os.environ)
    # Copy only desktop connection variables, never arbitrary Steam process secrets.
    candidates = pids('steam')
    for pid in candidates:
        try:
            entries = Path(f'/proc/{pid}/environ').read_bytes().split(b'\0')
        except OSError:
            continue
        for entry in entries:
            key, _, value = entry.partition(b'=')
            if key in (b'DISPLAY', b'XAUTHORITY', b'XDG_RUNTIME_DIR', b'WAYLAND_DISPLAY', b'DBUS_SESSION_BUS_ADDRESS'):
                env[key.decode()] = value.decode()
        if env.get('DISPLAY'):
            return env
    if not env.get('DISPLAY'):
        raise RuntimeError('No desktop DISPLAY available')
    return env


def interrupted(signum, frame):
    raise KeyboardInterrupt


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('run', 'recover'))
    parser.add_argument('--real-hmd', action='store_true', help='Keep physical headset/display configuration; add only synthetic controllers')
    parser.add_argument('--x11-compositor', action='store_true', help='Retry a failed compositor under X11 without Wayland display variables')
    parser.add_argument('--guard-monitor', action='store_true', help='Start an owned monitor with -nokillprocess before later Steam launches can start a destructive monitor')
    parser.add_argument('--disable-fixes', action='store_true', help='Disable the existing SteamVR fixes layer for this compositor experiment only')
    parser.add_argument('--direct-server', action='store_true', help='Launch vrserver under vrenv directly, then X11 compositor; avoid the initial Wayland crash and autostart clients')
    parser.add_argument('--driver-direct', action='store_true', help='Use experimental real-buffer driver-direct backend instead of DisplayRedirect')
    parser.add_argument('--disable-async', action='store_true', help='Disable Linux Vulkan async for this session only (capture diagnostic)')
    parser.add_argument('--renderdoc-layer', type=Path, help='Private RenderDoc implicit-layer directory for the X11 retry only')
    parser.add_argument('--capture-layer', action='store_true', help='Enable the optional pure Zig producer-side readback layer for this compositor only')
    parser.add_argument('--touch-controllers', action='store_true', help='Present the synthetic controllers as Oculus Touch so applications use their own Touch bindings')
    parser.add_argument('--display-profile', choices=['lab', 'beyond75'], default='lab',
                        help='Synthetic display workload; beyond75 matches saved BSB render size/rate without a physical headset')
    parser.add_argument('--refresh-hz', type=int, help='Override synthetic display clock (30..240 Hz)')
    parser.add_argument('--seconds', type=float, default=30)
    args = parser.parse_args()
    if args.real_hmd and (args.display_profile != 'lab' or args.refresh_hz is not None):
        parser.error('Synthetic display profiles/refresh overrides cannot be used with --real-hmd')
    if args.refresh_hz is not None and not 30 <= args.refresh_hz <= 240:
        parser.error('--refresh-hz must be 30..240')
    display_profile = None
    if args.display_profile != 'lab':
        display_profile = json.loads((ROOT / 'utils/vrlab/display-presets' / (args.display_profile + '.json')).read_text())
    if args.refresh_hz is not None:
        display_profile = display_profile or {'name': 'lab', 'driver_petplay': {}}
        display_profile['driver_petplay']['refreshHz'] = args.refresh_hz
    if args.real_hmd and (args.direct_server or args.driver_direct or args.disable_async or args.disable_fixes or args.capture_layer or args.renderdoc_layer or args.x11_compositor):
        parser.error('--real-hmd uses the normal headset/compositor configuration and excludes synthetic display/capture options')
    if args.action == 'recover':
        restore()
        return
    if args.guard_monitor and (not args.direct_server or args.real_hmd):
        parser.error('--guard-monitor requires a synthetic --direct-server session')
    if not 1 <= args.seconds <= 3600:
        parser.error('--seconds must be 1..3600')
    if args.direct_server and not args.x11_compositor:
        parser.error("--direct-server requires --x11-compositor")
    if args.renderdoc_layer and not args.x11_compositor:
        parser.error('Capture options require --x11-compositor')
    if args.renderdoc_layer and not args.renderdoc_layer.resolve().is_dir():
        parser.error('RenderDoc layer directory does not exist')
    if args.capture_layer and args.display_profile != 'lab':
        parser.error('--capture-layer currently requires the lab profile: its image detector assumes 960x960')
    capture_dir = None
    if args.capture_layer:
        if not args.driver_direct or not args.x11_compositor or args.renderdoc_layer:
            parser.error('--capture-layer requires --driver-direct --x11-compositor and excludes RenderDoc')
        library = ROOT / 'submodules/petplay_ovrdriver/zig-out/lib/libpetplay_capture.so'
        if not library.is_file():
            parser.error('Build zig capture-layer first')
        SESSION.mkdir(parents=True, exist_ok=True, mode=0o700)
        capture_dir = Path(tempfile.mkdtemp(prefix='native-capture-', dir=SESSION))
        (capture_dir / 'images').mkdir(mode=0o700)
        manifest = {'file_format_version': '1.1.0', 'layer': {'name': 'VK_LAYER_PETPLAY_capture', 'type': 'GLOBAL', 'library_path': str(library), 'api_version': '1.2.198', 'implementation_version': '1', 'description': 'Request-driven PetPlay producer-image diagnostic', 'enable_environment': {'PP_CAPTURE_ENABLE': '1'}, 'disable_environment': {'PP_CAPTURE_DISABLE': '1'}}}
        (capture_dir / 'petplay_capture.json').write_text(json.dumps(manifest))
        atomic_write(SESSION / 'latest-native-capture.json', json.dumps({'directory': str(capture_dir / 'images')}).encode())
        print(f'Native diagnostic capture directory: {capture_dir / "images"}', flush=True)
    env = desktop_env()
    signal.signal(signal.SIGTERM, interrupted)
    if running() or BACKUP.exists():
        raise RuntimeError("SteamVR must be off and pending recovery resolved before run")
    watcher = RuntimeLogWatch([STEAM / 'logs' / name for name in
                               ('vrcompositor.txt', 'vrcompositor-linux.txt')])
    prepare(args.direct_server, args.disable_async, args.driver_direct, args.real_hmd, args.touch_controllers, display_profile)
    try:
        print(f'{"Real-HMD / synthetic-controller" if args.real_hmd else "Synthetic-only"} session prepared; recovery: {BACKUP}', flush=True)
        with (SESSION / 'launch.log').open('wb') as log:
            if args.direct_server:
                env.pop('WAYLAND_DISPLAY', None)
                env.pop('GAMESCOPE_WAYLAND_DISPLAY', None)
                runtime = STEAM / 'steamapps/common/SteamVR'
                subprocess.Popen([str(runtime / 'bin/vrenv.sh'), str(runtime / 'bin/linux64/vrserver')],
                                 env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
            else:
                subprocess.run([str(STEAM / 'steam.sh'), '-applaunch', '250820'],
                               env=env, stdout=log, stderr=subprocess.STDOUT, check=True, timeout=20)
        print(f'SteamVR launch requested; test window {args.seconds:g}s', flush=True)
        deadline = time.monotonic() + args.seconds
        startup_deadline = time.monotonic() + 15
        observed = False
        compositor_attempted = False
        retry_at = time.monotonic() + 3
        while time.monotonic() < deadline:
            watcher.check()
            observed = observed or bool(pids('vrserver'))
            if not observed and time.monotonic() > startup_deadline:
                raise RuntimeError('SteamVR did not start within 15 seconds')
            if args.x11_compositor and observed and not compositor_attempted and time.monotonic() > retry_at and not pids('vrcompositor'):
                compositor_attempted = True
                x11_env = dict(env)
                x11_env.pop('WAYLAND_DISPLAY', None)
                x11_env.pop('GAMESCOPE_WAYLAND_DISPLAY', None)
                if args.disable_fixes:
                    x11_env['DISABLE_STEAMVR_LINUX_FIXES'] = '1'
                if capture_dir:
                    x11_env['PP_CAPTURE_ENABLE'] = '1'
                    x11_env['PP_CAPTURE_DIRECTORY'] = str(capture_dir / 'images')
                    existing = x11_env.get('VK_ADD_IMPLICIT_LAYER_PATH', '')
                    x11_env['VK_ADD_IMPLICIT_LAYER_PATH'] = str(capture_dir) + (':' + existing if existing else '')
                    existing = x11_env.get('VK_LOADER_LAYERS_ENABLE', '')
                    x11_env['VK_LOADER_LAYERS_ENABLE'] = existing + (',' if existing else '') + 'VK_LAYER_PETPLAY_capture'
                if args.renderdoc_layer:
                    layer = args.renderdoc_layer.resolve()
                    if not layer.is_dir():
                        raise RuntimeError('RenderDoc layer directory does not exist')
                    x11_env['ENABLE_VULKAN_RENDERDOC_CAPTURE'] = '1'
                    existing = x11_env.get('VK_ADD_IMPLICIT_LAYER_PATH', '')
                    x11_env['VK_ADD_IMPLICIT_LAYER_PATH'] = str(layer) + (':' + existing if existing else '')
                    existing = x11_env.get('VK_LOADER_LAYERS_ENABLE', '')
                    x11_env['VK_LOADER_LAYERS_ENABLE'] = existing + (',' if existing else '') + 'VK_LAYER_RENDERDOC_Capture'
                    x11_env['RENDERDOC_CAPFILE'] = str(SESSION / 'compositor-capture')
                    x11_env['STEAMVR_DISABLE_THREAD_WATCHDOGS'] = '1'
                with (SESSION / 'x11-compositor-launch.log').open('wb') as log:
                    subprocess.Popen([str(STEAM / 'steamapps/common/SteamVR/bin/linux64/vrcompositor-launcher.sh')],
                                     env=x11_env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
                print('Launched X11 compositor' if args.direct_server else 'Retried compositor using X11 fallback', flush=True)
                if args.guard_monitor:
                    # A later vrmonitor://driverinstalled launch otherwise runs
                    # TerminateZombieProcesses(), killing this live direct-launched runtime.
                    # Claim the monitor first with the existing local launcher's safe flag.
                    with (SESSION / 'guard-monitor-launch.log').open('wb') as log:
                        subprocess.Popen([str(runtime / 'bin/vrenv.sh'),
                                          str(runtime / 'bin/linux64/vrmonitor'), '-nokillprocess'],
                                         env=env, stdout=log, stderr=subprocess.STDOUT,
                                         start_new_session=True)
                    print('Launched guarded monitor (-nokillprocess)', flush=True)
            time.sleep(.2)
    finally:
        if BACKUP.exists():
            # A second Ctrl-C must not interrupt settings restoration halfway through.
            signal.signal(signal.SIGTERM, signal.SIG_IGN)
            signal.signal(signal.SIGINT, signal.SIG_IGN)
            stop()
            try:
                capture = SESSION / time.strftime('%Y%m%d-%H%M%S')
                capture.mkdir(exist_ok=True)
                for name in ('vrserver.txt', 'vrcompositor.txt', 'vrcompositor-linux.txt'):
                    log = STEAM / 'logs' / name
                    if log.exists():
                        (capture / name).write_bytes(log.read_bytes())
            finally:
                # Capture archival failure (e.g. full disk) must not prevent restoration.
                restore()


if __name__ == '__main__':
    main()
