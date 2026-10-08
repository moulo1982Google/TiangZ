use super::*;

fn config() -> KcpConfig {
    KcpConfig::for_profile(KcpProfile::Outer)
}

#[test]
fn shared_kcp_budget_rejects_creation_before_c_allocation_and_returns_on_drop() {
    let initial = unsafe { ets_kcp_initial_buffer_bound(u32::from(config().mtu)) } as usize;
    let budget = BufferBudget::new(initial);
    let first = KcpSession::new_with_budget(1, config(), budget.clone()).unwrap();
    let used = budget.snapshot().used_bytes;
    assert!(used > 0 && used < initial as u64);
    assert!(KcpSession::new_with_budget(2, config(), budget.clone()).is_err());
    assert_eq!(budget.snapshot().used_bytes, used);
    assert_eq!(budget.snapshot().rejections, 1);
    drop(first);
    assert_eq!(budget.snapshot().used_bytes, 0);
    let recovered = KcpSession::new_with_budget(2, config(), budget.clone()).unwrap();
    drop(recovered);
    assert_eq!(budget.snapshot().used_bytes, 0);
}

#[test]
fn unacknowledged_segments_retain_quota_and_pure_acks_work_at_full_process_capacity() {
    let budget = BufferBudget::new(64 * 1024);
    let mut left = KcpSession::new_with_budget(7, config(), budget.clone()).unwrap();
    let baseline = budget.snapshot().used_bytes;
    let mut right = KcpSession::new(7, config()).unwrap();
    left.send(b"waiting for ACK").unwrap();
    left.update(0).unwrap();
    let packet = left.take_output().unwrap();
    right.input(&packet).unwrap();
    drop(packet);
    assert_eq!(right.receive().unwrap().unwrap(), b"waiting for ACK");
    right.update(0).unwrap();
    let acknowledged = right.take_output().unwrap();
    assert_eq!(input_push_count(&acknowledged, left.mss).unwrap(), 0);
    let before_ack = budget.snapshot().used_bytes;
    assert!(before_ack > baseline);
    let fill = budget.try_reserve(64 * 1024 - before_ack as usize).unwrap();
    left.input(&acknowledged).unwrap();
    assert!(budget.snapshot().used_bytes < 64 * 1024);
    assert_eq!(budget.snapshot().rejections, 0);
    drop(fill);
    assert_eq!(budget.snapshot().used_bytes, baseline);
    drop(left);
    assert_eq!(budget.snapshot().used_bytes, 0);
}

#[test]
fn per_session_cache_limit_rejects_without_changing_c_state_or_shared_quota() {
    let budget = BufferBudget::new(64 * 1024);
    let mut session = KcpSession::new_with_limits(1, config(), budget.clone(), 8192).unwrap();
    let mut rejected = false;
    for _ in 0..32 {
        let before = budget.snapshot().used_bytes;
        if let Err(error) = session.send(&[7; 446]) {
            assert!(error.to_string().contains("session byte limit"));
            assert_eq!(budget.snapshot().used_bytes, before);
            rejected = true;
            break;
        }
    }
    assert!(rejected);
    assert!(budget.snapshot().used_bytes <= 8192);
    assert_eq!(budget.snapshot().rejections, 0);
    drop(session);
    assert_eq!(budget.snapshot().used_bytes, 0);
}

#[test]
fn popped_kcp_output_keeps_quota_after_session_drop_until_last_slice_is_released() {
    let budget = BufferBudget::new(64 * 1024);
    let mut session = KcpSession::new_with_budget(7, config(), budget.clone()).unwrap();
    session.send(b"payload").unwrap();
    session.update(0).unwrap();
    let datagram = session.take_output().unwrap();
    let bytes = datagram.len() as u64;
    let slice = datagram.slice(0..1);
    drop(session);
    assert_eq!(budget.snapshot().used_bytes, bytes);
    drop(datagram);
    assert_eq!(budget.snapshot().used_bytes, bytes);
    drop(slice);
    assert_eq!(budget.snapshot().used_bytes, 0);
}

#[test]
fn output_budget_failure_poisoning_is_reported_instead_of_silent_reliable_packet_loss() {
    let budget = BufferBudget::new(64 * 1024);
    let mut session = KcpSession::new_with_budget(7, config(), budget.clone()).unwrap();
    session.send(b"payload").unwrap();
    let fill = budget
        .try_reserve(64 * 1024 - budget.snapshot().used_bytes as usize)
        .unwrap();
    assert!(
        session
            .update(0)
            .unwrap_err()
            .to_string()
            .contains("session must close")
    );
    assert!(session.take_output().is_none());
    assert!(session.send(b"more").is_err());
    assert!(session.receive().is_err());
    assert!(session.update(10).is_err());
    assert_eq!(budget.snapshot().rejections, 1);
    drop(fill);
    drop(session);
    assert_eq!(budget.snapshot().used_bytes, 0);
}

#[test]
fn duplicate_pushes_bound_ack_capacity_and_malformed_segments_cannot_exceed_mss() {
    let mut source = KcpSession::new(7, config()).unwrap();
    source.send(b"once").unwrap();
    source.update(0).unwrap();
    let packet = source.take_output().unwrap();
    let budget = BufferBudget::new(64 * 1024);
    let mut target = KcpSession::new_with_budget(7, config(), budget.clone()).unwrap();
    for _ in 0..65 {
        target.input(&packet).unwrap();
        assert_eq!(budget.snapshot().used_bytes, unsafe {
            ets_kcp_buffer_bound(target.kcp.as_ptr())
        });
    }
    let before_receive = budget.snapshot().used_bytes;
    assert_eq!(target.receive().unwrap().unwrap(), b"once");
    assert!(target.receive().unwrap().is_none());
    assert!(budget.snapshot().used_bytes < before_receive);
    let before_invalid = budget.snapshot().used_bytes;
    let mut oversized = packet[..24].to_vec();
    oversized[20..24].copy_from_slice(&447_u32.to_le_bytes());
    oversized.extend_from_slice(&[0; 447]);
    assert!(
        target
            .input(&oversized)
            .unwrap_err()
            .to_string()
            .contains("MSS")
    );
    assert!(target.input(&packet[..packet.len() - 1]).is_err());
    assert_eq!(budget.snapshot().used_bytes, before_invalid);
    drop(target);
    assert_eq!(budget.snapshot().used_bytes, 0);
}

#[test]
fn fragment_limit_rejects_before_cache_growth() {
    let budget = BufferBudget::new(1024 * 1024);
    let mut session = KcpSession::new_with_budget(7, config(), budget.clone()).unwrap();
    let before = budget.snapshot().used_bytes;
    assert!(
        session
            .send(&vec![0; 1024 * 1024])
            .unwrap_err()
            .to_string()
            .contains("fragment limit")
    );
    assert_eq!(budget.snapshot().used_bytes, before);
}

#[test]
fn one_datagram_ack_growth_accounts_for_intermediate_and_final_allocations() {
    let mut target = KcpSession::new(7, config()).unwrap();
    let baseline = unsafe { ets_kcp_buffer_bound(target.kcp.as_ptr()) };
    let one_segment = unsafe { ets_kcp_send_buffer_bound(target.kcp.as_ptr(), 1) } - baseline;
    let growth = unsafe { ets_kcp_input_buffer_bound(target.kcp.as_ptr(), 65) };
    // 65 PUSH headers can grow ACK capacity through 8/16/32/64/128 in one input call.
    assert!(growth >= baseline + 65 * one_segment + (128 + 64) * 8);
    let mut datagram = Vec::new();
    for sequence in 0..65_u32 {
        let mut segment = [0_u8; 24];
        segment[..4].copy_from_slice(&7_u32.to_le_bytes());
        segment[4] = 81;
        segment[6..8].copy_from_slice(&256_u16.to_le_bytes());
        segment[12..16].copy_from_slice(&sequence.to_le_bytes());
        datagram.extend_from_slice(&segment);
    }
    target.input(&datagram).unwrap();
    for _ in 0..65 {
        assert_eq!(target.receive().unwrap(), Some(vec![]));
    }
    assert_eq!(target.receive().unwrap(), None);
    assert_eq!(
        unsafe { ets_kcp_buffer_bound(target.kcp.as_ptr()) },
        baseline + 128 * 8
    );
}
