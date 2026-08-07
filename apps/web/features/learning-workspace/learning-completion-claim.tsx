"use client";

import Link from "next/link";
import {
  Braces,
  Check,
  CircleAlert,
  FileSearch,
  LoaderCircle,
  ScanLine,
  Search,
  ShieldCheck,
  Wallet,
  X,
} from "lucide-react";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAccount, usePublicClient, useSwitchChain, useWriteContract } from "wagmi";
import {
  learningCompletionRegistryAbi,
  type CompletionClaimReview,
  type CompletionClaimStatus,
} from "@mindmark/shared";
import {
  completionRegistryAddress,
  monadChain,
} from "@/lib/client/chain";
import { parseApiResponse as parseApi } from "@/lib/client/http";

export function LearningCompletionClaim(props: {
  projectId: `0x${string}`;
  cardCount: number;
  masteredCount: number;
}) {
  const fullyMastered = props.cardCount > 0 && props.masteredCount === props.cardCount;
  if (!completionRegistryAddress || !fullyMastered) return null;
  return <ConfiguredLearningCompletionClaim {...props} />;
}

function ConfiguredLearningCompletionClaim(props: {
  projectId: `0x${string}`;
  cardCount: number;
  masteredCount: number;
}) {
  const [phase, setPhase] = useState<"reviewing" | "submitting" | null>(null);
  const [pendingReview, setPendingReview] = useState<CompletionClaimReview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const { address, chainId } = useAccount();
  const { switchChainAsync } = useSwitchChain();
  const { writeContractAsync } = useWriteContract();
  const publicClient = usePublicClient({ chainId: monadChain.id });
  const statusQuery = useQuery({
    queryKey: ["learning-completion-claim", props.projectId],
    queryFn: ({ signal }) => fetch(
      `/api/projects/${props.projectId}/completion-claim`,
      { signal },
    ).then((response) => parseApi<CompletionClaimStatus>(response)),
    enabled: true,
    retry: false,
    staleTime: 10_000,
  });

  if (statusQuery.isPending || !statusQuery.data) {
    return null;
  }
  if (!statusQuery.data.enabled || (!statusQuery.data.eligible && !statusQuery.data.claimed)) {
    return null;
  }

  async function prepareClaimReview() {
    if (!address) {
      setError("请先连接拥有该项目的钱包");
      return;
    }
    setPhase("reviewing");
    setError(null);
    try {
      const review = await parseApi<CompletionClaimReview>(await fetch(
        `/api/projects/${props.projectId}/completion-claim`,
        { method: "POST" },
      ));
      const { authorization } = review;
      if (authorization.contractAddress.toLowerCase() !== completionRegistryAddress!.toLowerCase()) {
        throw new Error("完成凭证合约配置不一致");
      }
      if (review.mossReview.account.toLowerCase() !== address.toLowerCase()) {
        throw new Error("Moss 审阅账户与当前钱包不一致");
      }
      if (review.mossReview.simulation.status !== "PASSED"
        || review.mossReview.simulation.warningCodes.length > 0) {
        throw new Error("Moss 模拟未通过，交易已阻止");
      }
      setPendingReview(review);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Moss 审阅失败");
    } finally {
      setPhase(null);
    }
  }

  async function submitClaim() {
    if (!pendingReview || !address) return;
    setPhase("submitting");
    setError(null);
    try {
      const { authorization } = pendingReview;
      if (authorization.deadline <= Math.floor(Date.now() / 1_000)) {
        setPendingReview(null);
        throw new Error("Moss 审阅已过期，请重新模拟");
      }
      if (chainId !== monadChain.id) await switchChainAsync({ chainId: monadChain.id });
      const transactionHash = await writeContractAsync({
        address: completionRegistryAddress!,
        abi: learningCompletionRegistryAbi,
        functionName: "claimCompletion",
        args: [
          authorization.projectId,
          authorization.progressHash,
          BigInt(authorization.deadline),
          authorization.signature as `0x${string}`,
        ],
        account: address,
        chain: monadChain,
      });
      if (!publicClient) throw new Error("Monad RPC 暂时不可用");
      const receipt = await publicClient.waitForTransactionReceipt({
        hash: transactionHash,
        confirmations: 1,
        timeout: 60_000,
      });
      if (receipt.status !== "success") throw new Error("完成凭证交易执行失败");
      setPendingReview(null);
      await queryClient.invalidateQueries({ queryKey: ["learning-completion-claim", props.projectId] });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "完成凭证领取失败");
    } finally {
      setPhase(null);
    }
  }

  return <>
    <div className="learning-completion-claim" data-claimed={statusQuery.data.claimed}>
      <span className="learning-completion-icon"><ShieldCheck /></span>
      <div>
        <strong>{statusQuery.data.claimed ? "学习完成凭证已上链" : "全部知识卡已掌握"}</strong>
        <small>{statusQuery.data.claimed ? "Monad 已记录学习者、最终卡组根和进度哈希" : "先由 Moss 模拟，再由学习者钱包签名"}</small>
        {error ? <em><CircleAlert />{error}</em> : null}
      </div>
      {statusQuery.data.claimed
        ? <Link href={`/verify/${props.projectId}`} className="command-button command-button-quiet">查看凭证</Link>
        : <button
            type="button"
            className="command-button command-button-accent"
            onClick={() => void prepareClaimReview()}
            disabled={phase !== null}
          >
            {phase === "reviewing" ? <LoaderCircle className="animate-spin" /> : <ShieldCheck />}
            {phase === "reviewing" ? "Moss 正在模拟" : "使用 Moss 安全领取"}
          </button>}
    </div>
    {pendingReview ? <MossReviewDrawer
      review={pendingReview}
      submitting={phase === "submitting"}
      onClose={() => setPendingReview(null)}
      onConfirm={() => void submitClaim()}
    /> : null}
  </>;
}

const reviewStages = [
  { key: "discover", label: "Discover", detail: "发现学习凭证 Capability", icon: Search },
  { key: "load", label: "Load", detail: "读取参数契约与风险", icon: FileSearch },
  { key: "action", label: "Action", detail: "构造并锁定 Plan", icon: Braces },
  { key: "simulate", label: "Simulate", detail: "核验执行结果与资产变化", icon: ScanLine },
] as const;

function compactHash(value: string) {
  return `${value.slice(0, 12)}…${value.slice(-10)}`;
}

function MossReviewDrawer(props: {
  review: CompletionClaimReview;
  submitting: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const { mossReview } = props.review;
  const experimental = mossReview.networkSupport === "EXPERIMENTAL_TESTNET";
  return <div className="moss-review-backdrop" role="presentation">
    <section className="moss-review-drawer" role="dialog" aria-modal="true" aria-labelledby="moss-review-title">
      <header className="moss-review-header">
        <div>
          <span className="moss-review-mark"><ShieldCheck /></span>
          <div><small>MOSS ONCHAIN REVIEW</small><h2 id="moss-review-title">签名前审阅</h2></div>
        </div>
        <button type="button" className="icon-button" onClick={props.onClose} disabled={props.submitting} aria-label="关闭审阅"><X /></button>
      </header>

      <div className="moss-review-network" data-experimental={experimental}>
        <span><i />Monad · Chain {monadChain.id}</span>
        <strong>{experimental ? "实验性 Testnet 兼容" : "Moss 官方 Mainnet"}</strong>
        <small>SDK {mossReview.sdkVersion}</small>
      </div>

      <div className="moss-review-body">
        <section className="moss-review-intent">
          <small>结构化意图</small>
          <p>{mossReview.intent}</p>
          <span>{mossReview.capability.protocol}.{mossReview.capability.method}</span>
        </section>

        <ol className="moss-stage-list">
          {reviewStages.map((stage) => {
            const Icon = stage.icon;
            return <li key={stage.key} data-complete="true">
              <span><Icon /></span>
              <div><strong>{stage.label}</strong><small>{stage.detail}</small></div>
              <Check />
            </li>;
          })}
        </ol>

        <section className="moss-review-receipt">
          <div><small>账户</small><code title={mossReview.account}>{compactHash(mossReview.account)}</code></div>
          <div><small>目标合约</small><code title={mossReview.target}>{compactHash(mossReview.target)}</code></div>
          <div><small>MON 转出</small><strong>0 MON</strong></div>
          <div><small>授权数量</small><strong>{mossReview.expectedEffects.approvalCount}</strong></div>
          <div><small>模拟 Gas</small><strong>{mossReview.simulation.gas ?? "不可估算"}</strong></div>
          <div><small>Warnings</small><strong data-clear={mossReview.simulation.warningCodes.length === 0}>{mossReview.simulation.warningCodes.length}</strong></div>
        </section>

        <section className="moss-review-hashes">
          <div><small>PLAN HASH</small><code title={mossReview.planHash ?? ""}>{mossReview.planHash ? compactHash(mossReview.planHash) : "-"}</code></div>
          <div><small>CALLDATA HASH</small><code title={mossReview.calldataHash ?? ""}>{mossReview.calldataHash ? compactHash(mossReview.calldataHash) : "-"}</code></div>
        </section>

        <div className="moss-signing-boundary">
          <Wallet />
          <div><strong>最终签名权属于当前学习者钱包</strong><small>Moss 不签名、不发送交易，也不接触钱包私钥。</small></div>
        </div>
      </div>

      <footer className="moss-review-actions">
        <button type="button" className="command-button command-button-quiet" onClick={props.onClose} disabled={props.submitting}>取消</button>
        <button type="button" className="command-button command-button-accent" onClick={props.onConfirm} disabled={props.submitting}>
          {props.submitting ? <LoaderCircle className="animate-spin" /> : <Wallet />}
          {props.submitting ? "等待钱包确认" : "确认并唤起钱包"}
        </button>
      </footer>
    </section>
  </div>;
}
