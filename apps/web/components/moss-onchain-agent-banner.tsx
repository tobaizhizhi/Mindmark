import { ArrowRight, ShieldCheck } from "lucide-react";

export function MossOnchainAgentBanner(props: { rewardCount: number; verifiedCount: number }) {
  return <div className="verification-moss-banner">
    <span className="verification-moss-banner-icon"><ShieldCheck /></span>
    <div>
      <small>MOSS ONCHAIN AGENT</small>
      <strong>每笔 Worker Reward 都先经过意图审阅与模拟</strong>
      <p>Discover → Load → Action → Simulate；Moss 不持有私钥、不签名、不广播交易。</p>
    </div>
    <div className="verification-moss-banner-status">
      <b>{props.verifiedCount} / {props.rewardCount}</b>
      <small>{props.rewardCount > 0 ? "Reward 已完成链上核验" : "等待 Worker 结算"}</small>
      <ArrowRight />
    </div>
  </div>;
}
