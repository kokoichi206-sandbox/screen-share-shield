import { defineConfig } from "wxt";

// WXT 設定。manifest はここから生成され、content scripts は entrypoints/ から自動登録される。
export default defineConfig({
  manifest: {
    name: "Screen Share Shield",
    description:
      "画面共有中だけ、相手の映像に映る機密情報をマスクするプライバシーガード（自分の画面はそのまま）。",
    permissions: ["storage", "tabs", "activeTab"],
    host_permissions: ["<all_urls>"],
    icons: { "128": "/icon-128.png" },
    action: { default_icon: { "128": "/icon-128.png" } },
    commands: {
      "toggle-mask": {
        suggested_key: { default: "Ctrl+Shift+M" },
        description: "マスクのON/OFFを切り替え",
      },
      "panic-mask-all": {
        suggested_key: { default: "Ctrl+Shift+K" },
        description: "緊急: フレーム全体をマスク",
      },
    },
  },
});
