import type { ReactNode } from "react";
import { Icon, UnavailableButton } from "../components/common";

const sidebarNavigationItems = [
  { label: "Compact dashboard navigation", icon: Icon.dashboard, active: false },
  { label: "Compact issue-board navigation", icon: Icon.layout, active: false },
  { label: "Compact agent-status navigation", icon: Icon.bolt, active: true },
  { label: "Compact history navigation", icon: Icon.history, active: false },
  { label: "Compact chat navigation", icon: Icon.message, active: false },
];

export function SidebarChrome({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "42px 1fr",
        height: "100%",
        background: "var(--bg)",
      }}
    >
      <div
        style={{
          background: "#0a0a0c",
          borderRight: "1px solid var(--border)",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          padding: "8px 0",
          gap: 4,
        }}
      >
        {sidebarNavigationItems.map((item) => (
          <UnavailableButton
            className="icon-btn"
            key={item.label}
            aria-current={item.active ? "page" : undefined}
            unavailableLabel={item.label}
            unavailableReason="compact sidebar navigation is read-only here; use the main Symphony tabs to switch views"
            style={{
              width: 30,
              height: 30,
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              borderRadius: 5,
              color: item.active ? "var(--text)" : "var(--text-3)",
              background: item.active ? "var(--elevated)" : "transparent",
              position: "relative",
            }}
          >
            {item.active ? (
              <span
                style={{
                  position: "absolute",
                  left: -9,
                  top: 5,
                  bottom: 5,
                  width: 2,
                  background: "var(--accent)",
                  borderRadius: 1,
                }}
              />
            ) : null}
            <span style={{ width: 16, height: 16, display: "inline-flex" }}>{item.icon()}</span>
          </UnavailableButton>
        ))}
        <div style={{ flex: 1 }} />
      </div>
      {children}
    </div>
  );
}
