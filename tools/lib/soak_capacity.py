"""Audit bounded healthy Outbox windows without endpoint sampling-phase bias."""

import datetime
import math


def timestamp(value):
    return datetime.datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp()


def capacity_review(rows, report, gates):
    assert gates['auditMethod'] == 'healthy-time-windows-v2', 'Unrecognized capacity audit method'
    window_seconds = gates['windowSeconds']
    minimum_samples = gates['minimumWindowSamples']
    assert window_seconds == 900 and minimum_samples == 12, 'Capacity window policy changed'
    ready = timestamp(report['ready']['observedAt'])
    windows = [(ready + f['start'], ready + f['end'], f['kind']) for f in report['faults']]
    start, stop = ready + 180, ready + report['seconds'] - 30
    steady, unknown = [], 0
    for row in rows:
        begin, end = row['wallTime'], row['completedWallTime']
        assert math.isfinite(begin) and math.isfinite(end) and begin <= end, 'Invalid SQL sample time'
        overlapping = [kind for first, last, kind in windows if begin <= last and end >= first]
        observation = row['observation']
        if not observation['observed']:
            assert any(kind in ('postgres-crash', 'aof-backlog-crash') for kind in overlapping), 'Unknown SQL evidence outside planned PG outage'
            unknown += 1
            continue
        outbox = observation['outbox']
        assert type(outbox['pending']) is int and outbox['pending'] >= 0, 'Invalid pending count'
        assert outbox['deadLettered'] == 0, 'Dead-lettered Outbox event'
        age = outbox['oldestPendingAgeSeconds']
        assert math.isfinite(age) and age >= 0, 'Invalid oldest pending age'
        if start <= begin and end <= stop and not overlapping:
            steady.append(dict(wallTime=begin, **outbox))
    assert len(steady) >= 24, 'Insufficient healthy SQL samples'
    assert all(a['wallTime'] < b['wallTime'] for a, b in zip(steady, steady[1:])), 'Unordered healthy SQL samples'
    x = sum(r['wallTime'] for r in steady) / len(steady)
    y = sum(r['pending'] for r in steady) / len(steady)
    slope = sum((r['wallTime'] - x) * (r['pending'] - y) for r in steady) / sum((r['wallTime'] - x) ** 2 for r in steady)
    peak = max(r['pending'] for r in steady)
    oldest = max(r['oldestPendingAgeSeconds'] for r in steady)

    # 尾段不足十五分钟时向前扩展，不能只选末尾几个点。 / Extend the final window rather than selecting a few endpoint samples.
    assert stop - start >= window_seconds, 'Load is shorter than the capacity observation window'
    bucket_starts = list(range(0, math.ceil((stop - start) / window_seconds)))
    buckets = []
    for index in bucket_starts:
        first = min(start + index * window_seconds, stop - window_seconds)
        last = first + window_seconds
        samples = [r for r in steady if first <= r['wallTime'] <= last]
        assert len(samples) >= minimum_samples, 'Insufficient healthy samples in a capacity time window'
        buckets.append({'startSeconds': first - ready, 'endSeconds': last - ready,
                        'samples': len(samples), 'meanPending': sum(r['pending'] for r in samples) / len(samples)})
    early, late = buckets[0]['meanPending'], buckets[-1]['meanPending']
    largest_growth = max(b['meanPending'] for b in buckets) - early
    idle_start = timestamp(report['noLoadObservation']['startedAt'])
    idle_end = timestamp(report['noLoadObservation']['finishedAt'])
    idle = [r for r in rows if idle_start <= r['wallTime'] and r['completedWallTime'] <= idle_end]
    assert len(idle) >= 8 and all(r['observation']['observed'] for r in idle), 'Missing no-load SQL evidence'
    assert all(r['observation']['outbox']['pending'] == 0 for r in idle), 'No-load Outbox not continuously empty'
    assert peak <= gates['maximumSteadyPending'], 'Unbounded healthy-window Outbox backlog'
    assert slope <= gates['maximumPositivePendingSlopeEventsPerSecond'], 'Healthy-window Outbox grows over time'
    assert largest_growth <= gates['maximumPendingMeanGrowth'], 'Healthy-window Outbox mean grows'
    assert oldest <= gates['maximumHealthyPendingAgeSeconds'], 'Healthy-window oldest Outbox event exceeds deadline'
    return {'passed': True, 'auditMethod': gates['auditMethod'], 'healthySqlSamples': len(steady),
            'explicitlyUnknownFaultSqlSamples': unknown, 'peakHealthyPending': peak,
            'healthyPendingSlopePerSecond': slope, 'earlyPendingMean': early, 'latePendingMean': late,
            'maximumWindowMeanGrowth': largest_growth, 'maximumHealthyPendingAgeSeconds': oldest,
            'timeWindows': buckets, 'noLoadSqlSamples': len(idle), 'allNoLoadPendingZero': True, 'gates': gates}
