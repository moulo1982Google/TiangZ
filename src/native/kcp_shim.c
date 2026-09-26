#include "ikcp.h"

extern const IUINT32 IKCP_MTU_DEF;
extern const IUINT32 IKCP_OVERHEAD;
extern const IUINT32 IKCP_WND_RCV;

/* Upper bounds for the pinned message-mode implementation; allocator metadata is excluded. */
IUINT64 ets_kcp_initial_buffer_bound(IUINT32 mtu)
{
    /* setmtu allocates its replacement before freeing the default work buffer. */
    return sizeof(struct IKCPCB) + ((IUINT64)IKCP_MTU_DEF + mtu + 2 * IKCP_OVERHEAD) * 3;
}

IUINT64 ets_kcp_buffer_bound(const ikcpcb *kcp)
{
    IUINT64 segments = (IUINT64)kcp->nsnd_que + kcp->nsnd_buf + kcp->nrcv_que + kcp->nrcv_buf;
    return sizeof(struct IKCPCB) + ((IUINT64)kcp->mtu + IKCP_OVERHEAD) * 3
        + segments * (sizeof(struct IKCPSEG) + kcp->mss)
        + (IUINT64)kcp->ackblock * sizeof(IUINT32) * 2;
}

IUINT64 ets_kcp_send_buffer_bound(const ikcpcb *kcp, IUINT32 length)
{
    IUINT64 count = ((IUINT64)length + kcp->mss - 1) / kcp->mss;
    if (count == 0) count = 1;
    if (kcp->stream != 0 || count >= IKCP_WND_RCV) return 0;
    return ets_kcp_buffer_bound(kcp) + count * (sizeof(struct IKCPSEG) + kcp->mss);
}

IUINT64 ets_kcp_input_buffer_bound(const ikcpcb *kcp, IUINT32 pushes)
{
    IUINT64 bound = ets_kcp_buffer_bound(kcp);
    IUINT64 needed = (IUINT64)kcp->ackcount + pushes;
    bound += (IUINT64)pushes * (sizeof(struct IKCPSEG) + kcp->mss);
    if (needed > kcp->ackblock) {
        IUINT64 block = 8;
        while (block < needed) block <<= 1;
        /* One datagram may grow several times. The last intermediate block also coexists. */
        IUINT64 previous = block / 2;
        if (previous < kcp->ackblock) previous = kcp->ackblock;
        bound += (block + previous - kcp->ackblock) * sizeof(IUINT32) * 2;
    }
    return bound;
}

void ets_kcp_set_min_rto(ikcpcb *kcp, IUINT32 min_rto)
{
    kcp->rx_minrto = (IINT32)min_rto;
}

IUINT32 ets_kcp_get_min_rto(const ikcpcb *kcp)
{
    return (IUINT32)kcp->rx_minrto;
}
