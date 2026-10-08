"""正常定时触发不能中断长稳；停用、重启或身份变更仍须失败。

Normal timer triggers must not interrupt a soak; identity failures stay strict.
"""

import copy
import unittest

from soak_protected_units import assert_protected_properties


class ProtectedUnitsTests(unittest.TestCase):
    def setUp(self):
        self.timer = {
            "ActiveState": "active", "SubState": "waiting",
            "ActiveEnterTimestampMonotonic": "123456",
            "FragmentPath": "/etc/systemd/system/protected.timer",
            "fragmentSha256": "frozen-fragment-hash",
        }
        self.service = {
            **self.timer, "MainPID": "42", "NRestarts": "0",
            "SubState": "running",
            "FragmentPath": "/etc/systemd/system/protected.service",
        }

    def current(self, baseline, **changes):
        value = {k: v for k, v in baseline.items() if k != "fragmentSha256"}
        value.update(changes)
        return value

    def test_active_timer_can_trigger_and_return_to_waiting(self):
        for before, after in [("waiting", "waiting"), ("waiting", "running"),
                              ("running", "waiting"), ("running", "running")]:
            with self.subTest(before=before, after=after):
                baseline = {**self.timer, "SubState": before}
                assert_protected_properties("protected.timer", self.current(baseline, SubState=after), baseline)

    def test_timer_stopped_failed_or_elapsed_is_rejected(self):
        for state, substate in [("inactive", "dead"), ("failed", "failed"),
                                ("active", "elapsed"), ("activating", "running")]:
            with self.subTest(state=state, substate=substate):
                with self.assertRaisesRegex(AssertionError, "protected unit changed"):
                    assert_protected_properties("protected.timer", self.current(
                        self.timer, ActiveState=state, SubState=substate), self.timer)

    def test_running_timer_does_not_mask_restart_or_fragment_change(self):
        for key, value in [("ActiveEnterTimestampMonotonic", "999999"),
                           ("FragmentPath", "/tmp/replacement.timer")]:
            with self.subTest(key=key):
                with self.assertRaisesRegex(AssertionError, key):
                    assert_protected_properties("protected.timer", self.current(
                        self.timer, SubState="running", **{key: value}), self.timer)

    def test_business_service_state_and_process_generation_remain_exact(self):
        assert_protected_properties("protected.service", self.current(self.service), self.service)
        for key, value in [("MainPID", "43"), ("NRestarts", "1"),
                           ("ActiveState", "inactive"), ("SubState", "exited"),
                           ("ActiveEnterTimestampMonotonic", "999999"),
                           ("FragmentPath", "/tmp/replacement.service")]:
            with self.subTest(key=key):
                with self.assertRaisesRegex(AssertionError, key):
                    assert_protected_properties("protected.service", self.current(
                        self.service, **{key: value}), self.service)

    def test_missing_or_extra_properties_are_not_silently_ignored(self):
        missing = self.current(self.timer)
        missing.pop("ActiveState")
        for value in [missing, self.current(self.timer, Unrecognized="active")]:
            with self.assertRaisesRegex(AssertionError, "missing or unexpected"):
                assert_protected_properties("protected.timer", value, self.timer)

    def test_incomplete_or_unrecognized_baseline_is_rejected(self):
        missing = copy.deepcopy(self.timer)
        missing.pop("ActiveEnterTimestampMonotonic")
        for value in [missing, {**self.timer, "Unrecognized": "active"}]:
            with self.assertRaisesRegex(AssertionError, "baseline"):
                assert_protected_properties("protected.timer", self.current(value), value)

    def test_empty_baseline_identity_is_rejected(self):
        for key in ["FragmentPath", "ActiveEnterTimestampMonotonic"]:
            with self.subTest(key=key):
                baseline = {**self.timer, key: ""}
                with self.assertRaisesRegex(AssertionError, "baseline"):
                    assert_protected_properties("protected.timer", self.current(baseline), baseline)


if __name__ == "__main__":
    unittest.main()
