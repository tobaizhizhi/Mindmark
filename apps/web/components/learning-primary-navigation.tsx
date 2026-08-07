"use client";

import { BookOpen, Clock3, Library, PackageOpen, Plus, X } from "lucide-react";
import type { ReactNode } from "react";

export type PrimaryNavigationTarget = "library" | "review" | "packs" | "new";

const navigationItems: Array<{
  target: PrimaryNavigationTarget;
  label: string;
  icon: typeof Library;
}> = [
  { target: "library", label: "资料库", icon: Library },
  { target: "review", label: "今日复习", icon: Clock3 },
  { target: "packs", label: "发现卡包", icon: PackageOpen },
  { target: "new", label: "新建资料", icon: Plus },
];

export function LearningPrimaryNavigation(props: {
  variant: "expanded" | "rail";
  active: PrimaryNavigationTarget | null;
  open?: boolean;
  onNavigate: (target: PrimaryNavigationTarget) => void;
  onClose?: () => void;
  children?: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <aside
      className={`learning-primary-navigation ${props.variant === "expanded" ? "library-sidebar" : "learning-primary-rail"}`}
      data-open={props.open}
      data-variant={props.variant}
      aria-label="学习主导航"
    >
      <div className="library-brand">
        <button type="button" className="learning-primary-brand-button" onClick={() => props.onNavigate("library")} aria-label="返回资料库" title="返回资料库">
          <span className="library-brand-mark"><BookOpen /></span>
          <span className="learning-primary-brand-copy"><strong>Mindmark</strong><small>学习工作台</small></span>
        </button>
        {props.onClose ? <button type="button" className="library-mobile-close" onClick={props.onClose} aria-label="关闭导航" title="关闭导航"><X /></button> : null}
      </div>
      <nav className="library-nav" aria-label="学习导航">
        {navigationItems.map((item) => {
          const Icon = item.icon;
          return (
            <button
              key={item.target}
              type="button"
              data-active={props.active === item.target}
              onClick={() => props.onNavigate(item.target)}
              aria-label={item.label}
              title={item.label}
            >
              <Icon /><span>{item.label}</span>
            </button>
          );
        })}
      </nav>
      {props.children}
      {props.footer ? <div className="library-sidebar-bottom">{props.footer}</div> : null}
    </aside>
  );
}
