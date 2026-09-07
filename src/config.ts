export const appConfig = {
  appName: import.meta.env.VITE_WEBSSH_APP_NAME || "Open WebSSH",
  targetLabel: import.meta.env.VITE_WEBSSH_TARGET_LABEL || "Remote",
  gatewayLabel: import.meta.env.VITE_WEBSSH_GATEWAY_LABEL || "Gateway",
  tmuxSession: import.meta.env.VITE_WEBSSH_TMUX_SESSION || "main",
};
