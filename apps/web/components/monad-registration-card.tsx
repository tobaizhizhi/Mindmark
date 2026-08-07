import { ArrowUpRight, Blocks, LoaderCircle, Wallet } from "lucide-react";

export function MonadRegistrationCard(props: {
  projectId: string;
  chainId: number;
  registryAddress: string | null;
  explorerUrl: string;
  busy: boolean;
  onCreate: () => void;
}) {
  const registryHref = props.registryAddress
    ? `${props.explorerUrl.replace(/\/$/u, "")}/address/${props.registryAddress}`
    : null;
  return (
    <section className="monad-registration-card" aria-label="Monad 项目登记">
      <div className="monad-registration-heading">
        <span className="monad-registration-icon"><Blocks /></span>
        <div>
          <small>MONAD REGISTRY / V2</small>
          <h3>把学习项目登记到 Monad</h3>
        </div>
        <span className="monad-registration-network">Chain {props.chainId}</span>
      </div>
      <p>链上只保存资料、章节大纲和 Work Unit 清单的哈希承诺；PDF 与知识卡正文仍保留在 Mindmark。</p>
      <div className="monad-registration-facts">
        <div><small>NETWORK</small><strong>Monad</strong></div>
        <div><small>PROJECT</small><code title={props.projectId}>{props.projectId.slice(0, 10)}…{props.projectId.slice(-8)}</code></div>
        <div><small>REGISTRY</small>{registryHref ? <a href={registryHref} target="_blank" rel="noreferrer">查看合约 <ArrowUpRight /></a> : <strong>未配置</strong>}</div>
      </div>
      <div className="monad-registration-footer">
        <span><Wallet />你只支付登记交易的 Gas；登记完成后由 Sponsor Treasury 为全部 Work Unit 锁定生成预算。</span>
        <button type="button" className="command-button command-button-accent" onClick={props.onCreate} disabled={props.busy || !props.registryAddress}>
          {props.busy ? <LoaderCircle className="animate-spin" /> : <Blocks />}
          {props.busy ? "等待 Monad 确认" : "在 Monad 创建项目"}
        </button>
      </div>
    </section>
  );
}
