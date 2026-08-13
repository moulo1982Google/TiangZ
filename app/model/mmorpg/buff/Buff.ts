/** MMORPG compatibility facade; Buff lifecycle data lives in the reusable domain layer. / MMORPG兼容门面；Buff生命周期数据位于可复用领域层。 */
export {
  Buff,
  type AwakeBuff,
  type BuffPublicState,
  type BuffRefreshRequest,
  type BuffTransferState,
} from "../../domains/buff/Buff";
