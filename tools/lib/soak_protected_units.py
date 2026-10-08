"""保护业务 unit 的身份，允许活跃 timer 的正常触发状态转换。

Protect unit identity while allowing normal active-timer trigger transitions.
"""

PROPERTY_NAMES = (
    "MainPID", "NRestarts", "ActiveState", "SubState",
    "ActiveEnterTimestampMonotonic", "FragmentPath",
)
PROPERTY_ARGUMENT = "--property=" + ",".join(PROPERTY_NAMES)
_REQUIRED = {
    "ActiveState", "SubState", "ActiveEnterTimestampMonotonic", "FragmentPath",
}
_ACTIVE_TIMER_STATES = {"waiting", "running"}


def assert_protected_properties(name, current, baseline):
    """保持配置、代次和服务状态精确匹配；timer 仅允许 waiting/running 转换。

    Match configuration, generation and service state; timers may wait or run.
    The caller must additionally verify the fragment and configuration hashes.
    """
    expected = {k: v for k, v in baseline.items() if k != "fragmentSha256"}
    assert _REQUIRED <= expected.keys(), f"{name}: incomplete unit baseline"
    assert set(expected) <= set(PROPERTY_NAMES), f"{name}: unknown baseline properties"
    assert set(current) == set(expected), (
        f"{name}: missing or unexpected properties: "
        f"expected={sorted(expected)}, observed={sorted(current)}"
    )
    assert all(isinstance(v, str) and v for v in expected.values()), (
        f"{name}: empty or invalid baseline properties"
    )
    timer_transition = (
        name.endswith(".timer")
        and expected["ActiveState"] == "active"
        and current["ActiveState"] == "active"
        and expected["SubState"] in _ACTIVE_TIMER_STATES
        and current["SubState"] in _ACTIVE_TIMER_STATES
    )
    differences = {
        key: {"expected": value, "observed": current[key]}
        for key, value in expected.items()
        if current[key] != value and not (key == "SubState" and timer_transition)
    }
    assert not differences, f"{name}: protected unit changed: {differences}"
