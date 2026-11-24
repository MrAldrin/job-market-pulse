// Serve validation requires a Tailscale DNS suffix. Use invented labels and
// supply the resulting hosts only to local tests; do not resolve them in DNS.
const serveSuffix = ["ts", "net"].join(".");

export const syntheticServeHost = `dashboard.synthetic.${serveSuffix}`;
export const syntheticServeOrigin = `https://${syntheticServeHost}`;
export const spoofedServeHost = `spoof.synthetic.${serveSuffix}`;
