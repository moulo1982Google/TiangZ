"""真实 Linux 监听/TIME_WAIT 与有限重试回归，不操作已有端口。"""
import errno
import json
import socket
import sys
import time
import unittest
from unittest.mock import patch
import soak_port_preflight as ports


class PortPreflightTests(unittest.TestCase):
    def test_free_loopback_port_passes(self):
        with socket.socket() as listener:
            listener.bind(('127.0.0.1', 0))
            port = listener.getsockname()[1]
        result = ports.wait_for_ports([port], timeout_seconds=1)
        self.assertEqual(result['ports'], [port])
        self.assertFalse(result['waitedPorts'])

    @unittest.skipUnless(sys.platform.startswith('linux'), 'ss and Linux TCP state required')
    def test_live_listener_is_rejected_and_left_running(self):
        with socket.socket() as listener:
            listener.bind(('127.0.0.1', 0))
            listener.listen(1)
            port = listener.getsockname()[1]
            with self.assertRaises(ports.PortPreflightError) as caught:
                ports.wait_for_ports([port], timeout_seconds=30)
            self.assertEqual(caught.exception.port, port)
            self.assertEqual(caught.exception.reason, 'live-listener')
            self.assertTrue(caught.exception.observation['listeners'])
            with socket.create_connection(('127.0.0.1', port), timeout=1):
                accepted, _ = listener.accept()
                accepted.close()

    @unittest.skipUnless(sys.platform.startswith('linux'), 'ss and Linux TCP state required')
    def test_real_time_wait_is_waited_and_has_a_bounded_failure(self):
        with socket.socket() as listener:
            listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            listener.bind(('127.0.0.1', 0))
            listener.listen(1)
            port = listener.getsockname()[1]
            with socket.create_connection(('127.0.0.1', port), timeout=1) as client:
                server, _ = listener.accept()
                server.close()
                self.assertEqual(client.recv(1), b'')
        observation = ports.socket_observation(port)
        self.assertFalse(observation['listeners'])
        self.assertGreater(observation['timeWaitCount'], 0)
        with self.assertRaises(OSError) as original:
            ports.bind_probe(port)
        self.assertEqual(original.exception.errno, errno.EADDRINUSE)
        events = []
        started = time.monotonic()
        with self.assertRaises(ports.PortPreflightError) as caught:
            ports.wait_for_ports([port], timeout_seconds=0.15, poll_seconds=0.02,
                                 emit=lambda name, **data: events.append((name, data)))
        self.assertEqual(caught.exception.reason, 'release-deadline-exceeded')
        self.assertGreater(caught.exception.observation['timeWaitCount'], 0)
        self.assertGreaterEqual(time.monotonic() - started, 0.15)
        self.assertLess(time.monotonic() - started, 2)
        self.assertEqual(events[0][0], 'port-release-wait')
        print(json.dumps({'realTimeWaitPort': port, 'ordinaryBindErrno': original.exception.errno,
                          'observation': observation, 'boundedWaitReason': caught.exception.reason}))

    def test_transient_bind_wait_then_release_keeps_one_deadline(self):
        clock = [0.0]
        events = []
        busy = OSError(errno.EADDRINUSE, 'busy')
        clear = {'listeners': [], 'timeWaitCount': 1}
        with patch.object(ports, 'bind_probe', side_effect=[busy, None, busy, None]), \
             patch.object(ports, 'socket_observation', return_value=clear), \
             patch.object(ports.time, 'monotonic', side_effect=lambda: clock[0]), \
             patch.object(ports.time, 'sleep', side_effect=lambda value: clock.__setitem__(0, clock[0] + value)):
            result = ports.wait_for_ports([10001, 10002], timeout_seconds=1, poll_seconds=0.75,
                                          emit=lambda name, **data: events.append(name))
        self.assertEqual(result['elapsedSeconds'], 1)
        self.assertEqual(set(result['waitedPorts']), {10001, 10002})
        self.assertEqual(events, ['port-release-wait', 'port-release-wait', 'ports-ready'])

    def test_unexpected_bind_errors_are_not_retried(self):
        with patch.object(ports, 'bind_probe', side_effect=OSError(errno.EACCES, 'denied')):
            with self.assertRaises(ports.PortPreflightError) as caught:
                ports.wait_for_ports([10001])
        self.assertEqual(caught.exception.reason, 'bind-error')

    def test_ss_failure_cannot_prove_a_free_port(self):
        with patch.object(ports, 'bind_probe', side_effect=OSError(errno.EADDRINUSE, 'busy')), \
             patch.object(ports, 'socket_observation', side_effect=RuntimeError('ss failure')):
            with self.assertRaisesRegex(RuntimeError, 'ss failure'):
                ports.wait_for_ports([10001])


if __name__ == '__main__':
    unittest.main(verbosity=2)
