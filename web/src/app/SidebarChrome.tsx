import type { ReactNode } from "react";
import { Icon } from "../components/common";

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
        {[
          { icon: Icon.dashboard, active: false },
          { icon: Icon.layout, active: false },
          { icon: Icon.bolt, active: true },
          { icon: Icon.history, active: false },
          { icon: Icon.message, active: false },
        ].map((item, index) => (
          <button
            key={index}
            type="button"
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
          </button>
        ))}
        <div style={{ flex: 1 }} />
      </div>
      {children}
    </div>
  );
}
