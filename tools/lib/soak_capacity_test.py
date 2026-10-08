import datetime
import unittest
from soak_capacity import capacity_review


class CapacityTests(unittest.TestCase):
    def fixture(self, seconds=1800):
        def utc(value):
            return datetime.datetime.fromtimestamp(value, datetime.timezone.utc).isoformat()
        report = {'seconds': seconds, 'ready': {'observedAt': utc(10000)},
                  'faults': [{'start': 420, 'end': 500, 'kind': 'postgres-crash'}],
                  'noLoadObservation': {'startedAt': utc(10000 + seconds + 10), 'finishedAt': utc(10000 + seconds + 310)}}
        rows = [{'wallTime': 10000 + t, 'completedWallTime': 10001 + t,
                 'observation': {'observed': True, 'outbox': {'pending': 0, 'deadLettered': 0, 'oldestPendingAgeSeconds': 0}}}
                for t in range(180, seconds + 300, 30)]
        gates = {'auditMethod': 'healthy-time-windows-v2', 'windowSeconds': 900, 'minimumWindowSamples': 12,
                 'maximumSteadyPending': 100, 'maximumPositivePendingSlopeEventsPerSecond': .05,
                 'maximumPendingMeanGrowth': 32, 'maximumHealthyPendingAgeSeconds': 60}
        return rows, report, gates

    def test_healthy_and_empty_idle_pass(self):
        self.assertTrue(capacity_review(*self.fixture())['passed'])

    def test_endpoint_burst_phase_does_not_imply_continuous_growth(self):
        rows, report, gates = self.fixture(57600)
        healthy = [r for r in rows if r['wallTime'] <= 10000 + 57600 - 30]
        for row, pending in zip(healthy[-6:], [91, 43, 63, 20, 2, 0]):
            row['observation']['outbox'].update(pending=pending, oldestPendingAgeSeconds=3 if pending else 0)
        self.assertGreater(sum(r['observation']['outbox']['pending'] for r in healthy[-6:]) / 6, 32)
        self.assertTrue(capacity_review(rows, report, gates)['passed'])

    def test_final_drain_does_not_hide_sustained_growth(self):
        rows, report, gates = self.fixture(57600)
        for row in rows:
            if 20000 <= row['wallTime'] < 67600:
                row['observation']['outbox'].update(pending=50, oldestPendingAgeSeconds=3)
        with self.assertRaisesRegex(AssertionError, 'mean grows'):
            capacity_review(rows, report, gates)

    def test_middle_window_growth_is_not_hidden_by_healthy_tail(self):
        rows, report, gates = self.fixture(57600)
        for row in rows:
            if 40000 <= row['wallTime'] < 42000:
                row['observation']['outbox'].update(pending=50, oldestPendingAgeSeconds=3)
        with self.assertRaisesRegex(AssertionError, 'mean grows'):
            capacity_review(rows, report, gates)

    def test_old_pending_event_fails_even_if_count_and_slope_are_small(self):
        rows, report, gates = self.fixture()
        rows[0]['observation']['outbox'].update(pending=1, oldestPendingAgeSeconds=61)
        with self.assertRaisesRegex(AssertionError, 'oldest'):
            capacity_review(rows, report, gates)

    def test_unknown_sql_is_not_zero_filled(self):
        rows, report, gates = self.fixture()
        rows[0]['observation'] = {'observed': False}
        with self.assertRaisesRegex(AssertionError, 'outside'):
            capacity_review(rows, report, gates)

    def test_planned_pg_unknown_is_explicit(self):
        rows, report, gates = self.fixture()
        rows[8]['observation'] = {'observed': False}
        self.assertEqual(capacity_review(rows, report, gates)['explicitlyUnknownFaultSqlSamples'], 1)

    def test_nonempty_idle_fails(self):
        rows, report, gates = self.fixture()
        rows[-1]['observation']['outbox']['pending'] = 1
        with self.assertRaisesRegex(AssertionError, 'continuously empty'):
            capacity_review(rows, report, gates)

    def test_sparse_time_window_fails(self):
        rows, report, gates = self.fixture(57600)
        rows = [r for r in rows if not 40000 <= r['wallTime'] <= 41000]
        with self.assertRaisesRegex(AssertionError, 'Insufficient healthy samples'):
            capacity_review(rows, report, gates)

    def test_peak_and_dead_letters_remain_errors(self):
        for key, value, error in [('pending', 101, 'backlog'), ('deadLettered', 1, 'Dead-lettered')]:
            rows, report, gates = self.fixture()
            rows[0]['observation']['outbox'][key] = value
            with self.assertRaisesRegex(AssertionError, error):
                capacity_review(rows, report, gates)


if __name__ == '__main__':
    unittest.main()
