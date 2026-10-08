"""长稳部署端口预检：等待内核释放，不停止占用者。 / Wait without killing owners."""
import errno
import json
import socket
import subprocess
import time


class PortPreflightError(RuntimeError):
    def __init__(self, port, reason, observation):
        self.port = port
        self.reason = reason
        self.observation = observation
        super().__init__(json.dumps({'port': port, 'reason': reason, 'observation': observation}))


def socket_observation(port):
    """只读记录实际 TCP 状态，失败不能冒充空闲。 / Read TCP state or fail closed."""
    result = subprocess.run(['ss', '-H', '-n', '-t', '-a', '-p', 'sport = :%d' % port],
                            capture_output=True, text=True, timeout=5)
    if result.returncode:
        raise RuntimeError('ss observation failed: ' + result.stderr[:1000])
    lines = result.stdout.splitlines()
    return {'listeners': [line[:2048] for line in lines if line.split()[:1] == ['LISTEN']][:8],
            'timeWaitCount': sum(line.split()[:1] == ['TIME-WAIT'] for line in lines),
            'tcpStateSample': [line[:2048] for line in lines[:8]], 'totalRows': len(lines)}


def bind_probe(port):
    """沿用普通独占预检，不用端口复用掩盖占用。 / Probe without reuse options."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.bind(('127.0.0.1', port))


def wait_for_ports(ports, timeout_seconds=180, poll_seconds=0.5, emit=None):
    """共用一个等待期限；真实监听立即失败。 / Share one deadline; reject listeners."""
    if timeout_seconds < 0 or poll_seconds <= 0:
        raise ValueError('Invalid port preflight deadline or poll interval')
    started = time.monotonic()
    deadline = started + timeout_seconds
    waiting = {}
    for port in ports:
        if not isinstance(port, int) or isinstance(port, bool) or not 1 <= port <= 65535:
            raise ValueError('Invalid TCP port')
        while True:
            try:
                bind_probe(port)
                break
            except OSError as error:
                if error.errno != errno.EADDRINUSE:
                    raise PortPreflightError(port, 'bind-error', {'errno': error.errno}) from error
                observation = socket_observation(port)
                if observation['listeners']:
                    raise PortPreflightError(port, 'live-listener', observation) from error
                if port not in waiting:
                    waiting[port] = {'firstObservation': observation}
                    if emit:
                        emit('port-release-wait', port=port, observation=observation)
                waiting[port]['lastObservation'] = observation
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise PortPreflightError(port, 'release-deadline-exceeded', observation) from error
                time.sleep(min(poll_seconds, remaining))
    result = {'ports': list(ports), 'elapsedSeconds': time.monotonic() - started,
              'waitedPorts': waiting, 'timeoutSeconds': timeout_seconds}
    if emit:
        emit('ports-ready', **result)
    return result
