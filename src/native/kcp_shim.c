#include "ikcp.h"

void ets_kcp_set_min_rto(ikcpcb *kcp, IUINT32 min_rto)
{
    kcp->rx_minrto = (IINT32)min_rto;
}

IUINT32 ets_kcp_get_min_rto(const ikcpcb *kcp)
{
    return (IUINT32)kcp->rx_minrto;
}
